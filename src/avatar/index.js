// Public avatar API (contract §5.1): createAvatar(canvas, options) -> avatar.

import * as THREE from 'three';
import { ANIM_KEYS, Director, STATES } from './director.js';
import { Particles } from './fx/particles.js';
import { Post } from './fx/post.js';
import { withSlash } from './pack.js';
import { mergePalette } from './palette.js';
import { QUALITY, QualityGovernor, normalizeQuality } from './quality.js';
import { Stage, collectGLResources, forgetDisposeListeners } from './stage.js';

/** @typedef {import('./types.js').AvatarOptions} AvatarOptions */
/** @typedef {import('./types.js').HeadContext} HeadContext */
/** @typedef {import('./director.js').AnimState} AnimState */

/**
 * Head modules, loaded on demand (code-split). A glob keeps the build working while a head
 * (e.g. the procedural one, owned by another lane) does not exist yet: missing heads simply
 * fall through to the next one in FALLBACK_ORDER.
 */
const HEAD_MODULES = import.meta.glob('./heads/*/index.js');
export const HEAD_NAMES = /** @type {const} */ (['relief', 'procedural', 'placeholder']);
const FALLBACK_ORDER = HEAD_NAMES;

/** @param {string} name */
function headLoader(name) {
  const load = HEAD_MODULES[`./heads/${name}/index.js`];
  if (!load) return () => Promise.reject(new Error(`head module "${name}" is not available in this build`));
  return /** @type {() => Promise<any>} */ (load);
}

/** @param {AvatarOptions} o @returns {Required<AvatarOptions>} */
export function normalizeOptions(o = {}) {
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const renderer = /** @type {any} */ (HEAD_NAMES.includes(o.renderer) ? o.renderer : 'relief');
  return {
    renderer,
    packUrl: withSlash(o.packUrl || './assets/avatars/reference/'),
    assetsBase: withSlash(o.assetsBase || './assets/'),
    quality: normalizeQuality(o.quality),
    particles: num(o.particles, 1, 0, 2),
    bloom: num(o.bloom, 1, 0, 2),
    seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) | 0 : 1,
    fixedTime: Number.isFinite(o.fixedTime) ? Number(o.fixedTime) : undefined,
    transparent: o.transparent !== false,
    opacity: num(o.opacity, 0.88, 0, 1),
    idleMotion: num(o.idleMotion, 1, 0, 3),
    zoom: num(o.zoom, 1, 0.2, 5),
    colors: o.colors && typeof o.colors === 'object' ? { ...o.colors } : {},
    autoStart: o.autoStart !== false,
    // frozen-time renders are for tests / visual diffs: never change quality under them
    autoQuality: o.autoQuality !== undefined ? !!o.autoQuality : !Number.isFinite(o.fixedTime),
  };
}

/** Soft limit (|result| < max, ~identity for small values). @param {number} v @param {number} max */
export function softLimit(v, max) {
  return max > 0 ? max * Math.tanh(v / max) : v;
}

/**
 * Keep the director's head rotation inside what the head can show (relief: a 2.5D card).
 * @param {import('./director.js').AnimState} a mutated
 * @param {{ yaw?: number, pitch?: number, roll?: number }|null|undefined} lim
 */
export function limitHeadMotion(a, lim) {
  if (!lim) return a;
  if (lim.yaw) a.headYaw = softLimit(a.headYaw, lim.yaw);
  if (lim.pitch) a.headPitch = softLimit(a.headPitch, lim.pitch);
  if (lim.roll) a.headRoll = softLimit(a.headRoll, lim.roll);
  return a;
}

/** Even-odd point in polygon test on a flat [x0,y0,x1,y1,...] array. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function toColors(hex) {
  const out = {};
  for (const [k, v] of Object.entries(hex)) out[k] = new THREE.Color(v); // sRGB hex -> linear working space
  return /** @type {import('./types.js').HeadPalette} */ (out);
}

/**
 * Create the hologram avatar on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {AvatarOptions} [options]
 */
