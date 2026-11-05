/* OCR worker: receives a pasted screenshot as RGBA pixels, decides what it shows
 * (stat window [+ pop-out] or HEXA Matrix) and returns the parsed values. */
/* global importScripts, MSParse, MSHexa, MSImage, MSPool */
importScripts('lib/imageproc.js', 'lib/glyphs.js', 'lib/templates.js', 'lib/assign.js',
  'lib/parse.js', 'lib/hexa.js', 'lib/ocrpool.js');

// A pool of Tesseract engines, each in its own worker, so independent OCR calls run in parallel.
// Two engines already saturate the critical path (two layout passes); a third helps when several
// screenshots are pasted at once.
const POOL_SIZE = Math.max(2, Math.min(3, (self.navigator && navigator.hardwareConcurrency || 4) - 1));
const pool = MSPool.createPool(() => new Worker('tess-worker.js'), POOL_SIZE);
const warm = pool.warm(); // start loading engines immediately

function serializeIcon(img) { return { width: img.width, height: img.height, data: img.data }; }

const statResult = (r) => ({ values: r.values, uncertain: r.uncertain, popup: r.popup, raw: r.raw, locator: r.debug.locator });
const enough = (r) => r && Object.values(r.values).filter((v) => v != null).length >= 10;

function hexaMessage(id, hexa, layout, stat) {
  return {
    id, ok: true, kind: 'hexa',
    result: {
      digitHeight: hexa.digitHeight, layoutFit: !!layout, stat,
      // only cores that sit on the matrix lattice
      cores: hexa.cores.map((c, i) => ({ c, i })).filter(({ i }) => !layout || layout.slots[i]).map(({ c, i }) => ({
        level: c.level, dist: c.dist, conf: c.conf, x: c.x, y: c.y,
        layoutSlot: layout && layout.slots[i] ? layout.slots[i].slot : null,
        quadrant: layout && layout.slots[i] ? layout.slots[i].quadrant : null,
        icon: serializeIcon(c.icon), sig: MSImage.iconSignature(c.icon, 0.22)
      }))
    }
  };
}

self.onmessage = async (ev) => {
  const { id, image, hint } = ev.data;
  try {
    const img = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    // If the STAT window's panels are visible, start reading it right away (OCR runs in the engine
    // workers) and look for a HEXA Matrix meanwhile; a screenshot may contain both.
    const hasStatPanel = MSParse.colorLocate(img).length > 0;
    let statP = null;
    if (hasStatPanel && hint !== 'hexa') {
      self.postMessage({ id, progress: 'Reading stats…' });
      statP = warm.then(() => MSParse.parseStatWindow(pool, img)).catch(() => null);
    }
    let hexa = { cores: [] }, layout = null;
    if (hint !== 'stat') {
      hexa = MSHexa.parseHexa(img, { quickOnly: true });
      layout = hexa.cores.length >= 3 ? MSHexa.layoutSlots(hexa.cores) : null;
      if (!layout && !hasStatPanel) { // neither obvious: scan thoroughly for a HEXA Matrix
        hexa = MSHexa.parseHexa(img);
        layout = hexa.cores.length >= 3 ? MSHexa.layoutSlots(hexa.cores) : null;
      }
    }
    if (layout || hint === 'hexa') {
      const r = statP ? await statP : null;
      self.postMessage(hexaMessage(id, hexa, layout, enough(r) ? statResult(r) : null));
      return;
    }
    if (!statP) { self.postMessage({ id, progress: 'Reading stats…' }); statP = warm.then(() => MSParse.parseStatWindow(pool, img)); }
    const r = await statP;
    const found = r ? Object.values(r.values).filter((v) => v != null).length : 0;
    if (found < 5 && !(r && r.popup)) {
      self.postMessage({ id, ok: false, error: 'Could not find the STAT window or the HEXA Matrix in this screenshot.' });
      return;
    }
    self.postMessage({ id, ok: true, kind: 'stat', result: statResult(r) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
