// Stage: WebGL renderer, camera framing, resize handling and the render loop.

import * as THREE from 'three';
import { DPR_STEP, QUALITY, normalizeQuality } from './quality.js';

/**
 * Camera framing requested by a head.
 * @typedef {Object} Framing
 * @property {[number,number,number]} center  world point at the centre of the view
 * @property {number} height                   world height that must fit the view
 * @property {number} [width]                  world width that must fit (optional)
 * @property {'perspective'|'orthographic'} [projection]  default 'perspective'
 * @property {number} [fov]                    vertical fov in degrees (perspective), default 20
 */

/**
 * Largest simulation step per frame. Below 1/MAX_DT fps the animation slows down instead of
 * jumping; 1/8 s keeps blinks and lip-sync close to real time on slow (software / iGPU)
 * renderers. Every consumer integrates or smooths stably at this step.
 */
export const MAX_DT = 1 / 8;

/**
 * Detach three.js' internal 'dispose' listeners from GL resources created before a WebGL context
 * loss. After the context is restored the renderer re-creates its resource managers and
 * re-registers fresh listeners on first use, but the stale ones stay attached: disposing the
 * avatar later would make them delete objects of the LOST context ("WebGL: INVALID_OPERATION:
 * delete: object does not belong to this context"). Their GL objects died with the old context
 * anyway, so forgetting them is exactly right. Only three.js adds 'dispose' listeners to these.
 * @param {Iterable<any>} objects textures, geometries, materials, render targets
 * @returns {number} how many objects had listeners removed
 */
export function forgetDisposeListeners(objects) {
  let n = 0;
  for (const o of objects) {
    const l = o?._listeners;
    if (l && l.dispose && l.dispose.length) {
      l.dispose.length = 0;
      n++;
    }
  }
  return n;
}

