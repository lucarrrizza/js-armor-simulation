'use strict';
// GPU engine: the same particle/bond model as sim.js, run as WebGPU compute shaders.
// All passes are written in "gather" form (each invocation only writes its own particle/bond).
// The timestep, the clock and the ping-pong grid selection live on the GPU, so a whole frame of
// substeps is encoded into one submission; one packed buffer is read back per frame for drawing.
(function (G) {
  const { Sim, PHYS } = G.ImpactSim;
  const WG = 128;
  const K = 6, ADJ = 8, NONE = 0xffffffff, EVCAP = 2048;
  const ALIVE = 256, FIRE = 512, INGRID = 1024;
  const MT = { MK: 0, MY: 16, MFR: 32, MCR: 48, MMELT: 64, MCB: 80, MEXP: 96, KC: 112, CC: 368, CONST: 624, LEN: 640 };
  const STATE_SIZE = 48;

  const HEADER = /* wgsl */`
const K: u32 = ${K}u;
const ADJ: u32 = ${ADJ}u;
const NONE: u32 = 0xffffffffu;
const ALIVE: u32 = ${ALIVE}u;
const FIRE: u32 = ${FIRE}u;
const INGRID: u32 = ${INGRID}u;
const EVCAP: u32 = ${EVCAP}u;
const MK: u32 = ${MT.MK}u; const MY: u32 = ${MT.MY}u; const MFR: u32 = ${MT.MFR}u; const MCR: u32 = ${MT.MCR}u;
const MMELT: u32 = ${MT.MMELT}u; const MCB: u32 = ${MT.MCB}u; const MEXP: u32 = ${MT.MEXP}u;
const KC: u32 = ${MT.KC}u; const CC: u32 = ${MT.CC}u; const CN: u32 = ${MT.CONST}u;
struct Params {
  n: u32, nb: u32, nexpl: u32, gw: u32, gh: u32, cells: u32, nm: u32, pad0: u32,
  gx0: f32, gy0: f32, bx0: f32, by0: f32, bx1: f32, by1: f32, dtStab: f32, pad1: f32,
};
struct State {
  dt: f32, time: f32, timeC: f32, remaining: f32,
  vacc: atomic<u32>, cur: u32, pending: u32, steps: u32,
  fire: atomic<u32>, nev: atomic<u32>, broken: atomic<u32>, pad: u32,
};
`;

  // binding declarations; each pipeline lists the ones it uses
  const DECL = {
    P: ['uniform', 'var<uniform> P: Params;'],
    st: ['storage', 'var<storage, read_write> st: State;'],
    pv: ['storage', 'var<storage, read_write> pv: array<vec4<f32>>;'],
    pa: ['storage', 'var<storage, read_write> pa: array<vec4<f32>>;'],
    pm: ['storage', 'var<storage, read_write> pm: array<vec4<u32>>;'],
    adj: ['read-only-storage', 'var<storage, read> adj: array<u32>;'],
    bonds: ['storage', 'var<storage, read_write> bonds: array<vec4<u32>>;'],
    bout: ['storage', 'var<storage, read_write> bout: array<vec4<f32>>;'],
    gcnt: ['storage', 'var<storage, read_write> gcnt: array<atomic<u32>>;'],
    gslot: ['storage', 'var<storage, read_write> gslot: array<u32>;'],
    mt: ['read-only-storage', 'var<storage, read> mt: array<f32>;'],
    expl: ['read-only-storage', 'var<storage, read> expl: array<u32>;'],
    ev: ['storage', 'var<storage, read_write> ev: array<vec4<f32>>;'],
    rb: ['storage', 'var<storage, read_write> rb: array<vec4<u32>>;'],
  };

  const KERNELS = {
    dt: [['P', 'st'], /* wgsl */`
@compute @workgroup_size(1) fn main() {
  if (st.pending == 1u) { st.cur = 1u - st.cur; st.pending = 0u; }
  let v = sqrt(bitcast<f32>(atomicLoad(&st.vacc)));
  let full = min(P.dtStab, 0.15 / max(1e-6, v));
  var dt = 0.0;
  // relative cutoff: f32 rounding of remaining must not cost an extra sliver step
  if (st.remaining > full * 1e-3) { dt = min(full, st.remaining); }
  st.dt = dt;
  if (dt > 0.0) {
    st.remaining = st.remaining - dt;
    let y = dt - st.timeC;
    let t = st.time + y;
    st.timeC = (t - st.time) - y;
    st.time = t;
    st.steps = st.steps + 1u;
    atomicStore(&st.vacc, 0u);
    atomicStore(&st.fire, 0u);
    st.pending = 1u;
  }
}`],

    init: [['P', 'pv', 'pm', 'gcnt', 'gslot'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  if ((pm[i].w & ALIVE) == 0u) { return; }
  let p = pv[i];
  let c = i32(p.x - P.gx0) + i32(p.y - P.gy0) * i32(P.gw);
  let slot = atomicAdd(&gcnt[u32(c)], 1u);
  if (slot < K) { gslot[u32(c) * K + slot] = i; }
  pm[i].z = bitcast<u32>(c);
  pm[i].w = select(pm[i].w & ~INGRID, pm[i].w | INGRID, slot < K);
}`],

    contacts: [['P', 'st', 'pv', 'pa', 'pm', 'gcnt', 'gslot', 'mt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let dt = st.dt;
  if (dt == 0.0) { return; }
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return; }
  let c = bitcast<i32>(m.z);
  // a particle that overflowed its grid cell is invisible to its neighbours, so it must not
  // push them either: one-sided contacts would act like a rocket on its fragment
  if (c < 0 || (m.w & INGRID) == 0u) { return; }
  let p = pv[i];
  let mi = (m.w & 255u) * P.nm;
  let g = i32(st.cur * P.cells);
  let r0 = mt[CN]; let r0sq = r0 * r0;
  let heatV = mt[CN + 1u]; let heatK = mt[CN + 2u] * dt; let fric = mt[CN + 6u];
  let gw = i32(P.gw);
  var f = vec2<f32>(0.0, 0.0);
  var h = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let cc = u32(g + c + dy * gw + dx);
      let cnt = min(atomicLoad(&gcnt[cc]), K);
      for (var s = 0u; s < cnt; s++) {
        let j = gslot[cc * K + s];
        if (j == i) { continue; }
        let mj = pm[j].w;
        if ((mj & ALIVE) == 0u) { continue; }
        let q = pv[j];
        let dd = q.xy - p.xy;
        let d2 = dot(dd, dd);
        if (d2 >= r0sq || d2 < 1e-10) { continue; }
        let d = sqrt(d2);
        let nrm = dd / d;
        let ov = r0 - d;
        let pk = mi + (mj & 255u);
        let cdamp = mt[CC + pk];
        let rv = q.zw - p.zw;
        let vn = dot(rv, nrm);
        var fn_ = mt[KC + pk] * ov * (1.0 + 8.0 * ov * ov);
        if (vn < 0.0) {
          fn_ -= cdamp * vn;
          let hs = -vn - heatV;
          if (hs > 0.0) { h += hs * heatK; }
        }
        let tvv = rv - vn * nrm;
        let tv = length(tvv);
        var t = vec2<f32>(0.0, 0.0);
        if (tv > 1e-6) { t = min(cdamp * tv, fric * abs(fn_)) * tvv / tv; }
        f -= fn_ * nrm - t;
      }
    }
  }
  let a = pa[i];
  pa[i] = vec4<f32>(f, a.z + h, a.w);
}`],

    bonds: [['P', 'st', 'pv', 'pa', 'pm', 'bonds', 'bout', 'mt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.x;
  if (b >= P.nb) { return; }
  if (st.dt == 0.0) { return; }
  let bd = bonds[b];
  let o = bitcast<f32>(bd.w);
  if (o < 0.0) {
    if (bout[b].w >= 0.0) { bout[b] = vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    return;
  }
  let i = bd.x; let j = bd.y;
  let fi = pm[i].w; let fj = pm[j].w;
  if ((fi & fj & ALIVE) == 0u) {
    bonds[b].w = bitcast<u32>(-1.0);
    bout[b] = vec4<f32>(0.0, 0.0, 0.0, -1.0);
    atomicAdd(&st.broken, 1u);
    return;
  }
  let m = fi & 255u;
  let p = pv[i]; let q = pv[j];
  let dd = q.xy - p.xy;
  let len = max(length(dd), 1e-6);
  let tot = (len - o) / o;
  let mfr = mt[MFR + m];
  let melt = mt[MMELT + m];
  if (tot > mfr || -tot > mt[MCR + m] || pa[i].z > melt || pa[j].z > melt) {
    bonds[b].w = bitcast<u32>(-1.0);
    bout[b] = vec4<f32>(0.0, 0.0, mt[CN + 5u], 0.0);
    atomicAdd(&st.broken, 1u);
    return;
  }
  let ph = mt[CN + 3u]; let minRest = mt[CN + 4u] * o;
  var r = bitcast<f32>(bd.z);
  let Y = mt[MY + m] * o;
  var h = 0.0;
  if (len - r > Y) {
    let nr = len - Y; h = (nr - r) * ph; r = nr;
  } else if (r - len > Y && r > minRest) {
    let nr = max(len + Y, minRest); h = (r - nr) * ph; r = nr;
  }
  bonds[b].z = bitcast<u32>(r);
  let nrm = dd / len;
  let vn = dot(q.zw - p.zw, nrm);
  let f = mt[MK + m] * (len - r) + mt[MCB + m] * vn;
  bout[b] = vec4<f32>(f * nrm, h, abs(tot) / mfr);
}`],

    integrate: [['P', 'st', 'pv', 'pa', 'pm', 'adj', 'bout', 'gcnt', 'gslot'], /* wgsl */`
var<workgroup> wmax: atomic<u32>;
fn one(i: u32, dt: f32) -> f32 {
  let m = pm[i];
  let gc = st.cur * P.cells;
  let gn = (1u - st.cur) * P.cells;
  let old = bitcast<i32>(m.z);
  if (old >= 0) { atomicStore(&gcnt[gc + u32(old)], 0u); }
  if ((m.w & ALIVE) == 0u) { pm[i].z = NONE; return 0.0; }
  let a = pa[i];
  var f = a.xy;
  var hb = 0.0;
  var smax = 0.0;
  for (var k = 0u; k < ADJ; k++) {
    let e = adj[i * ADJ + k];
    if (e == NONE) { break; }
    let o = bout[e >> 1u];
    if (o.w < 0.0) { continue; }
    if ((e & 1u) == 0u) { f += o.xy; } else { f -= o.xy; }
    hb += o.z;
    smax = max(smax, o.w);
  }
  pa[i] = vec4<f32>(0.0, 0.0, min(2.0, (a.z + hb) * exp(-dt / 20.0)), smax);
  let im = bitcast<f32>(m.x);
  var p = pv[i];
  var v2 = 0.0;
  if (im == 0.0) {
    p = vec4<f32>(p.xy, 0.0, 0.0);
  } else {
    let v = p.zw + f * (im * dt);
    let x = p.xy + v * dt;
    p = vec4<f32>(x, v);
    v2 = dot(v, v);
    if (!(x.x >= P.bx0 && x.x <= P.bx1 && x.y >= P.by0 && x.y <= P.by1 && v2 < 1e12)) {
      pv[i] = p;
      pm[i].w = m.w & ~ALIVE;
      pm[i].z = NONE;
      return 0.0;
    }
  }
  pv[i] = p;
  let c = i32(p.x - P.gx0) + i32(p.y - P.gy0) * i32(P.gw);
  let cc = gn + u32(c);
  let slot = atomicAdd(&gcnt[cc], 1u);
  if (slot < K) { gslot[cc * K + slot] = i; }
  pm[i].z = bitcast<u32>(c);
  pm[i].w = select(m.w & ~INGRID, m.w | INGRID, slot < K);
  return v2;
}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wmax, 0u); }
  workgroupBarrier();
  let dt = st.dt;
  var v2 = 0.0;
  if (gid.x < P.n && dt > 0.0) { v2 = one(gid.x, dt); }
  atomicMax(&wmax, bitcast<u32>(v2));
  workgroupBarrier();
  if (li == 0u) { atomicMax(&st.vacc, atomicLoad(&wmax)); }
}`],

    det1: [['P', 'st', 'pa', 'pm', 'expl', 'mt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= P.nexpl || st.dt == 0.0) { return; }
  let i = expl[k];
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return; }
  let now = st.time;
  var dett = bitcast<f32>(m.y);
  if (pa[i].z > mt[CN + 7u] && dett > now) { dett = now; pm[i].y = bitcast<u32>(dett); }
  if (dett <= now) { pm[i].w = m.w | FIRE; atomicAdd(&st.fire, 1u); }
}`],

    det2: [['P', 'st', 'pv', 'pa', 'pm', 'gcnt', 'gslot', 'mt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= P.n || st.dt == 0.0) { return; }
  if (atomicLoad(&st.fire) == 0u) { return; }
  let mj = pm[j];
  if ((mj.w & ALIVE) == 0u) { return; }
  let pj = pv[j];
  let now = st.time;
  let g = (1u - st.cur) * P.cells;
  let ci = i32(pj.x - P.gx0); let cj = i32(pj.y - P.gy0);
  let detSpeed = mt[CN + 8u]; let R = mt[CN + 9u]; let J = mt[CN + 10u];
  let isExp = mt[MEXP + (mj.w & 255u)] != 0.0;
  var dett = bitcast<f32>(mj.y);
  var dv = vec2<f32>(0.0, 0.0);
  var dh = 0.0;
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let X = ci + dx; let Y = cj + dy;
      if (X < 0 || Y < 0 || X >= i32(P.gw) || Y >= i32(P.gh)) { continue; }
      let cc = g + u32(X + Y * i32(P.gw));
      let cnt = min(atomicLoad(&gcnt[cc]), K);
      for (var s = 0u; s < cnt; s++) {
        let i = gslot[cc * K + s];
        if (i == j) { continue; }
        if ((pm[i].w & (ALIVE | FIRE)) != (ALIVE | FIRE)) { continue; }
        let dd = pj.xy - pv[i].xy;
        let d = length(dd);
        if (d > R || d < 1e-6) { continue; }
        if (isExp) {
          dett = min(dett, now + d / detSpeed);
        } else {
          let w = 1.0 - d / R;
          dv += J * w * dd / d;
          dh += 0.15 * w;
        }
      }
    }
  }
  if (isExp) {
    pm[j].y = bitcast<u32>(dett);
  } else if (dh > 0.0) {
    pv[j] = vec4<f32>(pj.xy, pj.zw + dv * bitcast<f32>(mj.x));
    pa[j].z = pa[j].z + dh;
  }
}`],

    det3: [['P', 'st', 'pv', 'pm', 'expl', 'ev'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= P.nexpl || st.dt == 0.0) { return; }
  let i = expl[k];
  let w = pm[i].w;
  if ((w & FIRE) == 0u) { return; }
  pm[i].w = w & ~(FIRE | ALIVE);
  if ((i & 3u) == 0u) {
    let e = atomicAdd(&st.nev, 1u);
    if (e < EVCAP) { ev[e] = vec4<f32>(pv[i].xy, st.time, 0.0); }
  }
}`],

    pack: [['P', 'pv', 'pa', 'pm', 'rb'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let p = pv[i];
  let a = pa[i];
  var h = a.z;
  if ((pm[i].w & ALIVE) == 0u) { h = -1.0; }
  rb[i] = vec4<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), pack2x16float(p.zw), pack2x16float(vec2<f32>(h, a.w)));
}`],
  };

  // half-float -> float lookup for unpacking the readback buffer
  let F16 = null;
  function f16Table() {
    if (F16) return F16;
    F16 = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
      F16[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
    }
    return F16;
  }

  class GpuSim {
    static available() { return !!(G.navigator && navigator.gpu); }

    static async create() {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('no WebGPU adapter available');
      const L = adapter.limits;
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
          maxBufferSize: L.maxBufferSize,
          maxStorageBuffersPerShaderStage: Math.min(L.maxStorageBuffersPerShaderStage, 10),
        },
      });
      const info = adapter.info || {};
      return new GpuSim(device, [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU');
    }

    constructor(device, label) {
      this.device = device;
      this.engineName = `GPU (WebGPU, ${label})`;
      this.events = [];
      this.n = 0; this.nb = 0; this.time = 0; this.gen = 0;
      this.lost = false;
      device.lost.then((e) => { this.lost = true; console.error('WebGPU device lost:', e.message); });
      device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', e.error.message));
      this.pipes = {};
      for (const [name, [binds, body]] of Object.entries(KERNELS)) {
        const code = HEADER + binds.map((b, k) => `@group(0) @binding(${k}) ${DECL[b][1]}`).join('\n') + '\n' + body;
        const layout = device.createBindGroupLayout({
          entries: binds.map((b, k) => ({ binding: k, visibility: GPUShaderStage.COMPUTE, buffer: { type: DECL[b][0] } })),
        });
        const pipeline = device.createComputePipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module: device.createShaderModule({ code, label: name }), entryPoint: 'main' },
        });
        this.pipes[name] = { pipeline, layout, binds };
      }
    }

    build(scn) {
      const b = new Sim();
      b.build(scn);
      for (const k of ['res', 'usPerT', 'cos', 'sin', 'layers', 'armorDepth', 'armorFront', 'stackLos', 'losThickness',
        'entryX', 'fit', 'bx0', 'bx1', 'by0', 'by1', 'gw', 'gh', 'projMass0', 'dtStab', 'vmax']) this[k] = b[k];
      const n = b.n, nb = b.nb, nexpl = b.expl.length;
      const cells = b.gw * b.gh;
      const dev = this.device;
      this.gen++;
      if (this.bufs) for (const buf of Object.values(this.bufs)) buf.destroy();

      const pv = new Float32Array(n * 4), pa = new Float32Array(n * 4);
      const pmU = new Uint32Array(n * 4), pmF = new Float32Array(pmU.buffer);
      for (let i = 0; i < n; i++) {
        pv[i * 4] = b.px[i]; pv[i * 4 + 1] = b.py[i]; pv[i * 4 + 2] = b.vx[i]; pv[i * 4 + 3] = b.vy[i];
        pa[i * 4 + 2] = b.heat[i];
        pmF[i * 4] = b.invm[i];
        pmF[i * 4 + 1] = b.detT[i] === Infinity ? 1e30 : b.detT[i];
        pmU[i * 4 + 2] = NONE;
        pmU[i * 4 + 3] = b.mat[i] | (b.alive[i] ? ALIVE : 0);
      }
      const bondsU = new Uint32Array(nb * 4), bondsF = new Float32Array(bondsU.buffer);
      const adj = new Uint32Array(n * ADJ).fill(NONE);
      const put = (i, e) => { for (let k = 0; k < ADJ; k++) if (adj[i * ADJ + k] === NONE) { adj[i * ADJ + k] = e; return; } };
      for (let k = 0; k < nb; k++) {
        bondsU[k * 4] = b.ba[k]; bondsU[k * 4 + 1] = b.bb[k];
        bondsF[k * 4 + 2] = b.brest[k]; bondsF[k * 4 + 3] = b.borig[k];
        put(b.ba[k], k * 2); put(b.bb[k], k * 2 + 1);
      }
      const mt = new Float32Array(MT.LEN);
      const P = PHYS;
      [P.MK, P.MY, P.MFR, P.MCR, P.MMELT, P.MCB].forEach((arr, k) => mt.set(arr, k * 16));
      for (let m = 0; m < P.NM; m++) mt[MT.MEXP + m] = P.MEXP[m];
      mt.set(P.KC, MT.KC); mt.set(P.CC, MT.CC);
      mt.set([P.R0, P.HEAT_V, P.HEAT_K, P.PLASTIC_HEAT, P.MIN_REST, P.BREAK_HEAT, P.FRICTION,
        P.DET_HEAT, P.DET_SPEED, P.BLAST_R, P.BLAST_J], MT.CONST);
      const params = new ArrayBuffer(64), pu = new Uint32Array(params), pf = new Float32Array(params);
      pu.set([n, nb, nexpl, b.gw, b.gh, cells, P.NM, 0]);
      pf.set([b.bx0 - 1, b.by0 - 1, b.bx0, b.by0, b.bx1, b.by1, b.dtStab, 0], 8);
      const state = new ArrayBuffer(STATE_SIZE), su = new Uint32Array(state);
      su[4] = new Uint32Array(new Float32Array([b.vmax * b.vmax]).buffer)[0];

      const S = GPUBufferUsage;
      const mk = (data, usage, size) => {
        const buf = dev.createBuffer({ size: Math.max(16, Math.ceil((size ?? data.byteLength) / 4) * 4), usage: usage | S.COPY_DST | S.COPY_SRC });
        if (data) dev.queue.writeBuffer(buf, 0, data);
        return buf;
      };
      const ST = S.STORAGE;
      this.bufs = {
        P: mk(params, S.UNIFORM),
        st: mk(state, ST | S.COPY_SRC),
        pv: mk(pv, ST), pa: mk(pa, ST), pm: mk(pmU, ST),
        adj: mk(adj, ST),
        bonds: mk(nb ? bondsU : null, ST, nb * 16),
        bout: mk(null, ST, nb * 16),
        gcnt: mk(null, ST, 2 * cells * 4),
        gslot: mk(null, ST, 2 * cells * K * 4),
        mt: mk(mt, ST),
        expl: mk(nexpl ? Uint32Array.from(b.expl) : null, ST, nexpl * 4),
        ev: mk(null, ST | S.COPY_SRC, EVCAP * 16),
        rb: mk(null, ST | S.COPY_SRC, n * 16),
      };
      this.evOff = STATE_SIZE;
      this.rbOff = STATE_SIZE + EVCAP * 16;
      this.bufs.staging = dev.createBuffer({ size: this.rbOff + n * 16, usage: S.MAP_READ | S.COPY_DST });
      this.groups = {};
      for (const [name, p] of Object.entries(this.pipes)) {
        this.groups[name] = dev.createBindGroup({
          layout: p.layout,
          entries: p.binds.map((k, i) => ({ binding: i, resource: { buffer: this.bufs[k] } })),
        });
      }
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      this.dispatch(pass, 'init', n);
      pass.end();
      dev.queue.submit([enc.finish()]);

      this.n = n; this.nb0 = nb; this.nb = nb; this.nexpl = nexpl;
      this.mat = b.mat.slice(0, n); this.grp = b.grp.slice(0, n);
      this.px = Float32Array.from(b.px.subarray(0, n)); this.py = Float32Array.from(b.py.subarray(0, n));
      this.vx = Float32Array.from(b.vx.subarray(0, n)); this.vy = Float32Array.from(b.vy.subarray(0, n));
      this.heat = Float32Array.from(b.heat.subarray(0, n)); this.stress = new Float32Array(n);
      this.alive = b.alive.slice(0, n);
      this.time = 0; this.steps = 0; this.events = [];
    }

    dispatch(pass, name, count) {
      if (count <= 0) return;
      pass.setPipeline(this.pipes[name].pipeline);
      pass.setBindGroup(0, this.groups[name]);
      pass.dispatchWorkgroups(Math.ceil(count / WG));
    }

    async advance(us, maxSteps) {
      if (this.lost || this.busy) return { steps: 0, lagging: false };
      this.busy = true;
      try { return await this.advanceInner(us, maxSteps); } finally { this.busy = false; }
    }

    async advanceInner(us, maxSteps) {
      const dev = this.device, gen = this.gen, bufs = this.bufs;
      const remaining = us / this.usPerT;
      const dtEst = Math.min(this.dtStab, 0.15 / Math.max(1e-6, this.vmax));
      const nSteps = Math.max(1, Math.min(maxSteps, Math.ceil(remaining / dtEst * 1.02) + 1));
      dev.queue.writeBuffer(bufs.st, 12, new Float32Array([remaining]));
      dev.queue.writeBuffer(bufs.st, 36, new Uint32Array([0]));
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      const { n, nexpl } = this, nb = this.nb0; // bonds are never compacted on the GPU
      for (let s = 0; s < nSteps; s++) {
        pass.setPipeline(this.pipes.dt.pipeline);
        pass.setBindGroup(0, this.groups.dt);
        pass.dispatchWorkgroups(1);
        this.dispatch(pass, 'contacts', n);
        this.dispatch(pass, 'bonds', nb);
        this.dispatch(pass, 'integrate', n);
        if (nexpl) {
          this.dispatch(pass, 'det1', nexpl);
          this.dispatch(pass, 'det2', n);
          this.dispatch(pass, 'det3', nexpl);
        }
      }
      this.dispatch(pass, 'pack', n);
      pass.end();
      const stg = bufs.staging;
      enc.copyBufferToBuffer(bufs.st, 0, stg, 0, STATE_SIZE);
      enc.copyBufferToBuffer(bufs.ev, 0, stg, this.evOff, EVCAP * 16);
      enc.copyBufferToBuffer(bufs.rb, 0, stg, this.rbOff, n * 16);
      dev.queue.submit([enc.finish()]);
      try {
        await stg.mapAsync(GPUMapMode.READ);
      } catch (e) {
        return { steps: 0, lagging: false };
      }
      if (gen !== this.gen) return { steps: 0, lagging: false };
      const data = stg.getMappedRange();
      const sf = new Float32Array(data, 0, STATE_SIZE / 4), su = new Uint32Array(data, 0, STATE_SIZE / 4);
      const steps = su[7] - this.steps;
      this.steps = su[7];
      this.time = sf[1];
      this.vmax = Math.sqrt(new Float32Array(su.buffer, 16, 1)[0]);
      this.nb = this.nb0 - su[10];
      const nev = Math.min(EVCAP, su[9]);
      const ev = new Float32Array(data, this.evOff, nev * 4);
      for (let k = 0; k < nev; k++) this.events.push({ x: ev[k * 4], y: ev[k * 4 + 1], t: ev[k * 4 + 2] });
      const rbF = new Float32Array(data, this.rbOff, n * 4), rbU = new Uint32Array(data, this.rbOff, n * 4);
      const T = f16Table();
      const { px, py, vx, vy, heat, stress, alive } = this;
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        px[i] = rbF[k]; py[i] = rbF[k + 1];
        const v = rbU[k + 2], hs = rbU[k + 3];
        vx[i] = T[v & 0xffff]; vy[i] = T[v >>> 16];
        const h = T[hs & 0xffff];
        alive[i] = h >= 0 ? 1 : 0;
        heat[i] = h; stress[i] = T[hs >>> 16];
      }
      stg.unmap();
      return { steps, lagging: sf[3] > dtEst * 1e-3 };
    }

    stats() { return Sim.prototype.stats.call(this); }

    dispose() {
      if (this.bufs) for (const buf of Object.values(this.bufs)) buf.destroy();
      this.device.destroy();
    }
  }

  G.GpuSim = GpuSim;
})(window);
