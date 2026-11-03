'use strict';
(function () {
  const { Sim, MATS, MAT_BY_ID, PROJECTILES } = window.ImpactSim;
  const $ = (id) => document.getElementById(id);
  const PICKABLE = MATS.filter((m) => !m.hidden); // detonation products only appear during a run

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
  for (const m of PICKABLE) pMat.add(new Option(m.name, m.id));
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
      for (const m of PICKABLE) sel.add(new Option(m.name, m.id));
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
  ['pMat', 'pD', 'pL', 'pV', 'pOff', 'res', 'plateH', 'explModel'].forEach((id) => $(id).addEventListener('change', rebuild));
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
  let drawn = []; // user-drawn shapes (see rasterizeDrawing in sim.js)
  try { drawn = JSON.parse(localStorage.getItem('impactDrawn') || '[]'); } catch (e) { /* storage disabled */ }
  if (!Array.isArray(drawn)) drawn = [];

  function scenarioFromUI() {
    return {
      res: +$('res').value,
      explosionModel: $('explModel').value,
      angle: +$('angle').value,
      plateH: Math.max(20, +$('plateH').value),
      layers: layers.map((l) => Object.assign({}, l)),
      offsetY: +$('pOff').value || 0,
      drawn: drawn.map((d) => Object.assign({}, d)),
      projectile: {
        type: pType.value, mat: pMat.value,
        D: Math.max(1, +$('pD').value), L: Math.max(1, +$('pL').value), v: Math.max(1, +$('pV').value),
      },
    };
  }

  function rebuild(keepCamera) {
    if (!engineReady) return;
    scenario = scenarioFromUI();
    buildGen++;
    if (rec) stopRecording('the scene was rebuilt');
    if (replay && !keepReplay && replay.key !== JSON.stringify(scenario)) discardReplay();
    sim = engineObj || new Sim();
    // the GPU engine only reads every particle back when the 2D canvas renderer (or the recorder) needs them
    if (engineKind === 'gpu') sim.readAll = !gpuRendering() || recStarting;
    setRunning(false);
    try {
      sim.build(scenario);
    } catch (e) {
      console.error(e);
      sim = null;
      $('count').textContent = `Could not build this scene: ${e.message}. Try a coarser resolution.`;
      return;
    }
    const heavy = (engineKind === 'js' && sim.n > 60000) || (engineKind === 'wasm' && sim.n > 500000);
    $('count').textContent = `${sim.n.toLocaleString()} particles · ${sim.nb.toLocaleString()} bonds` +
      (heavy ? ' — heavy! try the GPU engine or a coarser resolution' : '');
    if (renderer) renderer.reset();
    lastFxUs = 0;
    setupBuffers();
    if (keepCamera !== true) fitView();
    buildLegend();
    lastStats = sim.stats();
    if (replay && replayMode) showFrame(replay.idx, true);
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
    setRunning(false);
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

  // Reset rebuilds the scene at t = 0 and stays paused (and leaves the replay, which is kept)
  function resetScene() {
    if (!engineReady) return;
    if (rec) stopRecording('cancelled');
    leaveReplay();
    const cam0 = Object.assign({}, cam);
    rebuild(true);
    Object.assign(cam, cam0);
  }

  function setRunning(v) {
    running = v;
    updatePlayLabel();
  }
  function updatePlayLabel() {
    const on = replayMode ? replayPlaying : running;
    $('pause').textContent = on ? '⏸ Pause (Space)' : '▶ Play (Space)';
    $('tlPlay').textContent = replayPlaying ? '⏸' : '▶';
  }

  $('resetBtn').onclick = resetScene;
  $('pause').onclick = togglePause;
  $('stepBtn').onclick = stepForward;
  $('fitBtn').onclick = fitView;
  function togglePause() {
    if (rec) return;
    if (replayMode) { toggleReplayPlay(); return; }
    setRunning(!running);
  }
  function stepForward() {
    if (rec) return;
    if (replayMode) { replayPlaying = false; seekFrame(replay.idx + 1); return; }
    setRunning(false);
    if (!sim || advancing) return;
    advancing = true;
    Promise.resolve(sim.advance(usPerFrame(), 400)).finally(() => { advancing = false; });
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox')) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.type === 'range' && e.key.startsWith('Arrow')) return;
    const k = e.key.toLowerCase();
    const toolKeys = { b: 'brush', l: 'line', x: e.shiftKey ? 'rectO' : 'rect', c: e.shiftKey ? 'circleO' : 'circle', g: 'fill', e: 'erase', v: 'pan' };
    if (toolKeys[k]) { setTool(toolKeys[k]); return; }
    if (e.key === 'Escape') { if (drawing) drawing = null; else setTool('pan'); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (k === 'r') resetScene();
    else if (k === 'f') fitView();
    else if (e.key === '.' || (replayMode && e.key === 'ArrowRight')) { e.preventDefault(); stepForward(); }
    else if (replayMode && (e.key === ',' || e.key === 'ArrowLeft')) { e.preventDefault(); replayPlaying = false; seekFrame(replay.idx - 1); }
  });

  // ---------- record & replay ----------
  // Snapshots are quantised to ~12 bytes per particle (positions to 1/65535 of the box, velocities to
  // 1/32767 of the frame's fastest particle, pressure to PRES_STEP units), so replays are engine
  // independent and scrubbing is instant.
  const REC_BYTES = 8e8, PRES_STEP = 8;
  let buildGen = 0, recStarting = false, keepReplay = false;
  let rec = null;      // recording in progress
  let replay = null;   // finished recording: { key, frames, idx, view }
  let replayMode = false, replayPlaying = false, replayUs = 0;

  function encodeFrame(s, evs) {
    const n = s.n, buf = new ArrayBuffer(n * 12);
    const X = new Uint16Array(buf, 0, n), Y = new Uint16Array(buf, 2 * n, n);
    const VX = new Int16Array(buf, 4 * n, n), VY = new Int16Array(buf, 6 * n, n);
    const H = new Uint8Array(buf, 8 * n, n), S = new Uint8Array(buf, 9 * n, n), M = new Uint8Array(buf, 10 * n, n);
    const P = new Int8Array(buf, 11 * n, n);
    const { px, py, vx, vy, heat, stress, mat, alive, pres } = s;
    const x0 = s.bx0 - 1, y0 = s.by0 - 1, sx = 65535 / (s.bx1 - s.bx0 + 2), sy = 65535 / (s.by1 - s.by0 + 2);
    let vm = 1e-6;
    for (let i = 0; i < n; i++) if (alive[i]) vm = Math.max(vm, Math.abs(vx[i]), Math.abs(vy[i]));
    const vs = 32767 / vm;
    const q16 = (v) => (v > 0 ? (v < 65535 ? Math.round(v) : 65535) : 0);
    for (let i = 0; i < n; i++) {
      M[i] = mat[i];
      if (!alive[i]) { S[i] = 255; continue; }
      X[i] = q16((px[i] - x0) * sx); Y[i] = q16((py[i] - y0) * sy);
      VX[i] = Math.round(vx[i] * vs) || 0; VY[i] = Math.round(vy[i] * vs) || 0;
      H[i] = Math.min(255, Math.max(0, Math.round(heat[i] * 100)));
      S[i] = Math.min(254, Math.max(0, Math.round(stress[i] * 254)));
      P[i] = Math.max(-127, Math.min(127, Math.round(pres[i] / PRES_STEP)));
    }
    return { t: s.time, n, buf, vm, stats: s.stats(), events: evs };
  }

  function decodeFrame(f, v) {
    const n = f.n, buf = f.buf;
    const X = new Uint16Array(buf, 0, n), Y = new Uint16Array(buf, 2 * n, n);
    const VX = new Int16Array(buf, 4 * n, n), VY = new Int16Array(buf, 6 * n, n);
    const H = new Uint8Array(buf, 8 * n, n), S = new Uint8Array(buf, 9 * n, n), M = new Uint8Array(buf, 10 * n, n);
    const P = new Int8Array(buf, 11 * n, n);
    const x0 = v.bx0 - 1, y0 = v.by0 - 1, sx = (v.bx1 - v.bx0 + 2) / 65535, sy = (v.by1 - v.by0 + 2) / 65535, vs = f.vm / 32767;
    for (let i = 0; i < n; i++) {
      v.mat[i] = M[i];
      const st = S[i];
      v.alive[i] = st === 255 ? 0 : 1;
      v.px[i] = x0 + X[i] * sx; v.py[i] = y0 + Y[i] * sy;
      v.vx[i] = VX[i] * vs; v.vy[i] = VY[i] * vs;
      v.heat[i] = H[i] / 100; v.stress[i] = st === 255 ? 0 : st / 254;
      v.pres[i] = P[i] * PRES_STEP;
    }
    v.n = n; v.time = f.t;
  }

  // a stand-in for the simulation object that the renderers draw while replaying
  function makeView(s, nMax) {
    const v = { n: 0, time: 0, events: [], replay: true };
    for (const k of ['res', 'usPerT', 'bx0', 'bx1', 'by0', 'by1', 'losThickness', 'stackLos']) v[k] = s[k];
    v.fit = Object.assign({}, s.fit);
    for (const k of ['px', 'py', 'vx', 'vy', 'heat', 'stress', 'pres']) v[k] = new Float32Array(nMax);
    v.mat = new Uint8Array(nMax); v.alive = new Uint8Array(nMax);
    return v;
  }

  function recordButton() {
    $('recBtn').innerHTML = rec ? '■ Cancel recording' : '⏺ Run to t<sub>f</sub> &amp; record';
    $('recBtn').classList.toggle('primary', !!rec);
  }

  function startRecording() {
    if (!engineReady) return;
    if (rec) { stopRecording('cancelled'); return; }
    leaveReplay();
    discardReplay();
    recStarting = true;
    const cam0 = Object.assign({}, cam);
    try { rebuild(true); } finally { recStarting = false; }
    Object.assign(cam, cam0);
    if (!sim) return;
    const tf = Math.max(1, +$('recTf').value || 300);
    let frames = Math.max(2, Math.min(5000, Math.round(+$('recFrames').value || 300)));
    const perFrame = sim.n * 12 + 256;
    const maxFrames = Math.floor(REC_BYTES / perFrame);
    let note = '';
    if (maxFrames < 2) { $('recInfo').textContent = 'Too many particles to record; try a coarser resolution.'; return; }
    if (frames > maxFrames) {
      note = ` (limited to ${maxFrames} frames: ~${(perFrame / 1e6).toFixed(1)} MB each at this resolution)`;
      frames = maxFrames;
    }
    rec = { key: JSON.stringify(scenario), tf, N: frames, frames: [], gen: buildGen, lastEvT: -1, evs: [], note, bytes: 0, nMax: sim.n, t0: performance.now() };
    rec.view = makeView(sim, sim.n);
    captureFrame();
    recordButton();
  }

  function captureFrame() {
    const f = encodeFrame(sim, rec.evs);
    rec.evs = [];
    rec.frames.push(f);
    rec.bytes += f.buf.byteLength;
    $('recInfo').textContent = `Recording… frame ${rec.frames.length}/${rec.N} · t = ${(sim.time * sim.usPerT).toFixed(1)} µs${rec.note}`;
    if (rec.frames.length >= rec.N) stopRecording();
  }

  function collectEvents() {
    let last = rec.lastEvT;
    for (const e of sim.events) if (e.t > rec.lastEvT) { rec.evs.push({ x: e.x, y: e.y, t: e.t }); last = Math.max(last, e.t); }
    rec.lastEvT = last;
  }

  function recordStep() {
    const k = rec.frames.length;
    const target = rec.tf * k / (rec.N - 1) / sim.usPerT;
    const r0 = rec, gen = buildGen;
    const done = (r) => {
      if (rec !== r0 || gen !== buildGen) return;
      collectEvents();
      if (!r.lagging) captureFrame();
    };
    const fail = (e) => { console.error(e); if (rec === r0) stopRecording('the engine failed'); };
    let r;
    try { r = sim.advance(Math.max(0, (target - sim.time) * sim.usPerT), 1e7); } catch (e) { fail(e); return; }
    if (!(r instanceof Promise)) { done(r); return; }
    advancing = true;
    r.then(done, fail).finally(() => { advancing = false; });
  }

  // finish (why undefined) or abort a recording; partial recordings with 2+ frames are kept
  function stopRecording(why) {
    const r = rec;
    rec = null;
    recordButton();
    if (r.frames.length < 2) { $('recInfo').textContent = why ? `Recording ${why}.` : ''; return; }
    const mb = (r.bytes / 1e6).toFixed(0);
    const tEnd = r.frames[r.frames.length - 1].t * r.view.usPerT;
    replay = { key: r.key, frames: r.frames, idx: 0, view: r.view };
    $('recInfo').textContent = (why ? `Recording ${why}; kept ` : 'Recorded ') +
      `${r.frames.length} frames to t = ${tEnd.toFixed(1)} µs (${mb} MB, ${((performance.now() - r.t0) / 1000).toFixed(1)} s)${r.note}. ` +
      'Space plays the replay, drag the timeline to scrub, "Live" returns to the simulation.';
    const tl = $('tlSlider');
    tl.max = String(r.frames.length - 1);
    $('timeline').classList.add('show');
    $('timeline').classList.toggle('live', !replayMode);
    if (!why) { enterReplay(); seekFrame(0); replayPlaying = true; updatePlayLabel(); }
  }

  function discardReplay() {
    if (!replay) return;
    leaveReplay();
    replay = null;
    $('timeline').classList.remove('show');
    $('recInfo').textContent = 'The scene changed, so the recording was discarded.';
  }

  function enterReplay() {
    if (!replay || replayMode) return;
    setRunning(false);
    replayMode = true;
    replayPlaying = false;
    $('timeline').classList.remove('live');
    showFrame(replay.idx, true);
  }

  function leaveReplay() {
    if (!replayMode) return;
    replayMode = false;
    replayPlaying = false;
    $('timeline').classList.add('live');
    if (renderer) renderer.reset();
    if (sim) { lastFxUs = sim.time * sim.usPerT; lastStats = sim.stats(); }
    updatePlayLabel();
  }

  function frameUs(i) { return replay.frames[i].t * replay.view.usPerT; }

  // jump: a seek (reset effects and replay only the recent explosions) rather than sequential playback
  function showFrame(i, jump) {
    const fr = replay.frames, v = replay.view;
    i = Math.max(0, Math.min(fr.length - 1, i));
    const prev = replay.idx;
    if (jump || i < prev || i > prev + 8) {
      v.events = [];
      const tNow = fr[i].t;
      for (let j = i; j >= 0 && (tNow - fr[j].t) * v.usPerT < 30; j--) v.events.push(...fr[j].events);
      if (renderer) renderer.reset();
      lastFxUs = tNow * v.usPerT;
    } else {
      for (let j = prev + 1; j <= i; j++) v.events.push(...fr[j].events);
    }
    replay.idx = i;
    decodeFrame(fr[i], v);
    lastStats = fr[i].stats;
    $('tlSlider').value = String(i);
    $('tlTime').textContent = `t = ${frameUs(i).toFixed(1)} µs · ${i + 1}/${fr.length}`;
  }

  function seekFrame(i) {
    if (!replay) return;
    enterReplay();
    showFrame(i, true);
    replayUs = frameUs(replay.idx);
    updatePlayLabel();
  }

  function toggleReplayPlay() {
    if (!replay) return;
    enterReplay();
    replayPlaying = !replayPlaying;
    if (replayPlaying && replay.idx >= replay.frames.length - 1) seekFrame(0);
    replayUs = frameUs(replay.idx);
    updatePlayLabel();
  }

  function replayTick() {
    if (!replayPlaying) return;
    const fr = replay.frames;
    replayUs += usPerFrame();
    let i = replay.idx;
    while (i + 1 < fr.length && frameUs(i + 1) <= replayUs + 1e-6) i++;
    if (i !== replay.idx) showFrame(i, false);
    if (i >= fr.length - 1) { replayPlaying = false; updatePlayLabel(); }
  }

  $('recBtn').onclick = startRecording;
  $('tlPlay').onclick = toggleReplayPlay;
  $('tlLive').onclick = leaveReplay;
  $('tlSlider').addEventListener('input', () => { replayPlaying = false; seekFrame(+$('tlSlider').value); });

  // ---------- rendering ----------
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const glCanvas = $('gl');
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
    glCanvas.width = canvas.width; glCanvas.height = canvas.height;
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
  // signed pressure: x = tanh(p / 300) in [-1, 1]; compression blue, tension red (as in render.js)
  const presLUT = new Uint32Array(HL);
  for (let i = 0; i < HL; i++) {
    const x = 2 * i / (HL - 1) - 1, dark = [41, 43, 51], c = x >= 0 ? [51, 115, 255] : [242, 64, 51], a = Math.abs(x);
    presLUT[i] = rgba(...dark.map((d, k) => Math.round(d + (c[k] - d) * a)));
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
        vel: [turboLUT, '0', refV().toFixed(0) + ' m/s'],
        heat: [heatLUT, 'cold', 'white hot'],
        press: [presLUT, 'tension', 'compression'],
      }[mode];
      html = `<div style="flex-direction:column;align-items:stretch"><i style="width:160px;height:10px;background:${grad(info[0])}"></i>` +
        `<div style="justify-content:space-between"><span>${info[1]}</span><span>${info[2]}</span></div></div>`;
    }
    $('legend').innerHTML = html;
  }
  $('viewMode').addEventListener('change', buildLegend);

  // fastest projectile in the scene (m/s): the top of the velocity colour scale
  function refV() {
    let v = scenario.projectile.type === 'none' ? 0 : scenario.projectile.v;
    for (const d of scenario.drawn) if (d.role === 'projectile') v = Math.max(v, d.v || 0);
    return v || 1000;
  }

  function drawParticles() {
    const { n, px, py, alive, mat, heat, stress, vx, vy, pres } = sim;
    const ow = off.width, oh = off.height, gw = glowC.width, gh = glowC.height;
    const bx0 = sim.bx0, by0 = sim.by0;
    const mode = $('viewMode').value;
    const glow = $('glow').checked;
    buf32.fill(0);
    if (glow) { gR.fill(0); gG.fill(0); gB.fill(0); }
    const vScale = (HL - 1) / Math.max(1, refV() / 100);
    let anyGlow = false;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const h = heat[i];
      const hi = Math.min(HL - 1, (h * ((HL - 1) / HMAX)) | 0);
      let col;
      if (mode === 'mat') col = matLUT[mat[i]][hi];
      else if (mode === 'heat') col = heatLUT[hi];
      else if (mode === 'stress') col = stressLUT[Math.min(HL - 1, (stress[i] * (HL - 1)) | 0)];
      else if (mode === 'press') col = presLUT[Math.round((Math.tanh(pres[i] / 300) + 1) * 0.5 * (HL - 1))];
      else col = turboLUT[Math.min(HL - 1, (Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * vScale) | 0)];
      const X = ((px[i] - bx0) * SS - 1) | 0, Y = ((py[i] - by0) * SS - 1) | 0;
      if (X >= 0 && Y >= 0 && X < ow - 1 && Y < oh - 1) {
        const k = Y * ow + X;
        buf32[k] = col; buf32[k + 1] = col; buf32[k + ow] = col; buf32[k + ow + 1] = col;
      }
      if (glow && h > 0.3 && mode !== 'stress' && mode !== 'vel' && mode !== 'press') {
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
    drawGrid();
  }

  function drawGrid() {
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
    const x = 16, y = H - ($('timeline').classList.contains('show') ? 58 : 20);
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
    if (gpuRendering()) {
      renderGpu();
      ctx.clearRect(0, 0, W, H);
      drawGrid();
      drawOverlay();
      drawScaleBar();
      return;
    }
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
    drawOverlay();
    drawScaleBar();
  }

  const VIEW_MODES = { mat: 0, stress: 1, vel: 2, heat: 3, press: 4 };
  let lastFxUs = 0;
  function renderGpu() {
    const cine = rendererKind === 'cinematic';
    if (sim.events.length) {
      renderer.explode(sim.events, sim, cine);
      sim.events.length = 0;
    }
    // effects advance with simulated time, so they freeze while paused and follow the slow-mo
    const nowUs = sim.time * sim.usPerT;
    const frameUs = Math.max(0, Math.min(20, nowUs - lastFxUs));
    lastFxUs = nowUs;
    renderer.render({
      sim, cam, dpr, cinematic: cine, frameUs,
      mode: VIEW_MODES[$('viewMode').value],
      vRef: refV() / 100,
      glow: $('glow').checked,
      trailT: 1.5 * usPerFrame() / sim.usPerT,
    });
  }

  function updateStats() {
    const s = lastStats;
    const v0 = refV();
    $('stats').innerHTML =
      `t = <b>${s.timeUs.toFixed(1)} µs</b>${sim.replay ? ' (replay)' : rec ? ' (recording)' : running ? '' : ' (paused)'}${lagging ? ' <span style="color:#f66">slowed</span>' : ''}<br>` +
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
    const fail = (e) => { console.error(e); setRunning(false); };
    let r;
    try { r = sim.advance(usPerFrame(), 300); } catch (e) { fail(e); return; }
    if (!(r instanceof Promise)) { done(r); return; }
    advancing = true;
    r.then(done, fail).finally(() => { advancing = false; });
  }

  function loop() {
    if (rec && sim && engineReady && !advancing) recordStep();
    else if (running && !replayMode && sim && !advancing) startAdvance();
    if (sim) {
      if (replayMode && replay) {
        replayTick();
        // the render code reads the global `sim`; point it at the replay frame while drawing
        const live = sim;
        sim = replay.view;
        try {
          render();
          if (frame % 5 === 0) updateStats();
        } finally { sim = live; }
      } else {
        render();
        if (frame % 5 === 0) { lastStats = sim.stats(); updateStats(); }
      }
    }
    frame++;
    const now = performance.now();
    if (now - fpsT > 500) { fps = (frame - (loop.f0 || 0)) * 1000 / (now - fpsT); loop.f0 = frame; fpsT = now; }
    requestAnimationFrame(loop);
  }

  // ---------- renderer ----------
  const rendererSel = $('renderer');
  let renderer = null, rendererKind = '2d';
  function gpuRendering() { return rendererKind !== '2d' && !!renderer; }

  async function selectRenderer(kind) {
    if (kind !== '2d' && !renderer) {
      try {
        if (!GpuRenderer.available()) throw new Error('no WebGPU in this browser');
        renderer = await GpuRenderer.create(glCanvas);
      } catch (e) {
        console.error(e);
        for (const o of rendererSel.options) if (o.value !== '2d') { o.disabled = true; o.textContent += ' — unavailable'; }
        kind = '2d';
      }
    }
    const readAllBefore = !gpuRendering();
    rendererKind = kind;
    rendererSel.value = kind;
    glCanvas.style.display = kind === '2d' ? 'none' : 'block';
    try { localStorage.setItem('impactRenderer', kind); } catch (e) { /* storage disabled */ }
    if (renderer) renderer.reset();
    if (sim && engineKind === 'gpu' && readAllBefore !== !gpuRendering()) rebuild(true);
  }
  rendererSel.addEventListener('change', () => selectRenderer(rendererSel.value));

  function initialRenderer() {
    let want = new URLSearchParams(location.search).get('render');
    if (!want) try { want = localStorage.getItem('impactRenderer'); } catch (e) { /* storage disabled */ }
    if (want === 'cinematic' || want === 'standard' || want === '2d') return want;
    return GpuRenderer.available() ? 'standard' : '2d';
  }

  // ---------- drawing ----------
  // Shapes are kept in millimetres so they survive resolution changes; every edit rebuilds the scene.
  const dRole = $('dRole'), dMat = $('dMat');
  for (const m of PICKABLE) dMat.add(new Option(m.name, m.id));
  const matByRole = { armor: 'rha', projectile: 'tungsten' };
  let tool = 'pan', drawing = null, hover = null;

  function setTool(t) {
    tool = t;
    for (const b of $('tools').children) b.classList.toggle('on', b.dataset.tool === t);
    canvas.classList.toggle('draw', t !== 'pan');
  }
  for (const b of $('tools').children) b.onclick = () => setTool(b.dataset.tool);

  function updateDrawUI() {
    const role = dRole.value;
    if (matByRole[role]) dMat.value = matByRole[role];
    $('dMatRow').style.display = role === 'anchor' ? 'none' : '';
    for (const el of document.querySelectorAll('.dProj')) el.style.display = role === 'projectile' ? '' : 'none';
    $('dDirVal').textContent = $('dDir').value + '°';
    const nProj = drawn.filter((d) => d.role === 'projectile').length;
    $('dInfo').textContent = drawn.length
      ? `${drawn.length} shape${drawn.length > 1 ? 's' : ''} drawn` + (nProj ? ` (${nProj} projectile${nProj > 1 ? 's' : ''})` : '') +
        (nProj && pType.value !== 'none' ? '. Set projectile type to "None" to fire only your drawn projectiles.' : '.')
      : 'Pick a tool, then left-drag on the view. Drawings are added on top of the armor preset; the eraser cuts through anything.';
  }
  dRole.addEventListener('change', updateDrawUI);
  dMat.addEventListener('change', () => { if (matByRole[dRole.value]) matByRole[dRole.value] = dMat.value; });
  $('dDir').addEventListener('input', updateDrawUI);
  pType.addEventListener('change', updateDrawUI);

  function drawingChanged() {
    try { localStorage.setItem('impactDrawn', JSON.stringify(drawn)); } catch (e) { /* storage disabled */ }
    updateDrawUI();
    rebuild(true);
  }
  function undo() { if (drawn.length) { drawn.pop(); drawingChanged(); } }
  $('dUndo').onclick = undo;
  $('dClear').onclick = () => { if (drawn.length) { drawn = []; drawingChanged(); } };

  function eventMm(e) {
    const r = canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - W / 2) / cam.scale + cam.x, wy = (e.clientY - r.top - H / 2) / cam.scale + cam.y;
    return [Math.round(wx * sim.res * 10) / 10, Math.round(wy * sim.res * 10) / 10];
  }

  const TOOL_SHAPE = { erase: ['brush'], rectO: ['rect', true], circleO: ['circle', true] };
  function startShape(e) {
    const p = eventMm(e);
    const erase = tool === 'erase';
    const role = erase ? 'erase' : dRole.value;
    const [kind, outline] = TOOL_SHAPE[tool] || [tool];
    const s = { kind, role, size: Math.max(0.5, +$('dSize').value || 10), pts: [p] };
    if (outline) s.outline = true;
    if (kind !== 'brush' && kind !== 'fill') s.pts.push(p.slice());
    if (role === 'armor' || role === 'projectile') s.mat = dMat.value;
    if (role === 'projectile') { s.v = Math.max(0, +$('dV').value || 0); s.dir = +$('dDir').value || 0; }
    return s;
  }

  function extendShape(s, e) {
    let p = eventMm(e);
    if (s.kind === 'brush') {
      const q = s.pts[s.pts.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= Math.max(0.5, s.size * 0.25)) s.pts.push(p);
      return;
    }
    const a = s.pts[0];
    if (e.shiftKey) { // snap lines to 15°, rects to squares
      const dx = p[0] - a[0], dy = p[1] - a[1];
      if (s.kind === 'line') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12), l = Math.hypot(dx, dy);
        p = [a[0] + Math.cos(ang) * l, a[1] + Math.sin(ang) * l];
      } else if (s.kind === 'rect') {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        p = [a[0] + Math.sign(dx || 1) * m, a[1] + Math.sign(dy || 1) * m];
      }
    }
    s.pts[1] = p;
  }

  function finishShape(s) {
    if (s.kind === 'rect' || s.kind === 'circle') {
      const [a, b] = s.pts;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < sim.res) return; // just a click
    }
    drawn.push(s);
    if (s.kind !== 'fill') { drawingChanged(); return; }
    // a bucket fill only works out during the build; keep the recording until we know it changed the scene
    const trial = () => { keepReplay = true; try { drawingChanged(); } finally { keepReplay = false; } };
    trial();
    if (sim && sim.fillFailed && sim.fillFailed.includes(drawn.length - 1)) {
      drawn.pop();
      trial();
      $('dInfo').textContent = 'Bucket: that spot is open space that isn\'t enclosed. Close the area with outlines/lines first, or click on a body to recolour it.';
    } else if (replay && replay.key !== JSON.stringify(scenario)) discardReplay();
  }

  const ROLE_COL = { projectile: [255, 154, 60], anchor: [80, 200, 255], erase: [255, 80, 80] };
  function shapeColor(s) { return ROLE_COL[s.role] || (MAT_BY_ID[s.mat] || MAT_BY_ID.rha).color; }

  function tracePath(s) {
    const P = s.pts.map(([x, y]) => worldToScreen(x / sim.res, y / sim.res));
    ctx.beginPath();
    if (s.kind === 'rect') {
      const [a, b] = P;
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      return true;
    }
    if (s.kind === 'circle') {
      const [c, e] = P;
      ctx.arc(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, Math.PI * 2);
      return true;
    }
    ctx.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]);
    if (P.length === 1) ctx.lineTo(P[0][0] + 0.01, P[0][1]);
    return false;
  }

  function drawShape(s, alpha) {
    const c = shapeColor(s).join(',');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.kind === 'fill') { // bucket seed: a small marker
      const [x, y] = worldToScreen(s.pts[0][0] / sim.res, s.pts[0][1] / sim.res);
      ctx.strokeStyle = `rgba(${c},${alpha})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
      ctx.stroke();
      return;
    }
    if (tracePath(s) && !s.outline) {
      ctx.fillStyle = `rgba(${c},${alpha * 0.45})`; ctx.fill();
      ctx.strokeStyle = `rgba(${c},${alpha})`; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(${c},${alpha * 0.6})`;
      ctx.lineWidth = Math.max(1.5, s.size / sim.res * cam.scale);
      ctx.stroke();
    }
  }

  function shapeCenter(s) {
    if (s.kind === 'rect') return [(s.pts[0][0] + s.pts[1][0]) / 2, (s.pts[0][1] + s.pts[1][1]) / 2];
    if (s.kind === 'circle') return s.pts[0];
    const n = s.pts.length;
    return [s.pts.reduce((a, p) => a + p[0], 0) / n, s.pts.reduce((a, p) => a + p[1], 0) / n];
  }

  function drawArrow(s) {
    const [cx, cy] = shapeCenter(s);
    const [x, y] = worldToScreen(cx / sim.res, cy / sim.res);
    const a = (s.dir || 0) * Math.PI / 180, dx = Math.cos(a), dy = -Math.sin(a);
    const len = 28 + Math.min(90, (s.v || 0) / 40);
    const ex = x + dx * len, ey = y + dy * len;
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,190,110,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex + dx * 6, ey + dy * 6);
    ctx.lineTo(ex - dy * 5 - dx * 4, ey + dx * 5 - dy * 4); ctx.lineTo(ex + dy * 5 - dx * 4, ey - dx * 5 - dy * 4);
    ctx.fill();
    ctx.font = '11px system-ui';
    ctx.fillText(`${s.v} m/s`, ex + 8, ey + 4);
  }

  // drawing previews: the shape being drawn, pins, projectile launch arrows and the brush cursor
  function drawOverlay() {
    if (sim.time === 0 || tool !== 'pan') {
      for (const s of scenario.drawn) {
        if (s.role === 'anchor') { ctx.setLineDash([4, 4]); drawShape(s, 0.5); ctx.setLineDash([]); }
      }
    }
    if (sim.time === 0) for (const s of scenario.drawn) if (s.role === 'projectile' && s.v > 0) drawArrow(s);
    if (drawing) drawShape(drawing, 0.9);
    if (hover && !drawing && (tool === 'brush' || tool === 'erase' || tool === 'line' || tool === 'rectO' || tool === 'circleO')) {
      const [x, y] = worldToScreen(hover[0] / sim.res, hover[1] / sim.res);
      const r = Math.max(1, (+$('dSize').value || 10) / 2 / sim.res * cam.scale);
      ctx.strokeStyle = tool === 'erase' ? 'rgba(255,90,90,0.8)' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ---------- mouse: left button draws with a draw tool, otherwise any button pans ----------
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (!sim) return;
    if (tool !== 'pan' && e.button === 0 && rec) { $('dInfo').textContent = 'Drawing is disabled while recording.'; return; }
    if (tool === 'fill' && e.button === 0) { finishShape(startShape(e)); return; }
    if (tool !== 'pan' && e.button === 0) { drawing = startShape(e); return; }
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    canvas.classList.add('drag');
  });
  window.addEventListener('mouseup', () => {
    if (drawing) { const s = drawing; drawing = null; if (sim) finishShape(s); }
    drag = null; canvas.classList.remove('drag');
  });
  window.addEventListener('mousemove', (e) => {
    hover = sim && e.target === canvas ? eventMm(e) : null;
    if (drawing && sim) { extendShape(drawing, e); return; }
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
  canvas.addEventListener('dblclick', () => { if (tool === 'pan') fitView(); });

  // ---------- init ----------
  resize();
  pType.value = 'apfsds'; loadProjectileDefaults();
  preset.value = 'rha150'; loadPreset();
  updateLabels();
  setTool('pan');
  updateDrawUI();
  requestAnimationFrame(loop);
  selectRenderer(initialRenderer()).then(() => selectEngine(initialEngine()));
})();
