/* Template-based digit reader for MapleStory's stat-window pixel font.
 * Works on a tight crop around a value: splits glyphs on blank columns and matches each one
 * against averaged templates (see templates.js). Independent of panel colour: everything is
 * normalised between the crop's background (median) and its brightest pixels. */
(function (root) {
  'use strict';
  const GW = 6, GH = 10; // template grid

  function norm(img) {
    const n = img.width * img.height, L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      L[i] = Math.max(r, g, b) * 0.6 + (0.299 * r + 0.587 * g + 0.114 * b) * 0.4;
    }
    const s = Array.from(L).sort((a, b) => a - b);
    const bg = s[Math.floor(n * 0.5)], fg = s[Math.floor(n * 0.99)];
    const span = Math.max(20, fg - bg);
    const N = new Float32Array(n);
    for (let i = 0; i < n; i++) N[i] = Math.max(0, Math.min(1, (L[i] - bg) / span));
    return { w: img.width, h: img.height, N, contrast: fg - bg };
  }

  // Text band: rows whose max normalised brightness crosses the threshold.
  function segment(img, thr) {
    thr = thr || 0.4;
    const m = norm(img), { w, h, N } = m;
    if (m.contrast < 30) return { glyphs: [], band: null };
    const rowMax = new Float32Array(h), colMax = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = N[y * w + x]; if (v > rowMax[y]) rowMax[y] = v; if (v > colMax[x]) colMax[x] = v;
    }
    // Main band = the longest run of "inked" rows (digits); commas hang 1-3 rows under it.
    let best = null, cur = null;
    for (let y = 0; y <= h; y++) {
      if (y < h && rowMax[y] > thr) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
      else if (cur) { if (!best || cur.y1 - cur.y0 > best.y1 - best.y0) best = cur; cur = null; }
    }
    if (!best) return { glyphs: [], band: null };
    // a run of inked rows may include the comma tail; digits share the cap height, so recompute
    // the band from column-wise extents later.
    const glyphs = [];
    let gx = null;
    for (let x = 0; x <= w; x++) {
      let ink = false;
      if (x < w) for (let y = best.y0; y <= Math.min(h - 1, best.y1 + 3); y++) if (N[y * w + x] > thr) { ink = true; break; }
      if (ink) { if (gx == null) gx = x; }
      else if (gx != null) { glyphs.push({ x0: gx, x1: x - 1 }); gx = null; }
    }
    glyphs.forEach((g) => {
      let y0 = h, y1 = -1;
      for (let y = Math.max(0, best.y0 - 1); y <= Math.min(h - 1, best.y1 + 3); y++)
        for (let x = g.x0; x <= g.x1; x++) if (N[y * w + x] > thr) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      g.y0 = y0; g.y1 = y1;
    });
    // Cap height = most common glyph height.
    const hs = glyphs.map((g) => g.y1 - g.y0 + 1).sort((a, b) => a - b);
    const capH = hs.length ? hs[Math.floor(hs.length * 0.75)] : 0;
    const top = glyphs.length ? median(glyphs.filter((g) => g.y1 - g.y0 + 1 >= capH * 0.8).map((g) => g.y0)) : 0;
    return { glyphs, m, capH, top };
  }
  function median(a) { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; }

  // Feature vector of a glyph: its pixels resampled onto the cap-height box (GW x GH),
  // plus geometry relative to the cap height.
  function feature(seg, g) {
    const { m, capH, top } = seg, { w, N } = m;
    const gw = g.x1 - g.x0 + 1;
    const v = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const sx = g.x0 + (gx + 0.5) * gw / GW - 0.5, sy = top + (gy + 0.5) * capH / GH - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      const px = (x, y) => (x < g.x0 || x > g.x1 || y < 0 || y >= m.h) ? 0 : N[y * w + x];
      v[gy * GW + gx] = (px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx) * (1 - ty) + (px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx) * ty;
    }
    return { v, aspect: gw / capH, relTop: (g.y0 - top) / capH, relH: (g.y1 - g.y0 + 1) / capH };
  }

  function classify(f, templates) {
    let best = null, second = null;
    for (const ch in templates) {
      for (const t of templates[ch]) {
        let d = 0;
        for (let i = 0; i < f.v.length; i++) d += Math.abs(f.v[i] - t.v[i]);
        d /= f.v.length;
        d += Math.abs(f.aspect - t.aspect) * 0.6 + Math.abs(f.relTop - t.relTop) * 0.8 + Math.abs(f.relH - t.relH) * 0.8;
        if (!best || d < best.d) { second = best; best = { ch, d }; }
        else if ((!second || d < second.d) && ch !== best.ch) second = { ch, d };
      }
    }
    return { ch: best ? best.ch : '?', d: best ? best.d : 9, margin: best && second ? second.d - best.d : 1 };
  }

  /* Read a value. Returns {text, score} where score is the worst glyph distance (lower = surer).
   * Glyphs that do not look like any digit/punctuation (e.g. the yellow ▲ arrow) are dropped
   * when they are at the left edge. */
  function read(img, templates) {
    const seg = segment(img);
    if (!seg.glyphs.length || !seg.capH) return null;
    const res = seg.glyphs.map((g) => {
      const f = feature(seg, g);
      return Object.assign(classify(f, templates), { g, f });
    });
    // drop leading junk
    while (res.length && (res[0].d > 0.32 || res[0].ch === ',' || res[0].ch === '.')) res.shift();
    while (res.length && res[res.length - 1].d > 0.32) res.pop(); // trailing junk (e.g. the ">" button)
    if (!res.length) return null;
    return { text: res.map((r) => r.ch).join(''), score: Math.max(...res.map((r) => r.d)), glyphs: res };
  }

  const api = { segment, feature, classify, read, GW, GH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MSGlyphs = api;
})(typeof self !== 'undefined' ? self : this);
