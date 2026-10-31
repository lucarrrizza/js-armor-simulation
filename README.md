# Impact Sandbox

A 2D toy simulator for visualizing high-speed projectile impacts on armor (long rods, shaped-charge
jets, ERA, spaced/composite armor). Plausible-looking, not a validated ballistic code.

## Running

Start the local server from this folder, then open the printed URL (**http://localhost:8000/**):

```sh
python3 serve.py          # Windows: py serve.py
python3 serve.py --open   # also opens the browser
```

Use `localhost`, not the `[::]` / `0.0.0.0` address some servers print. Keep the terminal open while
you use the page.

You can also just open `index.html` in Chrome/Edge, but then the multi-core engine is unavailable
(it needs the cross-origin isolation headers `serve.py` sends; a plain `python -m http.server` won't do).

## Engines

Pick one under **Simulation → Engine** (or add `?engine=gpu|wasm|js` to the URL):

| Engine | Needs | Notes |
|---|---|---|
| GPU (WebGPU) | Chrome/Edge 113+ | Fastest, especially at fine resolution. Uses 32-bit floats. |
| Multi-core CPU (Rust) | `serve.py` | Rust compiled to multi-threaded WebAssembly; set the thread count in the UI. |
| Single-core CPU (JS) | nothing | The reference implementation and fallback. |

All engines share the same physics, so results agree to within a few percent.

## Rebuilding the Rust engine

The compiled `wasm/armor_sim.wasm` is checked in, so this is only needed after editing `rust/src/lib.rs`:

```sh
rustup target add wasm32-wasip1-threads
./build-wasm.sh
```
