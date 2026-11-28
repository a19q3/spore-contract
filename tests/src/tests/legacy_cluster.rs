use crate::{utils::*, MAX_CYCLES};
use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder as MoleculeBuilder, Entity as MoleculeEntity};
use spore_types::{generated::spore::ClusterDataV2, BytesOpt};

struct HistoricalCluster {
    id: [u8; 32],
    script: Script,
    data: Bytes,
    code: CellDep,
}

fn historical_cluster(context: &mut Context) -> HistoricalCluster {
    let (elf, record): (&[u8], &str) = if crate::Loader::default().is_testnet() {
        (
            include_bytes!("../../fixtures/legacy-cluster/testnet/cluster.bin"),
            include_str!("../../fixtures/legacy-cluster/testnet/cell.json"),
        )
    } else {
        (
            include_bytes!("../../fixtures/legacy-cluster/mainnet/cluster.bin"),
            include_str!("../../fixtures/legacy-cluster/mainnet/cell.json"),
        )
    };
    let cell: serde_json::Value = serde_json::from_str(record).unwrap();
    let field = |v: &serde_json::Value| {
        hex::decode(v.as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
    };
    let id = field(&cell["type"]["args"]).try_into().unwrap();
    let point = context.deploy_cell(Bytes::copy_from_slice(elf));
    let script = context
        .build_script_with_hash_type(&point, ScriptHashType::Data1, Vec::from(id).into())
        .unwrap();
    assert_eq!(cell["type"]["hash_type"], "data1");
    assert_eq!(
        field(&cell["type"]["code_hash"]),
        script.code_hash().as_slice()
    );
    HistoricalCluster {
        id,
        script,
        data: field(&cell["data"]).into(),
        code: CellDep::new_builder().out_point(point).build(),
    }
}

#[test]
fn v3_mint_with_historical_cluster_transfer_keeps_only_the_v2_action() {
    let mut context = Context::default();
    let cluster = historical_cluster(&mut context);
    let output = build_normal_output_cell_with_type(&mut context, Some(cluster.script.clone()));
    let point = context.create_cell(output.clone(), cluster.data.clone());
    let mint =
        build_single_spore_mint_tx(&mut context, vec![1], "text/plain", None, Some(cluster.id));
    let tx = mint
        .as_advanced_builder()
        .set_witnesses(vec![])
        .input(
            CellInput::new_builder()
                .previous_output(point.clone())
                .build(),
        )
        .output(output)
        .output_data(cluster.data.pack())
        .cell_dep(cluster.code)
        .cell_dep(CellDep::new_builder().out_point(point).build())
        .build();
    let action = co_build::build_transfer_cluster_action(&mut context, cluster.id);
    let mixed =
        co_build::complete_co_build_message_with_actions(tx, &[(Some(cluster.script), action)]);
    let mixed = context.complete_tx(mixed);
    context
        .verify_tx(&mixed, MAX_CYCLES)
        .expect("V3 mint and historical V2 Cluster transfer");
    let missing_action = mixed.as_advanced_builder().set_witnesses(vec![]).build();
    assert!(context.verify_tx(&missing_action, MAX_CYCLES).is_err());
}

#[test]
fn legacy_cluster_with_a_rule_can_transfer_but_cannot_authorize_v3_issuance() {
    let mut context = Context::default();
    let cluster = historical_cluster(&mut context);
    let original = spore_utils::compatible_load_cluster_data(&cluster.data)
        .ok()
        .unwrap();
    let required = [0x42u8; 32];
    let ruled = ClusterDataV2::new_builder()
        .name(original.name())
        .description(original.description())
        .mutant_id(
            BytesOpt::new_builder()
                .set(Some(required.as_slice().into()))
                .build(),
        )
        .build();
    let data = Bytes::copy_from_slice(ruled.as_slice());
    let output = build_normal_output_cell_with_type(&mut context, Some(cluster.script.clone()));
    let point = context.create_cell(output.clone(), data.clone());
    let transfer = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(point.clone())
                .build(),
        )
        .output(output)
        .output_data(data.pack())
        .cell_dep(cluster.code)
        .build();
    let action = co_build::build_transfer_cluster_action(&mut context, cluster.id);
    let transfer = co_build::complete_co_build_message_with_actions(
        transfer,
        &[(Some(cluster.script), action)],
    );
    let transfer = context.complete_tx(transfer);
    context
        .verify_tx(&transfer, MAX_CYCLES)
        .expect("legacy transfer retains its own rules");

    let mint =
        build_single_spore_mint_tx(&mut context, vec![1], "text/plain", None, Some(cluster.id));
    let mint = mint
        .as_advanced_builder()
        .cell_dep(CellDep::new_builder().out_point(point).build())
        .build();
    let mint = context.complete_tx(mint);
    let error = context
        .verify_tx(&mint, MAX_CYCLES)
        .expect_err("legacy rule in V3 issuance");
    assert!(format!("{error:?}").contains("error code 95"), "{error:?}");
}

#[test]
fn historical_cluster_identity_binds_its_reviewed_hash_type() {
    let mut context = Context::default();
    let cluster = historical_cluster(&mut context);
    let mint =
        build_single_spore_mint_tx(&mut context, vec![1], "text/plain", None, Some(cluster.id));
    for (hash_type, accepted) in [(0u8, false), (1, false), (2, true), (4, false)] {
        let script = cluster
            .script
            .clone()
            .as_builder()
            .hash_type(hash_type.into())
            .build();
        let dep = build_normal_cell_dep(&mut context, &cluster.data, Some(script));
        let tx = context.complete_tx(mint.as_advanced_builder().cell_dep(dep).build());
        let result = context.verify_tx(&tx, MAX_CYCLES);
        if accepted {
            result.expect("reviewed data1 Cluster in owner-lock mode");
        } else {
            let error = result.expect_err("unreviewed historical hash type");
            assert!(format!("{error:?}").contains("error code 6"), "{error:?}");
        }
    }
}
