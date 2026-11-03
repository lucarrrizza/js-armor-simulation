'use strict';
// Particle / bond based 2D impact simulator (cross-section).
// Units: 1 length unit = `res` mm (particle spacing), velocity unit = 100 m/s,
// so 1 time unit = res * 10 microseconds.
(function (G) {
  const ROW = Math.sqrt(3) / 2;
  const R0 = 0.85;            // contact radius
  const DT_FACTOR = globalThis.DT_FACTOR || 0.4;
  const R0SQ = R0 * R0;
  const BOND_RANGE = 1.2;     // lattice neighbours within this distance get bonded
  const HEAT_V = 3;           // approach speed (units/t) above which contacts heat up
  const HEAT_K = 0.9;          // contact heating per (excess approach speed * time)
  const PLASTIC_HEAT = 0.5;
  const MIN_REST = 0.95;       // limits plastic compaction (metals are ~incompressible)
  const BREAK_HEAT = 0.08;
  const FRICTION = 0.1;
  const DET_HEAT = 0.4;       // explosive initiation threshold (simple model)
  const DET_HEAT_HI = 1.9;    // gas model: heat cook-off, only very hot contact (integrator caps heat at 2)
  const DET_SPEED = 70;       // detonation velocity, units/t (7000 m/s), simple model and ERA default
  // shock initiation (gas model): an explosive particle's speed, smoothed over DET_TU, is its shock strength
  const DET_UCRIT = 15;       // speed at which a sensitivity-1 explosive initiates, units/t (1.5 km/s)
  const DET_TU = 0.3;         // speed smoothing time constant, units/t
  const BLAST_R = 2.6;
  const BLAST_J = 1.1;
  // detonation products (gas model)
  const H_SPH = 1.3;          // SPH smoothing length, in particle spacings
  const GAMMA_HI = 3;         // isentrope exponent for dense products
  const GAMMA_LO = 1.4;       // isentrope exponent for expanded products
  const RHO_LO = 0.1;         // density fraction (of rho0) where the exponent changes
  const GAS_E0 = 364;         // chemical energy per unit mass, (100 m/s)^2 units (Gurney-like)
  const GAS_CUT = 0.01;       // products below this fraction of rho0 are removed as smoke
  const DET_TOUCH = 1.2;      // the detonation front only spreads to touching explosive particles
  const SPH_KW = 10 / (7 * Math.PI) / (H_SPH * H_SPH); // 2D cubic spline normalisation
  // cubic spline kernel w(q) and its derivative, q = r / H_SPH, support 2
  function kw(q) { return q < 1 ? 1 - 1.5 * q * q + 0.75 * q * q * q : q < 2 ? 0.25 * (2 - q) * (2 - q) * (2 - q) : 0; }
  function dkw(q) { return q < 1 ? -3 * q + 2.25 * q * q : q < 2 ? -0.75 * (2 - q) * (2 - q) : 0; }

  const MATS_SOLID = [
    { id: 'rha', name: 'RHA steel', density: 7.85, c: 5900, yield: 0.004, fracture: 0.30, crush: 9, melt: 1.0, color: [140, 150, 165] },
    { id: 'hhs', name: 'High-hardness steel', density: 7.85, c: 5900, yield: 0.006, fracture: 0.15, crush: 9, melt: 1.1, color: [92, 108, 138] },
    { id: 'mild', name: 'Mild steel', density: 7.85, c: 5900, yield: 0.002, fracture: 0.5, crush: 9, melt: 0.9, color: [172, 156, 134] },
    { id: 'ceramic', name: 'Alumina ceramic', density: 3.9, c: 7000, yield: 9, fracture: 0.03, crush: 0.1, melt: 1.6, color: [236, 228, 204] },
    { id: 'glass', name: 'Glass / textolite', density: 2.5, c: 5000, yield: 9, fracture: 0.05, crush: 0.15, melt: 1.2, color: [110, 190, 178] },
    { id: 'alu', name: 'Aluminium alloy', density: 2.8, c: 5000, yield: 0.005, fracture: 0.4, crush: 9, melt: 0.7, color: [200, 213, 228] },
    { id: 'rubber', name: 'Rubber', density: 1.2, c: 1500, yield: 0.5, fracture: 2.0, crush: 9, melt: 0.8, color: [84, 78, 70] },
    { id: 'tungsten', name: 'Tungsten alloy', density: 17.5, c: 5000, yield: 0.007, fracture: 0.13, crush: 9, melt: 1.3, color: [132, 142, 214] },
    { id: 'du', name: 'Depleted uranium', density: 18.6, c: 3400, yield: 0.007, fracture: 0.08, crush: 9, melt: 1.0, color: [104, 176, 96] },
    { id: 'copper', name: 'Copper', density: 8.9, c: 4000, yield: 0.002, fracture: 3.0, crush: 9, melt: 2.0, color: [228, 136, 80] },
  ];
  // explosives. v = sqrt(2E) in m/s (Comp B's 2700 is the GAS_E0 reference), D = detonation speed in units/t
  // (10 units/t = 1 km/s), sens scales the shock-initiation thresholds (1 = reference)
  const EXPLOSIVES = [
    { id: 'explosive', name: 'Explosive (ERA)', density: 1.7, c: 2500, yield: 0.01, fracture: 0.3, crush: 9, melt: 1.0, color: [222, 186, 60], v: 2700, D: 70, sens: 1, explosive: true },
    { id: 'compb', name: 'Comp B (RDX/TNT)', density: 1.72, c: 2500, yield: 0.01, fracture: 0.3, crush: 9, melt: 1.0, color: [196, 160, 96], v: 2700, D: 79, sens: 1, explosive: true },
    { id: 'tnt', name: 'TNT', density: 1.65, c: 2400, yield: 0.01, fracture: 0.2, crush: 9, melt: 1.0, color: [214, 178, 98], v: 2370, D: 69, sens: 0.7, explosive: true },
    { id: 'pe4', name: 'PE4 / C4 (plastic)', density: 1.6, c: 2000, yield: 0.03, fracture: 1.0, crush: 9, melt: 0.9, color: [236, 220, 140], v: 2600, D: 80, sens: 0.8, explosive: true },
    { id: 'hmx', name: 'HMX / octol', density: 1.9, c: 2600, yield: 0.012, fracture: 0.3, crush: 9, melt: 1.0, color: [150, 122, 70], v: 2900, D: 88, sens: 1.2, explosive: true },
    { id: 'petn', name: 'PETN', density: 1.77, c: 2500, yield: 0.01, fracture: 0.3, crush: 9, melt: 0.9, color: [240, 224, 160], v: 2800, D: 83, sens: 1.5, explosive: true },
    { id: 'anfo', name: 'ANFO', density: 0.85, c: 1200, yield: 0.002, fracture: 0.1, crush: 9, melt: 0.8, color: [196, 176, 128], v: 1900, D: 45, sens: 0.2, explosive: true },
    { id: 'ammonal', name: 'Aluminised (H6 / Tritonal)', density: 1.75, c: 2400, yield: 0.01, fracture: 0.3, crush: 9, melt: 1.0, color: [160, 150, 140], v: 2200, D: 65, sens: 0.6, explosive: true },
  ];
  // hidden detonation-product twin of each explosive: carries that explosive's gas EOS (see GRHO0 etc.)
  // and is not user-selectable. The ERA twin keeps the id 'products' for compatibility.
  const PRODUCT_MATS = EXPLOSIVES.map((e) => ({
    id: e.id === 'explosive' ? 'products' : 'prod_' + e.id,
    name: e.id === 'explosive' ? 'Detonation products' : 'Products: ' + e.name,
    density: e.density, c: 4700, yield: 9, fracture: 0, crush: 9, melt: 9, color: [255, 128, 48], products: true, hidden: true,     twinOf: e.id,
  }));  const MATS = [...MATS_SOLID, ...EXPLOSIVES, ...PRODUCT_MATS];
  const NM = MATS.length;
  const MAT_BY_ID = {};
  MATS.forEach((m, i) => {
    m.index = i;
    m.m = m.density / 7.85;
    m.k = m.m * Math.pow(m.c / 106, 2);
    MAT_BY_ID[m.id] = m;
  });
  // reference state of the explosive for the gas model: density of the hex lattice (per unit area) and the isentrope
  function latticeDensity() {
    let s = 0;
    for (let row = -8; row <= 8; row++) for (let col = -8; col <= 8; col++) {
      s += kw(Math.hypot(col + (row & 1 ? 0.5 : 0), row * ROW) / H_SPH);
    }
    return s * SPH_KW;
  }
  // per-material gas tables. Each explosive and its product twin share one EOS:
  // rho0 = reference density, p0 = pressure at rho0, rhoc/pc = where the isentrope exponent changes
  const GRHO0 = new Float64Array(NM), GP0 = new Float64Array(NM), GRHOC = new Float64Array(NM), GPC = new Float64Array(NM);
  const MDSP = new Float64Array(NM), MUCRIT = new Float64Array(NM);
  const PROD_OF = new Int32Array(NM).fill(-1);
  {
    const LAT = latticeDensity();
    for (const e of EXPLOSIVES) {
      const ex = MAT_BY_ID[e.id], tw = MAT_BY_ID[e.id === 'explosive' ? 'products' : 'prod_' + e.id];
      const rho0 = ex.m * LAT;
      const p0 = (GAMMA_HI - 1) * rho0 * GAS_E0 * Math.pow(e.v / 2700, 2);
      const rhoc = RHO_LO * rho0, pc = p0 * Math.pow(RHO_LO, GAMMA_HI);
      for (const k of [ex.index, tw.index]) {
        GRHO0[k] = rho0; GP0[k] = p0; GRHOC[k] = rhoc; GPC[k] = pc;
        MDSP[k] = e.D; MUCRIT[k] = DET_UCRIT / e.sens;
      }
      PROD_OF[ex.index] = tw.index;
    }
  }
  function pressure(rho, t) {
    return rho >= GRHOC[t] ? GP0[t] * Math.pow(rho / GRHO0[t], GAMMA_HI) : GPC[t] * Math.pow(rho / GRHOC[t], GAMMA_LO);
  }

  const MK = new Float64Array(NM), MY = new Float64Array(NM), MFR = new Float64Array(NM),
    MCR = new Float64Array(NM), MMELT = new Float64Array(NM), MCB = new Float64Array(NM), MMASS = new Float64Array(NM), MEXP = new Uint8Array(NM),
    MGAS = new Uint8Array(NM), MDEN = new Uint8Array(NM);
  const KC = new Float64Array(NM * NM), CC = new Float64Array(NM * NM);
  MATS.forEach((m, i) => {
    MK[i] = m.k; MY[i] = m.yield; MFR[i] = m.fracture; MCR[i] = m.crush; MMELT[i] = m.melt;
    MCB[i] = 0.12 * Math.sqrt(m.k * m.m); MMASS[i] = m.m; MEXP[i] = m.explosive ? 1 : 0;
    MGAS[i] = m.products ? 1 : 0; MDEN[i] = MEXP[i] | MGAS[i];
  });
  for (let a = 0; a < NM; a++) for (let b = 0; b < NM; b++) {
    const k = Math.min(MK[a], MK[b]);
    const mm = Math.min(MMASS[a], MMASS[b]);
    KC[a * NM + b] = k;
    CC[a * NM + b] = 0.15 * Math.sqrt(k * mm);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- projectile shape definitions (all dims in units, lx: 0 = tail, L = nose tip) ----
  function ogive(R, L, Ln) {
    return (lx) => {
      if (lx < L - Ln) return R;
      const t = (lx - (L - Ln)) / Ln;
      return R * Math.sqrt(Math.max(0, 1 - t * t));
    };
  }

  const PROJECTILES = {
    apfsds: { name: 'APFSDS long rod', mat: 'tungsten', D: 25, L: 550, v: 1650 },
    apshell: { name: 'Full-calibre AP shell', mat: 'hhs', D: 100, L: 350, v: 850 },
    apcr: { name: 'APCR (sub-calibre core)', mat: 'tungsten', D: 75, L: 260, v: 1050 },
    heat: { name: 'HEAT / shaped-charge jet', mat: 'copper', D: 8, L: 450, v: 8000 },
    bullet: { name: 'AP rifle bullet', mat: 'hhs', D: 8, L: 32, v: 850 },
    sphere: { name: 'Sphere', mat: 'rha', D: 40, L: 40, v: 3000 },
    none: { name: 'None (drawn projectiles only)', mat: 'tungsten', D: 20, L: 100, v: 1500 },
    // explosive shells: a steel case around an explosive fill. Dimensions and fuzes are illustrative.
    hesh: { name: 'HESH (thin case, plastic explosive)', mat: 'mild', D: 75, L: 150, v: 800, fill: 'pe4', shell: 3, fuze: { type: 'delay', delay: 15 } },
    he: { name: 'HE fragmentation shell', mat: 'mild', D: 100, L: 350, v: 600, fill: 'compb', shell: 8, fuze: { type: 'impact', delay: 0 } },
    aphe: { name: 'APHE (base-fuzed, filled cavity)', mat: 'hhs', D: 100, L: 350, v: 850, fill: 'tnt', shell: 12, fuze: { type: 'delay', delay: 20 } },
  };
  // Impact fuzes arm once the explosive is moving faster than ARM_SPEED and fire when its speed drops
  // below IMPACT_DROP times its smoothed (shock) speed.
  const ARM_SPEED = 2;     // units/t (200 m/s)
  const IMPACT_DROP = 0.5;

  function projectileBodies(p, u) {
    const R = Math.max(0.6, u(p.D) / 2);
    const L = Math.max(2, u(p.L));
    const v = p.v / 100;
    const bodies = [];
    switch (p.type) {
      case 'apfsds': {
        const Ln = Math.min(L * 0.3, 2 * R * 1.6);
        bodies.push({ mat: p.mat, x0: 0, x1: L, R, radius: (lx) => lx > L - Ln ? Math.max(0.5, R * (L - lx) / Ln) : R, vel: () => v });
        break;
      }
      case 'apshell':
      case 'bullet': {
        const prof = ogive(R, L, Math.min(L * 0.5, 2 * R * (p.type === 'bullet' ? 1.6 : 1.2)));
        bodies.push({ mat: p.mat, x0: 0, x1: L, R, radius: prof, vel: () => v });
        break;
      }
      case 'apcr': {
        const prof = ogive(R, L, Math.min(L * 0.45, 2 * R * 1.0));
        const rc = Math.max(0.6, R * 0.38);
        const c0 = L * 0.3, c1 = L * 0.85, cn = Math.min((c1 - c0) * 0.4, rc * 2.2);
        const core = (lx) => lx < c0 || lx > c1 ? -1 : (lx > c1 - cn ? Math.max(0.5, rc * (c1 - lx) / cn) : rc);
        bodies.push({ mat: p.mat, x0: c0, x1: c1, R: rc, radius: core, vel: () => v });
        bodies.push({
          mat: 'alu', x0: 0, x1: L, R, vel: () => v, radius: prof,
          exclude: (lx, ly) => {
            const r = core(Math.min(c1, Math.max(c0, lx)));
            return lx > c0 - 0.9 && lx < c1 + 0.9 && Math.abs(ly) < r + 0.9;
          },
        });
        break;
      }
      case 'heat': {
        const vt = v, vb = Math.max(10, v * 0.22);
        bodies.push({
          mat: p.mat, x0: 0, x1: L, R: R * 1.4,
          radius: (lx) => Math.max(0.5, R * (0.6 + 0.8 * (1 - lx / L))),
          vel: (lx) => vb + (vt - vb) * (lx / L),
        });
        const Ls = Math.max(3, L * 0.12), Rs = Math.max(1.5, R * 3);
        bodies.push({
          mat: p.mat, x0: -Ls - 1, x1: -1, R: Rs,
          radius: (lx) => Rs * (0.5 + 0.5 * (lx + Ls + 1) / Ls),
          vel: () => vb * 0.6,
        });
        break;
      }
      case 'hesh':
      case 'he':
      case 'aphe': {
        // case + explosive fill. The fill is the case profile minus the wall thickness; the base is closed.
        const def = PROJECTILES[p.type] || {};
        const fill = p.fill || def.fill, shellMm = p.shell ?? def.shell;
        const t = Math.max(0.6, u(shellMm || 3));
        const prof = ogive(R, L, Math.min(L * 0.4, 2 * R * 1.2));
        const inner = (lx) => prof(lx) - t;
        const fx0 = p.type === 'aphe' ? L * 0.45 : t, fx1 = L - t;
        bodies.push({
          mat: p.mat, x0: 0, x1: L, R, radius: prof, vel: () => v,
          exclude: (lx, ly) => lx > t && lx < L - t && Math.abs(ly) < inner(lx) + 1e-6,
        });
        bodies.push({
          mat: fill, x0: fx0, x1: fx1, R: R - t, vel: () => v, radius: (lx) => (lx < fx0 || lx > fx1 ? -1 : inner(lx)),
          fuze: true,
        });
        break;
      }
      case 'sphere': {
        const Rr = Math.max(R, L / 2);
        bodies.push({ mat: p.mat, x0: 0, x1: 2 * Rr, R: Rr, radius: (lx) => Math.sqrt(Math.max(0, Rr * Rr - (lx - Rr) * (lx - Rr))), vel: () => v });
        break;
      }
    }
    return bodies;
  }

  // ---- user drawings ----
  // Shapes are stored in world millimetres (independent of resolution):
  //   { kind: 'brush'|'line'|'rect'|'circle'|'fill', role: 'armor'|'projectile'|'anchor'|'erase',
  //     mat, size (stroke width, mm), outline (rect/circle: only the edge, `size` wide),
  //     pts: [[x, y], ...] ('fill': the seed point), v (m/s), dir (deg, 0 = +x, counter-clockwise) }
  // They are rasterized onto a global hexagonal lattice, applied in order (later shapes win).
  // A bucket fill floods the connected region of whatever is under the seed point at that moment
  // (empty space, or one material) and is re-evaluated at every resolution.
  const LAT_OFF = 1 << 20;
  const latKey = (r, k) => (r + LAT_OFF) * 4194304 + (k + LAT_OFF);
  // x is shifted by a quarter unit so nodes don't sit exactly on the 2D renderer's pixel edges
  const LAT_X = 0.25;
  const latPos = (r, k) => [k + (r & 1 ? 0.5 : 0) + LAT_X, r * ROW];

  function forShapeNodes(s, res, fn) {
    const P = s.pts.map(([x, y]) => [x / res, y / res]);
    const visit = (x0, x1, y0, y1, inside) => {
      for (let r = Math.floor(y0 / ROW); r <= Math.ceil(y1 / ROW); r++) {
        const o = (r & 1 ? 0.5 : 0) + LAT_X;
        for (let k = Math.floor(x0 - o); k <= Math.ceil(x1 - o); k++) {
          const [x, y] = latPos(r, k);
          if (inside(x, y)) fn(r, k);
        }
      }
    };
    const rr = Math.max(0.5, (s.size || 1) / 2 / res);
    if (s.kind === 'rect' && !s.outline) {
      const [a, b] = P;
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      visit(x0, x1, y0, y1, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    } else if (s.kind === 'circle') {
      const [c, e] = P;
      const R = Math.hypot(e[0] - c[0], e[1] - c[1]);
      const Ro = s.outline ? R + rr : R, Ri = s.outline ? Math.max(0, R - rr) : -1;
      visit(c[0] - Ro, c[0] + Ro, c[1] - Ro, c[1] + Ro, (x, y) => {
        const d2 = (x - c[0]) ** 2 + (y - c[1]) ** 2;
        return d2 <= Ro * Ro && d2 >= Ri * Ri;
      });
    } else {
      let segs;
      if (s.kind === 'rect') { // outline: the four edges as strokes
        const [a, b] = P;
        const q = [a, [b[0], a[1]], b, [a[0], b[1]], a];
        segs = q.slice(1).map((p, i) => [q[i], p]);
      } else {
        segs = P.length === 1 ? [[P[0], P[0]]] : P.slice(1).map((p, i) => [P[i], p]);
      }
      for (const [a, b] of segs) {
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        visit(Math.min(a[0], b[0]) - rr, Math.max(a[0], b[0]) + rr, Math.min(a[1], b[1]) - rr, Math.max(a[1], b[1]) + rr, (x, y) => {
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
          return (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 <= rr * rr;
        });
      }
    }
  }

  // Bucket fills work on a dense window of lattice nodes covering everything solid (+ margin).
  // A node's "colour" is 0 when empty, else 1 + 2 * material + group.
  const FILL_NEAR = 0.62; // a node belongs to a preset body if a particle is this close (>= hex circumradius)
  class FillWindow {
    constructor(x0, x1, y0, y1) {
      this.R0 = Math.floor(y0 / ROW) - 2; this.K0 = Math.floor(x0) - 2;
      this.RH = Math.ceil(y1 / ROW) + 3 - this.R0; this.KW = Math.ceil(x1) + 3 - this.K0;
    }
    idx(r, k) {
      const i = r - this.R0, j = k - this.K0;
      return i < 0 || j < 0 || i >= this.RH || j >= this.KW ? -1 : i * this.KW + j;
    }
  }
  function baseLabels(base, win) {
    const lab = new Uint16Array(win.RH * win.KW);
    for (let i = 0; i < base.x.length; i++) {
      const x = base.x[i], y = base.y[i], r0 = Math.round(y / ROW);
      const c = 1 + 2 * base.mat[i] + base.grp[i];
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        const o = (r & 1 ? 0.5 : 0) + LAT_X, k0 = Math.round(x - o), ny = r * ROW;
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          const nx = k + o;
          if ((nx - x) ** 2 + (ny - y) ** 2 > FILL_NEAR * FILL_NEAR) continue;
          const w = win.idx(r, k);
          if (w >= 0 && !lab[w]) lab[w] = c;
        }
      }
    }
    return lab;
  }

  // flood the region under the seed: flat [r, k, ...] list, or null if it is open space reaching
  // the edge of the window (it would fill the whole world)
  function floodRegion(seed, res, win, label) {
    const sy = seed[1] / res, r0 = Math.round(sy / ROW);
    const k0 = Math.round(seed[0] / res - (r0 & 1 ? 0.5 : 0) - LAT_X);
    const w0 = win.idx(r0, k0);
    if (w0 < 0) return null;
    const target = label(r0, k0, w0);
    const seen = new Uint8Array(win.RH * win.KW);
    const q = [w0];
    seen[w0] = 1;
    for (let h = 0; h < q.length; h++) {
      const w = q[h], i = (w / win.KW) | 0, j = w - i * win.KW;
      if (i === 0 || j === 0 || i === win.RH - 1 || j === win.KW - 1) {
        if (target === 0) return null;
        continue;
      }
      const r = i + win.R0, k = j + win.K0;
      const d = r & 1 ? 0 : -1; // diagonal neighbours sit half a column left (even rows) or right (odd rows)
      const up = w - win.KW + d, dn = w + win.KW + d;
      for (const [nw, nr, nk] of [[w - 1, r, k - 1], [w + 1, r, k + 1], [up, r - 1, k + d], [up + 1, r - 1, k + d + 1],
        [dn, r + 1, k + d], [dn + 1, r + 1, k + d + 1]]) {
        if (seen[nw] || label(nr, nk, nw) !== target) continue;
        seen[nw] = 1;
        q.push(nw);
      }
    }
    const out = new Int32Array(q.length * 2);
    q.forEach((w, n) => { const i = (w / win.KW) | 0; out[2 * n] = i + win.R0; out[2 * n + 1] = w - i * win.KW + win.K0; });
    return out;
  }

  // base: the preset particles ({ x, y, mat, grp } arrays, lattice units), needed by bucket fills
  function rasterizeDrawing(shapes, res, base) {
    const cells = new Map(), touched = new Set(), pins = new Set();
    const fillFailed = [];
    let win = null, baseLab = null;
    (shapes || []).forEach((s, si) => {
      if (!s.pts || !s.pts.length || s.kind === 'det') return;
      let nodes = (fn) => forShapeNodes(s, res, fn);
      if (s.kind === 'fill') {
        // the window covers everything solid so far; empty space touching its edge is open
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
        if (base) for (let i = 0; i < base.x.length; i++) grow(base.x[i], base.y[i]);
        for (const c of cells.values()) grow(c.k, c.r * ROW);
        if (!(x1 >= x0)) { fillFailed.push(si); return; }
        if (!win || win.R0 > Math.floor(y0 / ROW) - 2 || win.K0 > Math.floor(x0) - 2 ||
          win.R0 + win.RH < Math.ceil(y1 / ROW) + 3 || win.K0 + win.KW < Math.ceil(x1) + 3) {
          win = new FillWindow(x0, x1, y0, y1);
          baseLab = baseLabels(base || { x: [] }, win);
        }
        const label = (r, k, w) => {
          if (!touched.size) return baseLab[w];
          const key = latKey(r, k);
          const c = cells.get(key);
          if (c) return 1 + 2 * c.mat + c.grp;
          return touched.has(key) ? 0 : baseLab[w];
        };
        const region = floodRegion(s.pts[0], res, win, label);
        if (!region) { fillFailed.push(si); return; }
        nodes = (fn) => { for (let i = 0; i < region.length; i += 2) fn(region[i], region[i + 1]); };
      }
      if (s.role === 'anchor') { nodes((r, k) => pins.add(latKey(r, k))); return; }
      if (s.role === 'erase') {
        nodes((r, k) => { const key = latKey(r, k); cells.delete(key); touched.add(key); });
        return;
      }
      const mat = (MAT_BY_ID[s.mat] || MAT_BY_ID.rha).index;
      const proj = s.role === 'projectile';
      const a = (s.dir || 0) * Math.PI / 180, v = proj ? (s.v || 0) / 100 : 0;
      const entry = { mat, grp: proj ? 1 : 0, vx: v * Math.cos(a), vy: -v * Math.sin(a),
        body: `${s.role}|${s.mat}|${proj ? s.v + '|' + s.dir : ''}` };
      const { grp, vx, vy, body } = entry;
      nodes((r, k) => { const key = latKey(r, k); cells.set(key, { r, k, mat, grp, vx, vy, body }); touched.add(key); });
    });
    // true if any drawn/erased lattice node lies within contact range of (x, y)
    const near = (set, x, y, rad) => {
      if (!set.size) return false;
      const r0 = Math.round(y / ROW);
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        const o = (r & 1 ? 0.5 : 0) + LAT_X, k0 = Math.round(x - o);
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          if (!set.has(latKey(r, k))) continue;
          const [nx, ny] = latPos(r, k);
          if ((nx - x) ** 2 + (ny - y) ** 2 < rad * rad) return true;
        }
      }
      return false;
    };
    return { cells, fillFailed, touched: (x, y) => near(touched, x, y, 0.9), pinned: (x, y) => near(pins, x, y, 0.75) };
  }

  class Sim {
    constructor() {
      this.n = 0; this.nb = 0; this.time = 0; this.steps = 0;
      this.events = [];
    }

    build(scn) {
      const res = scn.res;
      this.res = res;
      this.usPerT = res * 10;
      this.explosionModel = scn.explosionModel === 'simple' ? 'simple' : 'gas';
      const u = (mm) => mm / res;
      const rnd = mulberry32(1337);
      const J = 0.02;
      const T = { x: [], y: [], vx: [], vy: [], mat: [], grp: [], body: [], pin: [], fz: [], fzm: [] };
      let bodyId = 0;
      const add = (x, y, vx, vy, mat, grp, pin) => {
        T.x.push(x + (rnd() - 0.5) * J); T.y.push(y + (rnd() - 0.5) * J);
        T.vx.push(vx); T.vy.push(vy); T.mat.push(mat); T.grp.push(grp); T.body.push(bodyId); T.pin.push(pin ? 1 : 0);
        T.fz.push(0); T.fzm.push(0); // fuze: mode 0 none, 1 armed on impact then delay, 2 absolute time
      };

      // ---- armor (local frame: x through thickness, y along plate) ----
      const th = (scn.angle || 0) * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      this.cos = cs; this.sin = sn;
      const Hh = u(scn.plateH) / 2;
      let lx = 0;
      let firstFront = null;
      this.layers = [];
      // layers touching each other (gap 0) form a group that is centred on the line of fire together
      const groupMid = [];
      {
        let x = 0, g0 = 0, gi = -1;
        scn.layers.forEach((layer, k) => {
          const gap = Math.round(u(layer.gap));
          if (k === 0 || gap > 0) { gi++; g0 = x + gap; }
          x += gap + Math.max(1, Math.round(u(layer.thick)));
          groupMid[k] = gi; groupMid[gi + 1000] = (g0 + x) / 2;
        });
      }
      for (let li = 0; li < scn.layers.length; li++) {
        const layer = scn.layers[li];
        lx += Math.round(u(layer.gap));
        const nc = Math.max(1, Math.round(u(layer.thick)));
        const m = MAT_BY_ID[layer.mat].index;
        if (firstFront === null) firstFront = lx;
        // shift each layer along its own plane so the line of fire hits its middle
        const yc = -groupMid[groupMid[li] + 1000] * sn / cs;
        for (let r = 0, y = -Hh; y <= Hh; r++, y = -Hh + r * ROW) {
          const odd = r & 1;
          const cols = nc === 1 ? 1 : (odd ? nc - 1 : nc);
          for (let k = 0; k < cols; k++) {
            const x = lx + 0.45 + k + (odd && nc > 1 ? 0.5 : 0);
            const pin = layer.fixed && Math.abs(y) > Hh - 2;
            const yy = y + yc;
            add(x * cs - yy * sn, x * sn + yy * cs, 0, 0, m, 0, pin);
          }
        }
        this.layers.push({ x0: lx, x1: lx + nc });
        lx += nc;
        bodyId++;
      }
      this.armorDepth = lx;
      this.armorFront = firstFront || 0;
      this.stackLos = (lx - this.armorFront) / Math.max(0.05, cs) * res;
      this.losThickness = this.layers.reduce((s, l) => s + (l.x1 - l.x0), 0) / Math.max(0.05, cs) * res;

      // ---- projectile ----
      const bodies = projectileBodies(scn.projectile, u);
      const pFuze = scn.projectile.fuze || (PROJECTILES[scn.projectile.type] || {}).fuze || null;
      const maxR = Math.max(0, ...bodies.map((b) => b.R));
      let frontX = Infinity;
      for (let i = 0; i < T.x.length; i++) if (Math.abs(T.y[i]) < maxR + 1 && T.x[i] < frontX) frontX = T.x[i];
      if (!isFinite(frontX)) frontX = 0;
      const tipLocal = Math.max(0, ...bodies.map((b) => b.x1));
      const offX = frontX - 3 - tipLocal;
      const offY = u(scn.offsetY || 0);
      for (const b of bodies) {
        const m = MAT_BY_ID[b.mat].index;
        const R = b.R;
        for (let r = 0, y = -R; y <= R; r++, y = -R + r * ROW) {
          for (let x = b.x0 + (r & 1 ? 0.5 : 0); x <= b.x1; x += 1) {
            const rad = b.radius(x);
            if (rad < 0 || Math.abs(y) > rad + 1e-6) continue;
            if (b.exclude && b.exclude(x, y)) continue;
            if (b.fuze && MEXP[m] && pFuze && pFuze.type !== 'none') {
              add(offX + x, offY + y, b.vel(x), 0, m, 1, false);
              const k = T.x.length - 1;
              T.fzm[k] = pFuze.type === 'time' ? 2 : 1;
              T.fz[k] = Math.max(0, pFuze.delay || 0) / this.usPerT;
              continue;
            }
            add(offX + x, offY + y, b.vel(x), 0, m, 1, false);
          }
        }
        bodyId++;
      }
      this.entryX = this.armorFront / Math.max(0.05, cs);

      // ---- user drawing: replaces / erases base material, adds new bodies ----
      this.fillFailed = [];
      if (scn.drawn && scn.drawn.length) {
        const ras = rasterizeDrawing(scn.drawn, res, T);
        this.fillFailed = ras.fillFailed;
        const keep = [];
        for (let i = 0; i < T.x.length; i++) {
          if (ras.touched(T.x[i], T.y[i])) continue;
          if (!T.grp[i] && ras.pinned(T.x[i], T.y[i])) T.pin[i] = 1;
          keep.push(i);
        }
        if (keep.length !== T.x.length) for (const key in T) T[key] = keep.map((i) => T[key][i]);
        const bodyOf = new Map();
        for (const c of ras.cells.values()) {
          if (!bodyOf.has(c.body)) bodyOf.set(c.body, bodyOf.size);
        }
        const base = bodyId;
        for (const c of ras.cells.values()) {
          const [x, y] = latPos(c.r, c.k);
          bodyId = base + bodyOf.get(c.body);
          add(x, y, c.vx, c.vy, c.mat, c.grp, !c.grp && ras.pinned(x, y));
        }
        bodyId = base + bodyOf.size;
      }

      // ---- allocate ----
      const n = T.x.length;
      this.n = n;
      this.px = Float64Array.from(T.x); this.py = Float64Array.from(T.y);
      this.vx = Float64Array.from(T.vx); this.vy = Float64Array.from(T.vy);
      this.fx = new Float64Array(n); this.fy = new Float64Array(n);
      this.mat = Uint8Array.from(T.mat); this.grp = Uint8Array.from(T.grp);
      this.body = Int32Array.from(T.body);
      this.alive = new Uint8Array(n).fill(1);
      this.invm = new Float64Array(n);
      this.heat = new Float32Array(n); this.stress = new Float32Array(n);
      // signed per-particle pressure: gas products = EOS pressure (>= 0); solids = virial sum
      // (contact compression +, bond tension -)
      this.pres = new Float32Array(n);
      this.detT = new Float64Array(n).fill(Infinity);
      this.uav = new Float64Array(n);  // smoothed speed of explosive particles (shock strength), persists across steps
      this.cellOf = new Int32Array(n); this.sorted = new Int32Array(n);
      const expl = [];
      this.projMass0 = 0;
      for (let i = 0; i < n; i++) {
        const m = this.mat[i];
        this.invm[i] = T.pin[i] ? 0 : 1 / MMASS[m];
        if (MEXP[m]) expl.push(i);
        if (this.grp[i] === 1) this.projMass0 += MMASS[m];
      }
      this.expl = Int32Array.from(expl);
      // fuzes: fz = delay in time units (mode 1, armed on impact) or absolute time (mode 2)
      this.fz = Float64Array.from(T.fz);
      this.fzm = Uint8Array.from(T.fzm);
      for (const i of expl) if (this.fzm[i] === 2) { this.detT[i] = Math.min(this.detT[i], this.fz[i]); this.fzm[i] = 0; }
      // detonator points: the explosive particles nearest the point fire at the detonator's delay
      for (const s of scn.drawn || []) {
        if (s.kind !== 'det' || !s.pts || !s.pts.length) continue;
        const cx = s.pts[0][0] / res, cy = s.pts[0][1] / res;
        let dmin = Infinity;
        for (const i of expl) dmin = Math.min(dmin, Math.hypot(this.px[i] - cx, this.py[i] - cy));
        if (!isFinite(dmin)) continue;
        const t0 = Math.max(0, +s.delay || 0) / this.usPerT;
        for (const i of expl) {
          if (Math.hypot(this.px[i] - cx, this.py[i] - cy) <= dmin + 1.2) this.detT[i] = Math.min(this.detT[i], t0);
        }
      }

      // bounds
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        if (this.px[i] < x0) x0 = this.px[i]; if (this.px[i] > x1) x1 = this.px[i];
        if (this.py[i] < y0) y0 = this.py[i]; if (this.py[i] > y1) y1 = this.py[i];
      }
      if (!n) { x0 = -50; x1 = 50; y0 = -50; y1 = 50; }
      this.fit = { x0, x1, y0, y1 };
      const span = Math.max(x1 - x0, y1 - y0);
      const mg = Math.max(60, span * 0.4);
      this.bx0 = Math.floor(x0 - mg * 0.5); this.bx1 = Math.ceil(x1 + mg * 1.5);
      this.by0 = Math.floor(y0 - mg); this.by1 = Math.ceil(y1 + mg);
      // dense cell grid (cell size 1) with a 1-cell border so neighbour offsets never leave the array
      this.gw = this.bx1 - this.bx0 + 3;
      this.gh = this.by1 - this.by0 + 3;
      this.cellStart = new Int32Array(this.gw * this.gh + 1);
      this.cellFill = new Int32Array(this.gw * this.gh);

      // ---- bonds ----
      this.buildGrid();
      this.reorder();
      const ba = [], bb = [], br = [];
      const { px, py, body } = this;
      this.forPairs(BOND_RANGE, (i, j, d) => {
        if (body[i] === body[j]) { ba.push(i); bb.push(j); br.push(d); }
      });
      this.nb = ba.length;
      this.ba = Int32Array.from(ba); this.bb = Int32Array.from(bb);
      this.brest = Float64Array.from(br); this.borig = Float64Array.from(br);
      this.time = 0; this.steps = 0; this.vmax = 0; this.events = [];
      this.dtStab = Infinity;
      const present = new Set(T.mat);
      for (const m of present) this.dtStab = Math.min(this.dtStab, DT_FACTOR * 106 / MATS[m].c);
      if (!isFinite(this.dtStab)) this.dtStab = DT_FACTOR;
      this.gasDt = Infinity; // CFL limit for detonation products, updated every step by sph()
      this.rhoS = null; this.prS = null;
      this.updateVmax();
    }

    updateVmax() {
      let v2 = 0;
      for (let i = 0; i < this.n; i++) if (this.alive[i]) {
        const s = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
        if (s > v2) v2 = s;
      }
      this.vmax = Math.sqrt(v2);
    }

    buildGrid() {
      const { n, px, py, alive, cellOf, cellStart, cellFill, sorted, gw } = this;
      const bx = this.bx0 - 1, by = this.by0 - 1;
      let cmin = cellStart.length, cmax = -1;
      for (let i = 0; i < n; i++) {
        if (!alive[i]) { cellOf[i] = -1; continue; }
        const c = ((px[i] - bx) | 0) + ((py[i] - by) | 0) * gw;
        cellOf[i] = c;
        if (c < cmin) cmin = c;
        if (c > cmax) cmax = c;
      }
      // only the occupied range (plus one row for the forward stencil) is valid in cellStart
      const lo = Math.max(0, cmin), hi = Math.min(cellStart.length - 1, cmax + gw + 2);
      this.cLo = lo; this.cHi = hi;
      if (hi < lo) { this.nAlive = 0; return; }
      cellStart.fill(0, lo, hi + 1);
      for (let i = 0; i < n; i++) { const c = cellOf[i]; if (c >= 0) cellStart[c + 1]++; }
      for (let c = lo; c < hi; c++) cellStart[c + 1] += cellStart[c];
      cellFill.set(cellStart.subarray(lo, hi), lo);
      for (let i = 0; i < n; i++) {
        const c = cellOf[i];
        if (c >= 0) sorted[cellFill[c]++] = i;
      }
      this.nAlive = cellStart[hi];
    }

    // Permute particle storage into grid order (better cache locality) and drop dead particles.
    reorder() {
      const { sorted } = this;
      const m = this.nAlive, n = this.n;
      const inv = new Int32Array(n).fill(-1);
      for (let k = 0; k < m; k++) inv[sorted[k]] = k;
      const perm = (arr) => {
        const out = new arr.constructor(arr.length);
        for (let k = 0; k < m; k++) out[k] = arr[sorted[k]];
        return out;
      };
      for (const key of ['px', 'py', 'vx', 'vy', 'mat', 'grp', 'body', 'alive', 'invm', 'heat', 'detT', 'uav', 'pres', 'fz', 'fzm']) this[key] = perm(this[key]);
      this.n = m;
      // explosive index list refers to storage positions, so it must be rebuilt after the permutation
      const exNew = [];
      for (let i = 0; i < m; i++) if (this.alive[i] && MEXP[this.mat[i]]) exNew.push(i);
      this.expl = Int32Array.from(exNew);
      if (this.ba) {
        const { ba, bb, brest, borig } = this;
        let w = 0;
        for (let b = 0; b < this.nb; b++) {
          const i = inv[ba[b]], j = inv[bb[b]];
          if (i < 0 || j < 0) continue;
          ba[w] = i; bb[w] = j; brest[w] = brest[b]; borig[w] = borig[b]; w++;
        }
        this.nb = w;
      }
      for (let k = 0; k < m; k++) sorted[k] = k;
      for (let k = 0; k < m; k++) this.cellOf[k] = -1;
      this.buildGrid();
    }

    // visit every unordered pair closer than r (r <= 1) once
    forPairs(r, fn) {
      const { px, py, sorted, cellStart, gw } = this;
      const r2 = r * r;
      const offs = [1, gw - 1, gw, gw + 1];
      for (let c = this.cLo; c < this.cHi - gw - 1; c++) {
        const s0 = cellStart[c], s1 = cellStart[c + 1];
        if (s0 === s1) continue;
        for (let a = s0; a < s1; a++) {
          const i = sorted[a];
          const test = (j) => {
            const dx = px[j] - px[i], dy = py[j] - py[i], d2 = dx * dx + dy * dy;
            if (d2 < r2) fn(i, j, Math.sqrt(d2));
          };
          for (let b = a + 1; b < s1; b++) test(sorted[b]);
          for (const o of offs) for (let b = cellStart[c + o], e = cellStart[c + o + 1]; b < e; b++) test(sorted[b]);
        }
      }
    }

    step(dt) {
      if (this.steps % 64 === 0) { this.buildGrid(); this.reorder(); } else this.buildGrid();
      const n = this.n;
      this.fx.fill(0, 0, n); this.fy.fill(0, 0, n); this.stress.fill(0, 0, n); this.pres.fill(0, 0, n);
      this.contacts(dt);
      if (this.explosionModel === 'gas') this.sph();
      this.bonds();
      this.integrate(dt);
      this.time += dt;
      this.steps++;
      if (this.expl.length) this.detonations(dt);
    }

    // Detonation products (gas model). Density is an SPH sum over explosive-type particles; pressure
    // follows the isentrope of each explosive's products. Each product pushes every neighbour within 2h,
    // and non-product neighbours get the equal and opposite force, so momentum is conserved.
    sph() {
      const { sorted, nAlive, px, py, mat, alive, fx, fy, cellStart, gw, gh, cLo, cHi, n } = this;
      if (!this.rhoS || this.rhoS.length < n) { this.rhoS = new Float64Array(n); this.prS = new Float64Array(n); }
      const rho = this.rhoS, pr = this.prS;
      const H2 = (2 * H_SPH) * (2 * H_SPH);
      const gas = [];
      for (let a = 0; a < nAlive; a++) if (MGAS[mat[sorted[a]]]) gas.push(sorted[a]);
      if (!gas.length) { this.gasDt = Infinity; return; }

      // density (all products first, so pair terms use the same field on both sides)
      for (const i of gas) {
        const xi = px[i], yi = py[i];
        const ci = (xi - this.bx0 + 1) | 0, cj = (yi - this.by0 + 1) | 0;
        let s = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const Y = cj + dy;
          if (Y < 0 || Y >= gh) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const X = ci + dx;
            if (X < 0 || X >= gw) continue;
            const cc = X + Y * gw;
            if (cc < cLo || cc >= cHi) continue;
            for (let b = cellStart[cc], e = cellStart[cc + 1]; b < e; b++) {
              const j = sorted[b];
              if (!MDEN[mat[j]]) continue;
              const ex = px[j] - xi, ey = py[j] - yi, d2 = ex * ex + ey * ey;
              if (d2 < H2) s += MMASS[mat[j]] * kw(Math.sqrt(d2) / H_SPH);
            }
          }
        }
        rho[i] = s * SPH_KW;
      }

      // pressure, sound speed (CFL) and smoke removal
      let cmax2 = 0;
      for (const i of gas) {
        const r = rho[i], t = mat[i];
        pr[i] = pressure(r, t);
        this.pres[i] = pr[i];
        const c2 = (r >= GRHOC[t] ? GAMMA_HI : GAMMA_LO) * pr[i] / r;
        if (c2 > cmax2) cmax2 = c2;
        if (r < GAS_CUT * GRHO0[t]) alive[i] = 0;
      }
      this.gasDt = 0.4 * H_SPH / Math.sqrt(cmax2);

      // pair forces: F_i = m_i m_j S dW/dr (x_i - x_j)/r with S = P_i/rho_i^2 (+ P_j/rho_j^2 for products)
      for (const i of gas) {
        if (!alive[i]) continue;
        const xi = px[i], yi = py[i];
        const Si = pr[i] / (rho[i] * rho[i]), mi = MMASS[mat[i]];
        const ci = (xi - this.bx0 + 1) | 0, cj = (yi - this.by0 + 1) | 0;
        let fxi = 0, fyi = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const Y = cj + dy;
          if (Y < 0 || Y >= gh) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const X = ci + dx;
            if (X < 0 || X >= gw) continue;
            const cc = X + Y * gw;
            if (cc < cLo || cc >= cHi) continue;
            for (let b = cellStart[cc], e = cellStart[cc + 1]; b < e; b++) {
              const j = sorted[b];
              if (j === i || !alive[j]) continue;
              const ex = px[j] - xi, ey = py[j] - yi, d2 = ex * ex + ey * ey;
              if (d2 >= H2 || d2 < 1e-12) continue;
              const d = Math.sqrt(d2);
              const dwdr = SPH_KW * dkw(d / H_SPH) / H_SPH; // <= 0
              let S = Si;
              const gasJ = MGAS[mat[j]];
              if (gasJ) S += pr[j] / (rho[j] * rho[j]);
              const k = mi * MMASS[mat[j]] * S * dwdr / d;
              fxi += k * ex; fyi += k * ey;
              if (!gasJ) { fx[j] -= k * ex; fy[j] -= k * ey; }
            }
          }
        }
        fx[i] += fxi; fy[i] += fyi;
      }
    }

    contacts(dt) {
      const { px, py, vx, vy, fx, fy, mat, heat, sorted, cellStart, cellOf, gw, pres } = this;
      const o1 = 1, o2 = gw - 1, o3 = gw, o4 = gw + 1;

      // ---- contacts (half stencil: own cell + E, SW, S, SE) ----
      // detonation products take no contact forces; they interact through sph()
      const nAlive = this.nAlive;
      for (let a = 0; a < nAlive; a++) {
        const i = sorted[a];
        if (MGAS[mat[i]]) continue;
        const xi = px[i], yi = py[i], vxi = vx[i], vyi = vy[i], mi = mat[i] * NM;
        const c = cellOf[i];
        let fxi = 0, fyi = 0, hi = 0, vi = 0;
        for (let q = 0; q < 5; q++) {
          let b, e;
          if (q === 0) { b = a + 1; e = cellStart[c + 1]; }
          else { const cc = c + (q === 1 ? o1 : q === 2 ? o2 : q === 3 ? o3 : o4); b = cellStart[cc]; e = cellStart[cc + 1]; }
          for (; b < e; b++) {
            const j = sorted[b];
            if (MGAS[mat[j]]) continue;
            const ddx = px[j] - xi, ddy = py[j] - yi;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 >= R0SQ || d2 < 1e-12) continue;
            const d = Math.sqrt(d2);
            const nx = ddx / d, ny = ddy / d, ov = R0 - d;
            const pk = mi + mat[j];
            const rvx = vx[j] - vxi, rvy = vy[j] - vyi;
            const vn = rvx * nx + rvy * ny;
            let f = KC[pk] * ov * (1 + 8 * ov * ov);
            let tx = 0, ty = 0;
            if (vn < 0) {
              f -= CC[pk] * vn;
              const hs = -vn - HEAT_V;
              if (hs > 0) { const h = hs * HEAT_K * dt; hi += h; heat[j] += h; }
            }
            const tvx = rvx - vn * nx, tvy = rvy - vn * ny;
            const tv = Math.sqrt(tvx * tvx + tvy * tvy);
            if (tv > 1e-6) {
              const ft = Math.min(CC[pk] * tv, FRICTION * Math.abs(f));
              tx = ft * tvx / tv; ty = ft * tvy / tv;
            }
            const ex = f * nx - tx, ey = f * ny - ty;
            fxi -= ex; fyi -= ey;
            fx[j] += ex; fy[j] += ey;
            const vv = f * d;
            vi += vv; pres[j] += vv;
          }
        }
        fx[i] += fxi; fy[i] += fyi; heat[i] += hi; pres[i] += vi;
      }
    }

    bonds() {
      const { ba, bb, brest, borig, px, py, vx, vy, fx, fy, mat, alive, heat, stress, pres } = this;
      let nb = this.nb;
      for (let b = 0; b < nb; b++) {
        const i = ba[b], j = bb[b];
        if (!alive[i] || !alive[j] || MGAS[mat[i]] || MGAS[mat[j]]) { nb--; ba[b] = ba[nb]; bb[b] = bb[nb]; brest[b] = brest[nb]; borig[b] = borig[nb]; b--; continue; }
        const m = mat[i];
        const ddx = px[j] - px[i], ddy = py[j] - py[i];
        const len = Math.sqrt(ddx * ddx + ddy * ddy) + 1e-12;
        const o = borig[b];
        const tot = (len - o) / o;
        if (tot > MFR[m] || -tot > MCR[m] || heat[i] > MMELT[m] || heat[j] > MMELT[m]) {
          heat[i] += BREAK_HEAT; heat[j] += BREAK_HEAT;
          nb--; ba[b] = ba[nb]; bb[b] = bb[nb]; brest[b] = brest[nb]; borig[b] = borig[nb]; b--; continue;
        }
        let r = brest[b];
        const Y = MY[m] * o;
        if (len - r > Y) { const nr = len - Y; const h = (nr - r) * PLASTIC_HEAT; heat[i] += h; heat[j] += h; r = nr; }
        else if (r - len > Y && r > MIN_REST * o) { let nr = len + Y; if (nr < MIN_REST * o) nr = MIN_REST * o; const h = (r - nr) * PLASTIC_HEAT; heat[i] += h; heat[j] += h; r = nr; }
        brest[b] = r;
        const nx = ddx / len, ny = ddy / len;
        const vn = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
        const f = MK[m] * (len - r) + MCB[m] * vn;
        fx[i] += f * nx; fy[i] += f * ny; fx[j] -= f * nx; fy[j] -= f * ny;
        const vb = f * len;
        pres[i] -= vb; pres[j] -= vb;
        const s = Math.abs(tot) / MFR[m];
        if (s > stress[i]) stress[i] = s;
        if (s > stress[j]) stress[j] = s;
      }
      this.nb = nb;
    }

    integrate(dt) {
      const { n, px, py, vx, vy, fx, fy, alive, heat, invm } = this;
      const decay = Math.exp(-dt / 20);
      const bx0 = this.bx0, bx1 = this.bx1, by0 = this.by0, by1 = this.by1;
      let v2max = 0;
      for (let i = 0; i < n; i++) {
        if (!alive[i]) continue;
        const im = invm[i];
        if (im === 0) { vx[i] = 0; vy[i] = 0; continue; }
        let a = vx[i] + fx[i] * im * dt, c = vy[i] + fy[i] * im * dt;
        vx[i] = a; vy[i] = c;
        px[i] += a * dt; py[i] += c * dt;
        let h = heat[i] * decay;
        heat[i] = h > 2 ? 2 : h;
        const s = a * a + c * c;
        if (s > v2max) v2max = s;
        if (px[i] < bx0 || px[i] > bx1 || py[i] < by0 || py[i] > by1 || s !== s) alive[i] = 0;
      }
      this.vmax = Math.sqrt(v2max);
    }

    detonations(dt) {
      if (this.explosionModel === 'simple') this.detonationsSimple();
      else this.detonationsGas(dt);
    }

    // Gas model: a fired explosive becomes its detonation products and stays in the sim. The front only
    // spreads to touching explosive particles. Initiation is either the smoothed particle speed of the
    // explosive (shock strength) passing the material's threshold, or a very high heat (cook-off).
    detonationsGas(dt) {
      const { expl, alive, heat, detT, uav, vx, vy, px, py, mat, invm, sorted, cellStart, gw, fz, fzm } = this;
      const now = this.time;
      const aTU = Math.min(1, dt / DET_TU);
      const fire = [];
      for (let k = 0; k < expl.length; k++) {
        const i = expl[k];
        if (!alive[i] || !MEXP[mat[i]]) continue;
        const t = mat[i];
        const sp = Math.hypot(vx[i], vy[i]);
        uav[i] += (sp - uav[i]) * aTU;
        // impact fuze: arms once moving fast, then delays firing when the speed drops sharply (target impact)
        if (fzm[i] === 1 && uav[i] > ARM_SPEED) fzm[i] = 3;
        if (fzm[i] === 3 && sp < IMPACT_DROP * uav[i]) { detT[i] = Math.min(detT[i], now + fz[i]); fzm[i] = 0; }
        if (detT[i] > now && (uav[i] > MUCRIT[t] || heat[i] > DET_HEAT_HI)) detT[i] = now;
        if (detT[i] <= now) fire.push(i);
      }
      for (const i of fire) {
        mat[i] = PROD_OF[mat[i]];
        invm[i] = 1 / MMASS[mat[i]];
        const xi = px[i], yi = py[i];
        const ci = ((xi - this.bx0 + 1) | 0), cj = ((yi - this.by0 + 1) | 0);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const X = ci + dx, Y = cj + dy;
          if (X < 0 || Y < 0 || X >= gw || Y >= this.gh) continue;
          const cc = X + Y * gw;
          if (cc < this.cLo || cc >= this.cHi) continue;
          for (let b = cellStart[cc], e = cellStart[cc + 1]; b < e; b++) {
            const j = sorted[b];
            if (!alive[j] || !MEXP[mat[j]]) continue;
            const ddx = px[j] - xi, ddy = py[j] - yi;
            const d = Math.sqrt(ddx * ddx + ddy * ddy);
            if (d > DET_TOUCH || d < 1e-6) continue;
            const t = now + d / MDSP[mat[j]];
            if (t < detT[j]) detT[j] = t;
          }
        }
        if ((i & 3) === 0) this.events.push({ x: xi, y: yi, t: now });
      }
      let w = 0;
      for (let k = 0; k < expl.length; k++) { const i = expl[k]; if (alive[i] && MEXP[mat[i]]) expl[w++] = i; }
      this.expl = expl.slice(0, w);
    }

    // Legacy model: instant removal and a radial blast kick on non-explosive neighbours.
    detonationsSimple() {
      const { expl, alive, heat, detT, px, py, vx, vy, mat, invm, sorted, cellStart, gw } = this;
      const now = this.time;
      const fire = [];
      for (let k = 0; k < expl.length; k++) {
        const i = expl[k];
        if (!alive[i]) continue;
        if (heat[i] > DET_HEAT && detT[i] > now) detT[i] = now;
        if (detT[i] <= now) fire.push(i);
      }
      for (const i of fire) {
        alive[i] = 0;
        const xi = px[i], yi = py[i];
        const ci = ((xi - this.bx0 + 1) | 0), cj = ((yi - this.by0 + 1) | 0);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const X = ci + dx, Y = cj + dy;
          if (X < 0 || Y < 0 || X >= gw || Y >= this.gh) continue;
          const cc = X + Y * gw;
          if (cc < this.cLo || cc >= this.cHi) continue;
          for (let b = cellStart[cc], e = cellStart[cc + 1]; b < e; b++) {
            const j = sorted[b];
            if (!alive[j]) continue;
            const ddx = px[j] - xi, ddy = py[j] - yi;
            const d = Math.sqrt(ddx * ddx + ddy * ddy);
            if (d > BLAST_R || d < 1e-6) continue;
            if (MEXP[mat[j]]) {
              const t = now + d / DET_SPEED;
              if (t < detT[j]) detT[j] = t;
            } else {
              const J = BLAST_J * (1 - d / BLAST_R);
              vx[j] += J * ddx / d * invm[j];
              vy[j] += J * ddy / d * invm[j];
              heat[j] += 0.15 * (1 - d / BLAST_R);
            }
          }
        }
        if ((i & 3) === 0) this.events.push({ x: xi, y: yi, t: now });
      }
    }

    // advance by `us` microseconds of simulated time, at most maxSteps substeps
    // maxSteps caps work per frame; the wall-clock budget keeps the UI responsive on big scenes
    advance(us, maxSteps, budgetMs = 30) {
      const t0 = performance.now();
      let remaining = us / this.usPerT;
      let steps = 0;
      while (remaining > 1e-9 && steps < maxSteps && (steps === 0 || performance.now() - t0 < budgetMs)) {
        const dt = Math.min(this.dtStab, this.gasDt, 0.15 / Math.max(1e-6, this.vmax), remaining);
        this.step(dt);
        remaining -= dt;
        steps++;
      }
      return { steps, lagging: remaining > 1e-9 };
    }

    stats() {
      const { n, alive, grp, mat, px, py, vx, cos, sin } = this;
      let mAlive = 0, mBehind = 0, pBehind = 0, maxX = -Infinity;
      for (let i = 0; i < n; i++) {
        if (grp[i] !== 1 || !alive[i]) continue;
        const m = MMASS[mat[i]];
        mAlive += m;
        const lx = px[i] * cos + py[i] * sin;
        if (lx > this.armorDepth + 1) { mBehind += m; pBehind += m * vx[i]; }
        if (px[i] > maxX) maxX = px[i];
      }
      const pm0 = this.projMass0 || 1;
      return {
        timeUs: this.time * this.usPerT,
        massLeft: mAlive / pm0,
        massBehind: mBehind / pm0,
        residualV: mBehind > 0 ? (pBehind / mBehind) * 100 : 0,
        depthMm: Math.max(0, Math.min(this.stackLos, (maxX - this.entryX) * this.res)),
        perforated: mBehind / pm0 > 0.02,
        bonds: this.nb,
      };
    }
  }


  // Packed parameter table read by the GPU kernels (layout defined in sim.js).
  // Per-material tables have MAXM slots each. Pair tables are indexed a*NM+b. Scalars sit at MTL.CONST.
  const MAXM = 32;
  const MTL = {
    MK: 0, MY: 32, MFR: 64, MCR: 96, MMELT: 128, MCB: 160, MEXP: 192, MGAS: 224, MDEN: 256, MMASS: 288,
    MUCRIT: 320, MDSP: 352, GRHO0: 384, GP0: 416, GRHOC: 448, GPC: 480, PROD: 512,
    KC: 544, CC: 1568, CONST: 2592, LEN: 2624,
  };
  // scalar slot i of MTL.CONST: 0..10 contact/detonation (simple model), 11..18 gas model
  const SCALARS = [R0, HEAT_V, HEAT_K, PLASTIC_HEAT, MIN_REST, BREAK_HEAT, FRICTION, DET_HEAT, DET_SPEED, BLAST_R, BLAST_J,
    H_SPH, SPH_KW, GAMMA_HI, GAMMA_LO, GAS_CUT, DET_TOUCH, DET_HEAT_HI, DET_TU];
  function packMT() {
    if (NM > MAXM) throw new Error(`too many materials for the packed table (${NM} > ${MAXM})`);
    const mt = new Float64Array(MTL.LEN);
    const put = (base, arr) => { for (let m = 0; m < NM; m++) mt[base + m] = arr[m]; };
    put(MTL.MK, MK); put(MTL.MY, MY); put(MTL.MFR, MFR); put(MTL.MCR, MCR); put(MTL.MMELT, MMELT); put(MTL.MCB, MCB);
    put(MTL.MEXP, MEXP); put(MTL.MGAS, MGAS); put(MTL.MDEN, MDEN); put(MTL.MMASS, MMASS);
    put(MTL.MUCRIT, MUCRIT); put(MTL.MDSP, MDSP); put(MTL.GRHO0, GRHO0); put(MTL.GP0, GP0);
    put(MTL.GRHOC, GRHOC); put(MTL.GPC, GPC); put(MTL.PROD, PROD_OF);
    mt.set(KC, MTL.KC); mt.set(CC, MTL.CC);
    mt.set(SCALARS, MTL.CONST);
    return mt;
  }

  // shared with the WebAssembly and WebGPU engines so all engines use identical physics parameters
  const PHYS = {
    R0, HEAT_V, HEAT_K, PLASTIC_HEAT, MIN_REST, BREAK_HEAT, FRICTION, DET_HEAT, DET_SPEED, BLAST_R, BLAST_J,
    NM, MK, MY, MFR, MCR, MMELT, MCB, MMASS, MEXP, KC, CC,
    H_SPH, SPH_KW, GAMMA_HI, GAMMA_LO, GAS_CUT, DET_TOUCH, DET_HEAT_HI, DET_UCRIT, DET_TU, MUCRIT,
    GRHO0, GP0, GRHOC, GPC, MDSP, PROD_OF, MGAS, MDEN,
    MAXM, MTL, packMT,
  };

  G.ImpactSim = { Sim, MATS, MAT_BY_ID, PROJECTILES, PHYS };
})(typeof window !== 'undefined' ? window : globalThis);
