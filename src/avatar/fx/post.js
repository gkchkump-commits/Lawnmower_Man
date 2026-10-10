// Post-processing: scene render target -> cheap dual-filter bloom -> final composite that
// outputs PREMULTIPLIED alpha derived from brightness (black = transparent desktop) or opaque black.
// The bloom chain also carries the scene's coverage (alpha) blurred: the composite lays a thin dark
// outline just outside the head with it (a few CSS px wide at any display scale), so the
// hologram's silhouette reads over a bright or busy desktop too (over a dark one it is invisible).

import * as THREE from 'three';

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Soft-knee threshold + 4-tap box downsample.
const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec4 uThreshold; // threshold, knee, 2*knee, 0.25/knee
varying vec2 vUv;
// (rgb: the bright part; alpha: the coverage, carried for the silhouette halo)
vec4 pick(vec2 uv) {
  vec4 s = texture2D(tSrc, uv);
  vec3 c = s.rgb;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold.x + uThreshold.y, 0.0, uThreshold.z);
  rq = uThreshold.w * rq * rq;
  float contrib = max(rq, br - uThreshold.x) / max(br, 1e-4);
  return vec4(c * contrib, s.a);
}
void main() {
  vec2 o = uTexel * 0.5;
  vec4 c = pick(vUv + vec2(-o.x, -o.y)) + pick(vUv + vec2(o.x, -o.y))
         + pick(vUv + vec2(-o.x, o.y)) + pick(vUv + vec2(o.x, o.y));
  gl_FragColor = vec4(min(c.rgb * 0.25, vec3(32.0)), 0.25 * c.a);
}`;

// Dual-Kawase downsample (5 taps).
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec4 c = texture2D(tSrc, vUv) * 4.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y));
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y));
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y));
  c += texture2D(tSrc, vUv + vec2(o.x, o.y));
  gl_FragColor = c / 8.0;
}`;

