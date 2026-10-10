// Owns the avatar canvas: creates the hologram with createAvatar(), re-creates it when the
// renderer or pack changes (on a fresh canvas: a canvas keeps its first WebGL context forever),
// forwards runtime options, and falls back to a CSS "orb" plus a no-op avatar when WebGL is
// unavailable, so the rest of the app keeps working.

import { createAvatar as defaultCreateAvatar } from '../avatar/index.js';

/** A stand-in with the avatar API (no rendering; hit-test = a head-shaped ellipse). */
export function createNullAvatar(stage) {
  let state = 'idle';
  return {
    renderer: 'none',
    get state() { return state; },
    setState(s) {
      state = s;
      stage?.setAttribute?.('data-avatar-state', s);
    },
    setMouth() {},
    setSpeechLevel(l) { stage?.style?.setProperty?.('--speech', String(Math.round((Number(l) || 0) * 100) / 100)); },
    setExpression() {},
    setUser() {},
    blink() {},
    lookAt() {},
    setOptions() {},
    hitTest(x, y) {
      const r = stage?.getBoundingClientRect?.();
      if (!r || !r.width) return false;
      const nx = (x - (r.left + r.width * 0.5)) / (r.width * 0.3);
      const ny = (y - (r.top + r.height * 0.42)) / (r.height * 0.36);
      return nx * nx + ny * ny <= 1;
    },
    renderOnce() {},
    nextFrame: () => Promise.resolve(),
    stats: () => ({ renderer: 'none' }),
    animState: () => ({}),
    dispose() {},
  };
}

/** @param {{ pack?: string }} av */
export function packUrlFor(av) {
  const pack = /^[A-Za-z0-9_-]+$/.test(av?.pack || '') ? av.pack : 'reference';
  return `./assets/avatars/${pack}/`;
}

export class AvatarHost {
  /**
   * @param {HTMLElement} stage   element that holds the canvas
   * @param {object} [o]
   * @param {typeof defaultCreateAvatar} [o.createAvatar]
   * @param {(avatar: any) => void} [o.onCreated]
   * @param {() => void} [o.onCreating]   a (re)creation started; the stand-in is active meanwhile
   * @param {(err: Error) => void} [o.onError]
   * @param {Record<string, any>} [o.extraOptions]  e.g. { seed } for tests
   */
  constructor(stage, o = {}) {
    this.stage = stage;
    this._create = o.createAvatar || defaultCreateAvatar;
    this.onCreated = o.onCreated || (() => {});
    this.onCreating = o.onCreating || (() => {});
    this.onError = o.onError || (() => {});
    this.extra = o.extraOptions || {};
    this.api = null;
    this.nullAvatar = createNullAvatar(stage);
    /** @type {HTMLCanvasElement|null} */
    this.canvas = stage.querySelector('canvas');
    this._built = null;
    this._target = null;
    this._running = null;
    this.generation = 0;
  }

  /** The current avatar (or the no-op stand-in). */
  get avatar() {
    return this.api || this.nullAvatar;
  }

  /**
   * Bring the avatar in line with settings.avatar (create / re-create / setOptions).
   * Calls are coalesced: only the latest settings are applied once a creation finishes.
   * @param {{ renderer: string, pack: string, quality: string, particles: number, bloom: number, expressiveness?: number, liveliness?: number, projector?: boolean }} av
   */
  apply(av) {
    this._target = { ...av };
    if (!this._running) this._running = this._loop().finally(() => { this._running = null; });
    return this._running;
  }

  async _loop() {
    for (;;) {
      const want = this._target;
      const b = this._built;
      if (!b || want.renderer !== b.renderer || want.pack !== b.pack) {
        await this._recreate(want);
      } else if (this.api && (want.quality !== b.quality || want.particles !== b.particles || want.bloom !== b.bloom
        || want.expressiveness !== b.expressiveness || want.liveliness !== b.liveliness || want.projector !== b.projector)) {
        try {
          this.api.setOptions({ quality: want.quality, particles: want.particles, bloom: want.bloom, expressiveness: want.expressiveness, liveliness: want.liveliness, projector: want.projector });
        } catch (err) {
          console.warn('[avatar-host] setOptions failed', err);
        }
        this._built = { ...want };
      }
      if (this._target === want) return;
    }
  }

  /** @param {any} want */
  async _recreate(want) {
    this._disposeCurrent();
    this.onCreating();
    const canvas = document.createElement('canvas');
    canvas.id = 'avatar';
    canvas.className = 'avatar-canvas';
    canvas.setAttribute('aria-label', 'Claude hologram avatar');
    canvas.setAttribute('role', 'img');
    this.stage.prepend(canvas);
    this.canvas = canvas;
    const gen = ++this.generation;
    try {
      const api = await this._create(canvas, {
        renderer: want.renderer,
        packUrl: packUrlFor(want),
        quality: want.quality,
        particles: want.particles,
        bloom: want.bloom,
        expressiveness: want.expressiveness,
        liveliness: want.liveliness,
        projector: want.projector,
        transparent: true,
        ...this.extra,
      });
      if (gen !== this.generation) {
        api.dispose();
        return;
      }
      this.api = api;
      this.stage.classList.remove('no-webgl');
      this._built = { ...want };
      this.onCreated(api);
    } catch (err) {
      console.error('[avatar-host] the avatar could not be created', err);
      canvas.remove();
      this.canvas = null;
      this.api = null;
      this.stage.classList.add('no-webgl');
      this._built = { ...want };
      this.onCreated(this.nullAvatar);
      this.onError(/** @type {Error} */ (err));
    }
  }

  _disposeCurrent() {
    const api = this.api;
    const old = this.canvas;
    this.api = null;
    if (api) {
      try {
        api.dispose();
      } catch (err) {
        console.warn('[avatar-host] dispose failed', err);
      }
    }
    if (old) {
      // Free the GPU context right away instead of waiting for garbage collection. Only for a
      // canvas that really has one (getContext would otherwise create a context).
      if (api) {
        try {
          const gl = /** @type {WebGL2RenderingContext|null} */ (old.getContext('webgl2'));
          gl?.getExtension('WEBGL_lose_context')?.loseContext();
        } catch { /* ignore */ }
      }
      old.remove();
    }
    this.canvas = null;
  }

  dispose() {
    this.generation++;
    this._disposeCurrent();
  }
}
