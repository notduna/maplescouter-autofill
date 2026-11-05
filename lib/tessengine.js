/* Thin wrapper over tesseract.js-core (WASM). Works in a Web Worker (extension) and in node (tests).
 * engine.recognize(pgmBytes, {psm, whitelist}) -> [{text, conf, x, y, w, h, block, par, line}] */
(function (root) {
  'use strict';

  function parseTSV(tsv) {
    const words = [];
    tsv.split('\n').forEach((row) => {
      const c = row.split('\t');
      if (c.length < 12 || c[0] !== '5') return;
      const text = c.slice(11).join('\t').trim();
      if (!text) return;
      words.push({
        block: +c[2], par: +c[3], line: +c[4],
        x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf: +c[10], text
      });
    });
    return words;
  }

  function createEngine(TessModule, traineddata) {
    TessModule.FS.writeFile('eng.traineddata', traineddata);
    const api = new TessModule.TessBaseAPI();
    if (api.Init(null, 'eng') !== 0) throw new Error('Tesseract failed to initialise');
    let lastConfig = null;
    return {
      recognize(pgm, opts) {
        opts = opts || {};
        const cfg = JSON.stringify(opts);
        if (cfg !== lastConfig) {
          api.SetVariable('tessedit_char_whitelist', opts.whitelist || '');
          api.SetVariable('user_defined_dpi', '300');
          api.SetVariable('debug_file', '/dev/null');
          api.SetPageSegMode(opts.psm == null ? 11 : opts.psm);
          lastConfig = cfg;
        }
        TessModule.FS.writeFile('/input', pgm);
        api.SetImageFile();
        api.Recognize(null);
        const tsv = api.GetTSVText(0);
        return parseTSV(tsv);
      },
      end() { api.End(); TessModule.destroy(api); }
    };
  }

  const exp = { createEngine, parseTSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = exp; else root.MSTess = exp;
})(typeof self !== 'undefined' ? self : this);
