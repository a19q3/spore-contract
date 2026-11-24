#!/bin/sh
# Build in dependency order and stage the exact binaries pinned by build.rs.
set -eu
cd "$(dirname "$0")/.."
profile=debug
for arg in "$@"; do
    if [ "$arg" = --release ]; then profile=release; fi
done
runner=${SPORE_BUILD_RUNNER:-cross}
target=riscv64imac-unknown-none-elf
mkdir -p "build/$profile"
: "${SPORE_DEPLOYMENT_MANIFEST:?set a reviewed code Type ID plan (VM tests use deployment/type-ids.fixture.toml)}"
optional_contracts=$(python3 scripts/type-id-plan.py "$SPORE_DEPLOYMENT_MANIFEST" "build/$profile/code-type-ids.json")
# Do not leave legacy runtimes in staged artifacts after an incremental build.
rm -f "build/$profile/spore_extension_lua" "build/$profile/libckblua.so"
# Clear previously staged optional binaries when switching deployment plans.
rm -f "build/$profile/cluster_proxy" "build/$profile/cluster_agent"
for contract in spore_extension_rust cluster $optional_contracts spore mutant_equipment mutant_probe; do
    "$runner" build --locked --target "$target" -p "$contract" "$@"
    cp "target/$target/$profile/$contract" "build/$profile/$contract"
done
