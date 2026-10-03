// Decoder + validator for the procedural head model (public/assets/models/head.json + .bin),
// written by tools/procedural/build_head.py. PURE (no three.js, no DOM) so it is unit-testable.

export const FORMAT = 'lawnmower-procedural-head';
export const VERSION = 1;

/** Rig weight channels, in buffer order (tools/procedural/headbuild/rig.py RIG_CHANNELS). */
export const RIG_CHANNELS = /** @type {const} */ ([
  'jaw', 'upperLip', 'lowerLip', 'cornerL', 'cornerR', 'browL', 'browR', 'cheek',
]);

/**
 * @typedef {Object} EyeDef
 * @property {number[]} center   aperture centre on the lid surface (rest pose)
 * @property {number[]} axisX    screen-left -> screen-right corner direction
 * @property {number[]} axisY    up
 * @property {number[]} axisZ    forward (rest gaze)
 * @property {number} halfWidth  half the corner distance
 * @property {number[]} upper    upper lid curve y(t) = (1 - t^2)(c0 + c1 t + c2 t^2), t in [-1, 1]
 * @property {number[]} lower    lower lid curve (same form, negative values)
 * @property {number[]} ball     eyeball centre
 * @property {number} ballRadius
 * @property {number} irisRadius
 * @property {number} pupilRadius
 */

/**
 * @typedef {Object} HeadModel
 * @property {any} meta                 parsed head.json
 * @property {number} vertexCount
 * @property {number} skinVertexCount   vertices [skinVertexCount, vertexCount) are the mouth cavity
 * @property {Float32Array} positions   xyz (dequantized, world units, rest pose)
 * @property {Uint8Array} rig           RIG_CHANNELS.length per vertex (0..255)
 * @property {Uint8Array} aux           ao, convexity (128 = flat), lips, ear (0..255)
 * @property {Uint8Array} cavity        part, u, v, side (0..255); skin: y = curve distance / curveDistanceRange
 * @property {Uint8Array} shell         smoothed outer-shell normal * 0.5 + 0.5, inner-mouth mask (0..255)
 * @property {Uint8Array} extra         neck (below the jaw line), seam closeness, seam side (1 = upper), unused
 *                                      (0..255; optional block, all zeros for older models)
 * @property {Uint16Array|Uint32Array} index
 * @property {Float32Array} curvePoints x, y, z, intensity per point
 * @property {{start:number, count:number, center:number[], radius:number}[]} curveChunks
 * @property {{firstChunk:number, chunkCount:number, center:number[], radius:number}[]} curveGroups
 * @property {EyeDef[]} eyes            [screen-left eye, screen-right eye]
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

/**
 * Structural validation of head.json. Returns a list of problems ([] = ok).
 * @param {any} m
 */
