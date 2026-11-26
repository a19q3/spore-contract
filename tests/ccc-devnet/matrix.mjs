import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const { CCC_ROOT, SPORE_ROOT, SPORE_RUN, SPORE_RPC } = process.env;
const require = createRequire(
  path.join(CCC_ROOT, "packages/spore/package.json"),
);
const { ccc } = require("@ckb-ccc/core");
const {
  TESTNET_SCRIPTS,
  JsonRpcTransformers: rpcTypes,
} = require("@ckb-ccc/core/advanced");
const spore = require(
  path.join(CCC_ROOT, "packages/spore/dist.commonjs/index.js"),
);
const intent = require(
  path.join(CCC_ROOT, "packages/spore/dist.commonjs/advanced.js"),
);
const demoKey = "0x" + "01".repeat(32);
assert.equal(new URL(SPORE_RPC).hostname, "127.0.0.1");
const local = { url: SPORE_RPC, fallbacks: [] };
if (process.argv[2] === "owner") {
  const owner = new ccc.SignerCkbPrivateKey(
    new ccc.ClientPublicTestnet(local),
    demoKey,
  );
  console.log(ccc.hashCkbShort(owner.publicKey));
  process.exit(0);
}

async function rpc(method, params = []) {
  const response = await fetch(SPORE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json();
  if (payload.error)
    throw new Error(method + " " + JSON.stringify(payload.error));
  return payload.result;
}

const genesis = await rpc("get_block_by_number", ["0x0"]);
assert.equal((await rpc("get_blockchain_info")).chain, "ckb_dev");
const secpGroup = {
  outPoint: { txHash: genesis.transactions[1].hash, index: 0 },
  depType: "depGroup",
};
const secp = TESTNET_SCRIPTS[ccc.KnownScript.Secp256k1Blake160];
const client = new ccc.ClientPublicTestnet({
  ...local,
  scripts: {
    ...TESTNET_SCRIPTS,
    [ccc.KnownScript.Secp256k1Blake160]: {
      ...secp,
      cellDeps: [{ cellDep: secpGroup }],
    },
  },
});
const signer = new ccc.SignerCkbPrivateKey(client, demoKey);
const owner = (await signer.getRecommendedAddressObj()).script;
const rows = [];
const report = {
  genesis: genesis.header.hash,
  node: process.env.SPORE_NODE_VERSION,
  cases: rows,
};
const file = (name) => path.join(SPORE_RUN, name);

async function syncIndexer() {
  const height = BigInt(await rpc("get_tip_block_number"));
  for (let i = 0; i < 150; i++) {
    const tip = await rpc("get_indexer_tip");
    if (tip && BigInt(tip.block_number) >= height) return;
    await pause(100);
  }
  throw new Error("Indexer failed to catch up");
}

// Capture all resolved Cells, including the contents of dep groups, before submission.
async function capture(tx) {
  const cells = new Map();
  async function resolve(point) {
    const key = point.toHex();
    if (cells.has(key)) return cells.get(key);
    const prev = await rpc("get_transaction", [point.txHash]);
    const index = Number(point.index);
    const cell = {
      outPoint: key,
      output: rpcTypes.cellOutputTo(prev.transaction.outputs[index]).toHex(),
      data: prev.transaction.outputs_data[index],
    };
    cells.set(key, cell);
    return cell;
  }
  for (const input of tx.inputs) await resolve(input.previousOutput);
  for (const dep of tx.cellDeps) {
    const cell = await resolve(dep.outPoint);
    if (dep.depType === "depGroup") {
      const bytes = ccc.bytesFrom(cell.data);
      const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
        0,
        true,
      );
      assert.equal(bytes.length, 4 + count * 36);
      for (let i = 0; i < count; i++) {
        await resolve(
          ccc.OutPoint.fromBytes(bytes.subarray(4 + 36 * i, 40 + 36 * i)),
        );
      }
    }
  }
  return [...cells.values()];
}

