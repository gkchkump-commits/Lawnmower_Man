// Relief head: a 2.5D mesh of the reference frame textured with its own pixels and rigged from
// MediaPipe landmarks (built by tools/bake/bake_avatar.py). One draw call for the face, one for
// the mouth cavity (dark interior + upper teeth on the upper jaw, lower teeth on the jaw).

import { packWeights, validateMesh, validatePack, withSlash } from '../../pack.js';
import { RIG_LIMITS, buildRig, rigUniforms } from './rig.js';
import { mouthRegion, refineMesh } from './refine.js';
import { irisLayer } from './iris.js';
import { CAVITY_FRAG, CAVITY_VERT, FACE_FRAG, FACE_VERT } from './shaders.js';

/** @typedef {import('../../types.js').HeadContext} HeadContext */
/** @typedef {import('../../director.js').AnimState} AnimState */

export default class ReliefHead {
  /** @param {HeadContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'relief';
    this.base = withSlash(ctx.packUrl);
    this.group = null;
    this._u = {};      // scratch for rigUniforms (no per-frame allocation)
    this.fx = 1;
  }

  async load() {
    const { THREE, loadJSON, loadTexture, signal } = this.ctx;
    const pack = await loadJSON(`${this.base}pack.json`);
    const perr = validatePack(pack);
    if (perr.length) throw new Error(`invalid avatar pack (${this.base}): ${perr.join('; ')}`);
    const f = pack.files;
    const [mesh, plate, closed, mouth, masksA, masksB, masksC] = await Promise.all([
      loadJSON(this.base + f.mesh),
      loadTexture(this.base + f.plate, { srgb: true }),
      loadTexture(this.base + f.eyesClosed, { srgb: true }),
      loadTexture(this.base + f.mouth, { srgb: true }),
      loadTexture(this.base + f.masksA, { srgb: false }),
      loadTexture(this.base + f.masksB, { srgb: false }),
      // lid coordinate / occlusion (baker >= 1.1); older packs fall back to the cross-fade blink
      f.masksC ? loadTexture(this.base + f.masksC, { srgb: false }) : Promise.resolve(fallbackMaskC(THREE)),
    ]);
    if (signal?.aborted) {
      [plate, closed, mouth, masksA, masksB, masksC].forEach((t) => t.dispose());
      throw new Error('aborted');
    }
    const merr = validateMesh(mesh);
    if (merr.length) throw new Error(`invalid relief mesh: ${merr.join('; ')}`);
    this.pack = pack;
    this.hasLids = !!f.masksC;
    this.textures = { plate, closed, mouth, masksA, masksB, masksC };
    const maxAniso = this.ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    for (const [name, t] of Object.entries(this.textures)) {
      // The colour plates are minified ~2.6x at the small window preset: without mipmaps the fine
      // grid turns into pixel noise. Masks stay single-level (exact coverage / lid coordinate).
      const mip = name === 'plate' || name === 'closed' || name === 'mouth';
      t.generateMipmaps = mip;
      t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = mip ? Math.min(8, maxAniso) : 1;
      t.needsUpdate = true;
    }
    this.rig = buildRig(pack, mesh);
    // the irises as painted on the plate (the gaze moves them as discs), and the plate with them
    // painted over: what a moving iris uncovers
    const iris = irisLayer(plate.image, pack, { lids: f.masksC ? masksC.image : null, aperture: masksB.image });
    this.iris = iris.eyes;
    for (const k of /** @type {const} */ (['L', 'R'])) {
      const e = iris.eyes[k], H = pack.plate.height;
      // (the gaze travel is in iris radii: the painted iris')
      Object.assign(this.rig.eyes[k], { uv: [e.cx / pack.plate.width, 1 - e.cy / H], irisR: e.r / H, discR: e.disc / H });
    }
    if (iris.canvas) {
      const t = new THREE.CanvasTexture(iris.canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = Math.min(8, maxAniso);
      t.needsUpdate = true;
      this.textures.sclera = t;
    }
    if (iris.canvas && iris.open) {
      // (DataTexture rows run bottom-up, the open map's top-down)
      const W = pack.plate.width, H = pack.plate.height;
      const rows = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) rows.set(iris.open.subarray(y * W, (y + 1) * W), (H - 1 - y) * W);
      const t = new THREE.DataTexture(rows, W, H, THREE.RedFormat, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.unpackAlignment = 1;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      this.textures.open = t;
    }
    this._buildFace(mesh);
    this._buildCavity(mesh);
    this.group = new THREE.Group();
    this.group.add(this.cavityMesh, this.faceMesh);
    this.ctx.scene.add(this.group);
  }

  // ------------------------------------------------------------------------------------------
  _commonUniforms() {
    const { THREE } = this.ctx;
    const r = this.rig;
    const f = r.face;
    return {
      uHeadRot: { value: new THREE.Matrix3() },
      uHeadPivot: { value: new THREE.Vector3(...r.headPivot) },
      uJawDrop: { value: 0 }, uUpperLift: { value: 0 }, uLowerDrop: { value: 0 }, uLipPush: { value: 0 },
      uBreathY: { value: 0 }, uPlateAspect: { value: r.plateW }, uHeadXform: { value: new THREE.Vector3(0, 0, 1) },
      uCornerL: { value: new THREE.Vector2() }, uCornerR: { value: new THREE.Vector2() },
      uBrows: { value: new THREE.Vector2() }, uLids: { value: new THREE.Vector4() },
      uNeckBand: { value: new THREE.Vector2(r.neckBand[0], r.neckBand[1]) },
      uMouth: { value: new THREE.Vector3(r.mouthCenter[0], r.mouthCenter[1], r.mouthHalfW) },
      uLens: { value: new THREE.Vector2(1, RIG_LIMITS.cornerJawShare) },
      uLowerClose: { value: 0 },
      uOpen: { value: new THREE.Vector3(0, 0, 1) },
      // jaw hinge and the face regions that move with the mouth (rest geometry; amounts per frame)
      uHinge: { value: new THREE.Vector4(...r.hinge) },
      uHingeK: { value: new THREE.Vector3(RIG_LIMITS.hingeSide, RIG_LIMITS.hingeStretch, RIG_LIMITS.hingeBack) },
      uFaceMove: { value: new THREE.Vector4() },
      uCheekC: { value: new THREE.Vector4(...f.cheekL, ...f.cheekR) },
      uChinC: { value: new THREE.Vector4(...f.chin, ...f.chinRadius) },
      uAlaC: { value: new THREE.Vector4(...f.alaL, ...f.alaR) },
      uFaceR: { value: new THREE.Vector3(...f.cheekRadius, f.alaRadius) },
    };
  }

  _toWorld(positions, n) {
    const W = this.pack.plate.width, H = this.pack.plate.height;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = (positions[i * 3] - W / 2) / H;
      out[i * 3 + 1] = (H / 2 - positions[i * 3 + 1]) / H;
      out[i * 3 + 2] = positions[i * 3 + 2] / H;
    }
    return out;
  }

  _buildFace(mesh0) {
    const { THREE, palette } = this.ctx;
    // the mouth region is refined to ~6 px triangles (smooth lip contours when the mouth moves;
    // the rest surface is unchanged: new vertices lie on the baked edges)
    const mesh = refineFaceMesh(mesh0, this.pack);
    this.meshStats = { vertices: mesh.vertexCount, baked: mesh0.vertexCount, triangles: mesh.indices.length / 3 };
    const n = mesh.vertexCount;
    const W = this.pack.plate.width, H = this.pack.plate.height;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._toWorld(mesh.positions, n), 3));
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = mesh.positions[i * 3] / W;
      uv[i * 2 + 1] = 1 - mesh.positions[i * 3 + 1] / H;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const face = Float32Array.from(mesh.face, (v) => v / mesh.weightScale);
    const { w0, w1, w2 } = packWeights(mesh.weights, n, mesh.weightScale, face);
    geo.setAttribute('aW0', new THREE.BufferAttribute(w0, 4));
    geo.setAttribute('aW1', new THREE.BufferAttribute(w1, 4));
    geo.setAttribute('aW2', new THREE.BufferAttribute(w2, 4));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(Float32Array.from(mesh.edge), 1));
    // distance below the closed-mouth slit (px): the lip warp of press / tuck
    geo.setAttribute('aSlitD', new THREE.BufferAttribute(slitDistances(mesh.positions, n, this.pack.rig.slitLine), 1));
    const Index = n > 65535 ? Uint32Array : Uint16Array;
    geo.setIndex(new THREE.BufferAttribute(Index.from(mesh.indices), 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius *= 1.5; // rig deformation headroom

    const r = this.rig;
    const lm = this.pack.landmarks;
    const t = this.textures;
    this.faceUniforms = {
      ...this._commonUniforms(),
      tPlate: { value: t.plate }, tClosed: { value: t.closed }, tMaskA: { value: t.masksA }, tMaskB: { value: t.masksB },
      tSclera: { value: t.sclera || t.plate }, tOpen: { value: t.open || t.masksB },
      uIrisLayer: { value: t.sclera && t.open ? 1 : 0 },
      tMaskC: { value: t.masksC }, uHasLids: { value: this.hasLids ? 1 : 0 },
      uPlateSize: { value: new THREE.Vector2(W, H) },
      // iris discs: centre, radius (iris + glow), 2 px feather (plate heights)
      uEyeL: { value: new THREE.Vector4(r.eyes.L.uv[0], r.eyes.L.uv[1], r.eyes.L.discR ?? r.eyes.L.irisR, 2 / H) },
      uEyeR: { value: new THREE.Vector4(r.eyes.R.uv[0], r.eyes.R.uv[1], r.eyes.R.discR ?? r.eyes.R.irisR, 2 / H) },
      uGaze: { value: new THREE.Vector2() }, uBlink: { value: new THREE.Vector2() },
      // pulses radiate from the "third eye" between the brows along the gold circuit lines
      uPulseOrigin: { value: new THREE.Vector2(lm.noseBridge[0] / W, 1 - (lm.noseBridge[1] - 0.06 * this.pack.rig.faceHeight) / H) },
      uTime: { value: 0 }, uEnergy: { value: 0.5 }, uSpeech: { value: 0 }, uListen: { value: 0 },
      uThink: { value: 0 }, uSpeak: { value: 0 }, uError: { value: 0 }, uSleep: { value: 0 }, uFx: { value: this.fx },
      uChinV: { value: 1 - this.pack.framing.chinY / H },
      uLipWarp: { value: new THREE.Vector4() },
      uColLine: { value: palette.line.clone() }, uColRim: { value: palette.rim.clone() },
      uColEye: { value: palette.eye.clone() }, uColGrid: { value: palette.grid.clone() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: FACE_VERT, fragmentShader: FACE_FRAG, uniforms: this.faceUniforms,
      side: THREE.DoubleSide, depthTest: true, depthWrite: true, transparent: false,
      // premultiplied "over"
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.faceMesh = new THREE.Mesh(geo, mat);
    this.faceMesh.renderOrder = 1;
    this.faceMesh.frustumCulled = false;
  }

  _buildCavity(mesh) {
    const { THREE } = this.ctx;
    const c = refineCavity(mesh.cavity);
    const n = c.vertexCount;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._toWorld(c.positions, n), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(c.uvs), 2));
    const { w0, w1, w2 } = packWeights(c.weights, n, mesh.weightScale);
    geo.setAttribute('aW0', new THREE.BufferAttribute(w0, 4));
    geo.setAttribute('aW1', new THREE.BufferAttribute(w1, 4));
    geo.setAttribute('aW2', new THREE.BufferAttribute(w2, 4));
    geo.setAttribute('aLayer', new THREE.BufferAttribute(Float32Array.from(c.layer), 1));
    // distance below the closed-mouth slit (px) for the shadow under the upper lip
    geo.setAttribute('aSlit', new THREE.BufferAttribute(slitDistances(c.positions, n, this.pack.rig.slitLine), 1));
    geo.setIndex(new THREE.BufferAttribute((n > 65535 ? Uint32Array : Uint16Array).from(c.indices), 1));
    geo.computeBoundingSphere();
    const dark = this.pack.mouth?.darkColor ?? [0.06, 0.035, 0.03];
    this.cavityUniforms = {
      ...this._commonUniforms(),
      tMouth: { value: this.textures.mouth },
      uTeeth: { value: 0 }, uSleep: { value: 0 }, uTongue: { value: 0 }, uTeethShift: { value: 0 }, uJawPx: { value: 0 },
      uPxPerUnit: { value: this.pack.plate.height },
      uColLine: { value: this.ctx.palette.line.clone() },
      uDark: { value: new THREE.Color().setRGB(dark[0], dark[1], dark[2], THREE.SRGBColorSpace) },
    };
    // share the rig uniform objects so one update drives both meshes
    for (const k of Object.keys(this.cavityUniforms)) {
      if (this.faceUniforms[k] && k.startsWith('u') && !['uSleep'].includes(k)) this.cavityUniforms[k] = this.faceUniforms[k];
    }
    // The cavity is drawn first WITHOUT depth: the (opaque) face drawn over it hides it
    // everywhere except through the open lip slit, whatever the jaw does to the depth order.
    const mat = new THREE.ShaderMaterial({
      vertexShader: CAVITY_VERT, fragmentShader: CAVITY_FRAG, uniforms: this.cavityUniforms,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.cavityMesh = new THREE.Mesh(geo, mat);
    this.cavityMesh.renderOrder = 0;
    this.cavityMesh.frustumCulled = false;
  }

  // ------------------------------------------------------------------------------------------
  /** @param {number} dt @param {number} time @param {AnimState} a */
  update(dt, time, a) {
    if (!this.group) return;
    const u = rigUniforms(this.rig, a, this._u);
    const f = this.faceUniforms;
    f.uHeadRot.value.fromArray(u.headRot);
    f.uJawDrop.value = u.jawDrop;
    f.uUpperLift.value = u.upperLift;
    f.uLowerDrop.value = u.lowerDrop;
    f.uLipPush.value = u.lipPush;
    f.uBreathY.value = u.breathY;
    f.uHeadXform.value.set(u.headXform[0], u.headXform[1], u.headXform[2]);
    f.uCornerL.value.set(u.cornerL[0], u.cornerL[1]);
    f.uCornerR.value.set(u.cornerR[0], u.cornerR[1]);
    f.uBrows.value.set(u.brows[0], u.brows[1]);
    f.uLids.value.set(u.lids[0], u.lids[1], u.lids[2], u.lids[3]);
    f.uGaze.value.set(u.gaze[0], u.gaze[1]);
    f.uBlink.value.set(u.blink[0], u.blink[1]);
    f.uTime.value = time;
    f.uEnergy.value = a.energy;
    f.uSpeech.value = a.speech;
    f.uListen.value = a.listen;
    f.uThink.value = a.think;
    f.uSpeak.value = a.speak;
    f.uError.value = a.error;
    f.uSleep.value = a.sleep;
    f.uFx.value = this.fx;
    f.uLipWarp.value.set(u.lipWarp[0], u.lipWarp[1], u.lipWarp[2], u.lipWarp[3]);
    f.uFaceMove.value.set(u.faceMove[0], u.faceMove[1], u.faceMove[2], u.faceMove[3]);
    f.uLens.value.set(u.lens[0], u.lens[1]);
    f.uLowerClose.value = u.lowerClose;
    f.uOpen.value.set(u.open[0], u.open[1], u.open[2]);
    const cu = this.cavityUniforms;
    const H = this.pack.plate.height;
    cu.uTeeth.value = cavityTeeth(a);
    cu.uSleep.value = a.sleep;
    cu.uTongue.value = u.tongue;
    cu.uJawPx.value = u.jawDrop * H;
    // world -> px -> mouth texture v (its upper half, the cavity, spans the mouth rect height)
    cu.uTeethShift.value = (u.teethShift * H * 0.5) / (this.pack.mouthRect?.[3] || 127);
  }

  /**
   * Largest head rotation (radians) this 2.5D card still sells: beyond ~0.3 rad yaw the far cheek
   * compresses and the cranium edge turns hard. createAvatar soft-limits the director to it.
   */
  motionLimits() {
    return { yaw: 0.25, pitch: 0.18, roll: 0.2 };
  }

  framing() {
    const fr = this.pack.framing;
    const H = this.pack.plate.height;
    return {
      center: [0, 0, 0],
      height: fr.height / H,
      width: fr.width / H,
      projection: 'orthographic',
    };
  }

  /** @returns {import('../../fx/particles.js').ParticleAnchors} */
  particleAnchors() {
    const p = this.pack;
    const W = p.plate.width, H = p.plate.height;
    const fr = p.framing;
    const e = fr.headEllipse ?? { center: [W / 2, fr.chinY * 0.5], radius: [W * 0.42, fr.chinY * 0.48] };
    const neck = fr.neck ?? { centerX: W / 2, halfWidth: W * 0.27 };
    return {
      center: [(e.center[0] - W / 2) / H, (H / 2 - e.center[1]) / H],
      radius: [e.radius[0] / H, e.radius[1] / H],
      neckX: (neck.centerX - W / 2) / H,
      neckTop: (H / 2 - fr.chinY) / H,
      neckBottom: (H / 2 - Math.min(H, fr.neckFade?.[1] ?? H)) / H - 0.04,
      neckHalfWidth: neck.halfWidth / H,
      depth: (p.rig.depth?.inflateRadius ?? 0.3 * H) / H,
      outline: this._worldOutline(p.visibleOutline ?? p.outline),
      jaw: jawFromLandmarks(p.landmarks, W, H),
    };
  }

  /** Plate-px outline [x,y,...] -> world units. */
  _worldOutline(o) {
    const W = this.pack.plate.width, H = this.pack.plate.height;
    return Float32Array.from(o, (v, i) => (i % 2 === 0 ? (v - W / 2) / H : (H / 2 - v) / H));
  }

  /** Outline of the visibly lit head (world, rest pose) for hitTest. */
  hitPolygon() {
    return this._worldOutline(this.pack.visibleOutline ?? this.pack.outline);
  }

  /** What load() measured: the irises as located on the plate (px) and the refined mesh. */
  info() {
    return { iris: this.iris ? structuredClone(this.iris) : null, irisLayer: this.faceUniforms?.uIrisLayer.value === 1, mesh: this.meshStats ?? null };
  }

  /** @param {{ palette?: import('../../types.js').HeadPalette, fx?: number }} o */
  setOptions(o) {
    if (o.palette && this.faceUniforms) {
      this.faceUniforms.uColLine.value.copy(o.palette.line);
      this.faceUniforms.uColRim.value.copy(o.palette.rim);
      this.faceUniforms.uColEye.value.copy(o.palette.eye);
      this.faceUniforms.uColGrid.value.copy(o.palette.grid);
    }
    if (o.fx !== undefined) this.fx = Math.max(0, Number(o.fx) || 0);
  }

  dispose() {
    if (this.group) this.ctx.scene.remove(this.group);
    this.faceMesh?.geometry.dispose();
    this.faceMesh?.material.dispose();
    this.cavityMesh?.geometry.dispose();
    this.cavityMesh?.material.dispose();
    if (this.textures) Object.values(this.textures).forEach((t) => t.dispose());
    this.group = null;
  }
}

/**
 * The face mesh with its mouth region refined (src/avatar/heads/relief/refine.js), in the
 * mesh.json layout (positions in plate px, weights in 0..weightScale).
 * @param {any} mesh @param {any} pack
 */
export function refineFaceMesh(mesh, pack) {
  const names = Object.keys(mesh.weights);
  const attrs = { edge: { data: mesh.edge, size: 1 }, face: { data: mesh.face, size: 1 } };
  for (const k of names) attrs[`w:${k}`] = { data: mesh.weights[k], size: 1 };
  const r = refineMesh({ positions: mesh.positions, indices: mesh.indices, attrs }, { inside: mouthRegion(pack), maxLen: 6, levels: 3 });
  const weights = {};
  for (const k of names) weights[k] = r.attrs[`w:${k}`];
  return {
    ...mesh, vertexCount: r.vertexCount, positions: r.positions, indices: r.indices, edge: r.attrs.edge, face: r.attrs.face, weights,
  };
}

/**
 * The mouth cavity refined the same way (its teeth and interior follow the lips' fine rig).
 * @param {any} c mesh.cavity
 */
export function refineCavity(c) {
  const names = Object.keys(c.weights || {});
  const attrs = { uv: { data: c.uvs, size: 2 }, layer: { data: c.layer, size: 1 } };
  for (const k of names) attrs[`w:${k}`] = { data: c.weights[k], size: 1 };
  const r = refineMesh({ positions: c.positions, indices: c.indices, attrs }, { inside: () => true, maxLen: 8, levels: 2 });
  const weights = {};
  for (const k of names) weights[k] = r.attrs[`w:${k}`];
  return { ...c, vertexCount: r.vertexCount, positions: r.positions, indices: r.indices, uvs: r.attrs.uv, layer: r.attrs.layer, weights };
}

/**
 * Jaw line as a half ellipse (world units) through both jaw angles and the chin, for the
 * particle collar. @returns {{center:[number,number], radius:[number,number]}|undefined}
 */
export function jawFromLandmarks(lm, W, H) {
  const l = lm?.jawAngleL, r = lm?.jawAngleR, c = lm?.chin;
  if (!l || !r || !c) return undefined;
  const cy = 0.5 * (l[1] + r[1]);
  return {
    center: [(0.5 * (l[0] + r[0]) - W / 2) / H, (H / 2 - cy) / H],
    radius: [Math.max(1, 0.5 * (r[0] - l[0])) / H, Math.max(1, c[1] - cy) / H],
  };
}

/**
 * How much of the teeth the parted lips reveal (the dark interior always shows through the
 * opening): jaw and wide visemes bare the teeth, a rounded O / U pucker mostly does not.
 * @param {AnimState} a
 */
export function cavityTeeth(a) {
  const open = Math.max(a.jawOpen, a.mouthWide * 0.5, a.mouthRound * 0.06, a.mouthTeeth ?? 0, (a.mouthTuck ?? 0) * 0.8);
  // rounded lips cover the teeth more; pressed lips hide them
  return open * (1 - 0.4 * a.mouthRound * (1 - (a.mouthTeeth ?? 0))) * (1 - (a.mouthPress ?? 0));
}

/**
 * Vertical distance (plate px, + = below) of each vertex from the closed-mouth slit polyline.
 * @param {ArrayLike<number>} positions xyz per vertex (plate px) @param {number} n
 * @param {ArrayLike<number>} slit [x0, y0, x1, y1, ...] @returns {Float32Array}
 */
export function slitDistances(positions, n, slit) {
  const sx = [], sy = [];
  for (let i = 0; i + 1 < slit.length; i += 2) { sx.push(slit[i]); sy.push(slit[i + 1]); }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = positions[i * 3 + 1] - interp(positions[i * 3], sx, sy);
  return out;
}

/** 1x1 masks_c stand-in for packs without one: no lid coordinate, full occlusion. */
function fallbackMaskC(THREE) {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    }
  }
  return ys[ys.length - 1];
}