export function validateMeta(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['model metadata is not an object'];
  if (m.format !== FORMAT) errs.push(`format is "${m.format}", expected "${FORMAT}"`);
  if (m.version !== VERSION) errs.push(`unsupported version ${m.version}`);
  if (!Number.isInteger(m.vertexCount) || m.vertexCount < 3) errs.push('vertexCount missing');
  if (!Number.isInteger(m.indexCount) || m.indexCount < 3 || m.indexCount % 3) errs.push('indexCount must be a positive multiple of 3');
  if (!Number.isInteger(m.skinVertexCount) || m.skinVertexCount < 3 || m.skinVertexCount > m.vertexCount) errs.push('skinVertexCount invalid');
  const L = m.layout || {};
  for (const k of ['position', 'rig', 'aux', 'cavity', 'shell', 'index']) {
    const b = L[k];
    if (!b || !Number.isInteger(b.offset) || b.offset % 4 || !Number.isInteger(b.byteLength)) errs.push(`layout.${k} missing or misaligned`);
  }
  if (L.position && (!isVec(L.position.min, 3) || !isVec(L.position.max, 3))) errs.push('layout.position.min/max missing');
  // optional blocks (newer builds)
  if (L.extra !== undefined && (!Number.isInteger(L.extra?.offset) || L.extra.offset % 4 || !Number.isInteger(L.extra?.byteLength))) {
    errs.push('layout.extra misaligned');
  }
  if (L.rig && L.rig.components !== RIG_CHANNELS.length) errs.push(`rig must have ${RIG_CHANNELS.length} channels`);
  if (!m.buffer || typeof m.buffer.uri !== 'string' || /[\\/]|\.\./.test(m.buffer.uri)) errs.push('buffer.uri must be a plain file name');
  if (!Array.isArray(m.eyes) || m.eyes.length !== 2) errs.push('two eyes expected');
  else {
    m.eyes.forEach((e, i) => {
      for (const k of ['center', 'axisX', 'axisY', 'axisZ', 'upper', 'lower', 'ball']) if (!isVec(e?.[k], 3)) errs.push(`eyes[${i}].${k} invalid`);
      for (const k of ['halfWidth', 'ballRadius', 'irisRadius', 'pupilRadius']) if (!isNum(e?.[k]) || e[k] <= 0) errs.push(`eyes[${i}].${k} invalid`);
    });
  }
  const c = m.curves;
  if (!c || !Array.isArray(c.points) || c.points.length % 4 || !Array.isArray(c.chunks) || !Array.isArray(c.groups)) errs.push('curves invalid');
  else {
    const n = c.points.length / 4;
    c.chunks.forEach((k, i) => {
      // a chunk covers segments [start, start + count): points start .. start + count
      const ok = Number.isInteger(k?.start) && Number.isInteger(k?.count) && k.start >= 0 && k.count >= 1 &&
        k.start + k.count <= n - 1;
      if (!ok || k.count > MAX_SEGMENTS_PER_CHUNK) errs.push(`curves.chunks[${i}] out of range`);
      if (!isVec(k?.center, 3) || !isNum(k?.radius)) errs.push(`curves.chunks[${i}] bounds invalid`);
    });
    let next = 0;
    c.groups.forEach((g, i) => {
      // groups partition the chunk list in order
      const ok = Number.isInteger(g?.firstChunk) && Number.isInteger(g?.chunkCount) && g.firstChunk === next &&
        g.chunkCount >= 1 && g.chunkCount <= MAX_CHUNKS_PER_GROUP && isVec(g?.center, 3) && isNum(g?.radius);
      if (!ok) errs.push(`curves.groups[${i}] invalid`);
      next = (g?.firstChunk ?? 0) + (g?.chunkCount ?? 0);
    });
    if (next !== c.chunks.length) errs.push('curves.groups do not cover the chunks');
    if (c.groups.length > MAX_CURVE_GROUPS) errs.push(`more than ${MAX_CURVE_GROUPS} curves`);
  }
  if (!Array.isArray(m.outline) || m.outline.length < 8 || m.outline.length % 2) errs.push('outline invalid');
  const r = m.rig || {};
  for (const k of ['jawPivot', 'headPivot', 'mouthCenter', 'cornerL', 'cornerR']) if (!isVec(r[k], 3)) errs.push(`rig.${k} invalid`);
  for (const k of ['mouthHalfWidth', 'faceHeight']) if (!isNum(r[k]) || r[k] <= 0) errs.push(`rig.${k} invalid`);
  if (!m.neck || !isNum(m.neck.fadeTop) || !isNum(m.neck.fadeBottom)) errs.push('neck fade invalid');
  return errs;
}

/**
 * Decode the binary buffer against validated metadata. Throws on any inconsistency.
 * @param {any} meta parsed head.json (validateMeta(meta) must be empty)
 * @param {ArrayBuffer} buffer contents of head.bin
 * @returns {HeadModel}
 */
