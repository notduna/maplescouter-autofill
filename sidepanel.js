/* Side panel: guided screenshot capture, review, HEXA matching and filling MapleScouter. */
/* global MSImage, MSClasses, MSParse, chrome */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v);
    });
    kids.flat().forEach((k) => k != null && e.append(k.nodeType ? k : document.createTextNode(k)));
    return e;
  };
  const NAMES = MSClasses.STAT_NAMES;
  const SITE_URL = 'https://maplescouter.com/en/manual/input';

  // What we fill: site field key -> [label shown in panel, value key(s) from the stat window]
  const FIELD_MAP = [
    ['damageRange', 'General Range', ['damageRange']], ['damage', 'Damage %', ['damage']],
    ['finalDamage', 'Final Damage %', ['finalDamage']], ['bossDamage', 'Boss Damage %', ['bossDamage']],
    ['ignoreDefense', 'Ignore Enemy Def %', ['ignoreDefense']], ['normalDamage', 'Normal Enemy Dmg %', ['normalDamage']],
    ['attackPower', 'Attack', ['attackPower']], ['magicAtt', 'M.Attack', ['magicAtt']],
    ['critRate', 'Critical Rate %', ['critRate']], ['critDamage', 'Critical Damage %', ['critDamage']],
    ['cooldown', 'Cooldown Reduction (sec / %)', ['cooldownSec', 'cooldownPct']], ['buffDuration', 'Buff Duration %', ['buffDuration']],
    ['cooldownSkip', 'Cooldown Skip %', ['cooldownSkip']], ['ignoreElemental', 'Ignore Elemental Res %', ['ignoreElemental']],
    ['statusDamage', 'Additional Status Dmg %', ['statusDamage']], ['summonDuration', 'Summon Duration %', ['summonDuration']],
    ['arcane', 'Arcane Force', ['arcane']], ['sacred', 'Sacred Force', ['sacred']]
  ];

  const state = {
    cls: null, shots: [], edits: {}, popupEdits: {},
    site: null, siteSigs: [], hexaAssign: [], hexaLevels: [], ignoreLast: 2,
    memory: {}
  };

  // ---------------- worker ----------------
  const worker = new Worker('ocr-worker.js');
  const pending = new Map();
  let jobId = 0;
  worker.onmessage = (ev) => {
    const m = ev.data, p = pending.get(m.id);
    if (!p) return;
    if (m.progress) { p.onProgress && p.onProgress(m.progress); return; }
    pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  };
  function recognize(imageData, onProgress) {
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, image: { width: imageData.width, height: imageData.height, data: imageData.data.buffer } }, [imageData.data.buffer]);
    });
  }

  // ---------------- storage ----------------
  const store = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k]))),
    set: (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r))
  };

  // ---------------- class ----------------
  function setupClasses() {
    const sel = $('classSelect');
    sel.append(el('option', { value: '', text: '— Choose your class —' }));
    const groups = {};
    MSClasses.CLASSES.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
    Object.entries(groups).forEach(([g, list]) => {
      const og = el('optgroup', { label: g });
      list.forEach((c) => og.append(el('option', { value: c.name, text: c.name })));
      sel.append(og);
    });
    sel.addEventListener('change', async () => {
      state.cls = MSClasses.CLASSES.find((c) => c.name === sel.value) || null;
      await store.set('cls', sel.value);
      render();
      if (state.site) matchHexa();
    });
  }
  const neededPopups = () => {
    if (!state.cls) return [];
    const list = state.cls.main.map((s) => ({ stat: s, role: 'main' }))
      .concat(state.cls.sub.map((s) => ({ stat: s, role: 'sub' })));
    list.push({ stat: state.cls.att, role: 'att' });
    return list;
  };

  // ---------------- merged results ----------------
  function merged() {
    const values = {}, uncertain = {}, popups = {}, changed = {};
    let hexa = null;
    state.shots.forEach((s) => {
      if (s.status !== 'done') return;
      if (s.kind === 'hexa') { hexa = s.result; return; }
      const r = s.result;
      // Screenshots are applied oldest -> newest, so the newest one wins. A value that changed
      // between screenshots (e.g. a buff ran out) is flagged so it can be double-checked.
      Object.entries(r.values).forEach(([k, v]) => {
        if (v == null) return;
        const unsure = !!(r.uncertain && r.uncertain[k]);
        if (!(k in values)) { values[k] = v; if (unsure) uncertain[k] = true; return; }
        if (unsure && !uncertain[k]) return; // keep a clean earlier reading over a shaky newer one
        if (values[k] !== v) { changed[k] = [values[k], v]; uncertain[k] = true; }
        values[k] = v;
        if (!unsure && !changed[k]) delete uncertain[k];
      });
      if (r.popup && r.popup.stat) popups[r.popup.stat] = r.popup;
    });
    Object.entries(state.edits).forEach(([k, v]) => { values[k] = v; delete uncertain[k]; });
    Object.entries(state.popupEdits).forEach(([stat, ed]) => { popups[stat] = Object.assign({}, popups[stat] || {}, ed, { edited: true }); });
    return { values, uncertain, popups, hexa, changed };
  }

  // ---------------- rendering ----------------
  function render() {
    const m = merged();
    // class info
    $('classInfo').textContent = state.cls
      ? `Main stat: ${state.cls.main.map((s) => NAMES[s]).join(' / ')}` + (state.cls.sub.length ? ` · Secondary: ${state.cls.sub.map((s) => NAMES[s]).join(' + ')}` : '') + ` · Attack: ${NAMES[state.cls.att]}`
      : 'Pick your class so the extension knows which stat pop-outs to ask for.';
    // steps
    const steps = $('steps'); steps.textContent = '';
    if (state.cls) {
      let currentSet = false;
      const mk = (done, title, desc, optional) => {
        const li = el('li', { class: (done ? 'done ' : '') + (optional ? 'optional ' : '') },
          el('span', { class: 'dot', text: done ? '✓' : '' }),
          el('div', {}, el('div', { class: 'title', text: title }), el('div', { class: 'desc', text: desc })));
        if (!done && !currentSet && !optional) { li.classList.add('current'); currentSet = true; }
        steps.append(li);
      };
      const hasStat = Object.keys(m.values).length > 5;
      neededPopups().forEach((p, i) => {
        const n = NAMES[p.stat];
        const step = p.role === 'main' ? 'Step 1' : p.role === 'sub' ? 'Step 2' : 'Step 3';
        mk(!!m.popups[p.stat], `${step}: Stat window + ${n} pop-out`,
          p.role === 'att'
            ? `Click ${n} in the stat window so its STAT INFO opens (fills the "Attack" row of MapleScouter's stat table).`
            : `Open the STAT window, click ${n} so the STAT INFO pop-out shows, then screenshot both.`, p.optional);
      });
      mk(!!m.hexa, 'Step 4: HEXA Matrix', 'Screenshot the whole HEXA Matrix window (the X-shaped grid of cores).');
      if (!hasStat && state.shots.length) steps.append(el('li', {}, el('span', { class: 'dot', text: '!' }), el('div', { class: 'desc', text: 'No stat window read yet — include the full STAT window in a screenshot.' })));
    }
    // shots
    const shots = $('shots'); shots.textContent = '';
    state.shots.forEach((s) => {
      let what = '';
      if (s.status === 'reading') what = el('span', {}, el('i', { class: 'spinner' }), s.progress || 'Reading…');
      else if (s.status === 'error') what = el('span', { text: s.error });
      else if (s.kind === 'hexa') what = el('span', { text: `HEXA Matrix · ${s.result.cores.length} cores` });
      else {
        const p = s.result.popup;
        const ok = p ? (p.consistent ? '✓ checks out' : p.consistent === false ? '⚠ numbers don’t add up' : '') : '';
        what = el('span', { text: `Stat window` + (p && p.stat ? ` + ${NAMES[p.stat]} pop-out ${ok}` : p ? ' + pop-out (stat unknown)' : ' (no pop-out)') });
      }
      shots.append(el('div', { class: 'shot' + (s.status === 'error' ? ' err' : '') },
        el('img', { src: s.thumb }), el('div', { class: 'meta' }, el('b', { text: s.name }), what, s.note ? el('span', { text: ' · ' + s.note }) : null),
        el('button', { class: 'ghost small', title: 'Remove', text: '✕', onclick: () => { state.shots = state.shots.filter((x) => x !== s); render(); renderHexa(); } })));
    });
    renderReview(m);
    updateFillButton(m);
  }

  function numInput(value, onChange, cls) {
    const i = el('input', { type: 'number', step: 'any', value: value == null ? '' : value, class: cls || '' });
    i.addEventListener('change', () => onChange(i.value === '' ? null : +i.value));
    return i;
  }

  function renderReview(m) {
    const card = $('reviewCard');
    const has = Object.keys(m.values).length || Object.keys(m.popups).length;
    card.classList.toggle('hidden', !has);
    if (!has) return;
    // popups
    const pt = $('popupTable'); pt.textContent = '';
    const stats = neededPopups().map((p) => p.stat).filter((s) => m.popups[s]);
    Object.keys(m.popups).forEach((s) => { if (!stats.includes(s)) stats.push(s); });
    if (stats.length) {
      const t = el('table', { class: 'pop' }, el('tr', {}, el('th', { text: 'Stat table' }), el('th', { text: 'Base' }), el('th', { text: '%' }), el('th', { text: 'Not applied' })));
      stats.forEach((s) => {
        const p = m.popups[s];
        const set = (f) => (v) => { state.popupEdits[s] = Object.assign({}, state.popupEdits[s], { [f]: v }); render(); };
        const badge = p.edited ? el('span', { class: 'badge', text: 'edited' })
          : p.consistent ? el('span', { class: 'badge ok', text: '✓' }) : el('span', { class: 'badge warn', text: '?' , title: 'Base × (1 + %) + Not applied ≠ Current value' });
        t.append(el('tr', { class: p.consistent || p.edited ? '' : 'bad' },
          el('td', {}, NAMES[s].replace('ATTACK POWER', 'ATT').replace('MAGIC ATT', 'M.ATT'), badge),
          el('td', {}, numInput(p.base, set('base'))), el('td', {}, numInput(p.pct, set('pct'))), el('td', {}, numInput(p.notApplied, set('notApplied')))));
      });
      pt.append(t);
      if (state.cls) {
        const missing = neededPopups().filter((p) => !p.optional && !m.popups[p.stat]).map((p) => NAMES[p.stat]);
        if (missing.length) pt.append(el('p', { class: 'hint', text: `Still needed: ${missing.join(', ')} pop-out.` }));
      }
    }
    // fields
    const g = $('statGrid'); g.textContent = '';
    FIELD_MAP.forEach(([key, label, vkeys]) => {
      const unsure = vkeys.some((k) => m.uncertain[k]), missing = vkeys.every((k) => m.values[k] == null);
      const ch = vkeys.map((k) => m.changed[k]).find(Boolean);
      const tip = ch ? `Differs between screenshots: ${ch[0]} → ${ch[1]} (using the newest). A buff may have been active.` : label;
      const f = el('div', { class: 'field' + (unsure ? ' uncertain' : '') + (missing ? ' missing' : ''), title: tip }, el('label', { text: label + (ch ? ' ⟳' : '') }));
      if (vkeys.length === 2) {
        f.append(el('div', { class: 'pair' }, numInput(m.values[vkeys[0]], (v) => { state.edits[vkeys[0]] = v; render(); }), el('span', { text: 's' }),
          numInput(m.values[vkeys[1]], (v) => { state.edits[vkeys[1]] = v; render(); }), el('span', { text: '%' })));
      } else f.append(numInput(m.values[vkeys[0]], (v) => { state.edits[vkeys[0]] = v; render(); }));
      g.append(f);
    });
  }

  // ---------------- screenshots ----------------
  async function addImageBlob(blob, name) {
    const shot = { id: Date.now() + Math.random(), name: name || 'Pasted screenshot', status: 'reading', thumb: URL.createObjectURL(blob) };
    state.shots.push(shot); render();
    try {
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const res = await recognize(data, (p) => { shot.progress = p; render(); });
      shot.status = 'done'; shot.kind = res.kind; shot.result = res.result;
      if (res.kind === 'hexa' && res.result.stat) {
        // the same screenshot also showed the STAT window
        state.shots.push({ id: shot.id + 0.5, name: shot.name + ' (STAT window)', status: 'done', kind: 'stat', thumb: shot.thumb, result: res.result.stat });
      }
      if (res.kind === 'hexa') {
        // keep only the newest HEXA screenshot
        state.shots = state.shots.filter((s) => s === shot || s.kind !== 'hexa');
        state.hexaLevels = res.result.cores.map((c) => c.level);
        state.hexaAssign = [];
      } else if (res.result.popup && res.result.popup.stat) {
        delete state.popupEdits[res.result.popup.stat];
        if (state.cls && !neededPopups().some((p) => p.stat === res.result.popup.stat)) {
          shot.note = `${NAMES[res.result.popup.stat]} isn't used by ${state.cls.name}`;
        }
      }
    } catch (e) {
      shot.status = 'error'; shot.error = e.message;
    }
    render();
    if (shot.kind === 'hexa') { renderHexa(); if (!state.site) scanSite(true); else matchHexa(); }
  }

  function setupInput() {
    document.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData || {}).items || []);
      const imgs = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (!imgs.length) return;
      e.preventDefault();
      imgs.forEach((i) => addImageBlob(i.getAsFile(), 'Pasted ' + new Date().toLocaleTimeString()));
    });
    const dz = $('dropZone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('over');
      Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')).forEach((f) => addImageBlob(f, f.name));
    });
    $('fileInput').addEventListener('change', (e) => { Array.from(e.target.files).forEach((f) => addImageBlob(f, f.name)); e.target.value = ''; });
    $('resetBtn').addEventListener('click', () => {
      state.shots = []; state.edits = {}; state.popupEdits = {}; state.hexaAssign = []; state.hexaLevels = [];
      $('report').textContent = ''; render(); renderHexa();
    });
  }

  // ---------------- MapleScouter tab ----------------
  async function findTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && /^https:\/\/([a-z]+\.)?maplescouter\.com\//.test(active.url || '')) return active;
    const tabs = await chrome.tabs.query({ url: ['https://maplescouter.com/*', 'https://*.maplescouter.com/*'] });
    return tabs.find((t) => /manual/.test(t.url)) || tabs[0] || null;
  }
  async function send(tab, msg) {
    try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) {
      // content script not there yet (tab was open before the extension loaded)
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/classes.js', 'content.js'] });
      return chrome.tabs.sendMessage(tab.id, msg);
    }
  }

  // Follow the class selected on MapleScouter (on load and whenever it changes there).
  function applySiteClass(c) {
    const info = $('classSync');
    if (!c || !c.name) {
      info.textContent = c && c.ambiguous && c.ambiguous.length ? `Couldn't tell which class is selected on MapleScouter (${c.ambiguous.join(', ')}…).` : '';
      return;
    }
    const cls = MSClasses.CLASSES.find((k) => k.name === c.name);
    if (!cls) return;
    info.textContent = `Synced from MapleScouter: ${cls.name}`;
    if (state.cls && state.cls.name === cls.name) return;
    state.cls = cls; $('classSelect').value = cls.name;
    store.set('cls', cls.name);
    render(); if (state.site) matchHexa();
  }

  async function scanSite(quiet) {
    const tab = await findTab();
    if (!tab) {
      $('siteStatus').innerHTML = '';
      $('siteStatus').append('Open ', el('a', { href: SITE_URL, target: '_blank', class: 'link', text: 'MapleScouter manual input' }), ' in a tab, pick your class there, then press "Read MapleScouter\'s HEXA slots".');
      return null;
    }
    const r = await send(tab, { type: 'ms-scan' });
    if (!r || !r.ok) { if (!quiet) $('siteStatus').textContent = 'Could not read the MapleScouter page: ' + (r && r.error); return null; }
    state.site = r.scan;
    if (r.scan.cls) applySiteClass(r.scan.cls);
    const nf = Object.keys(r.scan.fields).length, nr = Object.keys(r.scan.rows).length;
    let msg = `MapleScouter: found ${nf} stat fields, ${nr} stat-table rows, ${r.scan.hexa.length} HEXA slots.`;
    if (state.cls) {
      const want = state.cls.main.concat(state.cls.sub);
      const lack = want.filter((s) => !r.scan.rows[s]);
      if (nr && lack.length) msg += ` ⚠ The site's stat table has no ${lack.map((s) => NAMES[s]).join('/')} row — select ${state.cls.name} on MapleScouter first.`;
    }
    $('siteStatus').textContent = msg;
    await loadSiteIcons(tab);
    matchHexa();
    updateFillButton(merged());
    return r.scan;
  }

  const sigFromPixels = (px) => MSImage.iconSignature({ width: px.width, height: px.height, data: new Uint8ClampedArray(px.data) }, 0.18);
  // An object URL the panel can always display (the site blocks loading its images from elsewhere).
  async function urlFromImageData(d) {
    const c = new OffscreenCanvas(d.width, d.height);
    c.getContext('2d').putImageData(d instanceof ImageData ? d : new ImageData(new Uint8ClampedArray(d.data), d.width, d.height), 0, 0);
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
  }
  async function sigFromBlob(blob) {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return MSImage.iconSignature(ctx.getImageData(0, 0, bmp.width, bmp.height), 0.18);
  }

  /* Get each MapleScouter HEXA icon's pixels, trying three independent ways:
   * 1) read them on the page, 2) fetch the image from the extension, 3) crop them out of a capture
   * of the visible tab. state.iconDiag records what happened for each slot. */
  let iconsBusy = null;
  function loadSiteIcons(tab) {
    // one load at a time: a second request waits for the running one instead of racing it
    if (iconsBusy) return iconsBusy;
    iconsBusy = loadSiteIconsNow(tab).finally(() => { iconsBusy = null; });
    return iconsBusy;
  }
  async function loadSiteIconsNow(tab) {
    if (!state.site) return;
    tab = tab || await findTab();
    const n = state.site.hexa.length;
    (state.siteIconURL || []).forEach((u) => u && URL.revokeObjectURL(u));
    const urls = new Array(n).fill(null);
    const sigs = new Array(n).fill(null), diag = state.site.hexa.map((h) => ({ slot: h.index + 1, src: h.src, broken: h.broken, tries: [] }));
    // 1) on the page
    try {
      const r = await send(tab, { type: 'ms-icons' });
      (r && r.icons || []).forEach((ic) => {
        if (ic.px) { sigs[ic.index] = sigFromPixels(ic.px); diag[ic.index].ok = ic.how; } else diag[ic.index].tries.push('page: ' + ic.error);
      });
      for (const ic of (r && r.icons || [])) if (ic.px) urls[ic.index] = await urlFromImageData(ic.px);
    } catch (e) { diag.forEach((d) => d.tries.push('page: ' + e.message)); }
    // 2) fetch from the extension (host access is granted at install, no prompt)
    for (let i = 0; i < n; i++) {
      const h = state.site.hexa[i];
      if (sigs[i] || !h.src || h.broken) continue;
      try {
        const resp = await fetch(h.src, { credentials: 'omit', cache: 'force-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        sigs[i] = await sigFromBlob(blob); diag[i].ok = 'fetch'; urls[i] = URL.createObjectURL(blob);
      } catch (e) { diag[i].tries.push('fetch: ' + e.message); }
    }
    // 3) capture the visible tab and crop the icons (needs the MapleScouter tab to be the visible one)
    if (sigs.some((x, i) => !x && !state.site.hexa[i].broken && state.site.hexa[i].src)) {
      try {
        if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
        const rr = await send(tab, { type: 'ms-icon-rects' });
        const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const bmp = await createImageBitmap(await (await fetch(shot)).blob());
        const sx = bmp.width / rr.r.vw, sy = bmp.height / rr.r.vh;
        const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
        rr.r.rects.forEach((b, i) => {
          if (state.site.hexa[i].broken || !state.site.hexa[i].src) return; // never match a broken image
          if (sigs[i] || !b || b.w < 4 || b.y < 0 || b.y + b.h > rr.r.vh) { if (!sigs[i] && b) diag[i].tries.push('capture: icon off-screen'); return; }
          const d = ctx.getImageData(Math.round(b.x * sx), Math.round(b.y * sy), Math.max(1, Math.round(b.w * sx)), Math.max(1, Math.round(b.h * sy)));
          sigs[i] = MSImage.iconSignature(d, 0.18); diag[i].ok = 'capture'; diag[i].px = d;
        });
        for (const dg of diag) if (dg.px) { urls[dg.slot - 1] = await urlFromImageData(dg.px); delete dg.px; }
      } catch (e) { diag.forEach((d, i) => { if (!sigs[i]) d.tries.push('capture: ' + e.message); }); }
    }
    state.siteSigs = sigs; state.iconDiag = diag; state.siteIconURL = urls;
    const usable = activeSlots().filter((i) => !state.site.hexa[i].broken && state.site.hexa[i].src);
    const missing = usable.filter((i) => !sigs[i]);
    const box = $('permBox');
    box.classList.toggle('hidden', !missing.length);
    if (missing.length) {
      box.textContent = `Couldn't load ${missing.length} of MapleScouter's HEXA icons (slots ${missing.map((i) => i + 1).join(', ')}), so those can't be matched automatically — pick them with the drop-downs below. "Copy diagnostics" tells me why.`;
    }
  }

  // ---------------- HEXA ----------------
  function activeSlots() {
    const n = state.site ? state.site.hexa.length : 0;
    return Array.from({ length: Math.max(0, n - state.ignoreLast) }, (_, i) => i);
  }

  /* Core -> MapleScouter slot, in priority order:
   * 1) your own corrections for this class (remembered by in-game icon -> site icon),
   * 2) the core's position in the HEXA Matrix (fixed layout; MapleScouter's 15 slots follow it),
   * 3) icon similarity, for anything left. */
  function matchHexa() {
    const m = merged();
    if (!m.hexa) { renderHexa(); return; }
    const cores = m.hexa.cores;
    const slots = activeSlots();
    const assign = new Array(cores.length).fill(null), conf = new Array(cores.length).fill(null);
    const used = new Set(), done = new Set();
    // 1) remembered corrections
    const mem = (state.cls && state.memory[state.cls.name]) || [];
    cores.forEach((c, i) => {
      let best = null;
      mem.forEach((e) => { const d = MSImage.iconDistance(c.sig, e.sig); if (d < 0.12 && (!best || d < best.d)) best = { d, e }; });
      if (!best || !state.site) return;
      done.add(i);
      if (best.e.src == null) { conf[i] = 'remembered'; return; } // remembered as "skip"
      const slot = state.site.hexa.findIndex((h) => h.src === best.e.src);
      if (slot >= 0 && slots.includes(slot) && !used.has(slot)) { assign[i] = slot; conf[i] = 'remembered'; used.add(slot); }
    });
    // 2) matrix layout
    const layoutOK = state.site && state.site.hexa.length === 15 && cores.some((c) => c.layoutSlot != null);
    if (layoutOK) cores.forEach((c, i) => {
      if (done.has(i) || c.layoutSlot == null) return;
      done.add(i); conf[i] = 'layout';
      if (slots.includes(c.layoutSlot) && !used.has(c.layoutSlot)) { assign[i] = c.layoutSlot; used.add(c.layoutSlot); }
    });
    // 3) icon similarity for the rest
    const restC = cores.map((c, i) => i).filter((i) => !done.has(i));
    const restS = slots.filter((s) => !used.has(s) && state.siteSigs[s]);
    if (restC.length && restS.length) {
      const res = MSParse.matchIcons(restC.map((i) => cores[i].sig), restS.map((s) => state.siteSigs[s]));
      res.forEach((r, k) => { if (r) { assign[restC[k]] = restS[r.slot]; conf[restC[k]] = r.d; } });
    }
    state.hexaAssign = assign; state.hexaConf = conf;
    renderHexa();
    updateFillButton(m);
  }

  // Remember a manual slot choice for this class, keyed by the in-game core's icon.
  function rememberCorrection(i, slot) {
    const m = merged();
    if (!state.cls || !m.hexa || !state.site) return;
    const c = m.hexa.cores[i];
    const list = (state.memory[state.cls.name] || []).filter((e) => MSImage.iconDistance(e.sig, c.sig) >= 0.12);
    list.push({ sig: c.sig, src: slot == null ? null : state.site.hexa[slot].src });
    state.memory[state.cls.name] = list;
    store.set('hexaMemory2', state.memory);
  }

  function renderHexa() {
    const m = merged();
    $('hexaCard').classList.toggle('hidden', !m.hexa);
    const box = $('cores'); box.textContent = '';
    if (!m.hexa) return;
    const slots = activeSlots();
    m.hexa.cores.forEach((c, i) => {
      const cv = el('canvas', { width: c.icon.width, height: c.icon.height, title: 'In-game core' });
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(c.icon.data), c.icon.width, c.icon.height), 0, 0);
      const slot = state.hexaAssign[i];
      const iconURL = slot != null && state.siteIconURL ? state.siteIconURL[slot] : null;
      const siteImg = iconURL ? el('img', { class: 'site', title: 'MapleScouter slot ' + (slot + 1), src: iconURL }) : el('div', { class: 'site slotno', text: slot != null ? '#' + (slot + 1) : '' });
      const sel = el('select', {});
      sel.append(el('option', { value: '', text: state.site ? '— not on MapleScouter / skip —' : 'Read MapleScouter first' }));
      slots.forEach((s) => {
        const h = state.site.hexa[s];
        sel.append(el('option', { value: s, text: `Slot ${s + 1} (now ${h.value || 0} on site)` }));
      });
      sel.value = slot == null ? '' : String(slot);
      sel.addEventListener('change', () => {
        const v = sel.value === '' ? null : +sel.value;
        // keep slots unique: swap with whoever had it
        const other = state.hexaAssign.indexOf(v);
        if (v != null && other >= 0 && other !== i) { state.hexaAssign[other] = state.hexaAssign[i]; state.hexaConf[other] = 'manual'; }
        state.hexaAssign[i] = v; state.hexaConf[i] = 'manual';
        rememberCorrection(i, v);
        renderHexa();
      });
      const lvl = el('input', { type: 'number', min: 0, max: 30, value: state.hexaLevels[i] != null ? state.hexaLevels[i] : c.level });
      lvl.addEventListener('change', () => { state.hexaLevels[i] = Math.max(0, Math.min(30, +lvl.value || 0)); });
      const cf = state.hexaConf && state.hexaConf[i];
      const nums = (state.hexaConf || []).filter((x) => typeof x === 'number').sort((a, b) => a - b);
      const med = nums.length ? nums[Math.floor(nums.length / 2)] : 0;
      const low = typeof cf === 'number' && cf > med * 1.25; // noticeably worse than a typical match
      const why = cf === 'remembered' ? 'Your correction from last time' : cf === 'layout' ? 'Matched by its position in the HEXA Matrix' : cf === 'manual' ? 'Set by you' : typeof cf === 'number' ? 'Matched by icon (distance ' + cf.toFixed(2) + ')' : '';
      box.append(el('div', { class: 'core' + (slot == null ? ' unmatched' : '') + (low ? ' lowconf' : ''), title: why },
        cv, el('div', { class: 'lvl' }, 'Lv', lvl),
        slot != null ? siteImg : el('div', { class: 'arrow', text: '—' }),
        el('div', { class: 'arrow', text: slot != null ? `→ slot ${slot + 1}` : (c.layoutSlot != null && state.site && c.layoutSlot >= activeSlots().length && c.layoutSlot < state.site.hexa.length) ? `slot ${c.layoutSlot + 1} · ignored` : 'not filled' }),
        sel));
    });
  }

  // ---------------- fill ----------------
  function buildPayload(m) {
    const fields = {};
    FIELD_MAP.forEach(([key, , vkeys]) => {
      const vals = vkeys.map((k) => m.values[k]);
      if (vals.some((v) => v != null)) fields[key] = vals;
    });
    const rows = {};
    Object.entries(m.popups).forEach(([stat, p]) => {
      if (p.base == null && p.pct == null && p.notApplied == null) return;
      rows[stat] = [p.base, p.pct, p.notApplied];
    });
    // The site may call the attack row "Attack" even for magicians (or the other way round).
    if (state.site) {
      if (rows.magic && !state.site.rows.magic && state.site.rows.attack && !rows.attack) rows.attack = rows.magic;
      if (rows.attack && !state.site.rows.attack && state.site.rows.magic && !rows.magic) rows.magic = rows.attack;
      Object.keys(rows).forEach((k) => { if (!state.site.rows[k]) delete rows[k]; });
    }
    const hexa = [];
    if (m.hexa) m.hexa.cores.forEach((c, i) => {
      const slot = state.hexaAssign[i];
      if (slot != null) hexa.push({ index: slot, level: state.hexaLevels[i] != null ? state.hexaLevels[i] : c.level });
    });
    return { fields, rows, hexa };
  }

  function updateFillButton(m) {
    const any = Object.keys(m.values).length || Object.keys(m.popups).length || m.hexa;
    $('fillBtn').disabled = !any;
  }

  async function doFill() {
    const rep = $('report'); rep.textContent = '';
    const tab = await findTab();
    if (!tab) { rep.append(el('div', { class: 'err' }, 'No MapleScouter tab found. ', el('a', { href: SITE_URL, target: '_blank', class: 'link', text: 'Open it' }), ', select your class, then try again.')); return; }
    if (!state.site) await scanSite(true);
    const m = merged();
    const payload = buildPayload(m);
    const r = await send(tab, { type: 'ms-fill', payload });
    if (!r || !r.ok) { rep.append(el('div', { class: 'err', text: 'Fill failed: ' + (r && r.error) })); return; }
    const { filled, missing, skipped } = r.report;
    rep.append(el('div', { class: 'ok', text: `Filled ${filled.length} inputs.` }));
    if (skipped.length) rep.append(el('div', { class: 'warn', text: `Read-only on the site (left as is): ${skipped.join(', ')}` }));
    if (missing.length) rep.append(el('div', { class: 'warn', text: `Not found on the page: ${missing.join(', ')}` }));
    const filledKeys = new Set([].concat(...FIELD_MAP.map((f) => f[2])));
    const labelOf = (k) => (FIELD_MAP.find((f) => f[2].includes(k)) || [])[1] || k;
    const unsure = Object.keys(m.uncertain).filter((k) => filledKeys.has(k)).map(labelOf);
    if (m.hexa) {
      const hx = filled.filter((f) => /^HEXA /.test(f)).length;
      if (!state.site || !state.site.hexa.length) rep.append(el('div', { class: 'warn', text: 'HEXA: the "HEXA Enhancement" section was not found on the page.' }));
      else if (!payload.hexa.length) rep.append(el('div', { class: 'warn', text: `HEXA: none of the ${m.hexa.cores.length} cores is assigned to a MapleScouter slot yet — choose slots in the HEXA section above, then fill again.` }));
      else rep.append(el('div', { class: hx === payload.hexa.length ? 'ok' : 'warn', text: `HEXA: filled ${hx} of ${payload.hexa.length} assigned cores` + (payload.hexa.length < m.hexa.cores.length ? ` (${m.hexa.cores.length - payload.hexa.length} not assigned)` : '') + '.' }));
    }
    if (unsure.length) rep.append(el('div', { class: 'warn', text: `Double-check: ${unsure.join(', ')}` }));
    chrome.tabs.update(tab.id, { active: true });
    // (only your manual corrections are remembered — see rememberCorrection)
  }

  // ---------------- diagnostics ----------------
  async function copyDiagnostics() {
    let live = null;
    try { const tab = await findTab(); if (tab) { const r = await send(tab, { type: 'ms-scan' }); live = r && r.scan; } } catch (e) { live = { error: e.message }; }
    const m = merged();
    const d = {
      extension: chrome.runtime.getManifest().version, when: new Date().toISOString(), cls: state.cls && state.cls.name,
      page: live && {
        url: live.url, classDetected: live.cls,
        fields: Object.fromEntries(Object.entries(live.fields || {}).map(([k, v]) => [k, v.label + (v.disabled ? ' (read-only)' : '')])),
        rows: Object.fromEntries(Object.entries(live.rows || {}).map(([k, v]) => [k, v.label])),
        hexaSlots: (live.hexa || []).map((h) => ({ slot: h.index + 1, src: h.src, broken: h.broken, alt: h.alt, value: h.value }))
      },
      iconLoading: state.iconDiag, hexaAssign: state.hexaAssign, hexaLevels: m.hexa && m.hexa.cores.map((c) => c.level),
      shots: state.shots.map((s) => ({ kind: s.kind, status: s.status, error: s.error, locator: s.result && s.result.locator, popup: s.result && s.result.popup && s.result.popup.stat }))
    };
    try { await navigator.clipboard.writeText(JSON.stringify(d, null, 1)); $('diagBtn').textContent = 'Copied ✓'; }
    catch (e) { console.log(d); $('diagBtn').textContent = 'Copy failed (see console)'; }
    setTimeout(() => { $('diagBtn').textContent = 'Copy diagnostics'; }, 2500);
  }

  // ---------------- init ----------------
  async function init() {
    setupClasses(); setupInput();
    const cls = await store.get('cls');
    state.memory = (await store.get('hexaMemory2')) || {};
    chrome.storage.local.remove('hexaMemory'); // v1.0/1.1 saved automatic (sometimes wrong) matches
    const ign = await store.get('ignoreLast');
    if (ign != null) { state.ignoreLast = ign; $('ignoreLast').value = ign; }
    if (cls) { $('classSelect').value = cls; state.cls = MSClasses.CLASSES.find((c) => c.name === cls) || null; }
    $('ignoreLast').addEventListener('change', async () => { state.ignoreLast = Math.max(0, +$('ignoreLast').value || 0); await store.set('ignoreLast', state.ignoreLast); matchHexa(); });
    $('scanBtn').addEventListener('click', () => scanSite(false));
    $('diagBtn').addEventListener('click', copyDiagnostics);
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === 'ms-class' && sender.tab && /maplescouter\.com/.test(sender.tab.url || '')) applySiteClass(msg);
    });
    $('fillBtn').addEventListener('click', doFill);
    render();
    scanSite(true);
  }
  init();
})();
