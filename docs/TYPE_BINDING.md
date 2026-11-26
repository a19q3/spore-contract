# Type-bound Spore v3 deployments

This unreleased candidate references new contract code with `hash_type: type`.
The reference is the hash of the code Cell's **standard Type ID script**, not
its ELF data hash. Existing data-bound deployments and the default SDK V2
selection are unchanged. This is not an automatic migration of existing NFTs.

## Three different Cells

| Cell | Type script | Data | Lock responsibility |
| --- | --- | --- | --- |
| Contract code Cell | Standard CKB Type ID | Contract ELF | Deployment governance |
| Native Mutant rule Cell | Type-bound Mutant lifecycle contract + rule ID | Rule ELF | Rule owner, subject to lifecycle checks |
| Spore asset Cell | Type-bound Spore contract + asset ID | Existing Spore data/DNA | Asset owner |

Changing the governance Lock of a contract code Cell is different from changing
an NFT owner's Lock. No new governance contract is introduced here. Deployers
provide an existing Lock with their intended authorization, delay and recovery
policy. A Type ID ensures identity/uniqueness; it does **not** supply upgrade
authorization or prevent an authorized controller from destroying its code
Cell. Those constraints belong to the chosen governance Lock and deployment
policy. A frozen deployment needs a Lock that actually prevents spending.

An authorized code successor keeps its Type ID but changes its OutPoint and
possibly data. Every client must resolve the live successor. The unchanged
Type ID does not certify unchanged code semantics. Current lifecycle code
preserves rule ELF data, but an upgrade to that lifecycle can change future
validation. Application sessions/replay profiles that require exact semantics
must also bind the reviewed executable hashes, including the rule ELF.

```mermaid
flowchart LR
    ASSET["Spore asset: ID and content"] --> REF["code_hash = hash of code Cell Type ID<br/>hash_type = type"]
    REF --> LIVE["Live code Cell<br/>Contract ELF"]
    GOV["Deployment-supplied Lock"] -->|"authorizes spending"| LIVE
    LIVE -. "authorized successor keeps Type ID" .-> NEXT["New OutPoint and possibly new ELF"]
```

## VM selection

After Meepo activation, `hash_type: type` selects VM2 and supports native
`spawn/wait`. Before activation it selects an older VM and cannot execute the
native path. Unlike `data2`, type binding does not permanently pin a VM
version: later network upgrades also need compatibility qualification.
The native ABI, transaction indices, returning execution, payment accounting,
cell formats and CoBuild responsibilities are unchanged by this binding work.

## Explicit deployment plan

Set `SPORE_DEPLOYMENT_MANIFEST` to a TOML plan with format 1, a profile label,
and distinct 32-byte standard Type ID arguments under `[type_ids]`.
The initial native profile includes `spore`, `cluster` and `mutant`. Omit
`cluster_proxy` and `cluster_agent` while their deployment is deferred.
The build stages a role only when its ID is configured and leaves deferred V3
roles out of the compiled allowlists. Enabling them later requires a reviewed
plan with their actual IDs and a compatible code update. The full five-role
fixture continues to exercise their contract logic in local VM tests.
The mutant role means the native lifecycle code in #75/combined builds; #76's
standalone intermediate tree still uses its legacy lifecycle and executor.
No standalone #76 artifact is advertised as the complete native v3 release.

Before compiling a real deployment, reserve the funding transaction's first
CellInput and each code output's index. Derive each standard Type ID using
CKB's Type ID algorithm. Keep that first input and the output indices stable
when balancing and signing. Compile the contracts against those identities,
then publish the code Cells with those exact Type IDs and chosen governance
Locks. Verify the final transaction, live Cells, code hashes and Lock scripts
against the reviewed plan before recording any public preset. Rebuilding code
must not silently allocate a new identity.

