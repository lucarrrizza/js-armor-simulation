'use strict';
(function () {
  const { Sim, MATS, MAT_BY_ID, PROJECTILES } = window.ImpactSim;
  const $ = (id) => document.getElementById(id);

  const L = (mat, thick, gap = 0, fixed = true) => ({ mat, thick, gap, fixed });
  const PRESETS = {
    rha150: { name: 'RHA plate 150 mm', angle: 0, plateH: 500, layers: [L('rha', 150)] },
    rha500: { name: 'RHA block 500 mm', angle: 0, plateH: 400, layers: [L('rha', 500)] },
    sloped: { name: 'Sloped RHA 80 mm @ 60°', angle: 60, plateH: 600, layers: [L('rha', 80)] },
    thin: { name: 'Thin steel 20 mm', angle: 0, plateH: 400, layers: [L('rha', 20)] },
    spaced: { name: 'Spaced: HHS 15 + 250 gap + RHA 100', angle: 0, plateH: 500, layers: [L('hhs', 15), L('rha', 100, 250)] },
    composite: { name: 'Composite: steel / ceramic / steel', angle: 0, plateH: 500, layers: [L('rha', 40), L('ceramic', 90), L('rha', 40)] },
    glacis: { name: 'Glacis: 60 steel + 105 textolite + 50 @ 68°', angle: 68, plateH: 900, layers: [L('rha', 60), L('glass', 105), L('rha', 50)] },
    nera: { name: 'NERA sandwiches + backing', angle: 50, plateH: 700, layers: [
      L('hhs', 15), L('rha', 6, 40, false), L('rubber', 9, 0, false), L('rha', 6, 0, false),
      L('rha', 6, 40, false), L('rubber', 9, 0, false), L('rha', 6, 0, false), L('rha', 80, 40)] },
    era: { name: 'ERA tile + RHA 120 @ 60°', angle: 60, plateH: 500, layers: [
      L('rha', 5, 0, false), L('explosive', 8, 0, false), L('rha', 5, 0, false), L('rha', 120, 120)] },
    alu: { name: 'Aluminium 250 mm', angle: 0, plateH: 500, layers: [L('alu', 250)] },
    custom: { name: 'Custom', angle: 0, plateH: 500, layers: [L('rha', 100)] },
  };

  // ---------- UI setup ----------
  const pType = $('pType'), pMat = $('pMat'), preset = $('preset'), rows = $('layerRows');
  for (const [k, p] of Object.entries(PROJECTILES)) pType.add(new Option(p.name, k));
  for (const m of MATS) pMat.add(new Option(m.name, m.id));
  for (const [k, p] of Object.entries(PRESETS)) preset.add(new Option(p.name, k));

  let layers = [];

  function loadProjectileDefaults() {
    const p = PROJECTILES[pType.value];
    pMat.value = p.mat; $('pD').value = p.D; $('pL').value = p.L; $('pV').value = p.v;
  }
  function loadPreset() {
    const p = PRESETS[preset.value];
    layers = p.layers.map((l) => Object.assign({}, l));
    $('angle').value = p.angle; $('plateH').value = p.plateH;
    renderRows(); updateLabels();
  }
  function renderRows() {
    rows.innerHTML = '';
    layers.forEach((l, i) => {
      const tr = document.createElement('tr');
      const sel = document.createElement('select');
      for (const m of MATS) sel.add(new Option(m.name, m.id));
      sel.value = l.mat;
      sel.onchange = () => { l.mat = sel.value; markCustom(); };
      const num = (key, min) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = min; inp.step = 1; inp.value = l[key];
        inp.onchange = () => { l[key] = Math.max(min, +inp.value || 0); markCustom(); };
        return inp;
      };
      const fix = document.createElement('input');
      fix.type = 'checkbox'; fix.checked = l.fixed;
      fix.onchange = () => { l.fixed = fix.checked; markCustom(); };
      const del = document.createElement('button');
      del.textContent = '×';
      del.onclick = () => { layers.splice(i, 1); renderRows(); markCustom(); };
      [sel, num('thick', 1), num('gap', 0), fix, del].forEach((el) => {
        const td = document.createElement('td'); td.appendChild(el); tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
  }
  function markCustom() {
    preset.value = 'custom';
    PRESETS.custom.layers = layers.map((l) => Object.assign({}, l));
    PRESETS.custom.angle = +$('angle').value; PRESETS.custom.plateH = +$('plateH').value;
    rebuild();
  }
  $('addLayer').onclick = () => { layers.push(L('rha', 50, 0)); renderRows(); markCustom(); };
  pType.onchange = () => { loadProjectileDefaults(); rebuild(); };
  preset.onchange = () => { loadPreset(); rebuild(); };
  ['pMat', 'pD', 'pL', 'pV', 'pOff', 'res', 'plateH'].forEach((id) => $(id).addEventListener('change', rebuild));
  $('angle').addEventListener('input', updateLabels);
  $('angle').addEventListener('change', rebuild);
  $('speed').addEventListener('input', updateLabels);

  function usPerFrame() { return Math.pow(10, +$('speed').value); }
  function updateLabels() {
    $('angleVal').textContent = $('angle').value + '°';
    const s = usPerFrame();
    $('speedVal').textContent = (s < 1 ? s.toFixed(2) : s.toFixed(1)) + ' µs';
  }

  // ---------- simulation ----------
  let sim = null, running = false, scenario = null;

  function scenarioFromUI() {
    return {
      res: +$('res').value,
      angle: +$('angle').value,
      plateH: Math.max(20, +$('plateH').value),
      layers: layers.map((l) => Object.assign({}, l)),
      offsetY: +$('pOff').value || 0,
      projectile: {
        type: pType.value, mat: pMat.value,
        D: Math.max(1, +$('pD').value), L: Math.max(1, +$('pL').value), v: Math.max(1, +$('pV').value),
      },
    };
  }

  function rebuild(keepCamera) {
    if (!engineReady) return;
    scenario = scenarioFromUI();
    sim = engineObj || new Sim();
    sim.build(scenario);
    running = false;
    $('pause').textContent = 'Play (Space)';
    $('count').textContent = `${sim.n.toLocaleString()} particles · ${sim.nb.toLocaleString()} bonds` +
      (sim.n > 60000 && engineKind === 'js' ? ' — heavy! try the GPU / multi-core engine or a coarser resolution' : '');
    setupBuffers();
    if (keepCamera !== true) fitView();
    buildLegend();
    lastStats = sim.stats();
  }

  // ---------- engines ----------
  const engineSel = $('engine'), threadsSel = $('threads');
  const hwThreads = navigator.hardwareConcurrency || 4;
  for (let t = 1; t <= Math.min(64, hwThreads); t++) threadsSel.add(new Option(String(t), String(t)));
  threadsSel.value = String(Math.max(1, Math.min(hwThreads - 1, Math.round(hwThreads * 0.5))));
  const engineAvail = { gpu: GpuSim.available(), wasm: WasmSim.available(), js: true };
  const engineWhy = { gpu: 'no WebGPU in this browser', wasm: 'start with: python3 serve.py' };
  for (const o of engineSel.options) {
    if (!engineAvail[o.value]) { o.disabled = true; o.textContent += ` — ${engineWhy[o.value]}`; }
  }
  const engineCache = {};
  let engineKind = 'js', engineObj = null, engineReady = false;

  async function createEngine(kind) {
    if (kind === 'gpu') return engineCache.gpu || (engineCache.gpu = await GpuSim.create());
    if (kind === 'wasm') {
      const t = +threadsSel.value;
      if (engineCache.wasm && engineCache.wasm.threads !== t) { engineCache.wasm.dispose(); engineCache.wasm = null; }
      return engineCache.wasm || (engineCache.wasm = await WasmSim.create(t));
    }
    return null;
  }

  async function selectEngine(kind) {
    running = false;
    engineReady = false;
    $('engineInfo').textContent = 'starting engine…';
    let msg = '';
    try {
      if (!engineAvail[kind]) throw new Error(engineWhy[kind]);
      engineObj = await createEngine(kind);
      engineKind = kind;
    } catch (e) {
      console.error(e);
      msg = `${kind === 'gpu' ? 'GPU' : 'multi-core'} engine unavailable (${e.message}); using single-core JS. `;
      engineObj = null; engineKind = 'js';
    }
    engineSel.value = engineKind;
    $('threadsRow').style.display = engineKind === 'wasm' ? '' : 'none';
    $('engineInfo').textContent = msg + 'Running on ' + (engineObj ? engineObj.engineName : 'single-core CPU (JS)');
    try { localStorage.setItem('impactEngine', engineKind); } catch (e) { /* storage disabled */ }
    engineReady = true;
    rebuild(!!sim);
  }
  engineSel.addEventListener('change', () => selectEngine(engineSel.value));
  threadsSel.addEventListener('change', () => selectEngine('wasm'));

  function initialEngine() {
    let want = new URLSearchParams(location.search).get('engine');
    if (!want) try { want = localStorage.getItem('impactEngine'); } catch (e) { /* storage disabled */ }
    if (want && engineAvail[want]) return want;
    return engineAvail.gpu ? 'gpu' : engineAvail.wasm ? 'wasm' : 'js';
  }

  function fire() {
    if (!engineReady) return;
    const cam0 = Object.assign({}, cam);
    rebuild(true);
    Object.assign(cam, cam0);
    running = true;
    $('pause').textContent = 'Pause (Space)';
  }

  $('fire').onclick = fire;
  $('pause').onclick = togglePause;
  $('stepBtn').onclick = () => {
    running = false; $('pause').textContent = 'Play (Space)';
    if (!sim || advancing) return;
    advancing = true;
    Promise.resolve(sim.advance(usPerFrame(), 400)).finally(() => { advancing = false; });
  };
  $('fitBtn').onclick = fitView;
  function togglePause() { running = !running; $('pause').textContent = running ? 'Pause (Space)' : 'Play (Space)'; }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (e.key === 'r' || e.key === 'R') fire();
    else if (e.key === 'f' || e.key === 'F') fitView();
    else if (e.key === '.') $('stepBtn').onclick();
  });

  // ---------- rendering ----------
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const SS = 2;               // offscreen pixels per world unit
  const GS = 0.5;             // glow buffer pixels per world unit
  const off = document.createElement('canvas'), offCtx = off.getContext('2d');
  const glowC = document.createElement('canvas'), glowCtx = glowC.getContext('2d');
  let img, buf32, glowImg, glow32, gR, gG, gB;
  const cam = { x: 0, y: 0, scale: 2 };
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);

  function setupBuffers() {
    off.width = Math.ceil((sim.bx1 - sim.bx0) * SS) + 2;
    off.height = Math.ceil((sim.by1 - sim.by0) * SS) + 2;
    img = offCtx.createImageData(off.width, off.height);
    buf32 = new Uint32Array(img.data.buffer);
    glowC.width = Math.ceil((sim.bx1 - sim.bx0) * GS) + 2;
    glowC.height = Math.ceil((sim.by1 - sim.by0) * GS) + 2;
    glowImg = glowCtx.createImageData(glowC.width, glowC.height);
    glow32 = new Uint32Array(glowImg.data.buffer);
    const gn = glowC.width * glowC.height;
    gR = new Float32Array(gn); gG = new Float32Array(gn); gB = new Float32Array(gn);
  }

  function fitView() {
    if (!sim) return;
    const f = sim.fit;
    const w = f.x1 - f.x0, h = f.y1 - f.y0;
    cam.scale = Math.min(W / (w * 1.12), H / (h * 1.12));
    cam.x = (f.x0 + f.x1) / 2; cam.y = (f.y0 + f.y1) / 2;
  }

  // colour LUTs
  const HL = 64;
  const HMAX = 2;             // sim heat range (melting starts around 1)
  const rgba = (r, g, b) => (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
  function heatRGB(h) { // 0..1 -> black body-ish
    const stops = [[0, [90, 10, 0]], [0.3, [200, 40, 0]], [0.55, [255, 120, 10]], [0.8, [255, 210, 80]], [1, [255, 250, 220]]];
    for (let i = 1; i < stops.length; i++) {
      if (h <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i];
        const t = (h - a) / (b - a);
        return ca.map((v, k) => v + (cb[k] - v) * t);
      }
    }
    return stops[stops.length - 1][1];
  }
  function turbo(t) {
    const stops = [[48, 18, 59], [65, 105, 225], [30, 200, 200], [80, 230, 80], [240, 220, 40], [250, 120, 20], [200, 20, 20]];
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
    return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f);
  }
  const matLUT = MATS.map((m) => {
    const lut = new Uint32Array(HL);
    for (let i = 0; i < HL; i++) {
      const h = i / (HL - 1) * HMAX;
      const g = heatRGB(Math.min(1, h / 1.8));
      const a = Math.min(1, Math.max(0, (h - 0.12) * 1.6));
      lut[i] = rgba(...m.color.map((c, k) => Math.round(c + (g[k] - c) * a)));
    }
    return lut;
  });
  const heatLUT = new Uint32Array(HL), turboLUT = new Uint32Array(HL), stressLUT = new Uint32Array(HL);
  for (let i = 0; i < HL; i++) {
    const t = i / (HL - 1);
    const hc = t < 0.03 ? [45, 50, 62] : heatRGB(t);
    heatLUT[i] = rgba(...hc.map(Math.round));
    turboLUT[i] = rgba(...turbo(t).map(Math.round));
    const s = t < 0.02 ? [70, 80, 95] : turbo(0.15 + 0.85 * t);
    stressLUT[i] = rgba(...s.map(Math.round));
  }

  function buildLegend() {
    const used = new Set();
    for (let i = 0; i < sim.n; i++) used.add(sim.mat[i]);
    const mode = $('viewMode').value;
    let html = '';
    if (mode === 'mat') {
      html = [...used].sort().map((m) => `<div><i style="background:rgb(${MATS[m].color.join(',')})"></i>${MATS[m].name}</div>`).join('');
    } else {
      const grad = (lut) => 'linear-gradient(90deg,' + [0, 16, 32, 48, 63].map((i) => {
        const v = lut[i]; return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
      }).join(',') + ')';
      const info = {
        stress: [stressLUT, 'intact', 'about to break'],
        vel: [turboLUT, '0', (scenario.projectile.v).toFixed(0) + ' m/s'],
        heat: [heatLUT, 'cold', 'white hot'],
      }[mode];
      html = `<div style="flex-direction:column;align-items:stretch"><i style="width:160px;height:10px;background:${grad(info[0])}"></i>` +
        `<div style="justify-content:space-between"><span>${info[1]}</span><span>${info[2]}</span></div></div>`;
    }
    $('legend').innerHTML = html;
  }
  $('viewMode').addEventListener('change', buildLegend);

  function drawParticles() {
    const { n, px, py, alive, mat, heat, stress, vx, vy } = sim;
    const ow = off.width, oh = off.height, gw = glowC.width, gh = glowC.height;
    const bx0 = sim.bx0, by0 = sim.by0;
    const mode = $('viewMode').value;
    const glow = $('glow').checked;
    buf32.fill(0);
    if (glow) { gR.fill(0); gG.fill(0); gB.fill(0); }
    const vScale = (HL - 1) / Math.max(1, scenario.projectile.v / 100);
    let anyGlow = false;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const h = heat[i];
      const hi = Math.min(HL - 1, (h * ((HL - 1) / HMAX)) | 0);
      let col;
      if (mode === 'mat') col = matLUT[mat[i]][hi];
      else if (mode === 'heat') col = heatLUT[hi];
      else if (mode === 'stress') col = stressLUT[Math.min(HL - 1, (stress[i] * (HL - 1)) | 0)];
      else col = turboLUT[Math.min(HL - 1, (Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * vScale) | 0)];
      const X = ((px[i] - bx0) * SS - 1) | 0, Y = ((py[i] - by0) * SS - 1) | 0;
      if (X >= 0 && Y >= 0 && X < ow - 1 && Y < oh - 1) {
        const k = Y * ow + X;
        buf32[k] = col; buf32[k + 1] = col; buf32[k + ow] = col; buf32[k + ow + 1] = col;
      }
      if (glow && h > 0.3 && mode !== 'stress' && mode !== 'vel') {
        const gx = ((px[i] - bx0) * GS) | 0, gy = ((py[i] - by0) * GS) | 0;
        if (gx >= 0 && gy >= 0 && gx < gw && gy < gh) {
          const c = heatRGB(Math.min(1, h / 1.8));
          const w = (h - 0.3) * 0.3;
          const k = gy * gw + gx;
          gR[k] += c[0] * w; gG[k] += c[1] * w; gB[k] += c[2] * w;
          anyGlow = true;
        }
      }
    }
    offCtx.putImageData(img, 0, 0);
    if (glow && anyGlow) {
      for (let k = 0; k < glow32.length; k++) {
        const r = gR[k], g = gG[k], b = gB[k];
        glow32[k] = r + g + b > 0 ? rgba(r | 0, g | 0, b | 0) : 0;
      }
      glowCtx.putImageData(glowImg, 0, 0);
    }
    return anyGlow;
  }

  function worldToScreen(x, y) { return [(x - cam.x) * cam.scale + W / 2, (y - cam.y) * cam.scale + H / 2]; }

  function drawBackground() {
    ctx.fillStyle = '#0f1217';
    ctx.fillRect(0, 0, W, H);
    // grid every 50 mm (or 100/250 when zoomed out)
    const mmPx = cam.scale / sim.res;
    let step = 50; if (step * mmPx < 25) step = 100; if (step * mmPx < 25) step = 250; if (step * mmPx < 25) step = 500;
    const su = step / sim.res;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = cam.x - W / 2 / cam.scale, x1 = cam.x + W / 2 / cam.scale;
    const y0 = cam.y - H / 2 / cam.scale, y1 = cam.y + H / 2 / cam.scale;
    for (let x = Math.floor(x0 / su) * su; x < x1; x += su) { const s = worldToScreen(x, 0)[0]; ctx.moveTo(s, 0); ctx.lineTo(s, H); }
    for (let y = Math.floor(y0 / su) * su; y < y1; y += su) { const s = worldToScreen(0, y)[1]; ctx.moveTo(0, s); ctx.lineTo(W, s); }
    ctx.stroke();
    // line of fire
    const oy = (scenario.offsetY || 0) / sim.res;
    const a = worldToScreen(x0, oy), b = worldToScreen(x1, oy);
    ctx.strokeStyle = 'rgba(255,154,60,0.12)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawScaleBar() {
    const mmPx = cam.scale / sim.res;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    let mm = nice.find((v) => v * mmPx > 80) || 1000;
    const len = mm * mmPx;
    const x = 16, y = H - 20;
    ctx.strokeStyle = '#cfd6e2'; ctx.fillStyle = '#cfd6e2'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5); ctx.stroke();
    ctx.font = '12px system-ui'; ctx.fillText(mm >= 1000 ? mm / 1000 + ' m' : mm + ' mm', x + len + 8, y + 1);
  }

  function drawFlashes() {
    const evs = sim.events;
    const now = sim.time * sim.usPerT;
    const life = 25; // µs
    let keep = 0;
    ctx.globalCompositeOperation = 'lighter';
    for (const e of evs) {
      const age = now - e.t * sim.usPerT;
      if (age > life) continue;
      evs[keep++] = e;
      const t = age / life;
      const [sx, sy] = worldToScreen(e.x, e.y);
      const r = (4 + 18 * Math.sqrt(t)) * cam.scale;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(255,240,190,${0.35 * (1 - t)})`);
      g.addColorStop(0.4, `rgba(255,140,40,${0.18 * (1 - t)})`);
      g.addColorStop(1, 'rgba(120,30,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    evs.length = keep;
    ctx.globalCompositeOperation = 'source-over';
  }

  let lastStats = null, frame = 0, fpsT = performance.now(), fps = 0, simMs = 0, lagging = false;

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground();
    const anyGlow = drawParticles();
    const [sx, sy] = worldToScreen(sim.bx0, sim.by0);
    const dw = off.width / SS * cam.scale, dh = off.height / SS * cam.scale;
    ctx.imageSmoothingEnabled = cam.scale < SS;
    ctx.drawImage(off, sx, sy, dw, dh);
    if ($('glow').checked) {
      if (anyGlow) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.filter = `blur(${Math.max(2, Math.min(18, cam.scale * 2.2)).toFixed(1)}px)`;
        ctx.drawImage(glowC, sx, sy, glowC.width / GS * cam.scale, glowC.height / GS * cam.scale);
        ctx.restore();
      }
      drawFlashes();
    }
    drawScaleBar();
  }

  function updateStats() {
    const s = lastStats;
    const v0 = scenario.projectile.v;
    $('stats').innerHTML =
      `t = <b>${s.timeUs.toFixed(1)} µs</b>${running ? '' : ' (paused)'}${lagging ? ' <span style="color:#f66">slowed</span>' : ''}<br>` +
      `impact ${v0.toFixed(0)} m/s · LOS armor ${sim.losThickness.toFixed(0)} mm` +
      (sim.stackLos > sim.losThickness + 1 ? ` (${sim.stackLos.toFixed(0)} incl. gaps)` : '') + '<br>' +
      `deepest point (LOS) <b>${s.depthMm.toFixed(0)} mm</b><br>` +
      `perforated: <b>${s.perforated ? 'YES' : 'no'}</b><br>` +
      (s.perforated ? `residual: <b>${s.residualV.toFixed(0)} m/s</b>, ${(s.massBehind * 100).toFixed(0)}% mass<br>` : '') +
      `bonds ${s.bonds.toLocaleString()} · ${fps.toFixed(0)} fps · sim ${simMs.toFixed(1)} ms`;
  }

  let advancing = false;
  // Not awaited: the GPU engine resolves asynchronously, so we keep drawing its latest readback
  // while the next batch of steps runs. CPU engines finish synchronously before render().
  function startAdvance() {
    const t0 = performance.now();
    const done = (r) => { lagging = r.lagging; simMs = simMs * 0.9 + (performance.now() - t0) * 0.1; };
    const fail = (e) => { console.error(e); running = false; };
    let r;
    try { r = sim.advance(usPerFrame(), 300); } catch (e) { fail(e); return; }
    if (!(r instanceof Promise)) { done(r); return; }
    advancing = true;
    r.then(done, fail).finally(() => { advancing = false; });
  }

  function loop() {
    if (running && sim && !advancing) startAdvance();
    if (sim) {
      render();
      if (frame % 5 === 0) { lastStats = sim.stats(); updateStats(); }
    }
    frame++;
    const now = performance.now();
    if (now - fpsT > 500) { fps = (frame - (loop.f0 || 0)) * 1000 / (now - fpsT); loop.f0 = frame; fpsT = now; }
    requestAnimationFrame(loop);
  }

  // ---------- camera interaction ----------
  let drag = null;
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; canvas.classList.add('drag'); });
  window.addEventListener('mouseup', () => { drag = null; canvas.classList.remove('drag'); });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    cam.x = drag.cx - (e.clientX - drag.x) / cam.scale;
    cam.y = drag.cy - (e.clientY - drag.y) / cam.scale;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = (mx - W / 2) / cam.scale + cam.x, wy = (my - H / 2) / cam.scale + cam.y;
    cam.scale = Math.max(0.05, Math.min(60, cam.scale * Math.exp(-e.deltaY * 0.0015)));
    cam.x = wx - (mx - W / 2) / cam.scale; cam.y = wy - (my - H / 2) / cam.scale;
  }, { passive: false });
  canvas.addEventListener('dblclick', fitView);

  // ---------- init ----------
  resize();
  pType.value = 'apfsds'; loadProjectileDefaults();
  preset.value = 'rha150'; loadPreset();
  updateLabels();
  requestAnimationFrame(loop);
  selectEngine(initialEngine());
})();
