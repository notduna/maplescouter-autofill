/* Minimum-cost assignment (Hungarian algorithm, rectangular). cost[i][j] (null = forbidden).
 * Returns result[i] = j or null. */
(function (root) {
  'use strict';
  function hungarian(cost) {
    const n = cost.length; if (!n) return [];
    const m = cost[0].length, N = Math.max(n, m), BIG = 1e6;
    const a = []; for (let i = 0; i < N; i++) { a.push([]); for (let j = 0; j < N; j++) { const v = i < n && j < m ? cost[i][j] : null; a[i].push(v == null ? BIG : v); } }
    const u = new Float64Array(N + 1), v = new Float64Array(N + 1), p = new Int32Array(N + 1), way = new Int32Array(N + 1);
    for (let i = 1; i <= N; i++) {
      p[0] = i; let j0 = 0; const minv = new Float64Array(N + 1).fill(Infinity), used = new Uint8Array(N + 1);
      do {
        used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= N; j++) if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= N; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const res = new Array(n).fill(null);
    for (let j = 1; j <= N; j++) if (p[j] && p[j] <= n && j <= m && a[p[j] - 1][j - 1] < BIG) res[p[j] - 1] = j - 1;
    return res;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { hungarian }; else root.MSAssign = { hungarian };
})(typeof self !== 'undefined' ? self : this);
