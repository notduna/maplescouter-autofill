/* Image preprocessing shared by the extension (browser) and the test harness (node).
 * All functions work on plain {data: Uint8ClampedArray RGBA, width, height} objects. */
(function (root) {
  'use strict';

  function makeImage(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  function crop(img, x, y, w, h) {
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    w = Math.max(1, Math.min(img.width - x, Math.round(w)));
    h = Math.max(1, Math.min(img.height - y, Math.round(h)));
    const out = makeImage(w, h);
    for (let row = 0; row < h; row++) {
      const s = ((y + row) * img.width + x) * 4;
      out.data.set(img.data.subarray(s, s + w * 4), row * w * 4);
    }
    return out;
  }

  // Bilinear resize.
  function resize(img, w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const out = makeImage(w, h);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5);
      const y0 = Math.min(img.height - 1, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5);
        const x0 = Math.min(img.width - 1, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          const a = img.data[(y0 * img.width + x0) * 4 + c], b = img.data[(y0 * img.width + x1) * 4 + c];
          const d = img.data[(y1 * img.width + x0) * 4 + c], e = img.data[(y1 * img.width + x1) * 4 + c];
          out.data[o + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
        }
      }
    }
    return out;
  }

  // "Text-ness" of a pixel: MapleStory UI text is bright (white / light grey / yellow / green)
  // on darker panels, so the brightest channel separates it well regardless of hue.
  function brightness(img) {
    const n = img.width * img.height, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      out[i] = Math.max(r, g, b) * 0.7 + (0.299 * r + 0.587 * g + 0.114 * b) * 0.3;
    }
    return out;
  }

  function otsu(values) {
    const hist = new Float64Array(256);
    for (let i = 0; i < values.length; i++) hist[values[i]]++;
    const total = values.length;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /* Binarise for OCR: dark text on white. Uses a local (tiled) threshold so that a
   * bright map background bleeding through one region does not wreck another.
   * Pixels are "text" when they are clearly brighter than their neighbourhood. */
  function binarize(img, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, L = brightness(img);
    const r = Math.max(8, Math.round(opts.radius || Math.min(w, h) / 12));
    // integral image for local mean
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += L[y * w + x];
        integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + rowSum;
      }
    }
    const globalT = otsu(L);
    if (opts.mode === 'contrast') {
      // Small crop that is mostly background: threshold between the median (background)
      // and the bright tail (text). Keeps thin anti-aliased strokes intact.
      const sorted = Array.from(L).sort((a, b) => a - b);
      const bg = sorted[Math.floor(sorted.length * 0.5)], fg = sorted[Math.floor(sorted.length * 0.985)];
      const t = bg + (fg - bg) * (opts.frac == null ? 0.38 : opts.frac);
      const o = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) o[i] = (L[i] > t && fg - bg > 25) ? 0 : 255;
      return { width: w, height: h, gray: o };
    }
    if (opts.mode === 'otsu') {
      const t = Math.max(globalT, opts.minAbs == null ? 110 : opts.minAbs);
      const o = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) o[i] = L[i] > t ? 0 : 255;
      return { width: w, height: h, gray: o };
    }
    const delta = opts.delta == null ? 28 : opts.delta;
    const minAbs = opts.minAbs == null ? 125 : opts.minAbs;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const area = (x1 - x0) * (y1 - y0);
        const s = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        const mean = s / area, v = L[y * w + x];
        const isText = v >= minAbs && (v > mean + delta || (v > globalT + 40 && v > 200));
        out[y * w + x] = isText ? 0 : 255;
      }
    }
    return { width: w, height: h, gray: out };
  }

  // Encode an 8-bit grey image as binary PGM (leptonica/tesseract read it natively).
  function toPGM(g) {
    const header = 'P5\n' + g.width + ' ' + g.height + '\n255\n';
    const out = new Uint8Array(header.length + g.gray.length);
    for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
    out.set(g.gray, header.length);
    return out;
  }

  function grayToImage(g) {
    const out = makeImage(g.width, g.height);
    for (let i = 0; i < g.gray.length; i++) {
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = g.gray[i]; out.data[i * 4 + 3] = 255;
    }
    return out;
  }

  /* Prepare an image region for OCR: crop -> upscale -> binarise -> pad.
   * Returns {pgm, scale, offX, offY, width, height} so word boxes can be mapped back. */
  function prepare(img, opts) {
    opts = opts || {};
    const region = opts.rect ? crop(img, opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h) : img;
    const scale = opts.scale || 3;
    const big = resize(region, region.width * scale, region.height * scale);
    const bin = binarize(big, opts);
    const pad = opts.pad == null ? 20 : opts.pad;
    const pw = bin.width + pad * 2, ph = bin.height + pad * 2;
    const padded = new Uint8Array(pw * ph).fill(255);
    for (let y = 0; y < bin.height; y++) padded.set(bin.gray.subarray(y * bin.width, (y + 1) * bin.width), (y + pad) * pw + pad);
    const g = { width: pw, height: ph, gray: padded };
    return {
      gray: g, pgm: toPGM(g), scale, pad,
      offX: opts.rect ? Math.max(0, Math.round(opts.rect.x)) : 0,
      offY: opts.rect ? Math.max(0, Math.round(opts.rect.y)) : 0
    };
  }

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx];
  }

  // Icon signature: HSV colour histogram (robust to small misalignment / overlays) + coarse RGB layout grid.
  function iconSignature(img, inset) {
    inset = inset == null ? 0.18 : inset;
    const c = crop(img, img.width * inset, img.height * inset, img.width * (1 - 2 * inset), img.height * (1 - 2 * inset));
    const s = resize(c, 24, 24), HB = 12, SB = 3, VB = 3, hist = new Float32Array(HB * SB * VB);
    for (let i = 0; i < 576; i++) {
      const hsv = rgb2hsv(s.data[i * 4], s.data[i * 4 + 1], s.data[i * 4 + 2]);
      let hb = Math.floor(hsv[0] / 360 * HB) % HB;
      const sb = Math.min(SB - 1, Math.floor(hsv[1] * SB)), vb = Math.min(VB - 1, Math.floor(hsv[2] * VB));
      if (hsv[1] < 0.2) hb = 0;
      hist[(hb * SB + sb) * VB + vb] += 1 / 576;
    }
    const G = 4, g = resize(c, G, G), gv = new Float32Array(G * G * 3);
    for (let i = 0; i < G * G; i++) for (let k = 0; k < 3; k++) gv[i * 3 + k] = g.data[i * 4 + k] / 255;
    return { hist: Array.from(hist), gv: Array.from(gv) };
  }

  function iconDistance(a, b) {
    let bc = 0;
    for (let i = 0; i < a.hist.length; i++) bc += Math.sqrt(a.hist[i] * b.hist[i]);
    const dh = Math.sqrt(Math.max(0, 1 - bc));
    let dg = 0;
    for (let i = 0; i < a.gv.length; i++) dg += Math.abs(a.gv[i] - b.gv[i]);
    return 0.7 * dh + 0.3 * dg / a.gv.length;
  }

  const api = { makeImage, crop, resize, brightness, otsu, binarize, toPGM, grayToImage, prepare, iconSignature, iconDistance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MSImage = api;
})(typeof self !== 'undefined' ? self : this);