export async function createAvatar(canvas, options = {}) {
  const opts = normalizeOptions(options);
  const abort = new AbortController();
  let disposed = false;
  /** @type {Partial<AnimState>} */
  let overrides = {};

  const director = new Director({ seed: opts.seed, idleMotion: opts.idleMotion });
  const governor = new QualityGovernor();
  let motionLimits = null;
  let head = /** @type {any} */ (null);
  let headName = '';
  let packPalette = null;
  let particles = /** @type {Particles|null} */ (null);
  let post = /** @type {Post|null} */ (null);
  /** @type {Array<() => void>} */
  const frameWaiters = [];

  // advance(): a scripted clock (deterministic speech renders); its frames must not settle
  let live = false;
  /** @param {number} dt @param {number} time @param {boolean} settle */
  function update(dt, time, settle) {
    const a = limitHeadMotion(director.update(dt, time, { settle }), motionLimits);
    for (const k in overrides) a[k] = overrides[k];
    if (opts.autoQuality && !settle && dt > 0) {
      const next = governor.sample(performance.now() / 1000, stage.fps, stage.quality);
      if (next) {
        console.warn(`[avatar] sustained ${Math.round(stage.fps)} fps: lowering quality ${stage.quality} -> ${next}`);
        applyQuality(next);
      }
    }
    head?.update(dt, time, a);
    particles?.update(dt, time, a);
    post?.update(a);
  }

  const stage = new Stage(canvas, {
    quality: opts.quality,
    fixedTime: opts.fixedTime,
    zoom: opts.zoom,
    onUpdate: (dt, time, settle) => update(dt, time, settle && !live),
    onRender: () => {
      post?.render(stage.scene, stage.camera);
      while (frameWaiters.length) frameWaiters.shift()();
    },
    onResize: (w, h) => {
      post?.setSize(w, h);
      syncParticleView();
    },
    onContextLost: () => {
      // GL objects of the lost context must never be deleted later (see forgetDisposeListeners)
      const res = collectGLResources(stage.scene);
      if (post) for (const o of post.glResources()) res.add(o);
      forgetDisposeListeners(res);
    },
    onContextRestored: () => governor.reset(performance.now() / 1000),
  });

  const tier = () => QUALITY[stage.quality];
  post = new Post(stage.renderer, { tier: tier(), bloom: opts.bloom, transparent: opts.transparent, opacity: opts.opacity });
  post.setSize(Math.round(stage.width * stage.pixelRatio), Math.round(stage.height * stage.pixelRatio));

  const texLoader = new THREE.TextureLoader();
  /** @type {HeadContext} */
  const ctx = {
    THREE,
    renderer: stage.renderer,
    scene: stage.scene,
    get camera() { return stage.camera; },
    options: opts,
    assetsBase: opts.assetsBase,
    packUrl: opts.packUrl,
    palette: toColors(mergePalette(undefined, opts.colors)),
    quality: stage.quality,
    get tier() { return tier(); },
    seed: opts.seed,
    loadTexture: (url, o = {}) => new Promise((resolve, reject) => {
      texLoader.load(url, (t) => {
        t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        resolve(t);
      }, undefined, () => reject(new Error(`failed to load texture ${url}`)));
    }),
    loadJSON: async (url) => {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.json();
    },
    signal: abort.signal,
  };

  // relief needs the pack palette before the head is built (particles use it too)
  if (opts.renderer === 'relief') {
    try {
      const pj = await ctx.loadJSON(`${opts.packUrl}pack.json`);
      packPalette = pj.palette;
      ctx.palette = toColors(mergePalette(packPalette, opts.colors));
    } catch { /* the head load below reports the real error */ }
  }

  /**
   * Compile the scene now (instead of on the first frame) so a head with a broken shader is
   * detected here and the fallback chain can kick in. Returns an error string or ''.
   */
  function compileCheck() {
    const r = stage.renderer;
    let err = '';
    const prev = r.debug.onShaderError;
    r.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs), gl.getProgramInfoLog(program)]
        .filter(Boolean).join(' ').trim();
      err = err || log.split('\n').slice(0, 3).join(' ') || 'unknown shader error';
    };
    try {
      r.compile(stage.scene, stage.camera);
    } catch (e) {
      err = err || String(e?.message || e);
    } finally {
      r.debug.onShaderError = prev ?? null;
    }
    return err;
  }

  async function loadHead(name) {
    const order = FALLBACK_ORDER.slice(FALLBACK_ORDER.indexOf(name));
    if (!order.length) order.push('placeholder');
    let lastErr = null;
    for (const n of order) {
      try {
        const mod = await headLoader(n)();
        const Head = mod.default;
        if (typeof Head !== 'function') throw new Error(`head "${n}" has no default export`);
        const h = new Head(ctx);
        try {
          await h.load();
          if (disposed) throw new Error('avatar disposed during load');
          const shaderErr = compileCheck();
          if (shaderErr) throw new Error(`shader compilation failed: ${shaderErr}`);
        } catch (e) {
          try { h.dispose(); } catch { /* half-loaded head: best effort */ }
          throw e;
        }
        if (n !== name) console.warn(`[avatar] using "${n}" head (requested "${name}")`);
        return { h, n };
      } catch (e) {
        lastErr = e;
        if (disposed) throw e;
        console.warn(`[avatar] head "${n}" failed to load: ${e?.message || e}`);
      }
    }
    throw lastErr || new Error('no head could be loaded');
  }

  try {
    ({ h: head, n: headName } = await loadHead(opts.renderer));
  } catch (e) {
    // nothing could be shown: release the WebGL context before reporting
    post.dispose();
    stage.dispose();
    throw e;
  }
  stage.setFraming(head.framing());
  motionLimits = head.motionLimits?.() ?? null;

  const baseCount = () => Math.round(tier().particles * opts.particles);
  particles = new Particles({
    maxCount: QUALITY.high.particles * 2,
    count: baseCount(),
    seed: opts.seed,
    palette: ctx.palette,
  });
  particles.setAnchors(head.particleAnchors?.() ?? defaultAnchors(head.framing()));
  stage.scene.add(particles.points);
  let particlesOk = true;
  {
    // the aura is decoration: if its shader cannot compile on this GPU, run without it
    const err = compileCheck();
    if (err) {
      console.warn(`[avatar] particles disabled: ${err}`);
      stage.scene.remove(particles.points);
      particles.setCount(0);
      particlesOk = false;
    }
  }

  function syncParticleView() {
    if (!particles) return;
    const vh = stage.viewHeight || 1;
    particles.setView(vh * (stage.width / stage.height), vh, stage.height * stage.pixelRatio);
  }
  syncParticleView();

  let hitPoly = head.hitPolygon?.() ?? null;
  const _v = new THREE.Vector3();

  /** @param {string} q */
  function applyQuality(q) {
    if (normalizeQuality(q) === stage.quality) return;
    stage.setQuality(q);
    post.setTier(tier());
    post.setSize(Math.round(stage.width * stage.pixelRatio), Math.round(stage.height * stage.pixelRatio));
    ctx.quality = stage.quality;
    head.setOptions?.({ quality: stage.quality, tier: tier() });
    if (particlesOk) particles.setCount(baseCount());
    syncParticleView();
    governor.reset(performance.now() / 1000);
  }

  const api = {
    /** Name of the head actually in use (after fallbacks). */
    get renderer() { return headName; },
    get state() { return director.state; },
    /** @param {import('./director.js').AvatarState} s */
    setState(s) { director.setState(s); stage.requestRender(); },
    /**
     * Lip-sync target, 0..1 each; missing fields mean 0.
     * @param {{jaw?:number, wide?:number, round?:number, press?:number, tuck?:number, teeth?:number, tongue?:number}} m
     */
    setMouth(m) { director.setMouth(m); stage.requestRender(); },
    /**
     * Speech prosody cue(s) from the lip-sync (nods, brow raises, phrase-end blinks, smiles).
     * @param {import('./director.js').ProsodyCue|import('./director.js').ProsodyCue[]} cue
     */
    setProsody(cue) { director.setProsody(cue); stage.requestRender(); },
    /** @param {number} level */
    setSpeechLevel(level) { director.setSpeechLevel(level); stage.requestRender(); },
    /** @param {{smile?:number, browUp?:number}} e */
    setExpression(e) { director.setExpression(e); stage.requestRender(); },
    blink() { director.blink(); stage.requestRender(); },
    /** @param {number|null} x @param {number} [y] */
    lookAt(x, y) { director.lookAt(x, y); stage.requestRender(); },
    /** @param {Partial<AvatarOptions>} p */
    setOptions(p = {}) {
      if (p.quality !== undefined) applyQuality(p.quality);
      if (p.autoQuality !== undefined) opts.autoQuality = !!p.autoQuality;
      if (p.particles !== undefined) opts.particles = Math.min(2, Math.max(0, Number(p.particles) || 0));
      if (particlesOk) particles.setCount(baseCount());
      post.setOptions({ bloom: p.bloom, transparent: p.transparent, opacity: p.opacity });
      if (p.colors) {
        opts.colors = { ...opts.colors, ...p.colors };
        ctx.palette = toColors(mergePalette(packPalette, opts.colors));
        particles.setPalette(ctx.palette);
        head.setOptions?.({ palette: ctx.palette });
      }
      if (p.idleMotion !== undefined) director.setIdleMotion(p.idleMotion);
      if (p.zoom !== undefined) { stage.setZoom(p.zoom); syncParticleView(); }
      stage.requestRender();
    },
    /**
     * True when the client point is over the visible avatar (head silhouette). Cheap: a polygon
     * test in world space, no GPU readback.
     * @param {number} clientX @param {number} clientY
     */
    hitTest(clientX, clientY) {
      if (!hitPoly) return false;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
      if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return false;
      _v.set(nx, ny, 0.5).unproject(stage.camera);
      if (stage.camera.isPerspectiveCamera) {
        // intersect the view ray with the z = 0 plane
        const o = stage.camera.position;
        const t = o.z / (o.z - _v.z);
        _v.set(o.x + (_v.x - o.x) * t, o.y + (_v.y - o.y) * t, 0);
      }
      return pointInPolygon(_v.x, _v.y, hitPoly);
    },
    /** Render a single frame at `time` seconds (deterministic). @param {number} time */
    renderOnce(time) { stage.renderOnce(time); },
    /**
     * Test / harness hook: advance the animation by `dt` seconds of a scripted clock (live
     * dynamics, not settled), optionally rendering the result. Deterministic for a seed. Use it
     * with autoStart: false so the render loop does not interleave its own frames.
     * @param {number} dt @param {{ render?: boolean }} [o]
     */
    advance(dt, o = {}) {
      const t = stage.time + Math.max(0, Number(dt) || 0);
      stage.time = t;
      update(Math.max(0, Number(dt) || 0), t, false);
      if (o.render !== false) {
        live = true;
        try { stage.renderOnce(t); } finally { live = false; }
      }
    },
    /** Resolves after the next rendered frame. */
    nextFrame() {
      return new Promise((res) => { frameWaiters.push(res); stage.requestRender(); });
    },
    /**
     * Debug/test hook: force AnimState fields after the director (e.g. {jawOpen: 0.6}).
     * Pass null to clear. Not part of the app contract.
     * @param {Partial<AnimState>|null} o
     */
    setOverrides(o) {
      overrides = {};
      if (o) for (const k of ANIM_KEYS) if (Number.isFinite(o[k])) overrides[k] = o[k];
      stage.requestRender();
    },
    /** Head-specific effect amount (relief: living effects 0..1). */
    setEffects(v) { head.setOptions?.({ fx: v }); stage.requestRender(); },
    /** Performance counters (fps, draw calls, triangles, points, ...). */
    stats() { return { ...stage.stats(), renderer: headName, particles: particles.count }; },
    /** Current AnimState (read-only snapshot). */
    animState() { return { ...director.out, ...overrides }; },
    get info() { return stage.renderer.info; },
    get canvas() { return canvas; },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      stage.stop();
      head?.dispose();
      particles?.dispose();
      post?.dispose();
      stage.dispose();
      head = null; particles = null;
    },
  };

  if (opts.fixedTime !== undefined) stage.renderOnce(opts.fixedTime);
  if (opts.autoStart) stage.start();
  return api;
}

/** @param {import('./stage.js').Framing} f @returns {import('./fx/particles.js').ParticleAnchors} */
function defaultAnchors(f) {
  const h = f.height;
  return {
    center: [f.center[0], f.center[1] + 0.08 * h], radius: [0.29 * h, 0.4 * h],
    neckX: f.center[0], neckTop: f.center[1] - 0.3 * h, neckBottom: f.center[1] - 0.52 * h,
    neckHalfWidth: 0.12 * h, depth: 0.3 * h,
  };
}

export { STATES };
export default createAvatar;
