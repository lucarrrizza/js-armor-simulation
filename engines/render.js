'use strict';
// WebGPU renderer: particles as instanced quads (motion-stretched in cinematic mode), explosion
// fireballs / sparks / smoke / shock rings as a small GPU particle system, HDR bloom and a
// shock-wave distortion pass. Draws straight from the GPU engine's buffers (no readback);
// the CPU engines upload positions each frame.
(function (G) {
  const { MATS } = G.ImpactSim;
  const NA = 16384, NB = 32768, NFX = NA + NB, EMIT_N = 8192, MAXRINGS = 16, MIPS = 6, WG = 128;
  const FIRE = 1, SMOKE = 2, SPARK = 3, RING = 4;
  const HDR = 'rgba16float';
  const RING_SPEED = 3.0, RING_LIFE = 70; // mm/µs, µs
  const U_HEAD = 7; // vec4s in U before mats
  const SPLAT_BELOW = 0.8; // device px per lattice unit under which particles are splatted

  const COMMON = /* wgsl */`
const NA: u32 = ${NA}u;
const NB: u32 = ${NB}u;
const NFX: u32 = ${NFX}u;
const EMIT_N: u32 = ${EMIT_N}u;
struct U {
  cam: vec4f,   // x, y, device px per unit, mm per unit
  view: vec4f,  // width, height (device px), 1/width, 1/height
  look: vec4f,  // view mode, 1/vRef, glow gain, trail length (time units)
  misc: vec4f,  // n, cinematic, fx dt (us), seed
  post: vec4f,  // bloom threshold, bloom intensity, distortion gain, ring count
  emit: vec4f,  // us per time unit, emit rate, smoke gain, fx gain
  ext: vec4f,   // splat mode, -, -, -
  mats: array<vec4f, 16>,
  rings: array<vec4f, ${MAXRINGS}>,
};
struct FX { a: vec4f, b: vec4f }; // pos.xy vel.xy (units, units/us) | age, life (us), kind, size (units)
struct Part { p: vec4f, heat: f32, stress: f32, mat: u32, alive: bool };
@group(0) @binding(0) var<uniform> u: U;

fn toClip(w: vec2f) -> vec4f {
  let px = (w - u.cam.xy) * u.cam.z + 0.5 * u.view.xy;
  return vec4f(px.x * u.view.z * 2.0 - 1.0, 1.0 - px.y * u.view.w * 2.0, 0.0, 1.0);
}
fn heatRGB(h0: f32) -> vec3f {
  let h = clamp(h0, 0.0, 1.0);
  var a = vec3f(90.0, 10.0, 0.0); var b = vec3f(200.0, 40.0, 0.0); var t = h / 0.3;
  if (h > 0.3) { a = b; b = vec3f(255.0, 120.0, 10.0); t = (h - 0.3) / 0.25; }
  if (h > 0.55) { a = vec3f(255.0, 120.0, 10.0); b = vec3f(255.0, 210.0, 80.0); t = (h - 0.55) / 0.25; }
  if (h > 0.8) { a = vec3f(255.0, 210.0, 80.0); b = vec3f(255.0, 250.0, 220.0); t = (h - 0.8) / 0.2; }
  return mix(a, b, t) / 255.0;
}
fn turbo(t0: f32) -> vec3f {
  var s = array<vec3f, 7>(vec3f(48.0, 18.0, 59.0), vec3f(65.0, 105.0, 225.0), vec3f(30.0, 200.0, 200.0),
    vec3f(80.0, 230.0, 80.0), vec3f(240.0, 220.0, 40.0), vec3f(250.0, 120.0, 20.0), vec3f(200.0, 20.0, 20.0));
  let t = clamp(t0, 0.0, 1.0) * 6.0;
  let i = min(5u, u32(t));
  return mix(s[i], s[i + 1u], t - f32(i)) / 255.0;
}
fn hash(x0: u32) -> u32 {
  var x = x0 * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn unit(s: u32) -> f32 { return f32(s & 0xffffu) / 65535.0; }
`;

  const SRC_GPU = /* wgsl */`
@group(1) @binding(0) var<storage, read> pv: array<vec4f>;
@group(1) @binding(1) var<storage, read> pa: array<vec4f>;
@group(1) @binding(2) var<storage, read> pm: array<vec4u>;
fn part(i: u32) -> Part { let f = pm[i].w; let a = pa[i]; return Part(pv[i], a.z, a.w, f & 255u, (f & 256u) != 0u); }
`;
  const SRC_CPU = /* wgsl */`
@group(1) @binding(0) var<storage, read> pv: array<vec4f>;
@group(1) @binding(1) var<storage, read> pq: array<vec4f>;
fn part(i: u32) -> Part { let q = pq[i]; return Part(pv[i], q.x, q.y, u32(q.z), q.w > 0.5); }
`;

  // shared by the quad and splat paths: particle colour and motion-trail length (device px, 0 = none)
  const SHADE = /* wgsl */`
const SPLAT_TRAIL: f32 = 1.5; // in splat mode, particles with a longer trail are still drawn as streak quads
fn trailPx(q: Part) -> f32 {
  if (u.look.w <= 0.0) { return 0.0; }
  let L = min(length(q.p.zw) * u.look.w, 40.0) * u.cam.z;
  return select(0.0, L, L >= 0.75);
}
fn partColor(q: Part) -> vec3f {
  let mode = u32(u.look.x);
  let h = q.heat;
  var c: vec3f;
  var e = heatRGB(h / 1.8) * smoothstep(0.3, 1.7, h);
  if (mode == 0u) {
    c = mix(u.mats[q.mat].rgb, heatRGB(h / 1.8), clamp((h - 0.12) * 1.6, 0.0, 1.0));
  } else if (mode == 1u) {
    c = select(turbo(0.15 + 0.85 * q.stress), vec3f(70.0, 80.0, 95.0) / 255.0, q.stress < 0.02);
    e = vec3f(0.0);
  } else if (mode == 2u) {
    c = turbo(length(q.p.zw) * u.look.y);
    e = vec3f(0.0);
  } else {
    c = select(heatRGB(h / 2.0), vec3f(45.0, 50.0, 62.0) / 255.0, h < 0.06);
  }
  return c + e * u.look.z;
}
`;

  const PARTICLES = SHADE + /* wgsl */`
struct PO {
  @builtin(position) pos: vec4f,
  @location(0) loc: vec2f,
  @location(1) col: vec3f,
  @location(2) shape: vec3f, // radius, trail length, radius in px
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PO {
  var o: PO;
  let q = part(ii);
  let tp = trailPx(q);
  if (!q.alive || (u.ext.x > 0.0 && tp < SPLAT_TRAIL)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  let c = partColor(q);
  let spx = u.cam.z;
  let r = max(0.62, 0.8 / spx);
  let L = tp / spx;
  var dir = vec2f(1.0, 0.0);
  if (L > 0.0) { dir = normalize(q.p.zw); }
  let perp = vec2f(-dir.y, dir.x);
  var cs = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let k = cs[vi];
  let lx = mix(-(r + L), r, k.x);
  let ly = mix(-r, r, k.y);
  o.pos = toClip(q.p.xy + dir * lx + perp * ly);
  o.loc = vec2f(lx, ly);
  o.col = c;
  o.shape = vec3f(r, L, r * spx);
  return o;
}
@fragment fn fs(i: PO) -> @location(0) vec4f {
  let r = i.shape.x; let L = i.shape.y;
  let qx = clamp(i.loc.x, -L, 0.0);
  let d = length(vec2f(i.loc.x - qx, i.loc.y)) / r;
  var a = clamp((1.0 - d) * i.shape.z + 0.5, 0.0, 1.0);
  if (L > 0.0 && i.loc.x < 0.0) { a *= 1.0 - 0.9 * clamp(-i.loc.x / (L + r), 0.0, 1.0); }
  return vec4f(i.col * a, a);
}
`;

  // dense views (several particles per pixel): blending millions of overlapping sub-pixel quads
  // serialises in the ROPs, so instead each particle adds its colour to its pixel with atomics
  const SPLAT = SHADE + /* wgsl */`
@group(2) @binding(0) var<storage, read_write> acc: array<atomic<u32>>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= u32(u.misc.x)) { return; }
  let q = part(i);
  if (!q.alive || trailPx(q) >= SPLAT_TRAIL) { return; }
  let px = floor((q.p.xy - u.cam.xy) * u.cam.z + 0.5 * u.view.xy);
  if (px.x < 0.0 || px.y < 0.0 || px.x >= u.view.x || px.y >= u.view.y) { return; }
  let k = (u32(px.y) * u32(u.view.x) + u32(px.x)) * 4u;
  let c = min(partColor(q), vec3f(60.0)) * 1024.0;
  atomicAdd(&acc[k], u32(c.r));
  atomicAdd(&acc[k + 1u], u32(c.g));
  atomicAdd(&acc[k + 2u], u32(c.b));
  atomicAdd(&acc[k + 3u], 1u);
}
`;
  const RESOLVE = /* wgsl */`
@group(1) @binding(0) var<storage, read> acc: array<u32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2u(pos.xy);
  let k = (p.y * u32(u.view.x) + p.x) * 4u;
  let cnt = acc[k + 3u];
  if (cnt == 0u) { discard; }
  return vec4f(vec3f(f32(acc[k]), f32(acc[k + 1u]), f32(acc[k + 2u])) / (1024.0 * f32(cnt)), 1.0);
}
`;

  // hot material sheds embers and vapour (cinematic mode); runs on a random sample of particles
  const EMIT = /* wgsl */`
@group(2) @binding(0) var<storage, read_write> fx: array<FX>;
@group(2) @binding(1) var<storage, read_write> ctr: array<atomic<u32>, 2>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = u32(u.misc.x);
  if (g.x >= EMIT_N || n == 0u) { return; }
  var s = hash(g.x * 1973u + u32(u.misc.w) * 9277u + 17u);
  let i = s % n; s = hash(s);
  let q = part(i);
  if (!q.alive || q.heat < 0.5) { return; }
  let r = unit(s); s = hash(s);
  if (r > u.emit.y * (q.heat - 0.4)) { return; }
  if (atomicAdd(&ctr[1], 1u) > 600u) { return; }
  let slot = NA + atomicAdd(&ctr[0], 1u) % NB;
  let mm = 1.0 / u.cam.w; // units per mm
  let vt = q.p.zw / u.emit.x;
  let sp = length(vt);
  let a = unit(s) * 6.2831853; s = hash(s);
  let jit = vec2f(cos(a), sin(a));
  var f: FX;
  if (q.heat > 0.8 && sp > 0.15 * mm && (s & 3u) != 0u) {
    f.a = vec4f(q.p.xy, vt * (0.9 + 0.3 * r) + jit * sp * 0.35);
    f.b = vec4f(0.0, 15.0 + 40.0 * unit(s), ${SPARK}.0, max(0.35, 0.25 * mm));
  } else {
    f.a = vec4f(q.p.xy, vt * 0.3 + jit * (0.05 + 0.1 * r) * mm);
    f.b = vec4f(0.0, 120.0 + 200.0 * unit(s), ${SMOKE}.0, (2.0 + 4.0 * r) * mm);
  }
  fx[slot] = f;
}
`;

  const FX_UPDATE = /* wgsl */`
@group(1) @binding(0) var<storage, read_write> fx: array<FX>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= NFX) { return; }
  var f = fx[i];
  if (f.b.y <= 0.0) { return; }
  let dt = u.misc.z;
  var drag = 0.0;
  switch (u32(f.b.z)) {
    case ${FIRE}u: { drag = 0.05; }
    case ${SMOKE}u: { drag = 0.025; }
    case ${SPARK}u: { drag = 0.008; }
    default: {}
  }
  f.a = vec4f(f.a.xy + f.a.zw * dt, f.a.zw * exp(-drag * dt));
  f.b.x = f.b.x + dt;
  if (f.b.x >= f.b.y) { f.b.y = 0.0; }
  fx[i] = f;
}
`;

  const FX_DRAW = /* wgsl */`
@group(1) @binding(0) var<storage, read> fx: array<FX>;
struct FO {
  @builtin(position) pos: vec4f,
  @location(0) loc: vec2f,
  @location(1) col: vec4f,
  @location(2) prm: vec4f, // shape (0 blob, 1 ring, 2 streak), radius, trail length, ring radius
};
fn vert(vi: u32, ii: u32, smoke: bool) -> FO {
  var o: FO;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  let f = fx[ii];
  if (f.b.y <= 0.0 || f.b.x < 0.0) { return o; }
  let kind = u32(f.b.z);
  if ((kind == ${SMOKE}u) != smoke) { return o; }
  let t = clamp(f.b.x / f.b.y, 0.0, 1.0);
  let spx = u.cam.z;
  var r = f.b.w;
  var L = 0.0;
  var dir = vec2f(1.0, 0.0);
  var shape = 0.0;
  var R = 0.0;
  var rw = 0.0;
  var col = vec4f(0.0);
  let gain = u.emit.w;
  if (kind == ${FIRE}u) {
    r = f.b.w * (0.35 + 1.15 * sqrt(t));
    let k = pow(1.0 - t, 1.5);
    col = vec4f(mix(vec3f(0.9, 0.18, 0.03), vec3f(1.0, 0.82, 0.5), k) * (0.25 + 2.6 * k * k) * gain, 0.0);
  } else if (kind == ${SMOKE}u) {
    r = f.b.w * (0.5 + 1.6 * sqrt(t));
    let a = smoothstep(0.0, 0.06, t) * (1.0 - t) * 0.33 * u.emit.z;
    col = vec4f(vec3f(0.15, 0.14, 0.13) * a, a);
  } else if (kind == ${SPARK}u) {
    let v = f.a.zw;
    let sp = length(v);
    if (sp > 1e-6) { dir = v / sp; }
    L = min(sp * 3.0, 40.0);
    shape = 2.0;
    let k = 1.0 - t;
    col = vec4f(mix(vec3f(1.0, 0.35, 0.08), vec3f(1.0, 0.85, 0.55), k) * 2.2 * k * gain, 0.0);
  } else {
    R = f.b.w * f.b.x;
    let w = max(1.5 / spx, 0.06 * R + 0.5);
    r = R + 3.0 * w;
    shape = 1.0;
    let k = (1.0 - t) * (1.0 - t);
    col = vec4f(vec3f(1.0, 0.85, 0.65) * 0.7 * k * gain, 0.0);
    rw = w;
  }
  r = max(r, 1.2 / spx);
  let perp = vec2f(-dir.y, dir.x);
  var cs = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let k = cs[vi];
  let lx = mix(-(r + L), r, k.x);
  let ly = mix(-r, r, k.y);
  o.pos = toClip(f.a.xy + dir * lx + perp * ly);
  o.loc = vec2f(lx, ly);
  o.col = col;
  if (shape == 1.0) { o.prm = vec4f(1.0, r, R, rw); } else { o.prm = vec4f(shape, r, L, 0.0); }
  return o;
}
@vertex fn vsSmoke(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FO { return vert(vi, ii, true); }
@vertex fn vsAdd(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FO { return vert(vi, ii, false); }
@fragment fn fs(i: FO) -> @location(0) vec4f {
  let r = i.prm.y;
  var w: f32;
  if (i.prm.x == 1.0) {
    let x = (length(i.loc) - i.prm.z) / i.prm.w;
    w = exp(-x * x);
  } else if (i.prm.x == 2.0) {
    let L = i.prm.z;
    let d = length(vec2f(i.loc.x - clamp(i.loc.x, -L, 0.0), i.loc.y)) / r;
    w = (1.0 - smoothstep(0.2, 1.0, d)) * (1.0 - 0.9 * clamp(-i.loc.x / (L + r), 0.0, 1.0));
  } else {
    let d = length(i.loc) / r;
    w = exp(-d * d * 3.0) * (1.0 - smoothstep(0.75, 1.0, d));
  }
  return i.col * w;
}
`;

  const FULL = /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;
fn box4(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  return 0.25 * (textureSampleLevel(src, smp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb + textureSampleLevel(src, smp, uv + t * vec2f(1.0, -1.0), 0.0).rgb +
    textureSampleLevel(src, smp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb + textureSampleLevel(src, smp, uv + t, 0.0).rgb);
}
`;
  const BLOOM_PRE = FULL + /* wgsl */`
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let c = min(box4(i.uv), vec3f(40.0));
  let b = max(c.r, max(c.g, c.b));
  let w = max(b - u.post.x, 0.0) / max(b, 1e-4);
  return vec4f(c * w, 1.0);
}`;
  const BLOOM_DOWN = FULL + /* wgsl */`
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(box4(i.uv), 1.0); }`;
  const BLOOM_UP = FULL + /* wgsl */`
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = 4.0 * textureSampleLevel(src, smp, i.uv, 0.0).rgb;
  c += 2.0 * (textureSampleLevel(src, smp, i.uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv - vec2f(t.x, 0.0), 0.0).rgb +
    textureSampleLevel(src, smp, i.uv + vec2f(0.0, t.y), 0.0).rgb + textureSampleLevel(src, smp, i.uv - vec2f(0.0, t.y), 0.0).rgb);
  c += textureSampleLevel(src, smp, i.uv + t, 0.0).rgb + textureSampleLevel(src, smp, i.uv - t, 0.0).rgb +
    textureSampleLevel(src, smp, i.uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(src, smp, i.uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}`;
  const COMPOSITE = FULL + /* wgsl */`
@group(1) @binding(2) var bloom: texture_2d<f32>;
fn shoulder(x: vec3f) -> vec3f {
  let k = 0.75;
  return select(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), x > vec3f(k));
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let px = i.uv * u.view.xy;
  var off = vec2f(0.0);
  for (var k = 0u; k < u32(u.post.w); k++) {
    let rg = u.rings[k];
    let d = px - rg.xy;
    let l = max(length(d), 1.0);
    let x = (l - rg.z) / max(6.0, rg.z * 0.12);
    off += d / l * exp(-x * x) * rg.w;
  }
  let uv = i.uv - off * u.post.z * u.view.zw;
  var c = textureSampleLevel(src, smp, uv, 0.0).rgb + textureSampleLevel(bloom, smp, uv, 0.0).rgb * u.post.y;
  return vec4f(shoulder(max(c, vec3f(0.0))), 1.0);
}`;

  class GpuRenderer {
    static available() { return !!(G.navigator && navigator.gpu && G.getGpuDevice); }

    static async create(canvas) {
      const { device } = await G.getGpuDevice();
      return new GpuRenderer(device, canvas);
    }

    constructor(device, canvas) {
      this.device = device;
      this.canvas = canvas;
      this.ctx = canvas.getContext('webgpu');
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const dev = device, S = GPUBufferUsage;
      this.ubuf = dev.createBuffer({ size: 16 * (U_HEAD + 16 + MAXRINGS), usage: S.UNIFORM | S.COPY_DST });
      this.udata = new Float32Array(4 * (U_HEAD + 16 + MAXRINGS));
      MATS.forEach((m, i) => this.udata.set([m.color[0] / 255, m.color[1] / 255, m.color[2] / 255, 1], 4 * U_HEAD + i * 4));
      this.fxBuf = dev.createBuffer({ size: NFX * 32, usage: S.STORAGE | S.COPY_DST });
      this.ctrBuf = dev.createBuffer({ size: 16, usage: S.STORAGE | S.COPY_DST });
      this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      this.ringA = 0; this.rings = []; this.seed = 1;
      this.src = null;

      const mod = (code, label) => dev.createShaderModule({ code: COMMON + code, label });
      const premul = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
      const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
      const renderPipe = (module, vs, fs, format, blend) => dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: vs },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipes = {};
      for (const [variant, src] of [['gpu', SRC_GPU], ['cpu', SRC_CPU]]) {
        this.pipes[variant] = {
          draw: renderPipe(mod(src + PARTICLES, 'particles-' + variant), 'vs', 'fs', HDR, premul),
          emit: dev.createComputePipeline({ layout: 'auto', compute: { module: mod(src + EMIT, 'emit-' + variant), entryPoint: 'main' } }),
          splat: dev.createComputePipeline({ layout: 'auto', compute: { module: mod(src + SPLAT, 'splat-' + variant), entryPoint: 'main' } }),
        };
      }
      this.resolve = renderPipe(mod(RESOLVE, 'splat-resolve'), 'vs', 'fs', HDR, premul);
      const fxDraw = mod(FX_DRAW, 'fx-draw');
      this.fxSmoke = renderPipe(fxDraw, 'vsSmoke', 'fs', HDR, premul);
      this.fxAdd = renderPipe(fxDraw, 'vsAdd', 'fs', HDR, add);
      this.fxUpdate = dev.createComputePipeline({ layout: 'auto', compute: { module: mod(FX_UPDATE, 'fx-update'), entryPoint: 'main' } });
      this.bloomPre = renderPipe(mod(BLOOM_PRE, 'bloom-pre'), 'vs', 'fs', HDR);
      this.bloomDown = renderPipe(mod(BLOOM_DOWN, 'bloom-down'), 'vs', 'fs', HDR);
      this.bloomUp = renderPipe(mod(BLOOM_UP, 'bloom-up'), 'vs', 'fs', HDR, add);
      this.composite = renderPipe(mod(COMPOSITE, 'composite'), 'vs', 'fs', this.format);

      const ug = (p) => dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
      this.ug = new Map();
      for (const p of [this.pipes.gpu.draw, this.pipes.gpu.emit, this.pipes.gpu.splat, this.pipes.cpu.draw, this.pipes.cpu.emit,
        this.pipes.cpu.splat, this.resolve, this.fxSmoke, this.fxAdd, this.fxUpdate, this.bloomPre, this.composite]) this.ug.set(p, ug(p));
      const fxg = (p, group, entries) => dev.createBindGroup({ layout: p.getBindGroupLayout(group), entries });
      const fxE = [{ binding: 0, resource: { buffer: this.fxBuf } }];
      this.fxUpdateG = fxg(this.fxUpdate, 1, fxE);
      this.fxSmokeG = fxg(this.fxSmoke, 1, fxE);
      this.fxAddG = fxg(this.fxAdd, 1, fxE);
      this.emitG = {};
      for (const v of ['gpu', 'cpu']) this.emitG[v] = fxg(this.pipes[v].emit, 2, [...fxE, { binding: 1, resource: { buffer: this.ctrBuf } }]);
      this.reset();
    }

    // call after the scene is rebuilt (also forces the next CPU-engine upload)
    reset() {
      this.dirty = true;
      this.device.queue.writeBuffer(this.fxBuf, 0, new Float32Array(NFX * 8));
      this.rings = [];
      this.cellA = new Map();
      this.ringA = 0;
    }

    resizeTargets(w, h) {
      if (this.tw === w && this.th === h) return;
      this.tw = w; this.th = h;
      if (this.scene) { this.scene.destroy(); this.mips.forEach((t) => t.destroy()); }
      const dev = this.device, T = GPUTextureUsage;
      const tex = (tw, th) => dev.createTexture({ size: [Math.max(1, tw), Math.max(1, th)], format: HDR, usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
      this.scene = tex(w, h);
      this.mips = [];
      for (let k = 0; k < MIPS; k++) this.mips.push(tex(w >> (k + 1), h >> (k + 1)));
      const tg = (p, src, extra = []) => dev.createBindGroup({
        layout: p.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: src.createView() }, { binding: 1, resource: this.sampler }, ...extra],
      });
      this.preG = tg(this.bloomPre, this.scene);
      this.downG = this.mips.slice(0, -1).map((m) => tg(this.bloomDown, m));
      this.upG = this.mips.slice(1).map((m) => tg(this.bloomUp, m));
      this.compG = tg(this.composite, this.scene, [{ binding: 2, resource: this.mips[0].createView() }]);
      // per-pixel splat accumulators (r, g, b fixed point + count); skipped if the buffer would be too big
      if (this.acc) { this.acc.destroy(); this.acc = null; }
      const accBytes = w * h * 16;
      if (accBytes <= dev.limits.maxStorageBufferBindingSize && accBytes <= dev.limits.maxBufferSize) {
        this.acc = dev.createBuffer({ size: accBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const accE = [{ binding: 0, resource: { buffer: this.acc } }];
        this.accG = {};
        for (const v of ['gpu', 'cpu']) this.accG[v] = dev.createBindGroup({ layout: this.pipes[v].splat.getBindGroupLayout(2), entries: accE });
        this.resolveG = dev.createBindGroup({ layout: this.resolve.getBindGroupLayout(1), entries: accE });
      }
      if (!this.emptyG) {
        // the down/up-sample shaders don't use the uniforms, but their auto layouts still have an empty group 0
        this.emptyG = [this.bloomDown, this.bloomUp].map((p) => this.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [] }));
      }
    }

    // particle source: the GPU engine's own buffers, or buffers we upload CPU-engine data into
    bindSource(sim) {
      const dev = this.device;
      if (sim.bufs && sim.device === dev) {
        if (this.src && this.src.sim === sim && this.src.gen === sim.gen) return this.src;
        const entries = ['pv', 'pa', 'pm'].map((k, i) => ({ binding: i, resource: { buffer: sim.bufs[k] } }));
        const P = this.pipes.gpu;
        this.src = {
          sim, gen: sim.gen, variant: 'gpu', n: sim.n,
          drawG: dev.createBindGroup({ layout: P.draw.getBindGroupLayout(1), entries }),
          emitG: dev.createBindGroup({ layout: P.emit.getBindGroupLayout(1), entries }),
          splatG: dev.createBindGroup({ layout: P.splat.getBindGroupLayout(1), entries }),
        };
        return this.src;
      }
      const n = sim.n;
      let s = this.src;
      if (!s || s.variant !== 'cpu' || s.cap < n) {
        if (s && s.variant === 'cpu') { s.pvBuf.destroy(); s.pqBuf.destroy(); }
        const cap = Math.max(1024, Math.ceil(n * 1.25));
        const S = GPUBufferUsage;
        const pvBuf = dev.createBuffer({ size: cap * 16, usage: S.STORAGE | S.COPY_DST });
        const pqBuf = dev.createBuffer({ size: cap * 16, usage: S.STORAGE | S.COPY_DST });
        const entries = [{ binding: 0, resource: { buffer: pvBuf } }, { binding: 1, resource: { buffer: pqBuf } }];
        const P = this.pipes.cpu;
        s = this.src = {
          variant: 'cpu', cap, pvBuf, pqBuf, pv: new Float32Array(cap * 4), pq: new Float32Array(cap * 4),
          drawG: dev.createBindGroup({ layout: P.draw.getBindGroupLayout(1), entries }),
          emitG: dev.createBindGroup({ layout: P.emit.getBindGroupLayout(1), entries }),
          splatG: dev.createBindGroup({ layout: P.splat.getBindGroupLayout(1), entries }),
        };
      }
      // CPU engines: re-upload only when the simulation moved on (nothing to do while paused)
      if (s.sim === sim && s.n === n && s.time === sim.time && !this.dirty) return s;
      s.sim = sim; s.n = n; s.time = sim.time; this.dirty = false;
      const { px, py, vx, vy, heat, stress, mat, alive } = sim;
      const pv = s.pv, pq = s.pq;
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        pv[k] = px[i]; pv[k + 1] = py[i]; pv[k + 2] = vx[i]; pv[k + 3] = vy[i];
        pq[k] = heat[i]; pq[k + 1] = stress[i]; pq[k + 2] = mat[i]; pq[k + 3] = alive[i];
      }
      if (n) {
        dev.queue.writeBuffer(s.pvBuf, 0, pv, 0, n * 4);
        dev.queue.writeBuffer(s.pqBuf, 0, pq, 0, n * 4);
      }
      return s;
    }

    // detonation events -> fireballs, sparks, smoke and a shock ring per cluster (visual only)
    explode(events, sim, cinematic) {
      if (!events.length) return;
      const res = sim.res, mm = 1 / res, nowUs = sim.time * sim.usPerT;
      const cell = 14 * mm;
      const clusters = new Map();
      for (const e of events) {
        const key = Math.floor(e.x / cell) * 65536 + Math.floor(e.y / cell);
        const c = clusters.get(key);
        if (c) { c.x += e.x; c.y += e.y; c.n++; c.t = Math.min(c.t, e.t); } else clusters.set(key, { x: e.x, y: e.y, n: 1, t: e.t });
      }
      const out = [];
      const rnd = Math.random;
      const push = (x, y, vx, vy, age, life, kind, size) => out.push(x, y, vx, vy, age, life, kind, size);
      // emission scales with detonated area (mm²), so it doesn't depend on resolution or frame rate
      const count = (perMm2, A) => { const x = perMm2 * A; return Math.floor(x) + (rnd() < x % 1 ? 1 : 0); };
      for (const [key, e] of this.cellA) if (nowUs - e.t > 40) this.cellA.delete(key);
      let k = 0;
      for (const [key, c] of clusters) {
        if (k++ > 48) break;
        const x = c.x / c.n, y = c.y / c.n;
        const age = Math.max(0, nowUs - c.t * sim.usPerT);
        const A = c.n * res * res;
        const acc = this.cellA.get(key);
        const accA = (acc ? acc.A * Math.exp(-(nowUs - acc.t) / 15) : 0) + A;
        this.cellA.set(key, { A: accA, t: nowUs });
        const s = Math.min(5, 1 + Math.sqrt(accA / 4));
        const burst = (count, vMin, vMax, lMin, lMax, kind, size, spread) => {
          for (let i = 0; i < count; i++) {
            const a = rnd() * Math.PI * 2, v = (vMin + rnd() * (vMax - vMin)) * mm, j = rnd() * spread * mm;
            push(x + Math.cos(a) * j, y + Math.sin(a) * j, Math.cos(a) * v, Math.sin(a) * v, age, lMin + rnd() * (lMax - lMin), kind,
              size() * mm);
          }
        };
        const cine = cinematic ? 2 : 1;
        burst(count(0.75, A), 0.2, 1.4, 25, 60, FIRE, () => (5 + rnd() * 7) * (0.8 + 0.2 * s), 4);
        burst(count(1.1 * cine, A), 1.5, 6.5, 30, 110, SPARK, () => 0.5 + rnd() * 0.4, 3);
        burst(count(0.35 * cine, A), 0.08, 0.6, 250, 650, SMOKE, () => (7 + rnd() * 9) * (0.8 + 0.2 * s), 6);
        const tUs = c.t * sim.usPerT;
        if (!this.rings.some((r) => Math.abs(r.t - tUs) < 12 && Math.hypot(r.x - x, r.y - y) < 25 * mm)) {
          push(x, y, 0, 0, age, RING_LIFE, RING, RING_SPEED * mm);
          this.rings.push({ x, y, t: tUs });
          if (this.rings.length > MAXRINGS) this.rings.shift();
        }
      }
      // write into the CPU-owned ring buffer region [0, NA)
      const data = new Float32Array(out);
      const cnt = Math.min(NA, data.length / 8);
      let off = 0;
      while (off < cnt) {
        const slot = this.ringA % NA, len = Math.min(cnt - off, NA - slot);
        this.device.queue.writeBuffer(this.fxBuf, slot * 32, data, off * 8, len * 8);
        this.ringA += len; off += len;
      }
    }

    render(o) {
      const dev = this.device, sim = o.sim;
      const Wd = this.canvas.width, Hd = this.canvas.height;
      if (!Wd || !Hd) return;
      this.resizeTargets(Wd, Hd);
      const src = this.bindSource(sim);
      const n = src.n;
      const cine = o.cinematic;
      const glow = o.glow || cine;
      const res = sim.res, spx = o.cam.scale * o.dpr;
      const splat = !!this.acc && n > 0 && spx < SPLAT_BELOW;
      const nowUs = sim.time * sim.usPerT;
      this.rings = this.rings.filter((r) => nowUs - r.t < RING_LIFE && nowUs >= r.t - 1);
      const ud = this.udata;
      ud.set([o.cam.x, o.cam.y, spx, res,
        Wd, Hd, 1 / Wd, 1 / Hd,
        o.mode, 1 / Math.max(1e-6, o.vRef), glow ? (cine ? 2.6 : 1.0) : 0, cine ? o.trailT : 0,
        n, cine ? 1 : 0, o.frameUs, this.seed++ & 0xffffff,
        cine ? 0.95 : 1.05, glow ? (cine ? 0.9 : 0.4) : 0, cine ? 1 : 0, cine ? this.rings.length : 0,
        sim.usPerT, Math.min(1, o.frameUs * 0.35), cine ? 1.3 : 1, cine ? 1.4 : 1,
        splat ? 1 : 0, 0, 0, 0]);
      this.rings.forEach((r, k) => {
        const age = Math.max(0, nowUs - r.t), f = 1 - age / RING_LIFE;
        const R = RING_SPEED / res * age * spx;
        ud.set([(r.x - o.cam.x) * spx + Wd / 2, (r.y - o.cam.y) * spx + Hd / 2, R, 9 * o.dpr * f * f], 4 * U_HEAD + 64 + k * 4);
      });
      dev.queue.writeBuffer(this.ubuf, 0, ud);

      const enc = dev.createCommandEncoder();
      if (splat) {
        enc.clearBuffer(this.acc, 0, Wd * Hd * 16);
        const cp = enc.beginComputePass();
        const p = this.pipes[src.variant].splat;
        cp.setPipeline(p);
        cp.setBindGroup(0, this.ug.get(p)); cp.setBindGroup(1, src.splatG); cp.setBindGroup(2, this.accG[src.variant]);
        cp.dispatchWorkgroups(Math.ceil(n / WG));
        cp.end();
      }
      if (o.frameUs > 0) {
        dev.queue.writeBuffer(this.ctrBuf, 4, new Uint32Array([0]));
        const cp = enc.beginComputePass();
        if (cine && n) {
          const p = this.pipes[src.variant].emit;
          cp.setPipeline(p);
          cp.setBindGroup(0, this.ug.get(p)); cp.setBindGroup(1, src.emitG); cp.setBindGroup(2, this.emitG[src.variant]);
          cp.dispatchWorkgroups(Math.ceil(EMIT_N / WG));
        }
        cp.setPipeline(this.fxUpdate);
        cp.setBindGroup(0, this.ug.get(this.fxUpdate)); cp.setBindGroup(1, this.fxUpdateG);
        cp.dispatchWorkgroups(Math.ceil(NFX / WG));
        cp.end();
      }

      const rp = enc.beginRenderPass({ colorAttachments: [{ view: this.scene.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 15 / 255, g: 18 / 255, b: 23 / 255, a: 1 } }] });
      if (splat) {
        rp.setPipeline(this.resolve); rp.setBindGroup(0, this.ug.get(this.resolve)); rp.setBindGroup(1, this.resolveG);
        rp.draw(3);
      }
      // in splat mode only streaking (cinematic) particles still need quads
      if (n && (!splat || cine)) {
        const p = this.pipes[src.variant].draw;
        rp.setPipeline(p); rp.setBindGroup(0, this.ug.get(p)); rp.setBindGroup(1, src.drawG);
        rp.draw(6, n);
      }
      rp.setPipeline(this.fxSmoke); rp.setBindGroup(0, this.ug.get(this.fxSmoke)); rp.setBindGroup(1, this.fxSmokeG);
      rp.draw(6, NFX);
      rp.setPipeline(this.fxAdd); rp.setBindGroup(0, this.ug.get(this.fxAdd)); rp.setBindGroup(1, this.fxAddG);
      rp.draw(6, NFX);
      rp.end();

      const full = (pipe, view, groups, load) => {
        const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
        p.setPipeline(pipe);
        groups.forEach((g, i) => g && p.setBindGroup(i, g));
        p.draw(3);
        p.end();
      };
      if (glow) {
        full(this.bloomPre, this.mips[0].createView(), [this.ug.get(this.bloomPre), this.preG]);
        for (let k = 1; k < MIPS; k++) full(this.bloomDown, this.mips[k].createView(), [this.emptyG[0], this.downG[k - 1]]);
        for (let k = MIPS - 2; k >= 0; k--) full(this.bloomUp, this.mips[k].createView(), [this.emptyG[1], this.upG[k]], true);
      }
      full(this.composite, this.ctx.getCurrentTexture().createView(), [this.ug.get(this.composite), this.compG]);
      dev.queue.submit([enc.finish()]);
    }
  }

  G.GpuRenderer = GpuRenderer;
})(window);
