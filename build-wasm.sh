#!/bin/sh
# Rebuilds wasm/armor_sim.wasm from rust/ (needs: rustup target add wasm32-wasip1-threads)
set -e
cd "$(dirname "$0")/rust"
cargo build --release
cp target/wasm32-wasip1-threads/release/armor_sim.wasm ../wasm/armor_sim.wasm
echo "built wasm/armor_sim.wasm ($(wc -c < ../wasm/armor_sim.wasm) bytes)"
