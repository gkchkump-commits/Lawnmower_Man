// Procedural head: a real 3D hologram head (rotatable) rendered from a processed head scan
// (public/assets/models/head.*, built by tools/procedural/build_head.py). Every visual —
// glass body lit from within, blue-white grid, irregular web, gold contour lines, glowing eyes
// and lips, cyan fresnel rim, dissolving neck — is generated in the shader; no pixels of the
// reference video are used. Two draw calls: the head (skin + mouth cavity share the mesh) and,
// on medium / high, an additive halo shell over the silhouette triangles (shared buffers).

import { decodeModel, packCurveTexture, validateMeta } from './format.js';
import { buildProcRig, procRigUniforms } from './rig.js';
import { DEFAULT_DEFINES, HALO_FRAG, HALO_VERT, HEAD_FRAG, HEAD_VERT } from './shaders.js';

/** @typedef {import('../../types.js').HeadContext} HeadContext */
/** @typedef {import('../../director.js').AnimState} AnimState */

const MODEL_FILE = 'models/head.json';
/** Gold-line reach added to each curve chunk's bounding radius (line + glow falloff). */
const CURVE_PAD = 0.008;
/** Grid: meridians around the head, latitude step (rad), line half width (period), web cell.
 * Dense like the reference (about 7-8 px between lines at 1168 px tall, ~12 px web cells); the
 * line AA fades the grid to its mean on small windows instead of letting it moire. */
export const GRID = Object.freeze([250, 0.0145, 0.04, 0.0095]);

/** Halo shell: offset along the outer-shell normal (world units, ~10 px on the 1168 px plate)
 * and strength of its additive cyan glow. */
export const HALO = Object.freeze({ offset: 0.009, strength: 0.22 });

/**
 * Triangles of the halo shell: skin triangles whose outer-shell normal (rest pose) turns away
 * from the camera by more than ~45 degrees (z < `maxFacing`) at some vertex. The halo only glows
 * where the shell is seen at > ~74 degrees, which the front of the face never reaches within
 * |yaw| <= ~0.5 rad, so the halo pass rasterises only the sides, top and underside of the head.
 * @param {{ index: ArrayLike<number>, shell: ArrayLike<number>, skinVertexCount: number }} model
 * @param {number} [maxFacing] shell normal z (toward the camera) above which a vertex is "front"
 * @returns {Uint32Array}
 */
export function haloIndex(model, maxFacing = 0.7) {
  const { index, shell, skinVertexCount: skin } = model;
  const nz = (i) => (shell[i * 4 + 2] / 255) * 2 - 1;
  const out = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (a >= skin || b >= skin || c >= skin) continue;            // mouth cavity
    if (Math.min(nz(a), nz(b), nz(c)) < maxFacing) out.push(a, b, c);
  }
  return Uint32Array.from(out);
}

/**
 * Lip seam height y(dx) = c0 + c2 dx^2 + c4 dx^4 (rest pose, dx from the mouth centre) — the
 * upper edge of the mouth opening, used to place the teeth. Older models without
 * rig.seamFit get a straight seam at the mouth centre.
 * @param {any} meta
 * @returns {[number, number, number]}
 */
export function seamFit(meta) {
  const f = meta?.rig?.seamFit;
  if (Array.isArray(f) && f.length === 3 && f.every((v) => Number.isFinite(v))) return [f[0], f[1], f[2]];
  return [meta.rig.mouthCenter[1], 0, 0];
}

/** The halo shell is drawn on medium and high (one extra draw call). @param {string} quality */
export function haloOn(quality) {
  return quality !== 'low';
}

/** Shader defines for a quality tier ('low' drops the web and the fine dust). @param {string} quality */
export function tierDefines(quality) {
  const low = quality === 'low';
  return { PH_WEB: low ? 0 : 1, PH_DUST: low ? 0 : 1 };
}

