// Free-standing RHA / Comp-B / RHA sandwich, initiated at the centre.
// Prints the plate velocities after 10, 30 and 60 µs for several resolutions.
const path = require('path');
global.window = global; global.performance = require('perf_hooks').performance;
require(path.join(__dirname, '..', '..', 'sim.js'));
const { Sim, MAT_BY_ID } = window.ImpactSim;
const E = MAT_BY_ID.explosive.index;

function run(res, te, tp = 5) {
  const scn = { res, angle: 0, plateH: 200, offsetY: 0, drawn: [],
    layers: [{ mat: 'rha', thick: tp, gap: 0, fixed: false }, { mat: 'explosive', thick: te, gap: 0, fixed: false }, { mat: 'rha', thick: tp, gap: 0, fixed: false }],
    projectile: { type: 'none', mat: 'tungsten', D: 10, L: 100, v: 1000 } };
  const s = new Sim(); s.build(scn);
  // initiate the explosive particle nearest the centre
  let best = -1, bd = 1e9, cx = 0, nE = 0;
  for (let i = 0; i < s.n; i++) if (s.mat[i] === E) { cx += s.px[i]; nE++; }
  cx /= nE;
  for (let i = 0; i < s.n; i++) if (s.mat[i] === E) { const d = Math.hypot(s.px[i] - cx, s.py[i]); if (d < bd) { bd = d; best = i; } }
  s.heat[best] = 1;
  for (const us of [10, 30, 60]) {
    s.advance(us - s.time * s.usPerT, 1e9, 1e9);
    let vL = 0, nL = 0, vR = 0, nR = 0, alive = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.alive[i]) continue;
      if (s.mat[i] === E) { alive++; continue; }
      if (Math.abs(s.py[i]) * res > 40) continue; // central 80 mm strip
      if (s.px[i] < cx) { vL += s.vx[i]; nL++; } else { vR += s.vx[i]; nR++; }
    }
    if (us === 60) console.log(`res ${res} expl ${te}mm plate ${tp}mm: front plate vx ${(vL / nL * 100).toFixed(0)} m/s, back ${(vR / nR * 100).toFixed(0)} m/s, unexploded ${alive}/${nE}`);
  }
  const C = te * 1.7, M = tp * 7.85;
  return 2700 / Math.sqrt(M / C + 1 / 3);
}

for (const res of [3, 2, 1, 0.5]) run(res, 8);
for (const te of [4, 16, 32]) { const g = run(1, te); console.log(`   Gurney (Comp B, symmetric sandwich) for ${te} mm: ~${g.toFixed(0)} m/s`); }
console.log('   Gurney for 8 mm: ~' + (2700 / Math.sqrt(5 * 7.85 / (8 * 1.7) + 1 / 3)).toFixed(0) + ' m/s');