async function submit(name, tx, expectedError) {
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1500n);
  const signed = await signer.signTransaction(tx);
  const bytes = signed.toHex();
  const cells = await capture(signed);
  const hash = signed.hash();
  const raw = rpcTypes.transactionFrom(signed);
  assert.equal(rpcTypes.transactionTo(raw).toHex(), bytes);
  if (expectedError !== undefined) {
    const matchesCode = new RegExp("error code " + expectedError + "(?![0-9])");
    await assert.rejects(() => rpc("estimate_cycles", [raw]), matchesCode);
    let submitted;
    try {
      submitted = await rpc("send_transaction", [raw, "passthrough"]);
    } catch (error) {
      assert.match(error.message, matchesCode);
    }
    if (submitted !== undefined) {
      assert.equal(submitted, hash);
      let rejection;
      for (let i = 0; i < 30; i++) {
        const status = (await rpc("get_transaction", [hash]))?.tx_status;
        if (status?.status === "rejected") {
          rejection = status.reason;
          break;
        }
        assert.notEqual(status?.status, "committed");
        await pause(100);
      }
      assert.match(rejection ?? "", matchesCode);
    }
    rows.push({ name, hash, error: expectedError });
  } else {
    const cycles = (await rpc("estimate_cycles", [raw])).cycles;
    assert.equal(await rpc("send_transaction", [raw, "passthrough"]), hash);
    let committed;
    for (let i = 0; i < 30; i++) {
      await rpc("generate_block");
      const receipt = await rpc("get_transaction", [hash]);
      if (receipt?.tx_status.status === "committed") {
        committed = receipt;
        break;
      }
      if (receipt?.tx_status.status === "rejected")
        throw Error(receipt.tx_status.reason);
      await pause(120);
    }
    assert.ok(committed, "transaction did not commit");
    assert.equal(rpcTypes.transactionTo(committed.transaction).toHex(), bytes);
    rows.push({
      name,
      hash,
      block: committed.tx_status.block_hash,
      cycles: Number(BigInt(cycles)),
    });
    await syncIndexer();
  }
  appendFileSync(
    file("transactions.jsonl"),
    JSON.stringify({
      name,
      tx: bytes,
      cells,
      expectReject: expectedError !== undefined,
      expectedError,
    }) + "\n",
  );
  writeFileSync(file("results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(name, hash);
  return hash;
}

await rpc("generate_block");
await syncIndexer();
const deploy = ccc.Transaction.from({});
await deploy.completeInputsAtLeastOne(signer);
const roles = ["spore", "cluster", "mutant"];
const typeIds = Object.fromEntries(
  roles.map((role, i) => [role, ccc.hashTypeId(deploy.inputs[0], i)]),
);
const manifest = file("type-ids.toml");
writeFileSync(
  manifest,
  'format = 1\nprofile = "isolated-devnet"\n[type_ids]\n' +
    roles.map((role) => role + ' = "' + typeIds[role] + '"').join("\n") +
    "\n",
);
const crates = ["spore", "cluster", "spore_extension_rust", "mutant_probe"];
const target = "riscv64imac-unknown-none-elf";
const buildDir = path.join(SPORE_RUN, "cargo");
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--target",
    target,
    ...crates.flatMap((p) => ["-p", p]),
  ],
  {
    cwd: SPORE_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      SPORE_DEPLOYMENT_MANIFEST: manifest,
      CARGO_TARGET_DIR: buildDir,
      CC_riscv64imac_unknown_none_elf: path.join(
        SPORE_ROOT,
        "scripts/clang-riscv.sh",
      ),
    },
  },
);
const elf = (name) =>
  readFileSync(path.join(buildDir, target, "release", name));
const standard =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";
for (const [i, role] of roles.entries()) {
  deploy.addOutput(
    {
      lock: owner,
      type: { codeHash: standard, hashType: "type", args: typeIds[role] },
    },
    elf(crates[i]),
  );
}
const oldBinary = readFileSync(
  path.join(SPORE_ROOT, "tests/fixtures/legacy-cluster/testnet/cluster.bin"),
);
deploy.addOutput({ lock: owner }, oldBinary);
const deployed = await submit("deploy reviewed code", deploy);
const codeDep = (index) => ({
  outPoint: { txHash: deployed, index },
  depType: "code",
});
const descriptors = Object.fromEntries(
  roles.map((role, i) => [
    role,
    {
      typeId: typeIds[role],
      cellDep: codeDep(i),
      governanceLock: owner,
      expectedDataHash: ccc.hashCkb(elf(crates[i])),
      cobuild: true,
    },
  ]),
);
const profile = spore.createSporeDeploymentProfile(descriptors);
for (const [i, role] of roles.entries()) {
  const live = await spore.resolveSporeCodeDeployment(client, profile[role]);
  assert.ok(live.outPoint.eq(codeDep(i).outPoint));
}
report.deployments = roles.map((role, i) => ({
  role,
  typeId: typeIds[role],
  outPoint: { txHash: deployed, index: i },
  codeHash: profile[role].scriptInfo.codeHash,
  dataHash: descriptors[role].expectedDataHash,
  governanceLock: rpcTypes.scriptFrom(owner),
}));
const legacy = {
  codeHash: ccc.hashCkb(oldBinary),
  hashType: "data1",
  cellDeps: [{ cellDep: codeDep(3) }],
  cobuild: true,
};
const info = profile.spore.scriptInfo;
const scripts = [info];
const empty = async () => {
  const tx = ccc.Transaction.from({});
  await tx.completeInputsAtLeastOne(signer);
  return tx;
};
const data = { contentType: "text/plain", content: "0x41" };
const mint = async (extra = {}) =>
  spore.createSpore({
    signer,
    tx: await empty(),
    scriptInfo: info,
    data,
    ...extra,
  });
