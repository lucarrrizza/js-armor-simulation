'use strict';
// Worker thread for the multi-core WebAssembly engine (see wasm.js).
// Waits for the coordinator to bump the generation counter, then helps process the current phase.
const GEN = 0, PHASE = 1, DONE = 2, QUIT = 3;
const SPIN = 20000;

onmessage = (e) => {
  const { module, memory, tid, stackTop, ctrlPtr } = e.data;
  const inst = new WebAssembly.Instance(module, { env: { memory } });
  inst.exports.__stack_pointer.value = stackTop;
  const ctrl = new Int32Array(memory.buffer, ctrlPtr, 16);
  const work = inst.exports.work;
  postMessage('ready');
  let seen = Atomics.load(ctrl, GEN);
  for (;;) {
    let g, spins = 0;
    while ((g = Atomics.load(ctrl, GEN)) === seen) {
      if (++spins > SPIN) { Atomics.wait(ctrl, GEN, seen); spins = 0; }
    }
    seen = g;
    if (Atomics.load(ctrl, QUIT)) break;
    work(Atomics.load(ctrl, PHASE), tid);
    Atomics.add(ctrl, DONE, 1);
  }
  close();
};