// Dual-Kawase upsample (8 taps) + add the finer level.
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;    // coarser level (being upsampled)
uniform sampler2D tBase;   // finer level at this resolution
uniform vec2 uTexel;       // texel of the coarser level
uniform float uRadius;
uniform float uHaloMix;    // the coverage: how much of the coarser (wider) blur this level keeps
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uRadius;
  vec4 c = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0));
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)) * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0));
  c += texture2D(tSrc, vUv + vec2(o.x, o.y)) * 2.0;
  c += texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0));
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)) * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0));
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)) * 2.0;
  vec4 base = texture2D(tBase, vUv);
  // colour: the levels add up (the glow); coverage: a weighted average (it stays 0..1)
  gl_FragColor = vec4(c.rgb / 12.0 + base.rgb, mix(base.a, c.a / 12.0, uHaloMix));
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uTransparent;
uniform float uOpacity;     // how strongly covered pixels (head) occlude the desktop
uniform float uExposure;
uniform vec2 uResolution;
uniform float uHalo;        // the silhouette halo's strength (alpha just outside the head)
uniform vec2 uGate;         // the glow a covered pixel needs to occlude the desktop (head-specific)
varying vec2 vUv;
vec3 shoulder(vec3 x) {
  // identity below 0.9, smooth roll-off above (keeps the baked plate exact, tames bloom hot spots)
  vec3 t = max(x - 0.9, 0.0);
  return min(x, vec3(0.9)) + 0.1 * (1.0 - exp(-t / 0.1));
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
void main() {
  vec4 s = texture2D(tScene, vUv);
  vec4 bl = texture2D(tBloom, vUv);
  vec3 c = s.rgb * uExposure + bl.rgb * uBloom;
  c = toSRGB(shoulder(c));
  // dithering against banding in dark glows
  c += (hash(gl_FragCoord.xy + fract(uResolution.x)) - 0.5) / 255.0;
  c = max(c, 0.0);
  if (uTransparent > 0.5) {
    // hologram = light: alpha follows brightness; covered pixels (the head) also occlude the
    // desktop, but only where they actually glow, so dark fringes / the dissolving neck don't
    // paint a dark outline on bright desktops
    float lum = max(c.r, max(c.g, c.b));
    // The "does it glow here" gate uses the neighbourhood brightness too: gated per pixel, the
    // dark gaps between the fine grid lines would let a light desktop through as speckles.
    vec2 o = 1.5 / uResolution;
    float nb = 0.25 * (maxc(texture2D(tScene, vUv + vec2(o.x, o.y)).rgb) + maxc(texture2D(tScene, vUv + vec2(-o.x, o.y)).rgb)
      + maxc(texture2D(tScene, vUv + vec2(o.x, -o.y)).rgb) + maxc(texture2D(tScene, vUv + vec2(-o.x, -o.y)).rgb));
    float glow = max(lum, toSRGB(vec3(nb * uExposure)).r);
    float a = clamp(max(lum, s.a * uOpacity * smoothstep(uGate.x, uGate.y, glow)), 0.0, 1.0);
    // the silhouette halo: a thin dark outline just outside the head (the blurred coverage where
    // the head itself is not), gone within ~8 CSS px; nothing inside the head, nothing far away
    float wide = bl.a, own = s.a;
    float hw = smoothstep(0.15, 0.5, wide);
    a = max(a, uHalo * hw * sqrt(hw) * (1.0 - smoothstep(0.05, 0.6, own)));
    gl_FragColor = vec4(min(c, vec3(a)), a);   // premultiplied
  } else {
    gl_FragColor = vec4(c, 1.0);
  }
}`;

/**
 * The silhouette halo: its peak alpha, how much of the coarser levels' coverage it takes past its
 * base level (its tail), and the base level's texel in CSS px (the level is picked by the pixel
 * ratio and the bloom scale, so the outline is as wide at any display scale).
 */
export const HALO = Object.freeze({ strength: 0.3, mix: 0.45, texelCss: 4 });

/**
 * The coverage mix of each bloom level for the halo (see UP_FRAG): the finer levels than its base
 * pass the coarser blur on in full, the base level (fractional: blended) and the coarser ones keep
 * HALO.mix of it. @param {number} levels @param {number} pixelRatio @param {number} bloomScale
 * @returns {number[]} per level (index 0 = the finest)
 */
export function haloMix(levels, pixelRatio, bloomScale) {
  const b = Math.min(levels - 1, Math.max(0, Math.log2(HALO.texelCss * bloomScale * Math.max(0.5, pixelRatio))));
  const out = [];
  for (let i = 0; i < levels; i++) out.push(i < Math.floor(b) ? 1 : i === Math.floor(b) ? HALO.mix + (1 - HALO.mix) * (b - i) : HALO.mix);
  return out;
}
/** The bloom's strength (x options.bloom): the brighter emissive lines and eyes carry the glow. */
export const BLOOM_GAIN = 0.44;
/** Default coverage gate (heads without a baked occlusion mask: only what visibly glows occludes). */
export const COVERAGE_GATE = Object.freeze([0.04, 0.24]);

function makeTarget(w, h, type, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    depthBuffer: !!opts.depth,
    stencilBuffer: false,
    samples: opts.samples || 0,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export class Post {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ tier: import('../quality.js').QualityTier, bloom?: number, transparent?: boolean,
   *   opacity?: number }} opts
   */
  constructor(renderer, opts) {
    this.renderer = renderer;
    this.tier = opts.tier;
    this.bloom = opts.bloom ?? 1;
    this.transparent = opts.transparent !== false;
    this.opacity = opts.opacity ?? 0.94;
    this.energy = 0.5;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    const ext = renderer.extensions;
    this.canHalf = renderer.capabilities.isWebGL2 &&
      (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geo);
    this.quad.frustumCulled = false;

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.matPrefilter = mk(PREFILTER_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: new THREE.Vector4() },
    });
    this.matDown = mk(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.matUp = mk(UP_FRAG, {
      tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 },
      uHaloMix: { value: HALO.mix },
    });
    this.matComposite = mk(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0.5 }, uTransparent: { value: 1 },
      uOpacity: { value: this.opacity }, uExposure: { value: 1 }, uResolution: { value: new THREE.Vector2() },
      uHalo: { value: HALO.strength }, uGate: { value: new THREE.Vector2(...COVERAGE_GATE) },
    });
    this.matComposite.premultipliedAlpha = true;
    this.threshold = 0.78;
    this.knee = 0.3;
    this._build();
  }

  /** Bloom chain precision (the tier decides). */
  _type() {
    return this.tier.halfFloat && this.canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  /**
   * The scene is rendered in LINEAR light and only encoded to sRGB in the composite, so an 8-bit
   * scene target quantises dim light to steps of 1/255 linear = ~13/255 after encoding: the soft
   * tails of the aura sprites turn into visible rings / blocks (worst over a light desktop, where
   * alpha follows that brightness). Half float whenever the GPU can render to it, on every tier.
   */
  _sceneType() {
    return this.canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  _build() {
    this._disposeTargets();
    const type = this._type();
    const samples = this.renderer.capabilities.isWebGL2 ? this.tier.msaa : 0;
    this.sceneRT = makeTarget(this.width, this.height, this._sceneType(), { depth: true, samples });
    this.mips = [];
    this.ups = [];
    let w = Math.max(1, Math.round(this.width * this.tier.bloomScale));
    let h = Math.max(1, Math.round(this.height * this.tier.bloomScale));
    for (let i = 0; i < this.tier.bloomLevels; i++) {
      this.mips.push(makeTarget(w, h, type));
      this.ups.push(makeTarget(w, h, type));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  _disposeTargets() {
    this.sceneRT?.dispose();
    this.mips?.forEach((t) => t.dispose());
    this.ups?.forEach((t) => t.dispose());
  }

  /** @param {number} w device px @param {number} h device px @param {number} [pr] device px per CSS px */
  setSize(w, h, pr) {
    if (pr > 0) this.pixelRatio = pr;
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
    this._build();
  }

  /** @param {import('../quality.js').QualityTier} tier */
  setTier(tier) {
    this.tier = tier;
    this._build();
  }

  /** @param {{ bloom?: number, transparent?: boolean, opacity?: number }} o */
  /**
   * The glow a covered pixel needs before it occludes the desktop: a head whose coverage is a
   * baked mask (the relief's masks_c) occludes with all of it, others only where they glow.
   * @param {[number, number]} g
   */
  setCoverageGate(g) {
    this.matComposite.uniforms.uGate.value.set(g[0], g[1]);
  }

  setOptions(o) {
    if (o.bloom !== undefined) this.bloom = Math.max(0, Number(o.bloom) || 0);
    if (o.transparent !== undefined) this.transparent = !!o.transparent;
    if (o.opacity !== undefined) this.opacity = Math.min(1, Math.max(0, Number(o.opacity)));
  }

  /** @param {{ energy: number }} a */
  update(a) { this.energy = a.energy; }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.camera);
  }

  /** @param {THREE.Scene} scene @param {THREE.Camera} camera */
  render(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, camera);

    const bloomOn = this.bloom > 0.001;
    if (bloomOn) {
      const m0 = this.mips[0];
      const pf = this.matPrefilter.uniforms;
      pf.tSrc.value = this.sceneRT.texture;
      pf.uTexel.value.set(1 / this.width, 1 / this.height);
      const t = this.threshold, k = this.knee;
      pf.uThreshold.value.set(t, k, 2 * k, 0.25 / k);
      this._pass(this.matPrefilter, m0);
      for (let i = 1; i < this.mips.length; i++) {
        const src = this.mips[i - 1];
        this.matDown.uniforms.tSrc.value = src.texture;
        this.matDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this._pass(this.matDown, this.mips[i]);
      }
      let coarse = this.mips[this.mips.length - 1];
      const hm = haloMix(this.mips.length, this.pixelRatio, this.tier.bloomScale);
      for (let i = this.mips.length - 2; i >= 0; i--) {
        const u = this.matUp.uniforms;
        u.tSrc.value = coarse.texture;
        u.tBase.value = this.mips[i].texture;
        u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
        u.uRadius.value = 1.0;
        u.uHaloMix.value = hm[i];
        this._pass(this.matUp, this.ups[i]);
        coarse = this.ups[i];
      }
      this.matComposite.uniforms.tBloom.value = coarse.texture;
    } else {
      this.matComposite.uniforms.tBloom.value = this.mips[this.mips.length - 1].texture;
    }
    const c = this.matComposite.uniforms;
    c.tScene.value = this.sceneRT.texture;
    // Bloom strength: options.bloom (0..2) x base, breathing a little with the avatar's energy.
    const levels = this.mips.length;
    c.uBloom.value = bloomOn ? (this.bloom * BLOOM_GAIN * (0.75 + 0.5 * this.energy)) / Math.max(1, levels * 0.6) : 0;
    c.uTransparent.value = this.transparent ? 1 : 0;
    c.uOpacity.value = this.opacity;
    // (the halo rides on the bloom chain: none without it)
    c.uHalo.value = bloomOn ? HALO.strength : 0;
    c.uResolution.value.set(this.width, this.height);
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    this._pass(this.matComposite, null);
  }

  /** GL-backed objects owned by the post chain (see stage.forgetDisposeListeners). */
  glResources() {
    const out = [this.quad.geometry, this.matPrefilter, this.matDown, this.matUp, this.matComposite];
    for (const rt of [this.sceneRT, ...this.mips, ...this.ups]) if (rt) out.push(rt, rt.texture);
    return out;
  }

  dispose() {
    this._disposeTargets();
    this.quad.geometry.dispose();
    this.matPrefilter.dispose(); this.matDown.dispose(); this.matUp.dispose(); this.matComposite.dispose();
  }
}