export default class ProceduralHead {
  /** @param {HeadContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'procedural';
    this.group = null;
    this.mesh = null;
    this.model = null;
    this._u = {};          // rig uniform scratch (no per-frame allocation)
    this.fx = 1;
  }

  async load() {
    const { THREE, loadJSON, signal, assetsBase } = this.ctx;
    const url = `${assetsBase}${MODEL_FILE}`;
    const meta = await loadJSON(url);
    const errs = validateMeta(meta);
    if (errs.length) throw new Error(`invalid procedural head model (${url}): ${errs.join('; ')}`);
    const binUrl = new URL(meta.buffer.uri, new URL(url, document.baseURI)).href;
    const res = await fetch(binUrl, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${binUrl}`);
    const buffer = await res.arrayBuffer();
    if (signal?.aborted) throw new Error('aborted');
    const model = decodeModel(meta, buffer);
    this.model = model;
    this.rig = buildProcRig(meta);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    const rigBuf = new THREE.InterleavedBuffer(model.rig, 8);
    geo.setAttribute('aRig0', new THREE.InterleavedBufferAttribute(rigBuf, 4, 0, true));
    geo.setAttribute('aRig1', new THREE.InterleavedBufferAttribute(rigBuf, 4, 4, true));
    geo.setAttribute('aAux', new THREE.BufferAttribute(model.aux, 4, true));
    geo.setAttribute('aCav', new THREE.BufferAttribute(model.cavity, 4, true));
    geo.setAttribute('aShell', new THREE.BufferAttribute(model.shell, 4, true));
    geo.setAttribute('aExtra', new THREE.BufferAttribute(model.extra, 4, true));
    geo.setIndex(new THREE.BufferAttribute(model.index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.boundingSphere.radius *= 1.3;   // rig headroom

    const curves = packCurveTexture(model.curvePoints, model.curveChunks, model.curveGroups, CURVE_PAD);
    const tex = new THREE.DataTexture(curves.data, curves.width, curves.height, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.curveTex = tex;

    this.uniforms = this._makeUniforms(meta, curves);
    const defines = { ...DEFAULT_DEFINES, ...tierDefines(this.ctx.quality) };
    const mat = new THREE.ShaderMaterial({
      vertexShader: HEAD_VERT,
      fragmentShader: HEAD_FRAG,
      uniforms: this.uniforms,
      defines,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      // premultiplied "over"
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    // soft outer glow: same geometry (shared buffers), drawn after the head, additive light only
    const haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: this.uniforms,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    // only the triangles that can reach the silhouette (the front of the face never does within
    // the head's motion range): ~1/3 of the head's fragments, shared vertex buffers
    const haloGeo = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(geo.attributes)) haloGeo.setAttribute(k, v);
    haloGeo.setIndex(new THREE.BufferAttribute(haloIndex(model), 1));
    haloGeo.boundingSphere = geo.boundingSphere;
    this.halo = new THREE.Mesh(haloGeo, haloMat);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 2;
    this.halo.visible = haloOn(this.ctx.quality);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.halo);
    this.ctx.scene.add(this.group);
  }

  /** @param {any} meta @param {{chunkBase:number, groupBase:number, groupCount:number}} curves */
  _makeUniforms(meta, curves) {
    const { THREE, palette } = this.ctx;
    const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    const eyes = meta.eyes;
    const crease = 0.35 * Math.abs(eyes[0].upper[0]) + 0.006;
    return {
      uJawRot: { value: new THREE.Matrix3() },
      uJawPivot: { value: v3(meta.rig.jawPivot) },
      uHeadRot: { value: new THREE.Matrix3() },
      uHeadPivot: { value: v3(meta.rig.headPivot) },
      uHeadXform: { value: new THREE.Vector3(0, 0, 1) },
      uCornerL: { value: new THREE.Vector3() },
      uCornerR: { value: new THREE.Vector3() },
      uLips: { value: new THREE.Vector4() },
      uMouthX: { value: new THREE.Vector4() },
      uBrow: { value: new THREE.Vector2() },
      uBreathY: { value: 0 },
      uNeckRot: { value: new THREE.Vector2(meta.neck.fadeBottom - 0.02, meta.neck.fadeTop + 0.06) },
      // the face moving with the mouth: chin boss, nostril wings (rest geometry; amounts per frame)
      uFace: { value: new THREE.Vector2() },
      uChinP: { value: new THREE.Vector4(...this.rig.chin) },
      uAlaP: { value: new THREE.Vector4(...this.rig.ala) },
      uTime: { value: 0 }, uEnergy: { value: 0.5 }, uSpeech: { value: 0 }, uListen: { value: 0 },
      uThink: { value: 0 }, uSpeak: { value: 0 }, uError: { value: 0 }, uSleep: { value: 0 }, uFx: { value: this.fx },
      uColLine: { value: palette.line.clone() }, uColRim: { value: palette.rim.clone() },
      uColEye: { value: palette.eye.clone() }, uColGrid: { value: palette.grid.clone() },
      uGridCenter: { value: v3(meta.features.craniumCenter) },
      uGrid: { value: new THREE.Vector4(...GRID) },
      uMouthC: { value: v3(meta.rig.mouthCenter) },
      uMouth: { value: new THREE.Vector4(...seamFit(meta), meta.rig.mouthHalfWidth) },
      uNoseTip: { value: v3(meta.features.noseTip) },
      uNoseBridge: { value: v3(meta.features.noseBridge ?? meta.features.glabella) },
      uNeckHW: { value: meta.particleAnchors?.neckHalfWidth ?? 0.15 },
      uPulseOrigin: { value: v3(meta.features.glabella) },
      uNeck: { value: new THREE.Vector2(meta.neck.fadeBottom, meta.neck.fadeTop) },
      tCurves: { value: this.curveTex },
      uChunkBase: { value: curves.chunkBase },
      uGroupBase: { value: curves.groupBase },
      uGroupCount: { value: curves.groupCount },
      uCurveRange: { value: meta.curveDistanceRange ?? 0.05 },
      uEyeC: { value: eyes.map((e) => v3(e.center)) },
      uEyeX: { value: eyes.map((e) => v3(e.axisX)) },
      uEyeY: { value: eyes.map((e) => v3(e.axisY)) },
      uEyeUp: { value: eyes.map((e) => new THREE.Vector4(e.upper[0], e.upper[1], e.upper[2], e.halfWidth)) },
      uEyeLo: { value: eyes.map((e) => new THREE.Vector4(e.lower[0], e.lower[1], e.lower[2], crease)) },
      uEyeBall: { value: eyes.map((e) => new THREE.Vector4(e.ball[0], e.ball[1], e.ball[2], e.ballRadius)) },
      uEyeIris: {
        value: eyes.map((e) => new THREE.Vector2(
          Math.asin(Math.min(0.95, e.irisRadius / e.ballRadius)),
          Math.asin(Math.min(0.9, e.pupilRadius / e.ballRadius)))),
      },
      uGaze: { value: eyes.map((e) => v3(e.axisZ)) },
      uBlink: { value: new THREE.Vector2() },
      uSquint: { value: 0 },
      uHalo: { value: HALO.strength },
      uHaloOffset: { value: HALO.offset },
    };
  }

