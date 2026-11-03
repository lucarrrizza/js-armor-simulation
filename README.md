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

You can also open `index.html` directly in Chrome/Edge, but `serve.py` is the recommended way to run it.

## Engines

Pick one under **Simulation → Engine** (or add `?engine=gpu|js` to the URL):

| Engine | Needs | Notes |
|---|---|---|
| GPU (WebGPU) | Chrome/Edge 113+ | Fastest, especially at fine resolution. Uses 32-bit floats. |
| Single-core CPU (JS) | nothing | The reference implementation and fallback. |

Both engines share the same physics, so results agree to within a few percent.

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

## Controls

| Key | Action |
|---|---|
| Space | play / pause (the replay, while replaying) |
| R | reset: rebuild the scene at t = 0, paused |
| . | step forward (one frame in a replay) |
| , or ← / → | previous / next replay frame |
| F | fit the view |

## Record & replay

Set **Run until t<sub>f</sub>** and **Frames to keep**, then press **Run to t<sub>f</sub> & record**. The sim
runs to t<sub>f</sub> as fast as the engine allows, keeps evenly spaced snapshots, then plays them back.
Use the timeline at the bottom to play, pause and scrub; **Slow-mo** sets the replay speed and the view
mode / renderer can be changed while replaying. **Live** goes back to the simulation (which is left
at t<sub>f</sub>, so you can keep running it); **Reset** rebuilds it at t = 0 and keeps the recording.

- Snapshots take about 11 bytes per particle, and a recording is capped at about 800 MB, so at fine
  resolutions fewer frames are kept (the panel says how many).
- **Cancel** keeps the frames recorded so far.
- Changing the scene (preset, projectile, resolution, drawing…) discards the recording.

## Drawing

Use the **Draw** section to add your own armor and projectiles:

| Tool | Key | Notes |
|---|---|---|
| Pan | V | drag to move, wheel to zoom, double-click to fit |
| Brush | B | freehand strokes, width = *Stroke width* |
| Line | L | Shift snaps to 15° |
| Rect fill / outline | X / Shift+X | Shift while dragging makes a square |
| Circle fill / outline | C / Shift+C | |
| Bucket | G | click inside a closed outline to fill it, or on a body to repaint it |
| Eraser | E | removes material (including preset parts) |

- **Paint as** sets what a shape becomes:
  - **Armor / object**: uses the selected material.
  - **Projectile**: also takes a speed and direction, shown as an arrow.
  - **Pin**: clamps armor in place.
- Outlines and lines use *Stroke width*. The bucket fills the area connected to the clicked spot:
  empty space must be fully enclosed (by drawings or armor); otherwise nothing is added.
- Any mouse button other than the left one always pans.
- Ctrl+Z undoes. **Clear drawing** removes everything drawn.
- Set **Projectile → Type** to **None** to use only your drawn ones.
- Drawings are saved in the browser (localStorage) and rebuilt at the current resolution.


