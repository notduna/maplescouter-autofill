/* HEXA Matrix reader: finds the two-digit level labels ("09", "30") drawn on small pills above each
 * core icon, reads them with a tiny pixel-font classifier, and crops the icon under each label.
 * No OCR engine needed. Works on any background because it only looks for very bright, compact
 * digit pairs with a clean margin. */
(function (root) {
  'use strict';
  const NODE = typeof module !== 'undefined' && module.exports;
  const IP = NODE ? require('./imageproc.js') : root.MSImage;

  // 4x5 pixel-font digit bitmaps (as drawn on the HEXA level pills).
  // 5x5 rounded pixel-font digits as drawn on the HEXA level pills (0,1,2,3,8,9 traced from a
  // real screenshot; 4,5,6,7 drawn in the same style).
  const FONT = {
    0: ['.###.', '#...#', '#...#', '#...#', '.###.'],
    1: ['##', '.#', '.#', '.#', '.#'],
    2: ['####.', '....#', '####.', '#....', '#####'],
    3: ['####.', '....#', '.####', '....#', '####.'],
    4: ['#..#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '####.'],
    6: ['.###.', '#....', '####.', '#...#', '.###.'],
    7: ['#####', '....#', '...#.', '..#..', '..#..'],
    8: ['.###.', '#...#', '.###.', '#...#', '.###.'],
    9: ['.###.', '#...#', '.####', '....#', '.###.']
  };

  function whiteness(img) {
    const n = img.width * img.height, W = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      // bright and not strongly saturated (digits are white / pale pink / pale blue)
      W[i] = mx * 0.55 + mn * 0.45;
    }
    return W;
  }

  // separable sliding-window minimum
  function minFilter(A, w, h, r) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 255; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = A[y * w + k]; if (v < m) m = v; }
      t[y * w + x] = m;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let m = 255; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = t[k * w + x]; if (v < m) m = v; }
      o[y * w + x] = m;
    }
    return o;
  }

  function components(mask, w, h) {
    const lab = new Int32Array(w * h).fill(-1), comps = [];
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i] >= 0) continue;
      const c = { x0: w, y0: h, x1: -1, y1: -1, n: 0, id: comps.length };
      lab[i] = c.id; stack.push(i);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx; if (mask[q] && lab[q] < 0) { lab[q] = c.id; stack.push(q); }
        }
        if (c.n > 400) break; // big bright areas are not digits
      }
      while (stack.length) { const p = stack.pop(); lab[p] = c.id; }
      comps.push(c);
    }
    return comps;
  }

  // Grey-level grid of a digit box resampled to 4x5, normalised 0..1 between pill bg and digit ink.
  function digitGrid(W, w, box, lo, hi, cols) {
    const out = new Float32Array(cols * 5), bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < cols; gx++) {
      // average over the source cell
      const sx0 = box.x0 + gx * bw / cols, sx1 = box.x0 + (gx + 1) * bw / cols;
      const sy0 = box.y0 + gy * bh / 5, sy1 = box.y0 + (gy + 1) * bh / 5;
      let s = 0, a = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
        const ov = (Math.min(x + 1, sx1) - Math.max(x, sx0)) * (Math.min(y + 1, sy1) - Math.max(y, sy0));
        if (ov <= 0) continue; s += W[y * w + x] * ov; a += ov;
      }
      out[gy * cols + gx] = Math.max(0, Math.min(1, ((s / a) - lo) / Math.max(1, hi - lo)));
    }
    return out;
  }

  // Fast coarse classifier (grid sampling) used to discard non-digits before the precise one.
  function quickDist(W, w, box, lo, hi, cellW) {
    let best = Infinity;
    for (const d in FONT) {
      const f = FONT[d], cols = f[0].length, grid = digitGrid(W, w, box, lo, hi, cols);
      let gmin = 1, gmax = 0; for (let k = 0; k < grid.length; k++) { if (grid[k] < gmin) gmin = grid[k]; if (grid[k] > gmax) gmax = grid[k]; }
      const span = Math.max(0.25, gmax - gmin);
      let e = 0;
      for (let y = 0; y < 5; y++) for (let x = 0; x < cols; x++) e += Math.abs((f[y][x] === '#' ? 1 : 0) - Math.max(0, Math.min(1, (grid[y * cols + x] - gmin) / span * 1.25 - 0.1)));
      e = e / (cols * 5) + Math.abs((box.x1 - box.x0 + 1) - cellW * cols / 5) / Math.max(1, cellW) * 0.6;
      if (e < best) best = e;
    }
    return best;
  }

  const RENDER_CACHE = new Map();
  // Render a font digit, anti-aliased, into a gw x gh pixel box placed at (ox, oy) inside a W x H grid.
  function renderDigit(f, W, H, ox, oy, gw, gh) {
    const cols = f[0].length, out = new Float32Array(W * H), SS = 4;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const fx = ((x + (sx + 0.5) / SS) - ox) / gw * cols, fy = ((y + (sy + 0.5) / SS) - oy) / gh * 5;
        if (fx >= 0 && fy >= 0 && fx < cols && fy < 5 && f[Math.floor(fy)][Math.floor(fx)] === '#') cov++;
      }
      out[y * W + x] = cov / (SS * SS);
    }
    return out;
  }

  /* Compare a glyph (pixel box from the screenshot) with every font digit rendered at that exact size,
   * trying small sub-pixel shifts. Works for crisp 100% screenshots and scaled/blurred ones alike. */
  function classifyDigit(Wimg, w, box, lo, hi, cellW) {
    const m = 1, X0 = box.x0 - m, Y0 = box.y0 - m, GW = box.x1 - box.x0 + 1 + 2 * m, GH = box.y1 - box.y0 + 1 + 2 * m;
    const N = new Float32Array(GW * GH);
    let nmax = 0;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const v = Wimg[(Y0 + y) * w + (X0 + x)];
      N[y * GW + x] = v == null ? 0 : Math.max(0, (v - lo) / Math.max(1, hi - lo));
      if (N[y * GW + x] > nmax) nmax = N[y * GW + x];
    }
    if (nmax > 0) for (let i = 0; i < N.length; i++) N[i] = Math.min(1, N[i] / nmax);
    const ink = box.x1 - box.x0 + 1, gh = box.y1 - box.y0 + 1;
    let best = null, second = null;
    for (const d in FONT) {
      const f = FONT[d], cols = f[0].length;
      const expectW = cellW * cols / 5; // a "1" is narrower than the other digits
      const widthPen = Math.abs(ink - expectW) / Math.max(1, cellW) * 0.5;
      let bd = Infinity;
      // glyph extent varies with blur/threshold: try a few widths, heights and sub-pixel offsets
      for (const dw of [-0.5, 0, 0.5]) for (const dh of [-0.5, 0, 0.5]) for (const sx of [-0.35, 0, 0.35]) for (const sy of [-0.35, 0, 0.35]) {
        const gw = Math.max(1, ink + dw), hh = Math.max(3, gh + dh);
        const key = d + '|' + GW + '|' + GH + '|' + ink + '|' + gh + '|' + dw + '|' + dh + '|' + sx + '|' + sy;
        let T = RENDER_CACHE.get(key);
        if (!T) { T = renderDigit(f, GW, GH, m + sx - dw / 2, m + sy - dh / 2, gw, hh); if (RENDER_CACHE.size > 20000) RENDER_CACHE.clear(); RENDER_CACHE.set(key, T); }
        let e = 0; for (let i = 0; i < N.length; i++) e += Math.abs(N[i] - T[i]);
        e /= N.length; if (e < bd) bd = e;
      }
      const r = { d: +d, dist: bd + widthPen };
      if (!best || r.dist < best.dist) { second = best; best = r; } else if (!second || r.dist < second.dist) second = r;
    }
    return { digit: best.d, dist: best.dist, margin: second.dist - best.dist };
  }

  function findLevels(img, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, W = whiteness(img);
    const thr = opts.thr || 205;
    const mask = new Uint8Array(w * h);
    if (opts.adaptive) {
      // ink = clearly brighter than the darkest pixel nearby (the pill background); keeps the dark
      // gap between a digit and the hexagon's bright border, which a global threshold can lose.
      const r = opts.adaptive, mn = minFilter(W, w, h, r);
      for (let i = 0; i < w * h; i++) mask[i] = (W[i] > 140 && W[i] - mn[i] > 70 && W[i] > mn[i] + 0.55 * (255 - mn[i]) * 0.8) ? 1 : 0;
    } else for (let i = 0; i < w * h; i++) mask[i] = W[i] > thr ? 1 : 0;
    const comps = components(mask, w, h).filter((c) => {
      const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
      return ch >= 4 && ch <= 16 && cw >= 1 && cw <= ch * 1.3 && c.n >= ch;
    });
    // pair up: same top/bottom, small gap
    const pairs = [];
    comps.sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < comps.length; i++) {
      const a = comps[i], ah = a.y1 - a.y0 + 1;
      for (let j = i + 1; j < comps.length; j++) {
        const b = comps[j];
        if (b.x0 - a.x1 > ah) break;
        const bh = b.y1 - b.y0 + 1;
        if (Math.abs(a.y0 - b.y0) > 1 || Math.abs(a.y1 - b.y1) > 1 || Math.abs(ah - bh) > 1) continue;
        const gap = b.x0 - a.x1 - 1;
        const narrow = (a.x1 - a.x0 + 1) <= ah * 0.5 || (b.x1 - b.x0 + 1) <= bh * 0.5; // a "1"
        if (gap < 1 || gap > Math.max(2, ah * (narrow ? 1.0 : 0.6))) continue;
        pairs.push({ a, b, h: Math.max(ah, bh) });
      }
    }
    // A "1" can be split by anti-aliasing; also a 1 next to another digit has a wider gap. Accept a pair
    // only if the ring around it is free of bright pixels (labels sit on a plain pill, icons are busy).
    const levels = [];
    pairs.forEach((p) => {
      const x0 = p.a.x0, x1 = p.b.x1, y0 = Math.min(p.a.y0, p.b.y0), y1 = Math.max(p.a.y1, p.b.y1), ph = y1 - y0 + 1;
      const m = Math.max(2, Math.round(ph * 0.35));
      let bright = 0, ring = 0, sum = 0;
      for (let y = y0 - m; y <= y1 + m; y++) for (let x = x0 - m; x <= x1 + m; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1) continue;
        ring++; sum += W[y * w + x]; if (mask[y * w + x]) bright++;
      }
      if (!ring || bright > ring * 0.06) return;
      const lo = sum / ring;
      let hi = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hi = Math.max(hi, W[y * w + x]);
      if (hi - lo < 50) return;
      // Full digit cell width ~= digit height (5x5 font); a "1" is narrower.
      const cellW = Math.max(p.a.x1 - p.a.x0 + 1, p.b.x1 - p.b.x0 + 1, Math.round(ph * 0.9));
      const box = (c) => ({ x0: c.x0, x1: c.x1, y0, y1 });
      // cheap screen first: most UI text is rejected here
      if (quickDist(W, w, box(p.a), lo, hi, cellW) > 0.5 || quickDist(W, w, box(p.b), lo, hi, cellW) > 0.5) return;
      const da = classifyDigit(W, w, box(p.a), lo, hi, cellW);
      const db = classifyDigit(W, w, box(p.b), lo, hi, cellW);
      levels.push({ x: (x0 + x1) / 2, y: y0, h: ph, x0, x1, y1, level: da.digit * 10 + db.digit, conf: Math.min(da.margin, db.margin), dist: Math.max(da.dist, db.dist) });
    });
    // de-duplicate overlapping detections
    const out = [];
    levels.sort((a, b) => a.dist - b.dist).forEach((l) => { if (!out.some((o) => Math.abs(o.x - l.x) < l.h * 2 && Math.abs(o.y - l.y) < l.h)) out.push(l); });
    return out.filter((l) => l.level <= 30 && l.dist < 0.18);
  }

  // All level labels found at one image scale (several brightness thresholds, best reading kept).
  const PASSES = [{ thr: 205 }, { thr: 185 }, { thr: 165 }, { thr: 150 }, { adaptive: 2 }, { adaptive: 3 }, { adaptive: 4 }, { adaptive: 5 }];
  function levelsAt(img, passes) {
    const levels = [];
    (passes || PASSES).forEach((o) => findLevels(img, o).forEach((l) => {
      const q = levels.find((k) => Math.abs(k.x - l.x) < l.h * 2 && Math.abs(k.y - l.y) < l.h);
      if (!q) levels.push(l); else if (l.dist < q.dist) levels[levels.indexOf(q)] = l;
    }));
    return levels;
  }

  // Big screenshot: one quick scan to find where the matrix is, then the thorough scan on that region.
  function levelsFast(img, opts) {
    opts = opts || {};
    const quick = levelsAt(img, [{ thr: 205 }, { thr: 165 }, { adaptive: 4 }]);
    const fit = quick.length >= 3 ? layoutSlots(quick) : null;
    if (!fit) return opts.quickOnly ? [] : levelsAt(img); // not found quickly: caller decides whether to scan everything
    const p = fit.pitch, c = fit.centre;
    const x0 = Math.max(0, c.x - p * 3.6), y0 = Math.max(0, c.y - p * 3.4), x1 = Math.min(img.width, c.x + p * 3.6), y1 = Math.min(img.height, c.y + p * 3.4);
    const sub = IP.crop(img, x0, y0, x1 - x0, y1 - y0);
    const ox = Math.round(Math.max(0, x0)), oy = Math.round(Math.max(0, y0));
    return levelsAt(sub).map((l) => Object.assign(l, { x: l.x + ox, y: l.y + oy, x0: l.x0 + ox, x1: l.x1 + ox, y1: l.y1 + oy }));
  }

  function parseHexa(img, opts) {
    // The level font is 5 px tall at 100% UI scale. Screenshots taken with Windows display scaling
    // (125 / 150 / 200 %) are tried again scaled back towards 100 %; the scale with the most
    // confident readings wins. Coordinates are mapped back to the original image.
    let levels = levelsFast(img, opts);
    if (!levels.length) return { cores: [] };
    const hs = levels.map((l) => l.h).sort((a, b) => a - b), medH = hs[Math.floor(hs.length / 2)];
    levels = levels.filter((l) => l.h >= medH * 0.75 && l.h <= medH * 1.3);
    // Real cores form one tight cluster (the matrix); drop isolated hits from other UI text.
    if (levels.length >= 4) {
      const nn = levels.map((a) => Math.min(...levels.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
      const sorted = nn.slice().sort((p, q) => p - q), medNN = sorted[Math.floor(sorted.length / 2)];
      levels = levels.filter((l, i) => nn[i] <= medNN * 2.5);
    }
    const iconSize = medH * 6.6, gapBelow = medH * 1.0;
    const cores = levels.map((l) => {
      const rect = { x: l.x - iconSize / 2, y: l.y1 + gapBelow, w: iconSize, h: iconSize };
      return { level: l.level, conf: l.conf, dist: l.dist, x: l.x, y: l.y, rect, icon: IP.crop(img, rect.x, rect.y, rect.w, rect.h) };
    });
    cores.sort((a, b) => (Math.abs(a.y - b.y) < medH * 2 ? a.x - b.x : a.y - b.y));
    return { cores, digitHeight: medH };
  }

  /* Fixed HEXA Matrix layout. Positions of the level labels relative to the matrix centre, in units
   * of the horizontal hexagon pitch, with the MapleScouter "HEXA Enhancement" slot (0-based) that
   * each position feeds. MapleScouter orders its 15 slots the same way for every class:
   * 1 Origin + 3 (top-right quadrant), 3 (top-left), 4 (bottom-left), Sol Janus etc. (bottom-right). */
  const LAYOUT = [
    // top-right
    { u: 0.7, v: -1.029, slot: 0, q: 'TR' }, { u: 1.2, v: -1.886, slot: 1, q: 'TR' }, { u: 2.2, v: -1.886, slot: 2, q: 'TR' }, { u: 2.7, v: -2.743, slot: 3, q: 'TR' },
    // top-left
    { u: -0.7, v: -1.029, slot: 4, q: 'TL' }, { u: -1.7, v: -1.029, slot: 5, q: 'TL' }, { u: -1.2, v: -1.886, slot: 6, q: 'TL' },
    { u: -2.2, v: -1.886, slot: null, q: 'TL' }, { u: -1.7, v: -2.743, slot: null, q: 'TL' }, { u: -2.7, v: -2.743, slot: null, q: 'TL' },
    // bottom-left
    { u: -0.7, v: 1.029, slot: 7, q: 'BL' }, { u: -1.2, v: 1.886, slot: 8, q: 'BL' }, { u: -2.2, v: 1.886, slot: 9, q: 'BL' }, { u: -2.7, v: 2.743, slot: 10, q: 'BL' },
    // bottom-right
    { u: 0.7, v: 1.029, slot: 14, q: 'BR' }, { u: 1.2, v: 1.886, slot: 11, q: 'BR' }, { u: 2.2, v: 1.886, slot: 12, q: 'BR' }, { u: 2.7, v: 2.743, slot: 13, q: 'BR' }
  ];
  const LAYOUT_SLOTS = 15;

  // Snap detected cores onto the fixed layout. Returns per-core {slot, pos} (or null) and the fit quality.
  function layoutSlots(cores) {
    if (cores.length < 3) return null;
    const near = cores.map((a) => Math.min(...cores.filter((b) => b !== a && Math.abs(b.y - a.y) < 6).map((b) => Math.abs(b.x - a.x))));
    const ds = near.filter(isFinite).sort((a, b) => a - b);
    if (!ds.length) return null;
    const p = ds[Math.floor(ds.length / 2)];
    const tol = p * 0.18;
    let best = null;
    cores.forEach((d) => LAYOUT.forEach((t) => {
      const cx = d.x - t.u * p, cy = d.y - t.v * p;
      const hit = cores.map((c) => {
        let bi = -1, bd = tol;
        LAYOUT.forEach((L, i) => { const e = Math.hypot(c.x - (cx + L.u * p), c.y - (cy + L.v * p)); if (e < bd) { bd = e; bi = i; } });
        return bi;
      });
      const n = hit.filter((i) => i >= 0).length;
      const err = hit.reduce((s, i, k) => s + (i >= 0 ? Math.hypot(cores[k].x - (cx + LAYOUT[i].u * p), cores[k].y - (cy + LAYOUT[i].v * p)) : tol), 0);
      if (!best || n > best.n || (n === best.n && err < best.err)) best = { n, err, hit, cx, cy };
    }));
    // Trusted when most hits sit on the lattice, or plenty do (stray UI digits elsewhere are ignored).
    if (!(best.n >= Math.max(3, Math.ceil(cores.length * 0.8)) || best.n >= 6)) return null;
    if (new Set(best.hit.filter((i) => i >= 0)).size !== best.hit.filter((i) => i >= 0).length) return null;
    return { pitch: p, centre: { x: best.cx, y: best.cy }, matched: best.n, slots: best.hit.map((i) => (i >= 0 ? { slot: LAYOUT[i].slot, quadrant: LAYOUT[i].q } : null)) };
  }

  const api = { parseHexa, findLevels, layoutSlots, LAYOUT_SLOTS, FONT };
  if (NODE) module.exports = api; else root.MSHexa = api;
})(typeof self !== 'undefined' ? self : this);
