/* MapleScouter page helper: finds the manual-input fields by their visible labels and fills them.
 * Label-based on purpose, so it keeps working if the site's markup/classes change. */
(() => {
  'use strict';
  if (window.__msAutofill) return;
  window.__msAutofill = true;

  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9%]/g, '');

  // Fields in the stat grid. labels: what the site shows (case/spacing/punctuation ignored, prefix match
  // allowed because long labels are cut with "...").
  const FIELDS = [
    { key: 'damageRange', labels: ['General Range', 'Stat Attack', 'Damage Range'] },
    { key: 'damage', labels: ['Damage'], exact: true },
    { key: 'finalDamage', labels: ['Final Damage'] },
    { key: 'bossDamage', labels: ['Boss Damage'] },
    { key: 'ignoreDefense', labels: ['Ignore Enemy Defense', 'Ignore Defense'] },
    { key: 'normalDamage', labels: ['Normal Enemy Damage'] },
    { key: 'attackPower', labels: ['Attack', 'Attack Power'], exact: true, single: true },
    { key: 'magicAtt', labels: ['M.Attack', 'Magic Attack', 'Magic ATT'], exact: true, single: true },
    { key: 'critRate', labels: ['Critical Rate'] },
    { key: 'critDamage', labels: ['Critical Damage'] },
    { key: 'cooldown', labels: ['Cooldown Reduction'], inputs: 2 },
    { key: 'buffDuration', labels: ['Buff Duration'] },
    { key: 'cooldownSkip', labels: ['Cooldown Skip', 'Cooldown Not Applied'] },
    { key: 'ignoreElemental', labels: ['Ignore Elemental Resistance', 'Ignore Elemental Res'] },
    { key: 'statusDamage', labels: ['Additional Status Damage', 'Status Damage'] },
    { key: 'summonDuration', labels: ['Summon Duration', 'Summons Duration'] },
    { key: 'arcane', labels: ['Arcane Force', 'Arcane Power'] },
    { key: 'sacred', labels: ['Sacred Force', 'Sacred Power'] }
  ];
  const ROW_NAMES = { str: ['STR'], dex: ['DEX'], int: ['INT'], luk: ['LUK'], hp: ['HP', 'MaxHP', 'Max HP'], attack: ['Attack', 'Attack Power'], magic: ['M.Attack', 'Magic Attack', 'Magic ATT'] };

  function ownText(el) {
    // text of an element that has no element children with their own text
    if (!el || el.children.length > 2) return null;
    const t = (el.textContent || '').trim();
    return t.length && t.length < 60 ? t : null;
  }

  function candidates() {
    const out = [];
    document.querySelectorAll('body *:not(script):not(style):not(input):not(select):not(textarea)').forEach((el) => {
      const t = ownText(el);
      if (t && !el.querySelector('input')) out.push({ el, t, n: norm(t) });
    });
    return out;
  }

  // Inputs "belonging" to a label: walk up to the nearest ancestor that contains inputs.
  function inputsFor(el, maxUp) {
    let cur = el;
    for (let i = 0; i < (maxUp || 5) && cur; i++) {
      cur = cur.parentElement;
      if (!cur) break;
      const ins = Array.from(cur.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio])'));
      if (ins.length) return { container: cur, inputs: ins };
    }
    return null;
  }

  function matches(c, labels, exact) {
    return labels.some((l) => {
      const n = norm(l);
      if (c.n === n) return true;
      if (exact) return false;
      // ellipsis-truncated label text ("Ignore Enemy Defen...")
      const cut = c.n.replace(/\.+$/, '');
      return (cut.length >= 6 && n.startsWith(cut)) || (c.n.startsWith(n) && c.n.length - n.length <= 2);
    });
  }

  function findStatTable(cands) {
    const head = cands.find((c) => c.n === norm('% Value Not Applied')) || cands.find((c) => c.n === norm('Base Value'));
    if (!head) return null;
    let cur = head.el;
    for (let i = 0; i < 8 && cur; i++) {
      cur = cur.parentElement;
      if (cur && cur.querySelectorAll('input').length >= 3) return cur;
    }
    return null;
  }

  function scan() {
    const cands = candidates();
    const table = findStatTable(cands);
    const rows = {};
    if (table) {
      cands.filter((c) => table.contains(c.el)).forEach((c) => {
        for (const key in ROW_NAMES) {
          if (rows[key]) continue;
          if (ROW_NAMES[key].some((n) => norm(n) === c.n)) {
            // smallest ancestor (inside the table) with exactly 3 inputs = the row
            let cur = c.el, found = null;
            for (let i = 0; i < 5 && cur && cur !== table.parentElement; i++) {
              cur = cur.parentElement;
              const ins = cur ? cur.querySelectorAll('input') : [];
              if (ins.length >= 3) { if (ins.length === 3) found = Array.from(ins); break; }
            }
            if (found) rows[key] = { label: c.t, inputs: found };
          }
        }
      });
    }
    const fields = {};
    FIELDS.forEach((f) => {
      const want = f.inputs || 1;
      for (const c of cands) {
        if (table && table.contains(c.el)) continue;
        if (!matches(c, f.labels, f.exact)) continue;
        const r = inputsFor(c.el);
        if (!r || r.inputs.length !== want) continue;
        fields[f.key] = { label: c.t, inputs: r.inputs };
        break;
      }
    });
    // HEXA Enhancement section
    const hexa = [];
    const hh = cands.find((c) => c.n === norm('HEXA Enhancement')) || cands.find((c) => c.n.startsWith('hexaenhancement'));
    if (hh) {
      let sec = hh.el;
      for (let i = 0; i < 8 && sec; i++) { sec = sec.parentElement; if (sec && sec.querySelectorAll('input').length >= 6) break; }
      if (sec) {
        Array.from(sec.querySelectorAll('input')).forEach((inp, idx) => {
          let cur = inp, img = null;
          for (let i = 0; i < 4 && cur && !img; i++) { cur = cur.parentElement; img = cur && cur.querySelector('img'); }
          const ok = !!(img && img.complete && img.naturalWidth > 0);
          hexa.push({ index: idx, input: inp, src: img ? (img.currentSrc || img.src) : null, broken: !ok, alt: img ? img.alt || img.title || '' : '' });
        });
      }
    }
    return { fields, rows, hexa, url: location.href };
  }

  function setValue(input, value) {
    if (input.disabled || input.readOnly) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    const prev = input.style.outline;
    input.style.outline = '2px solid #2fb67c';
    setTimeout(() => { input.style.outline = prev; }, 2500);
    return true;
  }

  function describe(s) {
    return {
      fields: Object.keys(s.fields).reduce((o, k) => { o[k] = { label: s.fields[k].label, values: s.fields[k].inputs.map((i) => i.value), disabled: s.fields[k].inputs.every((i) => i.disabled || i.readOnly) }; return o; }, {}),
      rows: Object.keys(s.rows).reduce((o, k) => { o[k] = { label: s.rows[k].label, values: s.rows[k].inputs.map((i) => i.value) }; return o; }, {}),
      hexa: s.hexa.map((h) => ({ index: h.index, src: h.src, broken: h.broken, alt: h.alt, value: h.input.value })),
      url: s.url
    };
  }

  function fill(payload) {
    const s = scan(), report = { filled: [], skipped: [], missing: [] };
    Object.entries(payload.fields || {}).forEach(([key, vals]) => {
      const f = s.fields[key];
      if (!f) { report.missing.push(key); return; }
      vals.forEach((v, i) => {
        if (v == null || v === '' || !f.inputs[i]) return;
        (setValue(f.inputs[i], v) ? report.filled : report.skipped).push(f.label + (vals.length > 1 ? ' #' + (i + 1) : ''));
      });
    });
    Object.entries(payload.rows || {}).forEach(([key, vals]) => {
      const r = s.rows[key];
      if (!r) { report.missing.push('row ' + key.toUpperCase()); return; }
      vals.forEach((v, i) => { if (v != null && v !== '' && setValue(r.inputs[i], v)) report.filled.push(r.label + ' [' + ['Base', '%', 'Not applied'][i] + ']'); });
    });
    (payload.hexa || []).forEach((h) => {
      const slot = s.hexa[h.index];
      if (!slot) { report.missing.push('HEXA slot ' + (h.index + 1)); return; }
      if (setValue(slot.input, h.level)) report.filled.push('HEXA ' + (h.index + 1));
    });
    return report;
  }

  // ---------- HEXA icon pixels ----------
  // Try to read each icon's pixels right here (works for same-site or CORS-enabled images).
  function pixelsOf(img) {
    const w = Math.min(64, img.naturalWidth || img.width), h = Math.min(64, img.naturalHeight || img.height);
    if (!w || !h) throw new Error('not loaded');
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h); // throws if the image is cross-origin without CORS
    return { width: w, height: h, data: Array.from(d.data) };
  }
  function loadCors(src) {
    return new Promise((resolve, reject) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { try { resolve(pixelsOf(im)); } catch (e) { reject(e); } };
      im.onerror = () => reject(new Error('CORS load failed'));
      im.src = src;
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
  }
  async function iconPixels() {
    const s = scan();
    const out = [];
    for (const h of s.hexa) {
      const img = h.input && (function find(el) { let cur = el; for (let i = 0; i < 4 && cur; i++) { cur = cur.parentElement; const im = cur && cur.querySelector('img'); if (im) return im; } return null; })(h.input);
      if (!img || h.broken) { out.push({ index: h.index, error: img ? 'image broken/not loaded' : 'no image' }); continue; }
      try { out.push({ index: h.index, px: pixelsOf(img), how: 'page' }); continue; } catch (e) { /* tainted */ }
      try { out.push({ index: h.index, px: await loadCors(h.src), how: 'page-cors' }); } catch (e) { out.push({ index: h.index, error: String(e.message || e) }); }
    }
    return out;
  }
  // Scroll the HEXA section into view and report where each icon is on screen (for tab capture).
  function iconRects() {
    const s = scan();
    const imgs = s.hexa.map((h) => { let cur = h.input; for (let i = 0; i < 4 && cur; i++) { cur = cur.parentElement; const im = cur && cur.querySelector('img'); if (im) return im; } return null; });
    const first = imgs.find(Boolean);
    if (first) first.scrollIntoView({ block: 'center', inline: 'nearest' });
    return new Promise((r) => setTimeout(() => r({
      dpr: window.devicePixelRatio || 1, vw: window.innerWidth, vh: window.innerHeight,
      rects: imgs.map((im) => { if (!im) return null; const b = im.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })
    }), 350));
  }

  // ---------- the class selected on MapleScouter ----------
  const ALIASES = {
    'Arch Mage (Fire, Poison)': ['Arch Mage (F/P)', 'Arch Mage F/P', 'Fire/Poison', 'Fire Poison', 'F/P Arch Mage', 'Fire/Poison Arch Mage', 'Arch Mage (Fire/Poison)'],
    'Arch Mage (Ice, Lightning)': ['Arch Mage (I/L)', 'Arch Mage I/L', 'Ice/Lightning', 'Ice Lightning', 'I/L Arch Mage', 'Ice/Lightning Arch Mage', 'Arch Mage (Ice/Lightning)'],
    'Bowmaster': ['Bow Master'], 'Night Lord': ['Nightlord'], 'Night Walker': ['Nightwalker'], 'Hoyoung': ['Ho Young'],
    'Mo Xuan': ['MoXuan'], 'Dawn Warrior': ['Dawnwarrior'], 'Wind Archer': ['Windarcher'], 'Dual Blade': ['Dual Blader'],
    'Angelic Buster': ['Angelicbuster'], 'Thunder Breaker': ['Thunderbreaker'], 'Demon Avenger': ['Demonavenger'], 'Demon Slayer': ['Demonslayer']
  };
  function classTable() {
    const list = (window.MSClasses && window.MSClasses.CLASSES) || [];
    const t = new Map();
    list.forEach((c) => [c.name].concat(ALIASES[c.name] || []).forEach((n) => t.set(norm(n).replace(/%/g, ''), c.name)));
    return t;
  }
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) && getComputedStyle(el).visibility !== 'hidden';
  const markedSelected = (el) => {
    for (let cur = el, i = 0; cur && i < 4; cur = cur.parentElement, i++) {
      if (cur.getAttribute) {
        if (['aria-selected', 'aria-checked', 'aria-pressed', 'aria-current'].some((a) => cur.getAttribute(a) === 'true' || (a === 'aria-current' && cur.hasAttribute(a) && cur.getAttribute(a) !== 'false'))) return true;
        if (/^(checked|on|active|selected)$/.test(cur.getAttribute('data-state') || '')) return true;
        if (/(^|[\s_-])(active|selected|checked|current|is-active|is-selected)($|[\s_-])/i.test(typeof cur.className === 'string' ? cur.className : '')) return true;
      }
    }
    return false;
  };
  const inList = (el) => !!el.closest('[role=listbox],[role=menu],[role=option],datalist,[role=menuitem]');
  function detectClass() {
    const T = classTable(); if (!T.size) return null;
    const found = [];
    const add = (name, score, how) => found.push({ name, score, how });
    document.querySelectorAll('select').forEach((sel) => {
      const o = sel.options[sel.selectedIndex]; if (!o) return;
      const n = T.get(norm(o.textContent).replace(/%/g, '')) || T.get(norm(o.value).replace(/%/g, ''));
      if (n) add(n, 10, 'select');
    });
    document.querySelectorAll('input:not([type=hidden])').forEach((i) => { const n = T.get(norm(i.value).replace(/%/g, '')); if (n && visible(i)) add(n, 9, 'input'); });
    document.querySelectorAll('body *:not(script):not(style):not(option)').forEach((el) => {
      if (el.children.length > 1) return;
      const raw = (el.textContent || '').trim(); if (!raw || raw.length > 40) return;
      const n = T.get(norm(raw).replace(/%/g, '')); if (!n || !visible(el)) return;
      if (inList(el)) { if (markedSelected(el)) add(n, 8, 'option'); return; }
      if (el.closest('[role=combobox],button,[aria-haspopup]')) add(n, 9, 'combobox');
      else if (markedSelected(el)) add(n, 8, 'selected');
      else add(n, 4, 'text');
    });
    document.querySelectorAll('img[alt],img[title]').forEach((im) => {
      const n = T.get(norm(im.alt || im.title).replace(/%/g, '')); if (n && visible(im)) add(n, markedSelected(im) ? 7 : 3, 'image');
    });
    if (!found.length) return null;
    const top = Math.max(...found.map((f) => f.score));
    const names = Array.from(new Set(found.filter((f) => f.score === top).map((f) => f.name)));
    if (names.length !== 1) return { name: null, ambiguous: names.slice(0, 6), score: top };
    return { name: names[0], score: top, how: found.find((f) => f.score === top && f.name === names[0]).how };
  }
  let lastClass, classTimer = null;
  function checkClass() {
    clearTimeout(classTimer);
    classTimer = setTimeout(() => {
      const c = detectClass(), name = c && c.name;
      if (name && name !== lastClass) {
        lastClass = name;
        try { chrome.runtime.sendMessage({ type: 'ms-class', name, how: c.how }); } catch (e) { /* panel closed */ }
      }
    }, 400);
  }
  new MutationObserver(checkClass).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-checked', 'data-state', 'value'] });
  document.addEventListener('change', checkClass, true);
  document.addEventListener('click', checkClass, true);
  checkClass();

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    try {
      if (msg.type === 'ms-scan') { const d = describe(scan()); d.cls = detectClass(); reply({ ok: true, scan: d }); }
      else if (msg.type === 'ms-icons') { iconPixels().then((icons) => reply({ ok: true, icons })); return true; }
      else if (msg.type === 'ms-icon-rects') { iconRects().then((r) => reply({ ok: true, r })); return true; }
      else if (msg.type === 'ms-class-now') { const c = detectClass(); lastClass = c && c.name; reply({ ok: true, cls: c }); }
      else if (msg.type === 'ms-fill') reply({ ok: true, report: fill(msg.payload) });
      else return false;
    } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
    return true;
  });
})();
