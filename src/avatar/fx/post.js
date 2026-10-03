// Post-processing: scene render target -> cheap dual-filter bloom -> final composite that
// outputs PREMULTIPLIED alpha derived from brightness (black = transparent desktop) or opaque black.

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
vec3 pick(vec2 uv) {
  vec3 c = texture2D(tSrc, uv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold.x + uThreshold.y, 0.0, uThreshold.z);
  rq = uThreshold.w * rq * rq;
  float contrib = max(rq, br - uThreshold.x) / max(br, 1e-4);
  return c * contrib;
}
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = pick(vUv + vec2(-o.x, -o.y)) + pick(vUv + vec2(o.x, -o.y))
         + pick(vUv + vec2(-o.x, o.y)) + pick(vUv + vec2(o.x, o.y));
  gl_FragColor = vec4(min(c * 0.25, vec3(32.0)), 1.0);
}`;

// Dual-Kawase downsample (5 taps).
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

// Dual-Kawase upsample (8 taps) + add the finer level.
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;    // coarser level (being upsampled)
uniform sampler2D tBase;   // finer level at this resolution
uniform vec2 uTexel;       // texel of the coarser level
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0 + texture2D(tBase, vUv).rgb, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uTransparent;
uniform float uOpacity;     // how strongly covered pixels (head) occlude the desktop
uniform float uExposure;
uniform vec2 uResolution;
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
void main() {
  vec4 s = texture2D(tScene, vUv);
  vec3 c = s.rgb * uExposure + texture2D(tBloom, vUv).rgb * uBloom;
  c = toSRGB(shoulder(c));
  // dithering against banding in dark glows
  c += (hash(gl_FragCoord.xy + fract(uResolution.x)) - 0.5) / 255.0;
  c = max(c, 0.0);
  if (uTransparent > 0.5) {
    // hologram = light: alpha follows brightness; covered pixels (the head) also occlude the
    // desktop, but only where they actually glow, so dark fringes / the dissolving neck don't
    // paint a dark outline on bright desktops
    float lum = max(c.r, max(c.g, c.b));
    float a = clamp(max(lum, s.a * uOpacity * smoothstep(0.04, 0.24, lum)), 0.0, 1.0);
    gl_FragColor = vec4(min(c, vec3(a)), a);   // premultiplied
  } else {
    gl_FragColor = vec4(c, 1.0);
  }
}`;

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
    this.opacity = opts.opacity ?? 0.88;
    this.energy = 0.5;
    this.width = 1;
    this.height = 1;
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
    });
    this.matComposite = mk(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0.5 }, uTransparent: { value: 1 },
      uOpacity: { value: this.opacity }, uExposure: { value: 1 }, uResolution: { value: new THREE.Vector2() },
    });
    this.matComposite.premultipliedAlpha = true;
    this.threshold = 0.72;
    this.knee = 0.3;
    this._build();
  }

  _type() {
    return this.tier.halfFloat && this.canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  _build() {
    this._disposeTargets();
    const type = this._type();
    const samples = this.renderer.capabilities.isWebGL2 ? this.tier.msaa : 0;
    this.sceneRT = makeTarget(this.width, this.height, type, { depth: true, samples });
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

  /** @param {number} w device px @param {number} h device px */
  setSize(w, h) {
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
      for (let i = this.mips.length - 2; i >= 0; i--) {
        const u = this.matUp.uniforms;
        u.tSrc.value = coarse.texture;
        u.tBase.value = this.mips[i].texture;
        u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
        u.uRadius.value = 1.0;
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
    c.uBloom.value = bloomOn ? (this.bloom * 0.42 * (0.75 + 0.5 * this.energy)) / Math.max(1, levels * 0.6) : 0;
    c.uTransparent.value = this.transparent ? 1 : 0;
    c.uOpacity.value = this.opacity;
    c.uResolution.value.set(this.width, this.height);
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    this._pass(this.matComposite, null);
  }

  dispose() {
    this._disposeTargets();
    this.quad.geometry.dispose();
    this.matPrefilter.dispose(); this.matDown.dispose(); this.matUp.dispose(); this.matComposite.dispose();
  }
}
