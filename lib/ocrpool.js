/* A pool of OCR engines (one per Web Worker). pool.recognize(pgm, opts) -> Promise<words>.
 * Jobs go to the least-busy engine, so independent OCR calls run in parallel. */
(function (root) {
  'use strict';
  function createPool(makeWorker, size) {
    const workers = [], pending = new Map();
    let nextId = 0;
    for (let i = 0; i < size; i++) {
      const w = makeWorker();
      w.busy = 0;
      w.onmessage = (ev) => {
        const m = ev.data, p = pending.get(m.id); if (!p) return;
        pending.delete(m.id); w.busy--;
        m.ok ? p.resolve(m.words) : p.reject(new Error(m.error));
      };
      workers.push(w);
    }
    function send(w, msg, transfer) {
      return new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject }); w.busy++;
        w.postMessage(Object.assign({ id }, msg), transfer || []);
      });
    }
    return {
      size,
      // start all engines loading now so the first screenshot doesn't wait for them one by one
      warm() { return Promise.all(workers.map((w) => send(w, { warm: true }))); },
      recognize(pgm, opts) {
        const w = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
        const buf = pgm.buffer.byteLength === pgm.byteLength ? pgm.buffer : pgm.slice().buffer;
        return send(w, { pgm: buf, opts }, [buf]);
      }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createPool }; else root.MSPool = { createPool };
})(typeof self !== 'undefined' ? self : this);
