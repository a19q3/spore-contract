//! Replay exact serialised SDK transactions and resolved cells. No re-signing,
//! complete_tx, always-success Lock substitution, RPC, or deployment.
use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        packed::{CellOutput, OutPoint, Transaction},
        prelude::*,
    },
    context::Context,
};

fn raw(value: &serde_json::Value) -> Vec<u8> {
    hex::decode(
        value
            .as_str()
            .expect("hex string")
            .strip_prefix("0x")
            .expect("0x prefix"),
    )
    .unwrap()
}

#[test]
#[ignore = "requires SPORE_V3_VM_CAPTURE from the SDK interoperability runner"]
fn sdk_captured_transactions_replay_in_ckb_vm() {
    let path = std::env::var("SPORE_V3_VM_CAPTURE").expect("capture path required");
    let input = std::fs::read_to_string(path).unwrap();
    let mut count = 0;
    let mut accepted = 0;
    let mut rejected = 0;
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let item: serde_json::Value = serde_json::from_str(line).unwrap();
        let mut context = Context::default();
        for cell in item["cells"].as_array().expect("resolved cells") {
            context.create_cell_with_out_point(
                OutPoint::from_slice(&raw(&cell["outPoint"])).unwrap(),
                CellOutput::from_slice(&raw(&cell["output"])).unwrap(),
                Bytes::from(raw(&cell["data"])),
            );
        }
        let tx = Transaction::from_slice(&raw(&item["tx"]))
            .unwrap()
            .into_view();
        let result = context.verify_tx(&tx, 50_000_000);
        if item["expectReject"].as_bool().unwrap() {
            let error = result.expect_err("negative SDK transaction accepted");
            assert!(
                format!("{error:?}").contains("ValidationFailure"),
                "not a script rejection: {error:?}"
            );
            rejected += 1;
            if let Some(code) = item["expectedError"].as_i64() {
                assert!(
                    format!("{error:?}").contains(&format!("error code {code}")),
                    "{error:?}"
                );
            }
        } else {
            result.expect("positive SDK transaction rejected");
            accepted += 1;
        }
        count += 1;
    }
    assert!(
        count >= 10 && accepted > 0 && rejected > 0,
        "capture is incomplete: {count} cases, {accepted} accepted, {rejected} rejected"
    );
    println!("Exact SDK byte replay: {count} cases, {accepted} accepted, {rejected} rejected");
}
