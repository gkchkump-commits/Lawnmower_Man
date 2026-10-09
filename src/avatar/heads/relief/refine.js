// Mesh refinement for the relief head (pure): the baked mesh has ~17 px triangles around the
// mouth, so a jaw drop of 60 px spans only a few triangle rows and the lip contours bend in
// straight segments. Before the geometry is built, every edge longer than `maxLen` whose
// midpoint lies in the region is split, conformingly (a triangle with one split edge becomes 2,
// with two 3, with three 4: no T-junctions), a few times over. New vertices lie on the old edges
// and interpolate every per-vertex attribute linearly, so the rest surface — and the rest render —
// is exactly what it was; only the deformation is sampled finely (the lip rig's lens profiles,
// the jaw hinge), and the contours of a parted mouth come out smooth.

/**
 * @typedef {{ data: ArrayLike<number>, size: number }} Attr  per-vertex attribute, `size` values each
 * @typedef {{ positions: ArrayLike<number>, indices: ArrayLike<number>, attrs?: Record<string, Attr> }} RefineInput
 * @typedef {{ positions: Float32Array, indices: Uint32Array, attrs: Record<string, Float32Array>, vertexCount: number, added: number }} RefineOutput
 */

/**
 * @param {RefineInput} mesh positions xyz per vertex (any units), triangles as index triples
 * @param {{ inside: (x: number, y: number) => boolean, maxLen: number, levels?: number }} o
 * @returns {RefineOutput} original vertices keep their indices; new ones are appended
 */
export function refineMesh(mesh, o) {
  const levels = o.levels ?? 3;
  let pos = Array.from(mesh.positions);
  let idx = Array.from(mesh.indices);
  const names = Object.keys(mesh.attrs || {});
  /** @type {Record<string, number[]>} */
  const attr = {};
  /** @type {Record<string, number>} */
  const size = {};
  for (const k of names) {
    attr[k] = Array.from(mesh.attrs[k].data);
    size[k] = mesh.attrs[k].size;
  }
  const n0 = pos.length / 3;
  const max2 = o.maxLen * o.maxLen;
  for (let level = 0; level < levels; level++) {
    /** @type {Map<number, number>} edge key -> midpoint vertex (or -1: not split) */
    const mid = new Map();
    let nv = pos.length / 3;
    const key = (a, b) => (a < b ? a * 1048576 + b : b * 1048576 + a);
    const split = (a, b) => {
      const k = key(a, b);
      let m = mid.get(k);
      if (m !== undefined) return m;
      const ax = pos[a * 3], ay = pos[a * 3 + 1], bx = pos[b * 3], by = pos[b * 3 + 1];
      const dx = bx - ax, dy = by - ay;
      const mx = 0.5 * (ax + bx), my = 0.5 * (ay + by);
      if (dx * dx + dy * dy <= max2 || !o.inside(mx, my)) {
        mid.set(k, -1);
        return -1;
      }
      m = nv++;
      pos.push(mx, my, 0.5 * (pos[a * 3 + 2] + pos[b * 3 + 2]));
      for (const name of names) {
        const s = size[name], d = attr[name];
        for (let c = 0; c < s; c++) d.push(0.5 * (d[a * s + c] + d[b * s + c]));
      }
      mid.set(k, m);
      return m;
    };
    const out = [];
    let changed = false;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const mab = split(a, b), mbc = split(b, c), mca = split(c, a);
      const ns = (mab >= 0 ? 1 : 0) + (mbc >= 0 ? 1 : 0) + (mca >= 0 ? 1 : 0);
      if (ns === 0) { out.push(a, b, c); continue; }
      changed = true;
      if (ns === 3) {
        out.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
        continue;
      }
      // rotate (keeping the winding) so the split edges come first: ab (and bc)
      let v = [a, b, c], m = [mab, mbc, mca];
      while (m[0] < 0 || (ns === 2 && m[1] < 0)) {
        v = [v[1], v[2], v[0]];
        m = [m[1], m[2], m[0]];
      }
      const [p, q, r] = v;
      if (ns === 1) {
        out.push(p, m[0], r, m[0], q, r);
      } else {
        out.push(m[0], q, m[1], p, m[0], m[1], p, m[1], r);
      }
    }
    idx = out;
    if (!changed) break;
  }
  /** @type {Record<string, Float32Array>} */
  const attrs = {};
  for (const k of names) attrs[k] = Float32Array.from(attr[k]);
  return {
    positions: Float32Array.from(pos), indices: Uint32Array.from(idx), attrs,
    vertexCount: pos.length / 3, added: pos.length / 3 - n0,
  };
}

/**
 * The mouth region of a relief pack (plate px): an ellipse around the mouth, 1.7 mouth half widths
 * across and 1.1 high, so the lips, the corners, the skin they stretch and the chin are fine.
 * @param {any} pack @returns {(x: number, y: number) => boolean}
 */
export function mouthRegion(pack) {
  const m = pack.rig.mouth;
  const hw = m.halfWidth;
  const [cx, cy] = m.center;
  return (x, y) => {
    const u = (x - cx) / (1.7 * hw), v = (y - cy - 0.15 * hw) / (1.1 * hw);
    return u * u + v * v < 1;
  };
}
