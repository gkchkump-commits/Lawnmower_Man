// Avatar pack manifest helpers (pure — no three.js, no DOM). The pack format is produced by
// tools/bake/bake_avatar.py; see tools/bake/README.md.

export const PACK_FORMAT = 'lawnmower-avatar-pack';
export const PACK_VERSION = 1;
export const MESH_FORMAT = 'lawnmower-relief-mesh';

export const WEIGHT_NAMES = /** @type {const} */ ([
  'jaw', 'lowerLip', 'upperLip', 'cornerL', 'cornerR',
  'lidUpperL', 'lidLowerL', 'lidUpperR', 'lidLowerR', 'browL', 'browR',
]);

const REQUIRED_FILES = ['plate', 'eyesClosed', 'mouth', 'masksA', 'masksB', 'mesh'];

/** Ensure a base URL ends with '/'. */
export function withSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Validate a pack.json object. Returns a list of human readable problems (empty = valid).
 * @param {any} p
 * @returns {string[]}
 */
export function validatePack(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['pack.json is not an object'];
  if (p.format !== PACK_FORMAT) errs.push(`format must be "${PACK_FORMAT}" (got ${JSON.stringify(p.format)})`);
  if (typeof p.version !== 'number' || p.version < 1) errs.push('version missing');
  else if (Math.floor(p.version) > PACK_VERSION) errs.push(`pack version ${p.version} is newer than supported ${PACK_VERSION}`);
  const W = p.plate?.width, H = p.plate?.height;
  if (!(W > 0 && H > 0)) errs.push('plate.width/height missing');
  for (const f of REQUIRED_FILES) {
    if (typeof p.files?.[f] !== 'string' || !p.files[f]) errs.push(`files.${f} missing`);
    else if (/^(?:[a-z]+:)?\/\//i.test(p.files[f]) || p.files[f].includes('..')) errs.push(`files.${f} must be a relative path inside the pack`);
  }
  const rig = p.rig;
  if (!rig) errs.push('rig missing');
  else {
    for (const k of ['L', 'R']) {
      const e = rig.eyes?.[k];
      if (!e || !isVec(e.center, 2) || !(e.irisRadius > 0) || !(e.height > 0)) errs.push(`rig.eyes.${k} incomplete`);
    }
    if (!isVec(rig.jawPivot, 3)) errs.push('rig.jawPivot missing');
    if (!isVec(rig.headPivot, 3)) errs.push('rig.headPivot missing');
    if (!rig.mouth || !isVec(rig.mouth.center, 2) || !(rig.mouth.halfWidth > 0)) errs.push('rig.mouth incomplete');
    if (!(rig.faceHeight > 0)) errs.push('rig.faceHeight missing');
  }
  if (!isVec(p.mouthRect, 4)) errs.push('mouthRect missing');
  if (!p.palette || typeof p.palette.eye !== 'string') errs.push('palette missing');
  return errs;
}

/**
 * Validate mesh.json. Returns problems (empty = valid). Checks lengths and index ranges.
 * @param {any} m
 */
export function validateMesh(m) {
  const errs = [];
  if (!m || m.format !== MESH_FORMAT) return [`mesh format must be "${MESH_FORMAT}"`];
  const n = m.vertexCount;
  if (!(n > 0)) errs.push('vertexCount missing');
  if (!Array.isArray(m.positions) || m.positions.length !== n * 3) errs.push('positions length != vertexCount*3');
  if (!Array.isArray(m.indices) || m.indices.length % 3 !== 0 || m.indices.length === 0) errs.push('indices invalid');
  else {
    let max = -1, min = Infinity;
    for (const i of m.indices) { if (i > max) max = i; if (i < min) min = i; }
    if (min < 0 || max >= n) errs.push(`index out of range [${min}, ${max}] for ${n} vertices`);
  }
  for (const k of WEIGHT_NAMES) {
    if (!Array.isArray(m.weights?.[k]) || m.weights[k].length !== n) errs.push(`weights.${k} length != vertexCount`);
  }
  if (!Array.isArray(m.edge) || m.edge.length !== n) errs.push('edge length != vertexCount');
  const c = m.cavity;
  if (!c || !(c.vertexCount > 0)) errs.push('cavity missing');
  else {
    if (c.positions?.length !== c.vertexCount * 3) errs.push('cavity.positions length');
    if (c.uvs?.length !== c.vertexCount * 2) errs.push('cavity.uvs length');
    if (c.layer?.length !== c.vertexCount) errs.push('cavity.layer length');
    for (const k of WEIGHT_NAMES) if (c.weights?.[k]?.length !== c.vertexCount) errs.push(`cavity.weights.${k} length`);
  }
  return errs;
}

function isVec(v, n) {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Pack plate-pixel coordinates (x right, y down, z toward camera) into world units used by the
 * relief head: the plate is 1 unit tall, centred at the origin, y up.
 * @param {number} W plate width px @param {number} H plate height px
 */
export function plateToWorld(W, H) {
  const s = 1 / H;
  return {
    scale: s,
    x: (x) => (x - W / 2) * s,
    y: (y) => (H / 2 - y) * s,
    z: (z) => z * s,
  };
}

/**
 * Interleave (pack) the per-vertex weights into 3 vec4 attribute arrays in the order the relief
 * shader expects: w0 = (jaw, lowerLip, upperLip, cornerL), w1 = (cornerR, lidUpperL, lidLowerL,
 * lidUpperR), w2 = (lidLowerR, browL, browR, extra).
 * @param {Record<string, ArrayLike<number>>} weights quantised 0..scale
 * @param {number} n vertex count
 * @param {number} scale quantisation scale (255)
 * @param {ArrayLike<number>} [extra] optional 4th component of w2 (already 0..1)
 */
export function packWeights(weights, n, scale, extra) {
  const w0 = new Float32Array(n * 4), w1 = new Float32Array(n * 4), w2 = new Float32Array(n * 4);
  const inv = 1 / scale;
  const g = (k, i) => (weights[k] ? weights[k][i] * inv : 0);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    w0[o] = g('jaw', i); w0[o + 1] = g('lowerLip', i); w0[o + 2] = g('upperLip', i); w0[o + 3] = g('cornerL', i);
    w1[o] = g('cornerR', i); w1[o + 1] = g('lidUpperL', i); w1[o + 2] = g('lidLowerL', i); w1[o + 3] = g('lidUpperR', i);
    w2[o] = g('lidLowerR', i); w2[o + 1] = g('browL', i); w2[o + 2] = g('browR', i); w2[o + 3] = extra ? extra[i] : 0;
  }
  return { w0, w1, w2 };
}
