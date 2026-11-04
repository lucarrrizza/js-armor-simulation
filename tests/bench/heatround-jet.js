// HEAT round against a 50 mm RHA plate, 100 mm standoff. Reports the fastest liner (copper) particle and how far
// the copper goes into the plate, with the V-liner and with no liner (the same fill, unshaped).
// Usage: node tests/bench/heatround-jet.js [res_mm=3] [tEnd_us=700]
const path = require('path');
global.window = global; global.performance = require('perf_hooks').performance;
require(path.join(__dirname, '..', '..', 'sim.js'));
const { Sim, MAT_BY_ID } = window.ImpactSim;
const CU = MAT_BY_ID.copper.index;

const res = +(process.argv[2] || 3), tEnd = +(process.argv[3] || 700);

function run(liner) {
  const scn = {
    res, angle: 0, plateH: 200, offsetY: 0, drawn: [], explosionModel: 'gas',
    layers: [{ mat: 'rha', thick: 50, gap: 0, fixed: false }],
    projectile: { type: 'heatRound', mat: 'mild', D: 100, L: 300, v: 300, liner },
  };
  const s = new Sim();
  const t0 = performance.now();
  s.build(scn);
  const front = s.armorFront;
  const nCu = (() => { let c = 0; for (let i = 0; i < s.n; i++) if (s.mat[i] === CU) c++; return c; })();
  // the sim reorders its arrays during advance(), so the particle indices are looked up again at every sample
  let tipSpeed = 0, tipAt = 0, depth = 0, pSpeed = 0, pDepth = 0, lastPrint = -1e9;
  const rows = [];
  for (let t = 0; t <= tEnd; t += 10) {
    if (t > 0) s.advance(10, 1e9, 1e9);
    let vmax = 0, xmax = -Infinity, pv = 0, px = -Infinity;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i] || s.grp[i] !== 1) continue;
      const v = Math.hypot(s.vx[i], s.vy[i]) * 100;
      if (v > pv) pv = v;
      if (s.px[i] > px) px = s.px[i];
      if (s.mat[i] !== CU) continue;
      if (v > vmax) vmax = v;
      if (s.px[i] > xmax) xmax = s.px[i];
    }
    if (vmax > tipSpeed) { tipSpeed = vmax; tipAt = t; }
    if (pv > pSpeed) pSpeed = pv;
    depth = Math.max(0, (xmax - front) * res);
    pDepth = Math.max(pDepth, (px - front) * res);
    if (t - lastPrint >= 100) { rows.push(`  t=${t} µs  liner max ${Math.round(vmax)} m/s  liner depth past plate face ${depth.toFixed(1)} mm  projectile max ${Math.round(pv)} m/s`); lastPrint = t; }
  }
  return { n: s.n, cuN: nCu, tipSpeed, tipAt, depth, pSpeed, pDepth, rows, secs: (performance.now() - t0) / 1000 };
}

for (const liner of [true, false]) {
  const r = run(liner);
  console.log(`liner=${liner}: ${r.n} particles (${r.cuN} copper), ${r.secs.toFixed(1)} s wall`);
  for (const line of r.rows) console.log(line);
  console.log(`  peak liner speed ${Math.round(r.tipSpeed)} m/s at ${r.tipAt} µs, deepest liner ${r.depth.toFixed(1)} mm past the plate face`);
  console.log(`  peak projectile speed ${Math.round(r.pSpeed)} m/s, deepest projectile particle ${r.pDepth.toFixed(1)} mm past the plate face`);
}