const send = async (name, build) => {
  const result = await build;
  await submit(name, result.tx);
  return result;
};
const transfer = async (id, extra = {}) =>
  spore.transferSpore({
    signer,
    tx: await empty(),
    id,
    to: owner,
    scripts,
    ...extra,
  });
const melt = async (id, extra = {}) =>
  spore.meltSpore({ signer, tx: await empty(), id, scripts, ...extra });
const ordinary = await send(
  "plain mint without intent",
  mint({ withIntent: false }),
);
await send("plain transfer", transfer(ordinary.id));
await send("plain melt", melt(ordinary.id, { withIntent: false }));

const noIntent = await mint({ withIntent: false });
intent.injectCobuild(noIntent.tx, [
  intent.assembleCreateSporeAction(noIntent.tx.outputs[0], "0x01"),
]);
await assert.rejects(
  () =>
    intent.checkSporeIntent({
      client,
      tx: noIntent.tx,
      scripts: { Spore: scripts },
    }),
  /data hash mismatch/,
);
await submit(
  "wallet rejects incorrect intent, V3 verifies actual Cells",
  noIntent.tx,
);

const v3Cluster = await send(
  "V3 Cluster mint",
  spore.createSporeCluster({
    signer,
    tx: await empty(),
    scriptInfo: profile.cluster.scriptInfo,
    data: { name: "v3", description: "" },
    withIntent: false,
  }),
);
await send(
  "V3 Cluster transfer",
  spore.transferSporeCluster({
    signer,
    id: v3Cluster.id,
    to: owner,
    tx: await empty(),
    scripts: [profile.cluster.scriptInfo],
    withIntent: false,
  }),
);

const cluster = await send(
  "V2 Cluster mint",
  spore.createSporeCluster({
    signer,
    tx: await empty(),
    scriptInfo: legacy,
    data: { name: "devnet", description: "" },
  }),
);
const mixed = await mint({
  data: { ...data, clusterId: cluster.id },
  clusterMode: "clusterCell",
  clusterScripts: [legacy],
  withIntent: false,
});
const verified = await intent.checkSporeIntent({
  client,
  tx: mixed.tx,
  scripts: { Spore: scripts, Cluster: [legacy] },
});
assert.equal(verified.length, 1);
await submit("V3 mint with required V2 Cluster action", mixed.tx);

const rule = await send(
  "native rule create",
  spore.createMutant({
    signer,
    tx: await empty(),
    scriptInfo: profile.mutant.scriptInfo,
    code: elf("mutant_probe"),
  }),
);
const ruleCell = await spore.findMutant(client, rule.id, [
  profile.mutant.scriptInfo,
]);
assert.ok(ruleCell);
await send(
  "V3 Cluster mint with native rule",
  spore.createSporeCluster({
    signer,
    tx: await empty(),
    scriptInfo: profile.cluster.scriptInfo,
    data: { name: "native rule", description: "", mutantId: rule.id },
    withIntent: false,
  }),
);
const native = await mint({
  data: {
    ...data,
    contentType: spore.withMutants(data.contentType, [rule.id]),
  },
  withIntent: false,
});
const missing = native.tx.clone();
missing.cellDeps = missing.cellDeps.filter(
  (dep) => !dep.outPoint.eq(ruleCell.cell.outPoint),
);
await submit("missing native rule", missing, 71);
await submit("native Spore mint", native.tx);
await send("native Spore transfer", transfer(native.id, { withIntent: false }));
await send("native Spore melt", melt(native.id));

const payee = (
  await new ccc.SignerCkbPrivateKey(
    client,
    "0x" + "02".repeat(32),
  ).getRecommendedAddressObj()
).script;
const threshold = ccc.fixedPointFrom(65);
const paidRules = [];
for (let i = 0; i < 2; i++) {
  const rule = await send(
    "paid native rule " + (i + 1),
    spore.createMutant({
      signer,
      tx: await empty(),
      scriptInfo: profile.mutant.scriptInfo,
      code: elf("mutant_probe"),
      payment: threshold,
      to: payee,
    }),
  );
  paidRules.push(rule.id);
}
const paid = await mint({
  data: {
    ...data,
    contentType: spore.withMutants(data.contentType, paidRules),
  },
});
const underpaid = paid.tx.clone();
underpaid.addOutput({ lock: payee, capacity: threshold });
await submit("two rules require their combined mint payment", underpaid, 72);
paid.tx.addOutput({ lock: payee, capacity: 2n * threshold });
await submit("two native rules with full same-owner payment", paid.tx);