  /** @param {number} dt @param {number} time @param {AnimState} a */
  update(dt, time, a) {
    if (!this.mesh) return;
    const u = procRigUniforms(this.rig, a, this._u);
    const f = this.uniforms;
    f.uJawRot.value.fromArray(u.jawRot);
    f.uHeadRot.value.fromArray(u.headRot);
    f.uHeadXform.value.fromArray(u.headXform);
    f.uCornerL.value.fromArray(u.cornerL);
    f.uCornerR.value.fromArray(u.cornerR);
    f.uLips.value.fromArray(u.lips);
    f.uMouthX.value.fromArray(u.mouthX);
    f.uBrow.value.fromArray(u.brow);
    f.uBreathY.value = u.breathY;
    f.uFace.value.set(u.face[0], u.face[1]);
    f.uBlink.value.fromArray(u.blink);
    f.uSquint.value = u.squint;
    f.uGaze.value[0].fromArray(u.gaze, 0);
    f.uGaze.value[1].fromArray(u.gaze, 3);
    f.uTime.value = time;
    f.uEnergy.value = a.energy;
    f.uSpeech.value = a.speech;
    f.uListen.value = a.listen;
    f.uThink.value = a.think;
    f.uSpeak.value = a.speak;
    f.uError.value = a.error;
    f.uSleep.value = a.sleep;
    f.uFx.value = this.fx;
  }

  framing() {
    const c = this.model?.meta.camera ?? { fov: 12, viewWidth: 784 / 1168 };
    return { center: [0, 0, 0], height: 1, width: c.viewWidth, projection: 'perspective', fov: c.fov };
  }

  /** @returns {import('../../fx/particles.js').ParticleAnchors} */
  particleAnchors() {
    const p = this.model.meta.particleAnchors;
    return { ...p, center: [...p.center], radius: [...p.radius], outline: this.hitPolygon() };
  }

  /** Silhouette (world, rest pose, screen plane) for hitTest. */
  hitPolygon() {
    return Float32Array.from(this.model.meta.outline);
  }

  /** @param {{ palette?: import('../../types.js').HeadPalette, fx?: number, quality?: string }} o */
  setOptions(o) {
    if (!this.uniforms) return;
    if (o.palette) {
      this.uniforms.uColLine.value.copy(o.palette.line);
      this.uniforms.uColRim.value.copy(o.palette.rim);
      this.uniforms.uColEye.value.copy(o.palette.eye);
      this.uniforms.uColGrid.value.copy(o.palette.grid);
    }
    if (o.fx !== undefined) this.fx = Math.max(0, Number(o.fx) || 0);
    if (o.quality !== undefined && this.mesh) {
      const mat = /** @type {any} */ (this.mesh.material);
      const want = tierDefines(o.quality);
      if (Object.entries(want).some(([k, v]) => mat.defines[k] !== v)) {
        Object.assign(mat.defines, want);
        mat.needsUpdate = true;
      }
      if (this.halo) this.halo.visible = haloOn(o.quality);
    }
  }

  dispose() {
    if (this.group) this.ctx.scene.remove(this.group);
    this.mesh?.geometry.dispose();
    this.halo?.geometry.dispose();
    /** @type {any} */ (this.mesh?.material)?.dispose();
    /** @type {any} */ (this.halo?.material)?.dispose();
    this.curveTex?.dispose();
    this.group = null;
    this.mesh = null;
    this.halo = null;
  }
}
