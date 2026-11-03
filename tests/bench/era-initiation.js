// Impacts on a 5/8/5 mm ERA-style stack (RHA / explosive / RHA) over a backing plate.
// Counts how many explosive particles detonate within 150 µs.
const path = require('path');
global.window = global; global.performance = require('perf_hooks').performance;
require(path.join(__dirname, '..', '..', 'sim.js'));
const { Sim, MAT_BY_ID, PROJECTILES } = window.ImpactSim;
const E = MAT_BY_ID.explosive.index;
const L = (mat, thick, gap = 0, fixed = true) => ({ mat, thick, gap, fixed });

for (const type of ['bullet', 'sphere', 'apfsds', 'heat']) {
  for (const v of type === 'bullet' ? [850, 400] : [PROJECTILES[type].v]) {
    const p = PROJECTILES[type];
    const s = new Sim();
    s.build({ res: 1.5, angle: 60, plateH: 300, offsetY: 0, drawn: [],
      layers: [L('rha', 5, 0, false), L('explosive', 8, 0, false), L('rha', 5, 0, false), L('rha', 120, 120)],
      projectile: { type, mat: p.mat, D: p.D, L: p.L, v } });
    let nE = 0; for (let i = 0; i < s.n; i++) if (s.mat[i] === E) nE++;
    s.advance(150, 1e9, 1e9);
    let left = 0; for (let i = 0; i < s.n; i++) if (s.mat[i] === E && s.alive[i]) left++;
    console.log(`${type} @ ${v} m/s: ${nE - left}/${nE} explosive particles detonated`);
  }
}
