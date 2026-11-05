/* Screenshot parsers. Shared by the extension's OCR worker and the node test harness.
 * Depends on MSImage (imageproc.js). Every parser takes (engine, image) where engine.recognize(pgm, opts)
 * returns word boxes, and image is {data, width, height}. */
(function (root) {
  'use strict';
  const NODE = typeof module !== 'undefined' && module.exports;
  const IP = NODE ? require('./imageproc.js') : root.MSImage;
  const G = NODE ? require('./glyphs.js') : root.MSGlyphs;
  const TEMPLATES = NODE ? require('./templates.js') : root.MSTemplates;

  // ---------- helpers ----------
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const letters = (s) => s.toUpperCase().replace(/[^A-Z]/g, '');

  // Run OCR and map word boxes back to original image coordinates.
  async function ocr(engine, img, opts) {
    const p = IP.prepare(img, opts);
    const words = await engine.recognize(p.pgm, opts);
    return words.map((w) => ({
      text: w.text, conf: w.conf,
      x: (w.x - p.pad) / p.scale + p.offX, y: (w.y - p.pad) / p.scale + p.offY,
      w: w.w / p.scale, h: w.h / p.scale
    }));
  }

  // Group words into visual rows by vertical overlap (independent of tesseract's own line grouping,
  // which tends to merge side-by-side panels).
  function rows(words) {
    const sorted = words.filter((w) => w.h >= 3).slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    const out = [];
    sorted.forEach((w) => {
      const cy = w.y + w.h / 2;
      let row = out.find((r) => Math.abs(r.cy - cy) < Math.max(2.5, Math.min(r.h, w.h) * 0.45));
      if (!row) { row = { cy, h: w.h, words: [] }; out.push(row); }
      row.words.push(w);
      row.cy = row.words.reduce((s, q) => s + q.y + q.h / 2, 0) / row.words.length;
      row.h = Math.max(row.h, w.h);
    });
    out.forEach((r) => r.words.sort((a, b) => a.x - b.x));
    return out;
  }

  // Find label phrases inside a row. labels: [{key, text}]. Longest labels win.
  function findLabels(row, labels, opts) {
    const toks = row.words.map((w) => letters(w.text));
    const used = new Array(toks.length).fill(false);
    const found = [];
    const sorted = labels.slice().sort((a, b) => letters(b.text).length - letters(a.text).length);
    sorted.forEach((lab) => {
      const target = letters(lab.text);
      const tol = target.length <= 3 ? 0 : target.length <= 6 ? 1 : Math.ceil(target.length * 0.15);
      let best = null;
      for (let i = 0; i < toks.length; i++) {
        if (!toks[i] || used[i]) continue;
        let s = '';
        for (let k = i; k < Math.min(toks.length, i + 5); k++) {
          if (used[k]) break;
          s += toks[k];
          if (!s) continue;
          if (s.length > target.length + tol) break;
          const d = lev(s, target);
          if (d <= tol && (!best || d < best.d)) best = { d, i, k };
        }
      }
      if (best && opts && opts.needNumber) {
        const endX = row.words[best.k].x + row.words[best.k].w;
        const after = row.words.slice(best.k + 1).find((w) => letters(w.text).length > 2 || /\d/.test(w.text));
        if (!after || !/\d/.test(after.text) || after.x - endX > opts.needNumber) best = null;
      }
      if (best) {
        for (let k = best.i; k <= best.k; k++) used[k] = true;
        const ws = row.words.slice(best.i, best.k + 1);
        const x0 = ws[0].x, x1 = Math.max(...ws.map((w) => w.x + w.w));
        const y0 = Math.min(...ws.map((w) => w.y)), y1 = Math.max(...ws.map((w) => w.y + w.h));
        found.push({ key: lab.key, x: x0, x2: x1, y: y0, h: y1 - y0, cy: (y0 + y1) / 2, d: best.d });
      }
    });
    return found.sort((a, b) => a.x - b.x);
  }

  // Read a number from a crop using a digits-only OCR pass.
  // Returns the raw text of the right-most "word" (values are right-aligned; arrows/icons sit to the left).
  async function readValue(engine, img, rect, kind) {
    const whitelist = kind === 'cooldown' ? '0123456789.%/sec' : kind === 'integer' ? '0123456789,%' : '0123456789.,%';
    const pad = rect.h * 0.35;
    const r = { x: rect.x, y: rect.y - pad, w: rect.w, h: rect.h + pad * 2 };
    let words = await ocr(engine, img, { rect: r, scale: rect.h < 14 ? 4 : 3, psm: 7, whitelist, mode: 'otsu' });
    if (api.onCrop) api.onCrop(r, words);
    words = words.filter((w) => /\d/.test(w.text));
    if (!words.length) return null;
    if (kind === 'cooldown') return words.map((w) => w.text).join(' ');
    return words.map((w) => w.text).join('');
  }

  function toNumber(s) {
    if (s == null) return null;
    const t = String(s).replace(/,/g, '').replace(/%/g, '').replace(/[^0-9.]/g, '');
    if (!t || t === '.') return null;
    // A value like "105.00" keeps its decimal; OCR sometimes doubles dots.
    const parts = t.split('.');
    const n = parseFloat(parts.length > 2 ? parts.slice(0, -1).join('') + '.' + parts[parts.length - 1] : t);
    return isFinite(n) ? n : null;
  }

  // ---------- the in-game STAT window ----------
  const STAT_LABELS = [
    { key: 'hp', text: 'HP' }, { key: 'mp', text: 'MP' },
    { key: 'str', text: 'STR' }, { key: 'dex', text: 'DEX' }, { key: 'int', text: 'INT' }, { key: 'luk', text: 'LUK' },
    { key: 'damageRange', text: 'DAMAGE RANGE' }, { key: 'damage', text: 'DAMAGE' },
    { key: 'finalDamage', text: 'FINAL DAMAGE' }, { key: 'bossDamage', text: 'BOSS DAMAGE' },
    { key: 'ignoreDefense', text: 'IGNORE DEFENSE' }, { key: 'normalDamage', text: 'NORMAL ENEMY DAMAGE' },
    { key: 'attackPower', text: 'ATTACK POWER' }, { key: 'critRate', text: 'CRITICAL RATE' },
    { key: 'magicAtt', text: 'MAGIC ATT' }, { key: 'critDamage', text: 'CRITICAL DAMAGE' },
    { key: 'cooldown', text: 'COOLDOWN REDUCTION' }, { key: 'buffDuration', text: 'BUFF DURATION' },
    { key: 'cooldownSkip', text: 'COOLDOWN NOT APPLIED' }, { key: 'ignoreElemental', text: 'IGNORE ELEMENTAL RESISTANCE' },
    { key: 'statusDamage', text: 'ADDITIONAL STATUS DAMAGE' }, { key: 'summonDuration', text: 'SUMMONS DURATION INCREASE' },
    { key: 'meso', text: 'MESOS OBTAINED' }, { key: 'starForce', text: 'STAR FORCE' },
    { key: 'dropRate', text: 'ITEM DROP RATE' }, { key: 'arcane', text: 'ARCANE POWER' },
    { key: 'exp', text: 'ADDITIONAL EXP OBTAINED' }, { key: 'sacred', text: 'SACRED POWER' },
    { key: 'combatPower', text: 'COMBAT POWER' }
  ];
  const POPUP_LABELS = [
    { key: 'current', text: 'Current Value' }, { key: 'base', text: 'Base Value' },
    { key: 'pctNotApplied', text: '% Value Not Applied' }, { key: 'pct', text: '% Value' }
  ];
  const POPUP_STATS = { STR: 'str', DEX: 'dex', INT: 'int', LUK: 'luk', HP: 'hp', MAXHP: 'hp', ATTACKPOWER: 'attack', MAGICATT: 'magic', ATTACK: 'attack', MAGICATTACK: 'magic' };

  // Union of label hits over several OCR passes; first pass wins per key.
  function collectLabels(passes, labels, opts, filter) {
    const out = {};
    passes.forEach((ws) => {
      rows(filter ? ws.filter(filter) : ws).forEach((r) => findLabels(r, labels, opts).forEach((l) => {
        l.row = r;
        if (!out[l.key] || l.d < out[l.key].d - 0.5) out[l.key] = l;
      }));
    });
    return Object.values(out);
  }

  /* Find the in-game STAT window inside a larger screenshot (full screen, other windows, chat,
   * name tags, skill effects...). Uses labels that only the STAT window has, all upper-case and
   * aligned in two columns. Returns a crop rectangle covering the window plus the STAT INFO
   * pop-out column to its right, or null if the screenshot is already just the window. */
  const ANCHORS = [
    { key: 'damageRange', text: 'DAMAGE RANGE', col: 0 }, { key: 'finalDamage', text: 'FINAL DAMAGE', col: 0 },
    { key: 'ignoreDefense', text: 'IGNORE DEFENSE', col: 0 }, { key: 'magicAtt', text: 'MAGIC ATT', col: 0 },
    { key: 'cooldown', text: 'COOLDOWN REDUCTION', col: 0 }, { key: 'cooldownSkip', text: 'COOLDOWN NOT APPLIED', col: 0 },
    { key: 'statusDamage', text: 'ADDITIONAL STATUS DAMAGE', col: 0 }, { key: 'meso', text: 'MESOS OBTAINED', col: 0 },
    { key: 'dropRate', text: 'ITEM DROP RATE', col: 0 }, { key: 'exp', text: 'ADDITIONAL EXP OBTAINED', col: 0 },
    { key: 'normalDamage', text: 'NORMAL ENEMY DAMAGE', col: 1 }, { key: 'buffDuration', text: 'BUFF DURATION', col: 1 },
    { key: 'ignoreElemental', text: 'IGNORE ELEMENTAL RESISTANCE', col: 1 }, { key: 'summonDuration', text: 'SUMMONS DURATION INCREASE', col: 1 },
    { key: 'starForce', text: 'STAR FORCE', col: 1 }, { key: 'sacred', text: 'SACRED POWER', col: 1 },
    { key: 'combatPower', text: 'COMBAT POWER', col: -1 }
  ];
  /* Fast, OCR-free locator: the STAT window's main panel has a fixed blue-grey colour and shape
   * (a ~2.4:1 panel with a full-width title strip above it). Returns candidate crops, best first. */
  function colorLocate(img) {
    const cell = 6, W = img.width, H = img.height, d = img.data;
    const cw = Math.floor(W / cell), ch = Math.floor(H / cell), g = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let m = 0;
      for (let y = cy * cell; y < cy * cell + cell; y++) for (let x = cx * cell; x < cx * cell + cell; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(d[i] - 108) <= 10 && Math.abs(d[i + 1] - 119) <= 10 && Math.abs(d[i + 2] - 133) <= 10) m++;
      }
      g[cy * cw + cx] = m >= cell * cell * 0.6 ? 1 : 0;
    }
    const lab = new Int32Array(cw * ch).fill(-1), comps = [];
    for (let i = 0; i < cw * ch; i++) {
      if (!g[i] || lab[i] >= 0) continue;
      const c = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 }, st = [i]; lab[i] = comps.length;
      while (st.length) {
        const p = st.pop(), x = p % cw, y = (p - x) / cw;
        c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) return;
          const q = ny * cw + nx; if (g[q] && lab[q] < 0) { lab[q] = comps.length; st.push(q); }
        });
      }
      comps.push({ x: c.x0 * cell, y: c.y0 * cell, w: (c.x1 - c.x0 + 1) * cell, h: (c.y1 - c.y0 + 1) * cell, fill: c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) });
    }
    const out = [];
    comps.forEach((m) => {
      const aspect = m.w / m.h;
      if (m.w < 150 || aspect < 1.8 || aspect > 3.2 || m.fill < 0.6) return;
      // structure score: a thin strip of the same width above (title bar) and a panel below
      const sameW = (c) => Math.abs(c.x - m.x) <= 12 && Math.abs(c.w - m.w) <= 18;
      const above = comps.some((c) => c !== m && sameW(c) && c.y < m.y && c.y > m.y - m.h * 1.1 && c.h < m.h * 0.2);
      const below = comps.some((c) => c !== m && sameW(c) && c.y > m.y + m.h && c.y < m.y + m.h * 1.2);
      const score = (above ? 2 : 0) + (below ? 1 : 0) + m.fill;
      const x0 = Math.max(0, m.x - m.w * 0.03), y0 = Math.max(0, m.y - m.h * 0.92);
      const x1 = Math.min(W, m.x + m.w * 1.66), y1 = Math.min(H, m.y + m.h * 1.65);
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, popupLeft: m.x + m.w + 4 - x0, score });
    });
    return out.sort((a, b) => b.score - a.score);
  }

  async function locateStatWindow(engine, img) {
    const words = await ocr(engine, img, { scale: 2, psm: 11 });
    const hits = [];
    rows(words).forEach((r) => findLabels(r, ANCHORS.filter((a) => a.col >= 0), { needNumber: 1e9 }).forEach((l) => {
      // the real labels are upper-case; Hyper Stats / Ability use mixed case ("Boss Damage")
      const raw = r.words.filter((w) => w.x >= l.x - 1 && w.x + w.w <= l.x2 + 1).map((w) => w.text).join('');
      const lettersOnly = raw.replace(/[^A-Za-z]/g, '');
      if (lettersOnly && lettersOnly.replace(/[^a-z]/g, '').length > lettersOnly.length * 0.3) return;
      l.col = ANCHORS.find((a) => a.key === l.key).col; hits.push(l);
    }));
    const left = hits.filter((h) => h.col === 0), right = hits.filter((h) => h.col === 1);
    if (left.length < 3) return null;
    // left-column labels share one x; keep the biggest group (another copy of the window, if any, loses)
    const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const lx = med(left.map((h) => h.x));
    const L = left.filter((h) => Math.abs(h.x - lx) < 12);
    const h = med(L.map((q) => q.h));
    const top0 = Math.min(...L.map((q) => q.y)), bot0 = Math.max(...L.map((q) => q.y + q.h));
    const R = right.filter((q) => q.x > lx && q.y > top0 - h * 4 && q.y < bot0 + h * 4);
    const rx = R.length ? med(R.map((q) => q.x)) : lx + h * 24;
    const colW = rx - lx;
    // The window spans ~2 columns; its top (Combat Power + basic stats) sits ~8 rows above DAMAGE RANGE.
    const dr = L.find((q) => q.key === 'damageRange');
    const rowPitch = L.length > 1 ? (bot0 - top0) / Math.max(1, L.length) : h * 2.4;
    const top = (dr ? dr.y : top0) - Math.max(h * 22, rowPitch * 9);
    const bottom = bot0 + h * 7;
    const winLeft = lx - colW * 0.12, winRight = lx + colW * 2.05;
    const rect = {
      x: Math.max(0, winLeft), y: Math.max(0, top),
      w: Math.min(img.width, winRight + colW * 1.1) - Math.max(0, winLeft),
      h: Math.min(img.height, bottom) - Math.max(0, top),
      popupLeft: winRight - Math.max(0, winLeft) // relative x where the pop-out column begins
    };
    // Already tight? (the screenshot is just the window)
    if (rect.w * rect.h > img.width * img.height * 0.7) return null;
    return rect;
  }

  // A parse is trusted when it found most of the window's labels, including the main anchors.
  const goodParse = (r) => r && r.debug.labels.length >= 14 && r.values.damageRange != null && r.values.finalDamage != null;

  async function parseStatWindow(engine, img, opts) {
    opts = opts || {};
    if (opts.cropped) return parseStatWindowInner(engine, img, opts);
    const big = img.width * img.height > 900 * 650;
    // 1) colour locator (no OCR) -> parse the crop; accept only if the parse looks complete.
    const cands = colorLocate(img).slice(0, 2);
    for (const loc of cands) {
      if (loc.w * loc.h > img.width * img.height * 0.7) break; // screenshot is already just the window
      const r = await parseStatWindowInner(engine, IP.crop(img, loc.x, loc.y, loc.w, loc.h), { cropped: true, popupLeft: loc.popupLeft });
      if (goodParse(r)) { r.debug.crop = loc; r.debug.locator = 'colour'; return r; }
    }
    // A small, tight screenshot: parse it whole; only fall back to the slow locator if that fails.
    if (!big) {
      const r = await parseStatWindowInner(engine, img, opts);
      if (goodParse(r)) { r.debug.locator = 'none'; return r; }
    }
    // 2) text-based locator (slower, works whatever the colours)
    const loc = await locateStatWindow(engine, img);
    if (loc) {
      const r = await parseStatWindowInner(engine, IP.crop(img, loc.x, loc.y, loc.w, loc.h), { cropped: true, popupLeft: loc.popupLeft });
      r.debug.crop = loc; r.debug.locator = 'text';
      return r;
    }
    const r = await parseStatWindowInner(engine, img, opts);
    r.debug.locator = 'none';
    return r;
  }

  async function parseStatWindowInner(engine, img, opts) {
    opts = opts || {};
    // Two layout passes: sparse text, and automatic page segmentation. They fail on different words.
    // Run them concurrently (the engine may be a pool of OCR workers).
    const [passA, passB] = await Promise.all([ocr(engine, img, { scale: 3, psm: 11 }), ocr(engine, img, { scale: 3, psm: 3 })]);
    const words = passA.concat(passB);

    // Locate the STAT INFO pop-out (if any) so its text is not confused with the stat window.
    let popLabs = collectLabels([passA, passB], POPUP_LABELS, { needNumber: 400 });
    if (opts.popupLeft != null) popLabs = popLabs.filter((l) => l.x > opts.popupLeft - 30);
    let popupX = popLabs.length ? Math.min(...popLabs.map((l) => l.x)) : Infinity;
    const inStat = (w) => w.x + w.w < popupX - 4;
    const statWords = passA.filter(inStat);
    const statWordsB = passB.filter(inStat);

    // Labels in the stat window
    const labels = collectLabels([statWords, statWordsB], STAT_LABELS);
    const statRows = Array.from(new Set(labels.map((l) => l.row)));

    // Column geometry: left column starts at the minimum label x; right column at the most common
    // x of labels that sit to the right of a left-column label on the same row.
    const leftX = Math.min(...labels.map((l) => l.x));
    const rightXs = [];
    statRows.forEach((r) => {
      const ls = labels.filter((l) => l.row === r).sort((a, b) => a.x - b.x);
      if (ls.length >= 2) rightXs.push(ls[ls.length - 1].x);
    });
    rightXs.sort((a, b) => a - b);
    const rightX = rightXs.length ? rightXs[Math.floor(rightXs.length / 2)] : leftX + 220;
    const colW = rightX - leftX;

    // Right edge of the value column = right-most numeric word of the stat window (values are right-aligned).
    const numWordsA = statWords.filter((w) => /\d/.test(w.text) && w.h >= 5);
    const numWords = numWordsA.concat(statWordsB.filter((w) => /\d/.test(w.text) && w.h >= 5));
    // Values are right-aligned: the column's value edge is where most numeric words end.
    const edgeOf = (ws, fallback) => {
      const e = ws.map((w) => w.x + w.w).sort((a, b) => a - b);
      if (e.length < 3) return fallback;
      // densest cluster of right edges (within 3px)
      let best = e[0], bestN = 0;
      e.forEach((x) => { const n = e.filter((y) => Math.abs(y - x) <= 3).length; if (n > bestN || (n === bestN && x > best)) { bestN = n; best = x; } });
      return Math.max(...e.filter((y) => Math.abs(y - best) <= 3));
    };
    const rightValEdge = edgeOf(numWords.filter((w) => w.x > rightX && w.x + w.w < popupX - 4), rightX + colW * 0.8);
    const windowRight = Math.min(img.width, popupX - 4, rightValEdge + 6);
    const leftValEdge = edgeOf(numWords.filter((w) => w.x < rightX - 4 && w.x > leftX && w.x + w.w < rightX), leftX + colW * 0.8);

    // Structural fallback for the short basic-stat labels (HP/MP, STR/DEX, INT/LUK), which OCR
    // garbles easily: they are always the three rows between Combat Power and Damage Range.
    const byKey = {}; labels.forEach((l) => { byKey[l.key] = l; });
    const dr = byKey.damageRange;
    if (dr) {
      const cp = byKey.combatPower;
      const lh = dr.h;
      const top = cp ? cp.y + cp.h + lh * 0.5 : dr.y - lh * 9;
      const nw = numWords.filter((w) => w.y > top && w.y + w.h < dr.y - lh * 0.3 && w.h >= lh * 0.7);
      const ys = [];
      nw.sort((a, b) => a.y - b.y).forEach((w) => {
        const cy = w.y + w.h / 2, c = ys.find((q) => Math.abs(q.cy - cy) < lh * 0.8);
        if (c) { c.cy = (c.cy * c.n + cy) / (c.n + 1); c.n++; c.h = Math.max(c.h, w.h); } else ys.push({ cy, n: 1, h: w.h });
      });
      ys.sort((a, b) => a.cy - b.cy);
      if (ys.length >= 3) {
        const use = ys.slice(-3);
        [['hp', 'mp'], ['str', 'dex'], ['int', 'luk']].forEach((pair, i) => {
          pair.forEach((key, side) => {
            const y = use[i].cy - lh / 2;
            if (byKey[key] && Math.abs(byKey[key].cy - use[i].cy) < lh) return; // real label agrees
            const x = side ? rightX : leftX;
            const l = { key, x, x2: x + colW * 0.25, y, h: lh, cy: use[i].cy, inferred: true };
            const idx = labels.indexOf(byKey[key]);
            if (idx >= 0) labels.splice(idx, 1);
            labels.push(l); byKey[key] = l;
          });
        });
      }
    }

    const values = {}, raw = {}, uncertain = {}, rects = {};
    const jobs = [], seen = new Set();
    labels.forEach((l) => {
      if (seen.has(l.key)) return; seen.add(l.key);
      const isLeft = Math.abs(l.x - leftX) < colW * 0.3;
      const wide = l.key === 'combatPower';
      const colEnd = wide ? windowRight : isLeft ? Math.min(rightX - 3, leftValEdge + 6) : windowRight;
      const kind = l.key === 'cooldown' ? 'cooldown' : 'number';
      // Words from the first pass that hold this label's value.
      const cand = numWords.filter((w) => Math.abs((w.y + w.h / 2) - l.cy) < Math.max(l.h, w.h) * 0.75 && w.x >= l.x2 - 1 && w.x + w.w <= colEnd + 4);
      const extra = kind === 'cooldown' ? statWords.filter((w) => Math.abs((w.y + w.h / 2) - l.cy) < l.h && w.x >= l.x2 && w.x + w.w <= colEnd + 4) : cand;
      let rect, first = null;
      if (extra.length) {
        const ws0 = extra; const ws = ws0.map((w) => {
          const m = w.text.match(/^[^0-9]+/); // leading arrow glyphs glued to the number
          const cut = m ? w.w * m[0].length / w.text.length : 0;
          return { x: w.x + cut, x2: w.x + w.w, y: w.y, y2: w.y + w.h };
        });
        const valEdge = wide ? windowRight - 6 : isLeft ? leftValEdge : rightValEdge;
        const x0 = Math.min(...ws.map((w) => w.x)), x1 = Math.max(Math.max(...ws.map((w) => w.x2)), valEdge);
        rect = { x: x0 - l.h * 0.4, y: l.y, w: x1 - x0 + l.h * 0.8, h: Math.max(l.h, 8) };
        const candA = cand.filter((w) => numWordsA.includes(w));
        first = (candA.length ? candA : cand).map((w) => w.text.replace(/^[^0-9]+/, '')).join('');
      } else {
        const start = l.x2 + l.h * (l.key.length <= 3 ? 1.6 : 0.6);
        rect = { x: start, y: l.y, w: Math.max(10, colEnd - start), h: Math.max(l.h, 8) };
      }
      rects[l.key] = rect;
      jobs.push({ l, rect, kind, first, p: readValue(engine, img, rect, kind) });
    });
    // Pop-out reading runs alongside the value reads.
    const popupP = popLabs.length ? parsePopup(engine, img, popLabs, popupX, words) : Promise.resolve(null);
    const txts = await Promise.all(jobs.map((j) => j.p));
    jobs.forEach(({ l, rect, kind, first }, ji) => {
      const txt = txts[ji];
      raw[l.key] = txt;
      if (kind === 'cooldown') {
        const m = (txt || '').match(/(\d+(?:\.\d+)?)\s*s?e?c?\D+?(\d+(?:\.\d+)?)/);
        values.cooldownSec = m ? +m[1] : null;
        values.cooldownPct = m ? +m[2] : null;
      } else {
        const a = toNumber(txt), b = toNumber(first);
        // Template reader (most reliable for this font); Tesseract readings are the fallback.
        const gl = l.key === 'combatPower' ? null : G.read(IP.crop(img, rect.x - 2, rect.y - 4, rect.w + 4, rect.h + 8), TEMPLATES);
        const c = gl ? toNumber(gl.text) : null;
        if (gl) raw[l.key + ':glyph'] = gl.text + ' (' + gl.score.toFixed(3) + ')';
        const digits = (x) => (x == null ? '' : String(x).replace(/[^0-9]/g, ''));
        // Tesseract's typical slip on this font is dropping a leading digit; if the template reading
        // only adds digits in front of what Tesseract saw, trust the template reading.
        const glyphExtends = c != null && [a, b].some((t) => t != null && digits(c).length > digits(t).length && digits(c).endsWith(digits(t)));
        if (c != null && (gl.score < 0.22 || (gl.score < 0.36 && (glyphExtends || (a == null && b == null))))) {
          values[l.key] = c;
          if (gl.score > 0.12 && c !== a && c !== b) uncertain[l.key] = { glyph: c, tesseract: a, firstPass: b };
        } else {
          const pick = a != null ? a : b != null ? b : c;
          values[l.key] = pick;
          if (pick == null || [a, b, c].filter((v) => v != null && v !== pick).length) uncertain[l.key] = { glyph: c, tesseract: a, firstPass: b };
        }
      }
    });

    const popup = await popupP;
    if (popup && popup.current != null) {
      // The popup's Current Value equals one of the stat-window totals: that identifies the stat.
      const map = { hp: 'hp', str: 'str', dex: 'dex', int: 'int', luk: 'luk', attackPower: 'attack', magicAtt: 'magic' };
      const hits = Object.keys(map).filter((k) => values[k] === popup.current);
      if (hits.length === 1) { if (popup.stat && popup.stat !== map[hits[0]]) popup.headerStat = popup.stat; popup.stat = map[hits[0]]; }
    }
    return { values, raw, uncertain, rects, popup, debug: { labels: labels.map((l) => l.key), popupX } };
  }

  async function parsePopup(engine, img, labs, popupX, words) {
    const lh = Math.max(...labs.map((l) => l.h));
    const rightLimit = Math.min(img.width, popupX + lh * 22);
    const firstY = Math.min(...labs.map((l) => l.y));
    // Header (stat name): OCR the popup column above the value rows as a text block.
    let stat = null;
    const hwP = ocr(engine, img, { rect: { x: popupX - lh, y: 0, w: rightLimit - popupX + lh, h: Math.max(10, firstY - lh * 0.5) }, scale: 3, psm: 6 });
    const valsP = []; // started below, awaited together with the header
    const startHeader = async () => { const hw = await hwP; for (const r of rows(hw)) {
      const t = letters(r.words.map((w) => w.text).join(''));
      for (const name of Object.keys(POPUP_STATS)) {
        if (t === name || (name.length > 4 && lev(t, name) <= 1)) { stat = POPUP_STATS[name]; break; }
      }
      if (stat) break;
    } };
    // The four value rows always come in this order. Prefer geometry (numeric rows in the popup
    // column, starting at the first label row) over individual label hits.
    const ORDER = ['current', 'base', 'pct', 'pctNotApplied'];
    // Numeric words in the popup's value column, grouped into rows.
    const numW = (words || []).filter((w) => /\d/.test(w.text) && w.x > popupX + lh * 5 && w.y > firstY - lh && w.h >= lh * 0.6);
    const right = numW.length ? Math.min(img.width, Math.max(...numW.map((w) => w.x + w.w)) + lh * 0.6) : rightLimit;
    const vrows = [];
    numW.sort((a, b) => a.y - b.y).forEach((w) => {
      const cy = w.y + w.h / 2, r = vrows.find((q) => Math.abs(q.cy - cy) < lh * 0.7);
      if (r) { r.ws.push(w); r.x0 = Math.min(r.x0, w.x); } else vrows.push({ cy, ws: [w], x0: w.x });
    });
    vrows.sort((a, b) => a.cy - b.cy);
    // Anchor on the "Current Value" label if seen, otherwise on the top-most value row.
    const curLab = labs.find((l) => l.key === 'current');
    let start = 0;
    if (curLab) { const i = vrows.findIndex((r) => Math.abs(r.cy - curLab.cy) < lh); if (i >= 0) start = i; }
    // Value rows are evenly spaced; a much larger gap means we left the pop-out (e.g. into the
    // Ability window below it), so stop there.
    let rowsUsed = vrows.slice(start, start + 4);
    if (rowsUsed.length >= 2) {
      const pitch = rowsUsed[1].cy - rowsUsed[0].cy;
      for (let k = 2; k < rowsUsed.length; k++) if (rowsUsed[k].cy - rowsUsed[k - 1].cy > pitch * 1.6) { rowsUsed = rowsUsed.slice(0, k); break; }
    }
    // A row only counts if a label hit (when we have one) agrees with its position.
    const vals = {}, raw = {};
    ORDER.forEach((key, i) => {
      const r = rowsUsed[i], hit = labs.find((l) => l.key === key);
      let rect;
      if (r) {
        // start right after this row's label text (values are right-aligned; a crop that starts at
        // the first OCR'd digit can cut off digits OCR missed)
        const lab = (words || []).filter((w) => !/\d/.test(w.text) && /[A-Za-z]/.test(w.text) && Math.abs(w.y + w.h / 2 - r.cy) < lh * 0.7 && w.x >= popupX - lh && w.x < r.x0);
        const labEnd = hit ? hit.x2 : lab.length ? Math.max(...lab.map((w) => w.x + w.w)) : r.x0 - lh * 3;
        const x0 = Math.min(r.x0 - lh * 0.8, Math.max(labEnd + lh * 0.5, r.x0 - lh * 6));
        rect = { x: x0, y: r.cy - lh / 2, w: right - x0, h: lh };
      }
      else if (hit) rect = { x: hit.x2 + lh * 0.6, y: hit.y, w: Math.max(10, right - hit.x2 - lh * 0.6), h: lh };
      else return;
      valsP.push(readValue(engine, img, rect, 'integer').then((txt) => {
        raw[key] = txt;
        const n = txt == null ? null : parseInt(String(txt).replace(/[^0-9]/g, ''), 10);
        vals[key] = isFinite(n) ? n : null;
      }));
    });
    await Promise.all(valsP.concat([startHeader()]));
    // Consistency: Current = floor(Base * (1 + %/100)) + NotApplied. If exactly one field is off,
    // recompute it from the other three when the fix is a plausible single-digit OCR slip.
    const calc = (v) => Math.floor(v.base * (1 + v.pct / 100)) + v.pctNotApplied;
    const ok = (v) => [v.base, v.pct, v.pctNotApplied, v.current].every((x) => x != null) && Math.abs(calc(v) - v.current) <= Math.max(1, v.current * 0.0005);
    let consistent = ok(vals) ? true : null, corrected = null;
    if (!consistent && [vals.base, vals.pct, vals.pctNotApplied, vals.current].filter((x) => x != null).length >= 3) {
      const cands = [];
      const near = (a, b) => a != null && b != null && (
        (String(a).length === String(b).length && [...String(a)].filter((c, i) => c !== String(b)[i]).length <= 1) ||
        (String(b).length > String(a).length && String(b).endsWith(String(a))) || // OCR dropped leading digits
        (String(a).length === String(b).length + 1 && String(a).startsWith(String(b)))); // "%" read as a digit
      const tryV = (key, v) => { const t = Object.assign({}, vals, { [key]: v }); if (ok(t) && (vals[key] == null || near(vals[key], v))) cands.push({ key, v }); };
      if (vals.pct != null && vals.pctNotApplied != null && vals.current != null) {
        const b = (vals.current - vals.pctNotApplied) / (1 + vals.pct / 100);
        [Math.floor(b), Math.ceil(b), Math.round(b)].forEach((x) => tryV('base', x));
      }
      if (vals.base != null && vals.pct != null && vals.current != null) tryV('pctNotApplied', vals.current - Math.floor(vals.base * (1 + vals.pct / 100)));
      if (vals.base != null && vals.pct != null && vals.pctNotApplied != null) tryV('current', calc(vals));
      if (vals.base != null && vals.pctNotApplied != null && vals.current != null) {
        const p = Math.round(((vals.current - vals.pctNotApplied) / vals.base - 1) * 100);
        tryV('pct', p);
      }
      const uniq = cands.filter((c, i) => cands.findIndex((d) => d.key === c.key) === i);
      if (uniq.length === 1) { corrected = { field: uniq[0].key, from: vals[uniq[0].key], to: uniq[0].v }; vals[uniq[0].key] = uniq[0].v; consistent = true; }
      else consistent = false;
    }
    return { stat, base: vals.base, pct: vals.pct, notApplied: vals.pctNotApplied, current: vals.current, consistent, corrected, raw };
  }

  // ---------- HEXA icon matching ----------
  // Assign in-game cores to website slots by icon similarity (optimal assignment). A core may stay
  // unassigned when nothing on the site resembles it (cost of "no match" = noMatch).
  function matchIcons(coreSigs, siteSigs, noMatch) {
    const H = NODE ? require('./assign.js') : root.MSAssign;
    const cost = coreSigs.map((c) => siteSigs.map((s) => (s ? IP.iconDistance(c, s) : null)));
    const all = [].concat(...cost).filter((x) => x != null).sort((a, b) => a - b);
    const nm = noMatch != null ? noMatch : (all.length ? all[Math.floor(all.length * 0.25)] : 1);
    // dummy columns, one per core
    const ext = cost.map((row, i) => row.concat(coreSigs.map((_, k) => (k === i ? nm : null))));
    const res = H.hungarian(ext);
    return res.map((j, i) => (j == null || j >= siteSigs.length ? null : { slot: j, d: cost[i][j] }));
  }

  const api = { ocr, rows, findLabels, readValue, toNumber, parseStatWindow, colorLocate, matchIcons, lev, letters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MSParse = api;
})(typeof self !== 'undefined' ? self : this);
