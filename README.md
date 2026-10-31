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

**Resolution** (Simulation → Resolution) goes down to 0.5 mm, which is about 1 million particles for a
500 mm block. Use the GPU engine for anything finer than about 2 mm. When a frame can't keep up, the
sim runs in slow motion ("slowed" in the stats) and the page stays responsive.

## Rendering

Pick one under **Playback → Renderer** (or add `?render=cinematic|standard|2d` to the URL):

| Renderer | Notes |
|---|---|
| Cinematic | WebGPU: HDR bloom, glowing hot metal, motion-blurred debris, explosion fireballs, sparks, smoke and shock-wave distortion |
| Standard | WebGPU: plain colours, light glow |
| Basic (2D) | Canvas 2D fallback for browsers without WebGPU |

Explosions from explosive materials (e.g. the ERA preset) are visual only; they don't push on the sim.

## Drawing

Use the **Draw** section to add your own armor and projectiles:

| Tool | Key | Notes |
|---|---|---|
| Pan | V | drag to move, wheel to zoom, double-click to fit |
| Brush | B | freehand strokes, width = *Brush / eraser size* |
| Line | L | Shift snaps to 15° |
| Rectangle | X | Shift makes a square |
| Circle | C | |
| Eraser | E | removes material (including preset parts) |

- **Paint as** sets what a shape becomes:
  - **Armor / object**: uses the selected material.
  - **Projectile**: also takes a speed and direction, shown as an arrow.
  - **Pin**: clamps armor in place.
- Any mouse button other than the left one always pans.
- Ctrl+Z undoes. **Clear drawing** removes everything drawn.
- Set **Projectile → Type** to **None** to use only your drawn ones.
- Drawings are saved in the browser (localStorage) and rebuilt at the current resolution.

## Rebuilding the Rust engine

The compiled `wasm/armor_sim.wasm` is checked in, so this is only needed after editing `rust/src/lib.rs`:

```sh
rustup target add wasm32-wasip1-threads
./build-wasm.sh
```
