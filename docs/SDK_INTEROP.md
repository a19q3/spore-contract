# SDK interoperability acceptance — 2026-11-03

The contract PRs #75 and #76 keep their original review scopes. This branch adds
only a replay test, a recorded transaction fixture and this report. No contract
consensus source, cell schema, package version or deployed public preset changes
are needed for the tested SDK flows.

The SDK adaptation remains a separate, local PR candidate. These results are
local interoperability evidence, not upstream acceptance or release readiness.

## Exact revisions and environment

| Component | Revision / version |
| --- | --- |
| Contract source / deployed v3 binary source | `46eaa8b59abe818f27dcfe3c7af0da46698c12f8` |
| SDK base | `5e5d886e49bfbd78253e9c14fd8baebccb488a81` (`beta`) |
| SDK candidate tree | `29ae2a72a04483ab01059f0da97f9c631df8f3d9` |
| SDK candidate patch SHA-256 | `fdc31614cb350b20d9896a461537bc4869755cb29313c5f7d99eb62918b109e4` |
| Historical contract source for local deployments | `9a6010e43ffd09ac9e6fe7ee389cc915e3e4f999` |
| Node | CKB `0.200.0` (`52c2be1`, official release), built-in indexer, Dummy mining |
| SDK tooling | Node `22.23.1`, Lumos `0.24.0-next.1`, Vitest `1.4.0`, TypeScript `5.3.2` |
| Contract build | Rust `1.92.0`, Clang `22.1.8`, ordered release build |

The temporary node listened on loopback only. A new local genesis funded public
fixture keys `[0x2a; 32]` and `[0x2b; 32]`; no production wallet was used. All v2
and v3 deployment outpoints were created on that local chain. The historical
comparison uses a local build of historical source, not a claim that its binary
hashes equal every previously deployed release. No public-network transaction,
SDK package publication or release tag was created. The node and miner were
stopped after receipt checks; local records were retained.

## What actually ran

| Check | Result |
| --- | --- |
| SDK interoperability offline suite | 12 passed, core build and isolated typecheck passed |
| Existing SDK SporeConfig tests | 5 passed |
| Real local devnet acceptance | 1 sequential suite passed, 23 transaction cases |
| Rust CKB-VM replay of captured SDK bytes | 1 test passed, all 23 cases matched |

Of those 23 transactions, **12 were accepted and committed**, and **11 were
rejected by script validation**. Commitments for all 12 positive cases were
queried after the suite. The rejection cases were not counted as successful
because of network errors, unresolved cells or inadequate fees.

The suite covers native rule publication and real recipe rejection (93), plain
and native Spore mint/transfer/melt without Actions, missing/wrong signatures,
recipient tampering, Lua bytes on native publication (91), a historical Lua rule
rejected by native Spore (71), matching and misleading optional intent, witness
tampering, historical required Actions, and a mixed historical/v3 transfer batch.

The first devnet attempt exposed a fixture assumption: CKB 0.200.0 can return
`unknown` for an already-spent Cell. The corrected assertion verifies that the
melt transaction committed and consumed the exact target outpoint, and that the
outpoint is no longer live. This required no SDK production or contract change.

## Recorded bytes → independent VM replay

```mermaid
flowchart LR
    SDK["Pinned SDK candidate"] --> TX["Build and sign final transaction"]
    TX --> NODE["Local CKB node<br/>script checks, fees, commitment, indexer"]
    TX --> CAPTURE["Capture exact packed transaction<br/>and resolved cells before submission"]
    CAPTURE --> VM["Rust Context::verify_tx<br/>same bytes, original Locks and signatures"]
    NODE --> CHECK["Compare 12 accepted / 11 rejected"]
    VM --> CHECK
```

The replay does not call `complete_tx`, re-sign, replace Locks with
AlwaysSuccess, rebuild witnesses, or query RPC. It resolves original code cells
and expanded dep-group members from the capture. Negative cases must be script
validation failures; specified exit codes are also checked. Replay alone does
not test fee policy, capacity conservation, commitment or indexer convergence;
those were exercised by the real-node suite.

The self-contained capture is stored at
[`tests/fixtures/sdk-interop/transactions.jsonl.xz`](../tests/fixtures/sdk-interop/transactions.jsonl.xz).
The raw JSONL is 54,450,163 bytes; compression removes repeated resolved code
cells without altering any decoded bytes. Its SHA-256 is:

```text
31bfedecf99f0ce51389575a16e4ed66faab3f6bcd652759b632b591aa8d99a7
```

[`acceptance-results.json`](../tests/fixtures/sdk-interop/acceptance-results.json)
records both archive/raw checksums, genesis, source identities, binary sizes and
hashes. These are local test records, not new public deployment records.

## Reproduce the offline Rust replay

From the contract repository root:

```sh
mkdir -p .tmp
python3 - <<'PY'
import hashlib, lzma
from pathlib import Path
data = lzma.decompress(Path('tests/fixtures/sdk-interop/transactions.jsonl.xz').read_bytes())
assert hashlib.sha256(data).hexdigest() == '31bfedecf99f0ce51389575a16e4ed66faab3f6bcd652759b632b591aa8d99a7'
Path('.tmp/sdk-transactions.jsonl').write_bytes(data)
PY
SPORE_V3_VM_CAPTURE="$PWD/.tmp/sdk-transactions.jsonl" \
  cargo test --locked --manifest-path tests/Cargo.toml \
  sdk_captured_transactions_replay_in_ckb_vm -- --ignored --nocapture
```

The recorded fixture verifies its recorded contract binaries. It does **not**
prove compatibility with future rebuilt or modified binaries. A new contract or
SDK revision needs its own exact deployment, capture and devnet run. The old
external SDK/devnet workflow still does not bind all of these source identities.

## Review and release boundary

The separate SDK candidate contains explicit v3 deployment configuration,
`mutantRuntime: native-v1`, native dependency resolution, full script identity
matching, mixed-version Action selection and a limited plain-Spore intent check.
SDK package version remains `0.2.2-alpha.2`; contract package version remains
`0.3.0-alpha.1`. Runtime identity is not inferred from either semver string.

This evidence covers standard secp256k1 input Locks and the exercised Spore
operations. It does not certify every wallet, Cluster operation, native rule or
permission policy. JoyID, CCC and hardware-wallet integration were not run.
Maintainer review, SDK release version/defaults, release CI and any public
network deployment remain separate work. Passing #75/#76's contract review is
not, by itself, approval to release the full client/contract stack.
