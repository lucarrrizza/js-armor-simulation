'use strict';
// GPU engine: the same particle/bond model as sim.js, run as WebGPU compute shaders.
// All passes are written in "gather" form (each invocation only writes its own particle/bond).
// The timestep, the clock and the ping-pong grid selection live on the GPU, so a whole frame of
// substeps is encoded into one submission. The renderer draws straight from the particle buffers;
// only the clock, detonation events and the projectile particles (for the stats) are read back.
(function (G) {
  const { Sim, PHYS } = G.ImpactSim;
  const WG = 128;
  const K = 6, ADJ = 8, NONE = 0xffffffff, EVCAP = 2048;
  const BATCH_MS = 40;
  const ALIVE = 256, FIRE = 512, INGRID = 1024;
  // impact fuze mode in pm.w bits 11-12 (1 waiting to arm, 3 armed); thresholds must match sim.js
  const FZ_SH = 11, FZ_MASK = 3 << FZ_SH, ARM_SPEED = 2, IMPACT_DROP = 0.5;
  // packed parameter table, layout defined in PHYS.MTL (sim.js); see PHYS.packMT
  const MT = PHYS.MTL;
  const STATE_SIZE = 48;

  const HEADER = /* wgsl */`
const K: u32 = ${K}u;
const ADJ: u32 = ${ADJ}u;
const NONE: u32 = 0xffffffffu;
const ALIVE: u32 = ${ALIVE}u;
const FIRE: u32 = ${FIRE}u;
const INGRID: u32 = ${INGRID}u;
const FZ_SH: u32 = ${FZ_SH}u;
const FZ_MASK: u32 = ${FZ_MASK}u;
const ARM_SPEED: f32 = ${ARM_SPEED}.0;
const IMPACT_DROP: f32 = ${IMPACT_DROP};
const EVCAP: u32 = ${EVCAP}u;
const MK: u32 = ${MT.MK}u; const MY: u32 = ${MT.MY}u; const MFR: u32 = ${MT.MFR}u; const MCR: u32 = ${MT.MCR}u;
const MMELT: u32 = ${MT.MMELT}u; const MCB: u32 = ${MT.MCB}u; const MEXP: u32 = ${MT.MEXP}u;
const KC: u32 = ${MT.KC}u; const CC: u32 = ${MT.CC}u; const CN: u32 = ${MT.CONST}u;
const MGAS: u32 = ${MT.MGAS}u; const MDEN: u32 = ${MT.MDEN}u; const MMASS: u32 = ${MT.MMASS}u;
const MUCRIT: u32 = ${MT.MUCRIT}u; const MDSP: u32 = ${MT.MDSP}u; const MPROD: u32 = ${MT.PROD}u;
const GRHO0: u32 = ${MT.GRHO0}u; const GP0: u32 = ${MT.GP0}u; const GRHOC: u32 = ${MT.GRHOC}u; const GPC: u32 = ${MT.GPC}u;
struct Params {
  n: u32, nb: u32, nexpl: u32, gw: u32, gh: u32, cells: u32, nm: u32, lo: u32,
  gx0: f32, gy0: f32, bx0: f32, by0: f32, bx1: f32, by1: f32, dtStab: f32, gas: u32,
};
struct State {
  dt: f32, time: f32, timeC: f32, remaining: f32,
  vacc: atomic<u32>, cur: u32, pending: u32, steps: u32,
  fire: atomic<u32>, nev: atomic<u32>, broken: atomic<u32>, c2: atomic<u32>,
};
// cubic spline kernel (support 2), same as kw()/dkw() in sim.js
fn kw(q: f32) -> f32 {
  if (q < 1.0) { return 1.0 - 1.5 * q * q + 0.75 * q * q * q; }
  if (q < 2.0) { let t = 2.0 - q; return 0.25 * t * t * t; }
  return 0.0;
}
fn dkw(q: f32) -> f32 {
  if (q < 1.0) { return -3.0 * q + 2.25 * q * q; }
  if (q < 2.0) { let t = 2.0 - q; return -0.75 * t * t; }
  return 0.0;
}
// gas equation of state, same as pressure() in sim.js
fn gpress(rho: f32, rhoc: f32, rho0: f32, p0: f32, pc: f32, ghi: f32, glo: f32) -> f32 {
  if (rho >= rhoc) { return p0 * pow(rho / rho0, ghi); }
  return pc * pow(rho / rhoc, glo);
}
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
    pg: ['storage', 'var<storage, read_write> pg: array<vec2<f32>>;'], // gas: (SPH density, pressure)
    uav: ['storage', 'var<storage, read_write> uav: array<f32>;'], // smoothed speed of each explosive, the shock driver
    prs: ['storage', 'var<storage, read_write> prs: array<f32>;'], // solid pressure: signed virial sum per particle
    bv: ['storage', 'var<storage, read_write> bv: array<f32>;'], // per-bond virial f*len, subtracted from both ends
    rp: ['storage', 'var<storage, read_write> rp: array<f32>;'], // per-particle pressure, for readback and the renderer
    fz: ['read-only-storage', 'var<storage, read> fz: array<f32>;'], // impact fuze delay per explosive (time units)
  };

  const KERNELS = {
    dt: [['P', 'st', 'mt'], /* wgsl */`
@compute @workgroup_size(1) fn main() {
  let v = sqrt(bitcast<f32>(atomicLoad(&st.vacc)));
  var full = min(P.dtStab, 0.15 / max(1e-6, v));
  // CFL limit of the detonation products, from the sound speed the previous step's pressure pass found
  if (P.gas != 0u) {
    let c2 = bitcast<f32>(atomicLoad(&st.c2));
    if (c2 > 0.0) { full = min(full, 0.4 * mt[CN + 11u] / sqrt(c2)); }
  }
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
    atomicStore(&st.c2, 0u);
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

    contacts: [['P', 'st', 'pv', 'pa', 'pm', 'gcnt', 'gslot', 'mt', 'prs'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let dt = st.dt;
  if (dt == 0.0) { return; }
  prs[i] = 0.0;
  var pvir = 0.0;
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return; }
  // detonation products take no contact forces (gas model)
  if (mt[MGAS + (m.w & 255u)] != 0.0) { return; }
  let c = bitcast<i32>(m.z);
  // a particle that overflowed its grid cell is invisible to its neighbours, so it must not
  // push them either: one-sided contacts would act like a rocket on its fragment
  if (c < 0 || (m.w & INGRID) == 0u) { return; }
  let p = pv[i];
  let mi = (m.w & 255u) * P.nm;
  let r0 = mt[CN]; let r0sq = r0 * r0;
  let heatV = mt[CN + 1u]; let heatK = mt[CN + 2u] * dt; let fric = mt[CN + 6u];
  let gw = i32(P.gw);
  var f = vec2<f32>(0.0, 0.0);
  var h = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let cc = u32(c + dy * gw + dx);
      let cnt = min(atomicLoad(&gcnt[cc]), K);
      for (var s = 0u; s < cnt; s++) {
        let j = gslot[cc * K + s];
        if (j == i) { continue; }
        let mj = pm[j].w;
        if ((mj & ALIVE) == 0u || mt[MGAS + (mj & 255u)] != 0.0) { continue; }
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
        pvir += fn_ * d;
      }
    }
  }
  prs[i] = pvir;
  let a = pa[i];
  pa[i] = vec4<f32>(f, a.z + h, a.w);
}`],

    bonds: [['P', 'st', 'pv', 'pa', 'pm', 'bonds', 'bout', 'mt', 'bv'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.x;
  if (b >= P.nb) { return; }
  if (st.dt == 0.0) { return; }
  bv[b] = 0.0;
  let bd = bonds[b];
  let o = bitcast<f32>(bd.w);
  if (o < 0.0) {
    if (bout[b].w >= 0.0) { bout[b] = vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    return;
  }
  let i = bd.x; let j = bd.y;
  let fi = pm[i].w; let fj = pm[j].w;
  // bonds touching detonation products are removed (gas model)
  if ((fi & fj & ALIVE) == 0u || mt[MGAS + (fi & 255u)] != 0.0 || mt[MGAS + (fj & 255u)] != 0.0) {
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
  bv[b] = f * len;
}`],

    integrate: [['P', 'st', 'pv', 'pa', 'pm', 'adj', 'bout', 'bv', 'prs'], /* wgsl */`
var<workgroup> wmax: atomic<u32>;
fn one(i: u32, dt: f32) -> f32 {
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return 0.0; }
  let a = pa[i];
  var f = a.xy;
  var hb = 0.0;
  var smax = 0.0;
  var pvir = prs[i];
  for (var k = 0u; k < ADJ; k++) {
    let e = adj[i * ADJ + k];
    if (e == NONE) { break; }
    let o = bout[e >> 1u];
    if (o.w < 0.0) { continue; }
    if ((e & 1u) == 0u) { f += o.xy; } else { f -= o.xy; }
    hb += o.z;
    smax = max(smax, o.w);
    pvir -= bv[e >> 1u];
  }
  prs[i] = pvir;
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
      return 0.0;
    }
  }
  pv[i] = p;
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

    // gas model, same maths as the JS reference (Sim in sim.js). Each pass only writes its
    // own particle, so the three passes are separate dispatches: density, then pressure (which also
    // removes smoke), then the pair forces in gather form.
    gasDensity: [['P', 'st', 'pv', 'pm', 'gcnt', 'gslot', 'mt', 'pg'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n || P.gas == 0u || st.dt == 0.0) { return; }
  let m = pm[i];
  if ((m.w & ALIVE) == 0u || mt[MGAS + (m.w & 255u)] == 0.0) { return; }
  let p = pv[i];
  let h = mt[CN + 11u];
  let h2 = 4.0 * h * h;
  let ci = i32(p.x - P.gx0); let cj = i32(p.y - P.gy0);
  // the particle's own kernel value kw(0) = 1, weighted by its own mass
  var sum = mt[MMASS + (m.w & 255u)];
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let X = ci + dx; let Y = cj + dy;
      if (X < 0 || Y < 0 || X >= i32(P.gw) || Y >= i32(P.gh)) { continue; }
      let cc = u32(X + Y * i32(P.gw));
      let cnt = min(atomicLoad(&gcnt[cc]), K);
      for (var s = 0u; s < cnt; s++) {
        let j = gslot[cc * K + s];
        let mjm = pm[j].w & 255u;
        if (j == i || mt[MDEN + mjm] == 0.0) { continue; }
        let dd = pv[j].xy - p.xy;
        let d2 = dot(dd, dd);
        if (d2 < h2) { sum += mt[MMASS + mjm] * kw(sqrt(d2) / h); }
      }
    }
  }
  pg[i] = vec2<f32>(sum * mt[CN + 12u], 0.0);
}`],

    gasPressure: [['P', 'st', 'pm', 'mt', 'pg'], /* wgsl */`
var<workgroup> wc2: atomic<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wc2, 0u); }
  workgroupBarrier();
  let i = gid.x;
  var c2 = 0.0;
  if (i < P.n && P.gas != 0u && st.dt > 0.0) {
    let m = pm[i];
    let mi = m.w & 255u;
    if ((m.w & ALIVE) != 0u && mt[MGAS + mi] != 0.0) {
      let rho = pg[i].x;
      let rhoc = mt[GRHOC + mi];
      let p = gpress(rho, rhoc, mt[GRHO0 + mi], mt[GP0 + mi], mt[GPC + mi], mt[CN + 13u], mt[CN + 14u]);
      pg[i] = vec2<f32>(rho, p);
      c2 = select(mt[CN + 14u], mt[CN + 13u], rho >= rhoc) * p / rho;
      if (rho < mt[CN + 15u] * mt[GRHO0 + mi]) { pm[i].w = m.w & ~ALIVE; }
    }
  }
  atomicMax(&wc2, bitcast<u32>(c2));
  workgroupBarrier();
  if (li == 0u) { atomicMax(&st.c2, atomicLoad(&wc2)); }
}`],

    gasForce: [['P', 'st', 'pv', 'pa', 'pm', 'gcnt', 'gslot', 'mt', 'pg'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n || P.gas == 0u || st.dt == 0.0) { return; }
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return; }
  let mi = m.w & 255u;
  let h = mt[CN + 11u];
  let h2 = 4.0 * h * h;
  let sphkw = mt[CN + 12u];
  let self_gas = mt[MGAS + mi] != 0.0;
  let m_self = mt[MMASS + mi];
  let p = pv[i];
  var s_self = 0.0;
  if (self_gas) { let gi = pg[i]; s_self = gi.y / (gi.x * gi.x); }
  let ci = i32(p.x - P.gx0); let cj = i32(p.y - P.gy0);
  var f = vec2<f32>(0.0, 0.0);
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let X = ci + dx; let Y = cj + dy;
      if (X < 0 || Y < 0 || X >= i32(P.gw) || Y >= i32(P.gh)) { continue; }
      let cc = u32(X + Y * i32(P.gw));
      let cnt = min(atomicLoad(&gcnt[cc]), K);
      for (var s = 0u; s < cnt; s++) {
        let j = gslot[cc * K + s];
        if (j == i) { continue; }
        let mj = pm[j].w;
        if ((mj & ALIVE) == 0u) { continue; }
        let mjm = mj & 255u;
        let j_gas = mt[MGAS + mjm] != 0.0;
        // a non-product only receives forces from products
        if (!self_gas && !j_gas) { continue; }
        let ex = pv[j].xy - p.xy;
        let d2 = dot(ex, ex);
        if (d2 >= h2 || d2 < 1e-12) { continue; }
        let d = sqrt(d2);
        let dwdr = sphkw * dkw(d / h) / h; // <= 0
        var sj = 0.0;
        if (j_gas) { let gj = pg[j]; sj = gj.y / (gj.x * gj.x); }
        // pair term m_i m_j (S_i + S_j) dW/dr, with S_j only for products; same as the scatter in sim.js
        f += m_self * mt[MMASS + mjm] * (s_self + sj) * dwdr / d * ex;
      }
    }
  }
  let a = pa[i];
  pa[i] = vec4<f32>(a.xy + f, a.zw);
}`],

    // single cell grid, rebuilt every step: clear the cells particles were in, then re-insert
    gclear: [['P', 'st', 'pm', 'gcnt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n || st.dt == 0.0) { return; }
  let old = bitcast<i32>(pm[i].z);
  if (old >= 0) { atomicStore(&gcnt[u32(old)], 0u); }
}`],

    ginsert: [['P', 'st', 'pv', 'pm', 'gcnt', 'gslot'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n || st.dt == 0.0) { return; }
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { pm[i].z = NONE; return; }
  let p = pv[i];
  let c = i32(p.x - P.gx0) + i32(p.y - P.gy0) * i32(P.gw);
  let slot = atomicAdd(&gcnt[u32(c)], 1u);
  if (slot < K) { gslot[u32(c) * K + slot] = i; }
  pm[i].z = bitcast<u32>(c);
  pm[i].w = select(m.w & ~INGRID, m.w | INGRID, slot < K);
}`],

    det1: [['P', 'st', 'pv', 'pa', 'pm', 'expl', 'mt', 'uav', 'fz'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= P.nexpl || st.dt == 0.0) { return; }
  let i = expl[k];
  let m = pm[i];
  if ((m.w & ALIVE) == 0u) { return; }
  let t = m.w & 255u;
  // detonation products (no longer explosive) must not fire again
  if (mt[MEXP + t] == 0.0) { return; }
  let now = st.time;
  var dett = bitcast<f32>(m.y);
  var w = m.w;
  if (P.gas != 0u) {
    // gas model: the shock strength is the smoothed speed of the explosive, see detonationsGas in sim.js
    let sp = length(pv[i].zw);
    let a = min(1.0, st.dt / mt[CN + 18u]);
    let u = uav[i] + (sp - uav[i]) * a;
    uav[i] = u;
    // impact fuze: arms once moving fast, then fires when the speed drops sharply (target impact)
    if (((w >> FZ_SH) & 3u) == 1u && u > ARM_SPEED) { w = (w & ~FZ_MASK) | (3u << FZ_SH); }
    if (((w >> FZ_SH) & 3u) == 3u && sp < IMPACT_DROP * u) {
      dett = min(dett, now + fz[i]);
      w = w & ~FZ_MASK;
      pm[i].y = bitcast<u32>(dett);
    }
    if (dett > now && (u > mt[MUCRIT + t] || pa[i].z > mt[CN + 17u])) { dett = now; pm[i].y = bitcast<u32>(dett); }
  } else if (pa[i].z > mt[CN + 7u] && dett > now) {
    dett = now; pm[i].y = bitcast<u32>(dett);
  }
  if (dett <= now) { w = w | FIRE; atomicAdd(&st.fire, 1u); }
  pm[i].w = w;
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
  let ci = i32(pj.x - P.gx0); let cj = i32(pj.y - P.gy0);
  let mjm = mj.w & 255u;
  let J = mt[CN + 10u];
  // gas model: the front spreads to touching explosive at each material's own speed, with no blast kick on the rest
  let gas = P.gas != 0u;
  let R = select(mt[CN + 9u], mt[CN + 16u], gas);
  let detSpeed = select(mt[CN + 8u], mt[MDSP + mjm], gas);
  let isExp = mt[MEXP + mjm] != 0.0;
  if (gas && !isExp) { return; }
  var dett = bitcast<f32>(mj.y);
  var dv = vec2<f32>(0.0, 0.0);
  var dh = 0.0;
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let X = ci + dx; let Y = cj + dy;
      if (X < 0 || Y < 0 || X >= i32(P.gw) || Y >= i32(P.gh)) { continue; }
      let cc = u32(X + Y * i32(P.gw));
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

    det3: [['P', 'st', 'pv', 'pm', 'expl', 'ev', 'mt'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= P.nexpl || st.dt == 0.0) { return; }
  let i = expl[k];
  let w = pm[i].w;
  if ((w & FIRE) == 0u) { return; }
  if (P.gas != 0u) {
    // the explosive becomes detonation products, which stay in the simulation as gas
    let prod = u32(mt[MPROD + (w & 255u)]);
    pm[i].w = (w & ~(FIRE | 255u)) | prod;
    pm[i].x = bitcast<u32>(1.0 / mt[MMASS + prod]);
  } else {
    pm[i].w = w & ~(FIRE | ALIVE);
  }
  if ((i & 3u) == 0u) {
    let e = atomicAdd(&st.nev, 1u);
    if (e < EVCAP) { ev[e] = vec4<f32>(pv[i].xy, st.time, 0.0); }
  }
}`],

    pack: [['P', 'pv', 'pa', 'pm', 'rb', 'mt', 'prs', 'pg', 'rp'], /* wgsl */`
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x + P.lo;
  if (i >= P.n) { return; }
  let p = pv[i];
  let a = pa[i];
  var h = a.z;
  if ((pm[i].w & ALIVE) == 0u) { h = -1.0; }
  rb[i - P.lo] = vec4<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), pack2x16float(p.zw), pack2x16float(vec2<f32>(h, a.w)));
  // gas: EOS pressure from gasPressure; solids: virial sum
  rp[i] = select(prs[i], pg[i].y, mt[MGAS + (pm[i].w & 255u)] != 0.0);
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

  // one device shared by the simulation and the renderer, so particles never leave the GPU
  let devicePromise = null;
  function getGpuDevice() {
    if (devicePromise) return devicePromise;
    devicePromise = (async () => {
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
      device.lost.then((e) => { devicePromise = null; console.error('WebGPU device lost:', e.message); });
      device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', e.error.message));
      return { device, label: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU' };
    })();
    devicePromise.catch(() => { devicePromise = null; });
    return devicePromise;
  }

  class GpuSim {
    static available() { return !!(G.navigator && navigator.gpu); }

    static async create() {
      const { device, label } = await getGpuDevice();
      return new GpuSim(device, label);
    }

    constructor(device, label) {
      this.device = device;
      this.engineName = `GPU (WebGPU, ${label})`;
      this.events = [];
      this.n = 0; this.nb = 0; this.time = 0; this.gen = 0;
      this.lost = false;
      this.readAll = false; // read every particle back (only needed by the 2D fallback renderer)
      device.lost.then(() => { this.lost = true; });
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
        'entryX', 'fit', 'bx0', 'bx1', 'by0', 'by1', 'gw', 'gh', 'projMass0', 'dtStab', 'vmax', 'fillFailed']) this[k] = b[k];
      const n = b.n, nb = b.nb, nexpl = b.expl.length;
      const cells = b.gw * b.gh;
      const dev = this.device;
      this.gen++;
      if (this.bufs) for (const buf of Object.values(this.bufs)) buf.destroy();

      // projectile particles go last, so the stats only need to read back the range [lo, n)
      const perm = new Int32Array(n);
      let lo = 0;
      for (let i = 0; i < n; i++) if (b.grp[i] !== 1) perm[i] = lo++;
      for (let i = 0, k = lo; i < n; i++) if (b.grp[i] === 1) perm[i] = k++;
      this.projLo = lo;
      this.lo = this.readAll ? 0 : lo;
      const pv = new Float32Array(n * 4), pa = new Float32Array(n * 4);
      const pmU = new Uint32Array(n * 4), pmF = new Float32Array(pmU.buffer);
      const mat = new Uint8Array(n), grp = new Uint8Array(n), fzF = new Float32Array(n);
      for (let o = 0; o < n; o++) {
        const i = perm[o];
        pv[i * 4] = b.px[o]; pv[i * 4 + 1] = b.py[o]; pv[i * 4 + 2] = b.vx[o]; pv[i * 4 + 3] = b.vy[o];
        pa[i * 4 + 2] = b.heat[o];
        pmF[i * 4] = b.invm[o];
        pmF[i * 4 + 1] = b.detT[o] === Infinity ? 1e30 : b.detT[o];
        pmU[i * 4 + 2] = NONE;
        pmU[i * 4 + 3] = b.mat[o] | (b.alive[o] ? ALIVE : 0) | ((b.fzm[o] & 3) << FZ_SH);
        fzF[i] = b.fz[o];
        mat[i] = b.mat[o]; grp[i] = b.grp[o];
      }
      const bondsU = new Uint32Array(nb * 4), bondsF = new Float32Array(bondsU.buffer);
      const adj = new Uint32Array(n * ADJ).fill(NONE);
      const put = (i, e) => { for (let k = 0; k < ADJ; k++) if (adj[i * ADJ + k] === NONE) { adj[i * ADJ + k] = e; return; } };
      for (let k = 0; k < nb; k++) {
        const i = perm[b.ba[k]], j = perm[b.bb[k]];
        bondsU[k * 4] = i; bondsU[k * 4 + 1] = j;
        bondsF[k * 4 + 2] = b.brest[k]; bondsF[k * 4 + 3] = b.borig[k];
        put(i, k * 2); put(j, k * 2 + 1);
      }
      const explP = Uint32Array.from(b.expl, (i) => perm[i]);
      const mt = Float32Array.from(PHYS.packMT());
      const P = PHYS;
      this.gas = b.explosionModel === 'gas';
      const params = new ArrayBuffer(64), pu = new Uint32Array(params), pf = new Float32Array(params);
      pu.set([n, nb, nexpl, b.gw, b.gh, cells, P.NM, this.lo]);
      pf.set([b.bx0 - 1, b.by0 - 1, b.bx0, b.by0, b.bx1, b.by1, b.dtStab, 0], 8);
      pu[15] = this.gas ? 1 : 0;
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
        gcnt: mk(null, ST, cells * 4),
        gslot: mk(null, ST, cells * K * 4),
        mt: mk(mt, ST),
        expl: mk(nexpl ? explP : null, ST, nexpl * 4),
        pg: mk(null, ST, n * 8),
        uav: mk(null, ST, n * 4),
        prs: mk(null, ST, n * 4),
        bv: mk(null, ST, nb * 4),
        ev: mk(null, ST | S.COPY_SRC, EVCAP * 16),
        rb: mk(null, ST | S.COPY_SRC, (n - this.lo) * 16),
        rp: mk(null, ST | S.COPY_SRC, n * 4),
        fz: mk(fzF, ST),
      };
      this.evOff = STATE_SIZE;
      this.rbOff = STATE_SIZE + EVCAP * 16;
      this.rpOff = this.rbOff + (n - this.lo) * 16;
      this.bufs.staging = dev.createBuffer({ size: this.rpOff + (n - this.lo) * 4, usage: S.MAP_READ | S.COPY_DST });
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
      this.mat = mat; this.grp = grp;
      const pick = (src) => { const a = new Float32Array(n); for (let o = 0; o < n; o++) a[perm[o]] = src[o]; return a; };
      this.px = pick(b.px); this.py = pick(b.py); this.vx = pick(b.vx); this.vy = pick(b.vy);
      this.heat = pick(b.heat); this.stress = new Float32Array(n); this.pres = new Float32Array(n);
      this.alive = new Uint8Array(n).fill(1);
      this.time = 0; this.steps = 0; this.events = [];
      this.msPerStep = Math.max(0.05, n * 2e-5); // rough first guess; refined from measurements
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
      // Keep each submission short (~40 ms of GPU work): long batches stall the UI and can trip the
      // OS GPU watchdog (Windows resets the driver after ~2 s), which matters at fine resolutions.
      const budget = Math.max(2, Math.floor(BATCH_MS / this.msPerStep));
      const nSteps = Math.max(1, Math.min(maxSteps, budget, Math.ceil(remaining / dtEst * 1.02) + 1));
      const t0 = performance.now();
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
        if (this.gas) {
          this.dispatch(pass, 'gasDensity', n);
          this.dispatch(pass, 'gasPressure', n);
          this.dispatch(pass, 'gasForce', n);
        }
        this.dispatch(pass, 'bonds', nb);
        this.dispatch(pass, 'integrate', n);
        this.dispatch(pass, 'gclear', n);
        this.dispatch(pass, 'ginsert', n);
        if (nexpl) {
          this.dispatch(pass, 'det1', nexpl);
          this.dispatch(pass, 'det2', n);
          this.dispatch(pass, 'det3', nexpl);
        }
      }
      const lo = this.lo;
      this.dispatch(pass, 'pack', n - lo);
      pass.end();
      const stg = bufs.staging;
      enc.copyBufferToBuffer(bufs.st, 0, stg, 0, STATE_SIZE);
      enc.copyBufferToBuffer(bufs.ev, 0, stg, this.evOff, EVCAP * 16);
      if (n > lo) {
        enc.copyBufferToBuffer(bufs.rb, 0, stg, this.rbOff, (n - lo) * 16);
        enc.copyBufferToBuffer(bufs.rp, lo * 4, stg, this.rpOff, (n - lo) * 4);
      }
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
      const rbF = new Float32Array(data, this.rbOff, (n - lo) * 4), rbU = new Uint32Array(data, this.rbOff, (n - lo) * 4);
      const rpF = new Float32Array(data, this.rpOff, n - lo);
      const T = f16Table();
      const { px, py, vx, vy, heat, stress, alive, pres } = this;
      for (let i = lo, k = 0; i < n; i++, k += 4) {
        px[i] = rbF[k]; py[i] = rbF[k + 1];
        const v = rbU[k + 2], hs = rbU[k + 3];
        vx[i] = T[v & 0xffff]; vy[i] = T[v >>> 16];
        const h = T[hs & 0xffff];
        alive[i] = h >= 0 ? 1 : 0;
        heat[i] = h; stress[i] = T[hs >>> 16];
        pres[i] = rpF[i - lo];
      }
      stg.unmap();
      if (steps > 0) this.msPerStep = Math.max(0.01, this.msPerStep * 0.5 + (performance.now() - t0) / steps * 0.5);
      return { steps, lagging: sf[3] > dtEst * 1e-3 };
    }

    stats() { return Sim.prototype.stats.call(this); }

    dispose() {
      if (this.bufs) for (const buf of Object.values(this.bufs)) buf.destroy();
    }
  }

  G.GpuSim = GpuSim;
  G.getGpuDevice = getGpuDevice;
})(window);