/** Every geometry, material and uniform texture under `root` (for forgetDisposeListeners). */
export function collectGLResources(root, out = new Set()) {
  root.traverse?.((obj) => {
    if (obj.geometry) out.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      out.add(m);
      for (const u of Object.values(m.uniforms ?? {})) if (u?.value?.isTexture) out.add(u.value);
      for (const k of ['map', 'alphaMap']) if (m[k]?.isTexture) out.add(m[k]);
    }
  });
  return out;
}

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ quality?: string, fixedTime?: number, zoom?: number,
   *   onUpdate?: (dt:number, time:number, settle:boolean) => void,
   *   onRender?: () => void, onResize?: (w:number, h:number, pr:number) => void,
   *   onContextLost?: () => void, onContextRestored?: () => void }} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.quality = normalizeQuality(opts.quality);
    this.tier = QUALITY[this.quality];
    this.fixedTime = Number.isFinite(opts.fixedTime) ? Number(opts.fixedTime) : undefined;
    this.zoom = opts.zoom ?? 1;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,          // MSAA happens in the scene render target (see fx/post.js)
      depth: false,              // the default framebuffer only receives the final full-screen pass
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    // Shaders do their own colour management (linear in, sRGB encode in the final pass).
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.perspective = new THREE.PerspectiveCamera(20, 1, 0.01, 100);
    this.ortho = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.01, 100);
    /** @type {THREE.Camera} */
    this.camera = this.perspective;
    /** @type {Framing} */
    this.framing = { center: [0, 0, 0], height: 1, projection: 'perspective', fov: 20 };

    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    /** the tier's pixel ratio cap x this (the auto quality's first step down: DPR_STEP) */
    this.dprScale = 1;
    this.time = this.fixedTime ?? 0;
    this.frame = 0;
    this._raf = 0;
    this._running = false;
    this._dirty = true;
    this._last = -1;
    this._fps = 0;
    /** the shortest frame interval lately (ms): the display's refresh (frames come no faster) */
    this._vsyncMs = Infinity;
    this._frameMs = 0;
    this._lostContext = false;
    this._info = { calls: 0, triangles: 0, points: 0, lines: 0 };

    this._tick = this._tick.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onLost = (e) => {
      e.preventDefault();
      this._lostContext = true;
      this._cancel();
      console.warn('[avatar] WebGL context lost — pausing');
      this.opts.onContextLost?.();
    };
    this._onRestored = () => {
      this._lostContext = false;
      console.warn('[avatar] WebGL context restored');
      this.opts.onContextRestored?.();
      this.resize(true);
      this._dirty = true;
      if (this._running) this._schedule();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);

    this._ro = null;
    const RO = globalThis.ResizeObserver;
    if (typeof RO === 'function') {
      this._ro = new RO(() => this.resize());
      this._ro.observe(canvas);
    } else if (typeof window !== 'undefined') {
      this._onWinResize = () => this.resize();
      window.addEventListener('resize', this._onWinResize);
    }
    this.resize(true);
  }

  /** @param {Framing} f */
  setFraming(f) {
    this.framing = { projection: 'perspective', fov: 20, ...f };
    this.camera = this.framing.projection === 'orthographic' ? this.ortho : this.perspective;
    this._updateCamera();
    this._dirty = true;
  }

  /** @param {string} q */
  setQuality(q) {
    this.quality = normalizeQuality(q);
    this.tier = QUALITY[this.quality];
    this.dprScale = 1;
    this.resize(true);
  }

  /** The device pixel ratio the tier allows (x dprScale). @param {number} [scale] */
  _ratioFor(scale = this.dprScale) {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(dpr, this.tier.dprCap * scale);
  }

  /** The auto quality can still lower this tier's resolution (by at least a tenth). */
  canStepDpr() {
    return this.dprScale === 1 && this._ratioFor(DPR_STEP) < 0.9 * this._ratioFor(1);
  }

  /** Render at the tier's pixel ratio cap x `k` (1 = the tier's own). @param {number} k */
  setDprScale(k) {
    this.dprScale = Math.min(1, Math.max(0.25, Number(k) || 1));
    this.resize(true);
  }

  /** The display's refresh rate as the frame loop sees it (Hz; 60 before it knows). */
  get refreshHz() {
    return Number.isFinite(this._vsyncMs) && this._vsyncMs > 0 ? 1000 / this._vsyncMs : 60;
  }

  setZoom(z) {
    this.zoom = Math.max(0.2, Number(z) || 1);
    this._updateCamera();
    this._dirty = true;
  }

  /** Re-read the canvas size (CSS pixels) and update the backing store + camera. */
  resize(force = false) {
    const c = this.canvas;
    let w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) { w = c.width || 300; h = c.height || 450; }
    const pr = this._ratioFor();
    if (!force && w === this.width && h === this.height && pr === this.pixelRatio) return;
    this.width = w; this.height = h; this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this._updateCamera();
    this.opts.onResize?.(Math.round(w * pr), Math.round(h * pr), pr);
    this._dirty = true;
  }

  _updateCamera() {
    const f = this.framing;
    const aspect = this.width / this.height;
    const contentAspect = f.width ? f.width / f.height : aspect;
    let viewH = aspect < contentAspect ? f.width / aspect : f.height;
    viewH /= this.zoom;
    const [cx, cy, cz] = f.center;
    if (f.projection === 'orthographic') {
      const o = this.ortho;
      o.left = (-viewH * aspect) / 2; o.right = (viewH * aspect) / 2;
      o.top = viewH / 2; o.bottom = -viewH / 2;
      o.near = 0.01; o.far = 20;
      o.position.set(cx, cy, cz + 5);
      o.lookAt(cx, cy, cz);
      o.updateProjectionMatrix();
    } else {
      const p = this.perspective;
      p.fov = f.fov ?? 20;
      p.aspect = aspect;
      const dist = viewH / 2 / Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
      p.near = Math.max(0.01, dist * 0.05);
      p.far = dist * 20;
      p.position.set(cx, cy, cz + dist);
      p.lookAt(cx, cy, cz);
      p.updateProjectionMatrix();
    }
    this.viewHeight = viewH;
  }

  /** Smoothed frame rate of the live loop (0 before the second frame). */
  get fps() { return this._fps; }

  /** World units -> device pixels scale at the focal plane. */
  get pixelsPerUnit() {
    return (this.height * this.pixelRatio) / (this.viewHeight || 1);
  }

  start() {
    this._running = true;
    this._last = -1;
    this._schedule();
  }

  stop() {
    this._running = false;
    this._cancel();
  }

  requestRender() { this._dirty = true; }

  /**
   * Render a single frame at `time` (seconds), synchronously. Deterministic (settled director).
   * @param {number} time
   */
  renderOnce(time) {
    this.time = Number(time) || 0;
    this._frame(0, true);
  }

  _schedule() {
    if (this._raf || this._lostContext) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  _cancel() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick(now) {
    this._raf = 0;
    if (!this._running) return;
    if (this.fixedTime !== undefined) {
      this.time = this.fixedTime;
      if (this._dirty) this._frame(0, true);
    } else {
      const dt = this._last < 0 ? 1 / 60 : Math.min(MAX_DT, Math.max(0, (now - this._last) / 1000));
      if (this._last >= 0) {
        const ms = now - this._last;
        const inst = ms > 0 ? 1000 / ms : 60;
        this._fps = this._fps ? this._fps * 0.92 + inst * 0.08 : inst;
        // (forgets slowly: a few seconds without a fast frame and it trusts the slower ones)
        if (ms > 3 && ms < 100) this._vsyncMs = Math.min(this._vsyncMs * 1.002, ms);
      }
      this._last = now;
      this.time += dt;
      this._frame(dt, false);
    }
    this._schedule();
  }

  _frame(dt, settle) {
    if (this._lostContext) return;
    const t0 = performance.now();
    this._dirty = false;
    this.renderer.info.reset();
    this.opts.onUpdate?.(dt, this.time, settle);
    this.opts.onRender?.();
    const r = this.renderer.info.render;
    this._info.calls = r.calls; this._info.triangles = r.triangles; this._info.points = r.points; this._info.lines = r.lines;
    this._frameMs = this._frameMs ? this._frameMs * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
    this.frame++;
  }

  _onVisibility() {
    if (document.hidden) {
      this._cancel();
    } else if (this._running) {
      this._last = -1;    // avoid a dt spike after the pause
      this._schedule();
    }
  }

  /** Performance counters for perf checks (renderer.info of the last frame). */
  stats() {
    const mem = this.renderer.info.memory;
    return {
      fps: Math.round(this._fps * 10) / 10,
      cpuFrameMs: Math.round(this._frameMs * 100) / 100,
      frame: this.frame,
      drawCalls: this._info.calls,
      triangles: this._info.triangles,
      points: this._info.points,
      geometries: mem.geometries,
      textures: mem.textures,
      width: Math.round(this.width * this.pixelRatio),
      height: Math.round(this.height * this.pixelRatio),
      pixelRatio: this.pixelRatio,
      quality: this.quality,
    };
  }

  dispose() {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    this._ro?.disconnect();
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this.renderer.dispose();
  }
}
