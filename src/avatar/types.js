// Shared JSDoc typedefs for the avatar module (no runtime code besides an empty export).

/**
 * Options accepted by createAvatar() and (partially) avatar.setOptions().
 * @typedef {Object} AvatarOptions
 * @property {'relief'|'procedural'|'placeholder'} [renderer]  head to load (falls back relief -> procedural -> placeholder)
 * @property {string} [packUrl]       relief pack folder URL (default './assets/avatars/reference/')
 * @property {string} [assetsBase]    shared assets base URL (default './assets/')
 * @property {'low'|'medium'|'high'} [quality]
 * @property {number} [particles]     particle density multiplier 0..2
 * @property {number} [bloom]         bloom strength multiplier 0..2
 * @property {number} [seed]          deterministic particles / noise / blinks
 * @property {number} [fixedTime]     freeze the clock at this time (seconds) -> deterministic renders
 * @property {boolean} [transparent]  true: premultiplied black->alpha output (desktop overlay); false: opaque black
 * @property {number} [opacity]       0..1 how much the head occludes the desktop when transparent (default 0.94)
 * @property {number} [idleMotion]    idle sway / saccade amount (default 1, 0 for visual diffs)
 * @property {number} [expressiveness] 0..2 how much speech moves the head, brows and face (default 1;
 *           settings avatar.expressiveness)
 * @property {number} [liveliness]    0..2 how much spontaneous behaviour (look-arounds, posture shifts, small
 *           gestures; default 1, 0 = none; settings avatar.liveliness; src/avatar/behavior.js)
 * @property {boolean} [projector]    a projector's cone of light under the bust (default false; settings avatar.projector)
 * @property {number} [zoom]          camera zoom (default 1)
 * @property {Record<string,string>} [colors]  palette overrides: eye, line, rim, grid, wisp, mote (hex)
 * @property {boolean} [autoStart]    start the render loop (default true)
 * @property {boolean} [autoQuality]  step quality down one tier after ~3 s below 24 fps (default
 *           true, false with fixedTime)
 */

/**
 * Normalised palette handed to heads (THREE.Color instances, linear-sRGB working space).
 * @typedef {Object} HeadPalette
 * @property {import('three').Color} eye
 * @property {import('three').Color} line
 * @property {import('three').Color} rim
 * @property {import('three').Color} grid
 * @property {import('three').Color} wisp
 * @property {import('three').Color} mote
 */

/**
 * Context passed to every Head constructor (contract §5.2).
 * @typedef {Object} HeadContext
 * @property {typeof import('three')} THREE       the shared three.js namespace (do not import a second copy)
 * @property {import('three').WebGLRenderer} renderer
 * @property {import('three').Scene} scene         add your meshes here in load(); remove them in dispose()
 * @property {import('three').Camera} camera      current camera (the stage may swap it after framing())
 * @property {Required<AvatarOptions>} options    normalised options (quality, seed, packUrl, ...)
 * @property {string} assetsBase                  e.g. './assets/' (always ends with '/'); models live in assetsBase + 'models/'
 * @property {string} packUrl                     relief pack URL (always ends with '/')
 * @property {HeadPalette} palette
 * @property {'low'|'medium'|'high'} quality
 * @property {import('./quality.js').QualityTier} tier
 * @property {number} seed
 * @property {(url: string, opts?: { srgb?: boolean }) => Promise<import('three').Texture>} loadTexture
 *           resolves relative URLs against the document; srgb (default true) sets the colour space
 * @property {(url: string) => Promise<any>} loadJSON
 * @property {AbortSignal} signal                 aborted when the avatar is disposed during loading
 */

/**
 * Head interface (contract §5.2). Required: constructor(ctx), load(), update(), framing(), dispose().
 * Optional extras used by the engine when present:
 *   particleAnchors(): import('./fx/particles.js').ParticleAnchors   where the aura should wrap
 *   hitPolygon(): Float32Array    outline [x0,y0,x1,y1,...] in world units (rest pose) for hitTest
 *   setOptions(o): void           runtime option changes ({ palette, quality, tier, ... })
 *   name: string
 * Rendering conventions: draw into the scene with premultiplied-alpha output (alpha = coverage),
 * write depth for opaque-ish parts so the particle aura is occluded correctly, keep values linear
 * (the post pass encodes sRGB). The stage clears to transparent black.
 * @typedef {Object} Head
 * @property {() => Promise<void>} load
 * @property {(dt:number, time:number, a:import('./director.js').AnimState) => void} update
 * @property {() => import('./stage.js').Framing} framing
 * @property {() => void} dispose
 */

export {};
