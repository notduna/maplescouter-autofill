/* One Tesseract engine. Part of the OCR pool used by ocr-worker.js. */
/* global importScripts, TesseractCore, MSTess */
importScripts('lib/tessengine.js', 'lib/tesseract-core-simd-lstm.js');
let ready = null;
function engine() {
  if (!ready) ready = (async () => {
    const Module = await TesseractCore({ locateFile: (p) => 'lib/' + p, print() {}, printErr() {} });
    const data = new Uint8Array(await (await fetch('lib/eng.traineddata')).arrayBuffer());
    return MSTess.createEngine(Module, data);
  })();
  return ready;
}
self.onmessage = async (ev) => {
  const { id, pgm, opts, warm } = ev.data;
  try {
    const e = await engine();
    if (warm) { self.postMessage({ id, ok: true, words: [] }); return; }
    self.postMessage({ id, ok: true, words: e.recognize(new Uint8Array(pgm), opts) });
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