export function decodeModel(meta, buffer) {
  const errs = validateMeta(meta);
  if (errs.length) throw new Error(`invalid head model: ${errs.join('; ')}`);
  if (!(buffer instanceof ArrayBuffer)) throw new Error('head model buffer must be an ArrayBuffer');
  if (meta.buffer.byteLength !== undefined && buffer.byteLength !== meta.buffer.byteLength) {
    throw new Error(`head model buffer is ${buffer.byteLength} bytes, expected ${meta.buffer.byteLength}`);
  }
  const n = meta.vertexCount;
  const L = meta.layout;
  const view = (key, Ctor, count) => {
    const b = L[key];
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    if (b.byteLength !== bytes || b.offset + bytes > buffer.byteLength) {
      throw new Error(`head model block "${key}" has ${b.byteLength} bytes, expected ${bytes}`);
    }
    return new Ctor(buffer, b.offset, count);
  };
  const q = view('position', Uint16Array, n * 3);
  const { min, max } = L.position;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = min[k] + (q[i * 3 + k] / 65535) * (max[k] - min[k]);
  }
  const IndexCtor = L.index.type === 'uint32' ? Uint32Array : Uint16Array;
  const index = view('index', IndexCtor, meta.indexCount);
  for (let i = 0; i < index.length; i++) {
    if (index[i] >= n) throw new Error(`head model index ${index[i]} out of range (${n} vertices)`);
  }
  return {
    meta,
    vertexCount: n,
    skinVertexCount: meta.skinVertexCount,
    positions,
    rig: view('rig', Uint8Array, n * RIG_CHANNELS.length),
    aux: view('aux', Uint8Array, n * 4),
    cavity: view('cavity', Uint8Array, n * 4),
    shell: view('shell', Uint8Array, n * 4),
    extra: L.extra ? view('extra', Uint8Array, n * 4) : new Uint8Array(n * 4),
    index,
    curvePoints: Float32Array.from(meta.curves.points),
    curveChunks: meta.curves.chunks,
    curveGroups: meta.curves.groups,
    eyes: meta.eyes,
  };
}

/** Width of the curve data texture (texels per row). */
export const CURVE_TEX_WIDTH = 512;
/** Shader loop bounds (see shaders.js nearestCurve). */
export const MAX_CURVE_GROUPS = 32;
export const MAX_CHUNKS_PER_GROUP = 24;
export const MAX_SEGMENTS_PER_CHUNK = 8;

/**
 * Pack the curve data into one RGBA float texture image (two-level culling in the shader):
 *   texel i (i < points)       = x, y, z, intensity of point i
 *   texel chunkBase + 2k       = chunk k centre xyz + radius (+ pad)
 *   texel chunkBase + 2k + 1   = chunk k first point, segment count
 *   texel groupBase + 2g       = curve g centre xyz + radius (+ pad)
 *   texel groupBase + 2g + 1   = curve g first chunk, chunk count
 * @param {Float32Array} points
 * @param {{start:number,count:number,center:number[],radius:number}[]} chunks
 * @param {{firstChunk:number,chunkCount:number,center:number[],radius:number}[]} groups
 * @param {number} [pad] world units added to every radius (line width + glow reach)
 */
export function packCurveTexture(points, chunks, groups, pad = 0) {
  const nPts = points.length / 4;
  const chunkBase = nPts;
  const groupBase = chunkBase + chunks.length * 2;
  const texels = groupBase + groups.length * 2;
  const width = CURVE_TEX_WIDTH;
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Float32Array(width * height * 4);
  data.set(points, 0);
  const put = (texel, a, b) => {
    const o = texel * 4;
    data[o] = a[0]; data[o + 1] = a[1]; data[o + 2] = a[2]; data[o + 3] = a[3];
    data[o + 4] = b[0]; data[o + 5] = b[1];
  };
  chunks.forEach((c, k) => put(chunkBase + 2 * k, [...c.center, c.radius + pad], [c.start, c.count]));
  groups.forEach((g, k) => put(groupBase + 2 * k, [...g.center, g.radius + pad], [g.firstChunk, g.chunkCount]));
  return { data, width, height, chunkBase, chunkCount: chunks.length, groupBase, groupCount: groups.length };
}
