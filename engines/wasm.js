'use strict';
// Multi-core CPU engine: the Rust solver in wasm/armor_sim.wasm, run on shared memory by a pool of
// Web Workers. Needs SharedArrayBuffer, i.e. the page must be cross-origin isolated (use serve.py).
(function (G) {
  const { Sim, PHYS } = G.ImpactSim;
  const BASE = document.currentScript.src;
  const GEN = 0, PHASE = 1, DONE = 2, QUIT = 3;
  const STACK = 1 << 19;

  class WasmSim {
    static available() {
      return typeof SharedArrayBuffer !== 'undefined' && G.crossOriginIsolated === true;
    }

    static async create(threads) {
      const bytes = await (await fetch(new URL('../wasm/armor_sim.wasm', BASE))).arrayBuffer();
      const module = await WebAssembly.compile(bytes);
      const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
      const inst = await WebAssembly.instantiate(module, { env: { memory } });
      const X = inst.exports;
      const nW = Math.max(0, threads - 1);
      const stacks = X.init_heap(STACK * Math.max(1, nW));
      const ctrlPtr = X.ctrl_ptr();
      const workers = [];
      await Promise.all(Array.from({ length: nW }, (_, k) => new Promise((resolve, reject) => {
        const w = new Worker(new URL('wasm-worker.js', BASE));
        w.onmessage = () => resolve();
        w.onerror = (e) => reject(new Error('worker failed: ' + e.message));
        w.postMessage({ module, memory, tid: k + 1, stackTop: stacks + STACK * (k + 1), ctrlPtr });
        workers.push(w);
      })));
      return new WasmSim(X, memory, workers, ctrlPtr);
    }

    constructor(X, memory, workers, ctrlPtr) {
      this.X = X;
      this.memory = memory;
      this.workers = workers;
      this.nW = workers.length;
      this.threads = workers.length + 1;
      this.ctrl = new Int32Array(memory.buffer, ctrlPtr, 16);
      this.engineName = `multi-core CPU (Rust/WASM, ${this.threads} threads)`;
      this.events = [];
      this.n = 0; this.nb = 0; this.time = 0;
    }

    build(scn) {
      const b = new Sim();
      b.build(scn);
      for (const k of ['res', 'usPerT', 'cos', 'sin', 'layers', 'armorDepth', 'armorFront', 'stackLos', 'losThickness',
        'entryX', 'fit', 'bx0', 'bx1', 'by0', 'by1', 'gw', 'gh', 'projMass0', 'dtStab', 'vmax', 'fillFailed']) this[k] = b[k];
      const X = this.X, n = b.n, nb = b.nb;
      const L = X.setup(n, nb, b.expl.length, PHYS.NM, b.gw, b.gh, b.bx0, b.by0, b.bx1, b.by1);
      if (!L) throw new Error('out of WebAssembly memory - try a coarser resolution');
      const buf = this.memory.buffer;
      const lay = new Uint32Array(buf, L, 20);
      const F64 = (k, len) => new Float64Array(buf, lay[k], len);
      const F32 = (k, len) => new Float32Array(buf, lay[k], len);
      const U8 = (k, len) => new Uint8Array(buf, lay[k], len);
      const U32 = (k, len) => new Uint32Array(buf, lay[k], len);
      this.px = F64(0, n); this.py = F64(1, n); this.vx = F64(2, n); this.vy = F64(3, n);
      this.heat = F32(6, n); this.stress = F32(7, n); this.pres = F32(19, n);
      this.mat = U8(8, n); this.grp = U8(9, n); this.alive = U8(10, n);
      this.px.set(b.px.subarray(0, n)); this.py.set(b.py.subarray(0, n));
      this.vx.set(b.vx.subarray(0, n)); this.vy.set(b.vy.subarray(0, n));
      F64(4, n).set(b.invm.subarray(0, n));
      this.detT = F64(5, n);
      this.detT.set(b.detT.subarray(0, n).map((t) => (t === Infinity ? 1e300 : t)));
      this.heat.set(b.heat.subarray(0, n));
      this.mat.set(b.mat.subarray(0, n)); this.grp.set(b.grp.subarray(0, n)); this.alive.set(b.alive.subarray(0, n));
      U32(11, nb).set(b.ba.subarray(0, nb)); U32(12, nb).set(b.bb.subarray(0, nb));
      F64(13, nb).set(b.brest.subarray(0, nb)); F64(14, nb).set(b.borig.subarray(0, nb));
      U32(15, b.expl.length).set(b.expl);
      // parameter table: same packing as the JS and WebGPU engines (PHYS.packMT in sim.js)
      F64(16, PHYS.MTL.LEN).set(PHYS.packMT());
      this.evView = F64(17, 4096 * 3);
      X.finalize();
      this.gas = b.explosionModel === 'gas';
      X.set_gas(this.gas ? 1 : 0);
      this.n = X.get_n(); this.nb = X.get_nb(); this.time = 0; this.events = [];
    }

    phase(p) {
      const { X, ctrl } = this;
      X.phase_begin(p);
      Atomics.store(ctrl, PHASE, p);
      Atomics.store(ctrl, DONE, 0);
      Atomics.add(ctrl, GEN, 1);
      if (this.nW) Atomics.notify(ctrl, GEN);
      X.work(p, 0);
      const nW = this.nW;
      while (Atomics.load(ctrl, DONE) < nW) { /* spin: the main thread may not Atomics.wait */ }
    }

    advance(us, maxSteps, budgetMs = 30) {
      const X = this.X;
      const t0 = performance.now();
      let remaining = us / this.usPerT;
      let steps = 0;
      while (remaining > 1e-9 && steps < maxSteps && (steps === 0 || performance.now() - t0 < budgetMs)) {
        const gasDt = this.gas ? X.get_gas_dt() : Infinity;
        const dt = Math.min(this.dtStab, gasDt, 0.15 / Math.max(1e-6, this.vmax), remaining);
        X.step_begin(dt, Math.exp(-dt / 20));
        this.phase(0);
        if (this.gas) {
          this.phase(3); // SPH density and pressure
          this.phase(4); // SPH pair forces
        }
        this.phase(1);
        this.phase(2);
        this.vmax = X.step_end();
        remaining -= dt;
        steps++;
      }
      this.n = X.get_n(); this.nb = X.get_nb(); this.time = X.get_time();
      const ne = X.take_events(), ev = this.evView;
      for (let k = 0; k < ne; k++) this.events.push({ x: ev[k * 3], y: ev[k * 3 + 1], t: ev[k * 3 + 2] });
      return { steps, lagging: remaining > 1e-9 };
    }

    stats() { return Sim.prototype.stats.call(this); }

    dispose() {
      Atomics.store(this.ctrl, QUIT, 1);
      Atomics.add(this.ctrl, GEN, 1);
      Atomics.notify(this.ctrl, GEN);
      for (const w of this.workers) w.terminate();
    }
  }

  G.WasmSim = WasmSim;
})(window);