Build-time cross-contract allowlists separate type hashes from historical
frozen data hashes, and check both the hash and its interpretation. Governance
can update code under an allowed identity; adding an entirely different code
Type ID still requires a reviewed allowlist change. Historical Cluster entries bind the deployment data hash and the exact
`data1` mode. The V3 Spore accepts ordinary Cluster data under those entries.
A populated historical Mutant field rejects V3 issuance with error 95. The
original Cluster still transfers under its original contract and witness rules.

`deployment/type-ids.fixture.toml` is **test-only**. Its IDs are not public
mainnet/testnet records. Builds require an explicit plan; CI explicitly selects
this fixture. `build/<profile>/code-type-ids.json` records the selected plan for
the VM harness. The build copies the input plan into the checkout for runner
visibility. It replaces the staged profile only after compiling and checking the
complete ELF set. CI uses Cargo with the RISC-V Clang wrapper.

For a local native/combined VM build:

```sh
export SPORE_DEPLOYMENT_MANIFEST=deployment/type-ids.fixture.toml
SPORE_BUILD_RUNNER=cargo \
CC_riscv64imac_unknown_none_elf="$PWD/scripts/clang-riscv.sh" \
./scripts/build-contracts.sh
cargo test --locked --manifest-path tests/Cargo.toml
```

Use `--release` and then `--release --features release_export` with the matching
`CAPSULE_TEST_ENV=release` to qualify each configuration. For actual deployment,
use the real reviewed plan rather than the fixture. This change deploys no
contracts and establishes no public governance policy.

The earlier data2 SDK captures and benchmark hashes document their original
revisions. They do not validate these type-bound artifacts; new exact-byte
SDK/devnet acceptance and deployment governance checks remain release gates.

## Local type-binding validation (2026-11-13)

| Tree | Debug | Testnet release | Mainnet release |
| --- | --- | --- | --- |
| #75 native execution | 72 passed / 2 ignored | 72 passed / 2 ignored | 72 passed / 2 ignored |
| #76 optional core intent | 57 passed / 1 ignored | 57 passed / 1 ignored | 57 passed / 1 ignored |
| Combined candidate | 78 passed / 3 ignored | 78 passed / 3 ignored | 78 passed / 3 ignored |

All listed runs had zero failures. Each tree also passed three deployment-plan
unit tests; native trees passed the invocation ABI unit test. The two added VM
cases verify code resolution under the same Type ID after a changed ELF and
OutPoint, and rejection of identical bytes under a different Type ID. These
fixtures do not simulate or approve a particular governance Lock.

Ignored cases are the historical deployment-transaction generator, the native
performance report (native trees), and the old exact-byte SDK capture (combined
tree). The old capture is explicitly pinned to its data2 artifacts; it has not
been relabelled as type-bound acceptance. Local builds used direct Cargo with
a RISC-V Clang adapter, Rust 1.92.0 for native trees and 1.74.0 for standalone
#76. Docker/Cross, live deployment and fresh CCC signed devnet/replay acceptance
were not run for these artifacts.


## Reproduce the CCC Type ID acceptance run

Build Core and Spore in the CCC candidate checkout with its locked pnpm
dependencies. From this contract checkout, supply the CCC directory and a
Meepo-capable CKB executable with the Indexer and IntegrationTest modules.

```sh
python3 tests/ccc-devnet/run.py --ccc /path/to/ccc --ckb /path/to/ckb
```

The runner uses a fresh dev genesis and a test signing key, derives code Type
IDs from its actual funding input and output indices, and builds the native
contracts against that plan. Its deployment transaction also includes the
historical testnet V2 Cluster ELF for mixed-version tests. The run directory
under `tests/target` contains the plan, signed transactions, resolved Cells,
block receipts, executable hashes, cycle estimates and exact-byte replay
checksum. The node exits after verification.

The offline `legacy_cluster` tests load the code and asset data from historical
public transactions recorded under `tests/fixtures/legacy-cluster`. They use
a local test owner to exercise Cluster transfers. The ruled-Cluster case adds
a synthetic rule reference to the historical data. Set
`SPORE_TEST_CLUSTER_NETWORK=testnet` or `mainnet` to select the fixture for
the matching contract build.
