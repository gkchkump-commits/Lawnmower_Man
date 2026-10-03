// GPU particle aura: cyan + amber bokeh motes hugging the head, rising from the dissolving
// neck, a sparse far field and cyan wisp streams around the sides of the head.
// All motion is evaluated in the vertex shader from per-particle seeds -> zero CPU work per
// particle per frame; only a handful of uniforms change.

import * as THREE from 'three';
import { mulberry32 } from '../noise.js';

/**
 * Where the head is (world units) so the aura can wrap around it.
 * @typedef {Object} ParticleAnchors
 * @property {[number,number]} center   centre of the head ellipse (cranium + face)
 * @property {[number,number]} radius   ellipse radii (x, y)
 * @property {number} neckX
 * @property {number} neckTop           y where the neck starts (under the chin)
 * @property {number} neckBottom        y where the neck has fully dissolved
 * @property {number} neckHalfWidth
 * @property {number} depth             head depth scale (z spread of the halo)
 * @property {Float32Array|number[]} [outline]  silhouette polygon [x0,y0,x1,y1,...] (world, rest
 *           pose). When given, the halo hugs the real outline instead of the ellipse.
 */

const KIND_FRACTIONS = [
  ['halo', 0.4],
  ['neck', 0.24],
  ['far', 0.12],
  ['wisp', 0.24],
];

const VERT = /* glsl */ `
attribute vec4 aSeed;
attribute vec4 aSeed2;
attribute vec4 aBase;    // halo: point on the silhouette outline (xy) + outward normal (zw)
attribute float aKind;
uniform float uTime;
uniform float uPTime;
uniform float uSwirl;
uniform float uVisible;
uniform float uWisp;
uniform float uIntensity;
uniform float uBuild;     // aura build-up after start (sparse at first, like the reference)
uniform float uSpeechPulse;
uniform float uPointScale;
uniform vec4 uAnchor;    // cx, cy, rx, ry
uniform vec4 uNeck;      // x, top, halfWidth, bottom
uniform vec4 uView;      // view width, view height, focus z, depth scale
uniform vec4 uState;     // listen, think, speak, sleep
uniform float uError;
uniform vec3 uCyan;
uniform vec3 uAmber;
varying vec3 vColor;
varying float vAlpha;
varying float vBokeh;
varying float vSoft;

void main() {
  float listen = uState.x, think = uState.y, speak = uState.z, sleep = uState.w;
  vec3 p = vec3(0.0);
  float size = 1.0;
  float bright = 0.0;
  float soft = 0.0;          // 1 = smoke sprite (wisps), 0 = mote / bokeh
  // motes: size and brightness correlate -> lots of faint dust, a few big bright bokeh dots
  float sz = aSeed2.w;
  float moteSize = mix(1.5, 5.2, pow(sz, 2.4));
  float moteBright = 0.1 + 0.9 * pow(sz, 3.0);
  float amber = step(aSeed2.z, 0.42);
  vec3 col = mix(uCyan, uAmber, amber);
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.3 + aSeed2.x * 4.5) + aSeed2.y * 6.2831);

  if (aKind < 0.5) {
    // halo: just outside the silhouette outline (biased toward the jaw, cheeks and shoulders,
    // like the reference), thinning outward; drifts / swirls (thinking) / breathes
    float d = (-0.006 + 0.17 * pow(aSeed.y, 1.6)) * uAnchor.w * 2.0;
    d -= 0.03 * listen * (0.4 + aSeed.y) * uAnchor.w;             // listening: drift inward
    d += 0.05 * uSpeechPulse * speak * (0.3 + aSeed.w) * uAnchor.w; // speaking: pulse outward
    d += 0.012 * sin(uPTime * 0.6 + aSeed.w * 31.0) * uAnchor.w;
    vec2 q = aBase.xy + aBase.zw * d;
    // slow tangential drift + swirl around the head centre
    float rot = uSwirl * (0.25 + 0.5 * aSeed.z) + 0.02 * sin(uPTime * 0.15 + aSeed.x * 20.0);
    float cr = cos(rot), sr = sin(rot);
    vec2 rel = q - uAnchor.xy;
    p.xy = uAnchor.xy + vec2(rel.x * cr - rel.y * sr, rel.x * sr + rel.y * cr);
    p.y += 0.01 * sin(uPTime * 0.4 + aSeed.z * 17.0) * uAnchor.w;
    p.z = mix(-0.35, 0.12, aSeed.z) * uView.w;
    size = moteSize;
    bright = 0.5 * moteBright;
  } else if (aKind < 1.5) {
    // rising from the dissolving neck
    float life = fract(aSeed.y + uPTime * (0.028 + 0.03 * aSeed.z));
    float x = aSeed.x * 2.0 - 1.0;
    x = sign(x) * pow(abs(x), 0.7);
    p.x = uNeck.x + x * uNeck.z * (1.0 + 0.45 * life) + 0.02 * sin(uPTime * 0.5 + aSeed.w * 20.0);
    p.y = mix(uNeck.w, uNeck.y, life);
    p.z = uView.w * (0.15 + 0.55 * aSeed.w);
    size = moteSize * 0.9;
    bright = 0.75 * moteBright * smoothstep(0.0, 0.18, life) * (1.0 - smoothstep(0.55, 1.0, life));
  } else if (aKind < 2.5) {
    // sparse far field with depth of field
    p.x = (aSeed.x - 0.5) * uView.x * 1.08;
    p.y = (fract(aSeed.y + uPTime * 0.006 * (0.4 + aSeed.z)) - 0.5) * uView.y * 1.08 + uAnchor.y * 0.0;
    p.z = mix(-1.2, 0.9, aSeed.w) * uView.w;
    size = moteSize;
    bright = 0.42 * moteBright;
  } else {
    // wisps: cyan ribbons flowing up around the sides of the head. Each ribbon is a thin bright
    // filament (small dots with tiny jitter) wrapped in soft smoke (larger faint sprites).
    float side = aSeed.x < 0.5 ? -1.0 : 1.0;
    float stream = floor(aSeed.y * 3.0);
    float u = fract(aSeed.z + uPTime * (0.03 + 0.012 * stream) + uSwirl * 0.1);
    float ang = mix(-0.8 + 0.28 * stream, 0.35 + 0.3 * stream, u);    // jaw level -> temple
    float wob = 0.025 * sin(u * 6.0 + uPTime * 0.5 + stream * 2.3 + side * 1.7)
              + 0.012 * sin(u * 17.0 - uPTime * 0.9 + stream);
    float rr = 0.985 + 0.04 * stream + wob;
    p.x = uAnchor.x + side * cos(ang) * uAnchor.z * rr;
    p.y = uAnchor.y + sin(ang) * uAnchor.w * rr;
    float filament = step(aSeed2.w, 0.55);
    vec2 j = (vec2(aSeed.w, aSeed2.x) - 0.5);
    p.xy += j * mix(vec2(0.022, 0.02), vec2(0.004, 0.004), filament);
    p.z = (aSeed2.y - 0.5) * 0.1 * uView.w;
    size = mix(mix(7.0, 16.0, aSeed2.w), mix(2.0, 3.4, aSeed2.x), filament);
    // patchy: broken streaks that drift along the ribbon instead of a continuous ring
    float streak = 0.5 + 0.5 * sin(u * 11.0 + stream * 5.0 + side * 1.3 - uPTime * 0.35)
                            * sin(u * 5.3 - uPTime * 0.21 + side * 2.0 + stream * 1.7);
    streak = smoothstep(0.35, 0.9, streak);
    bright = uWisp * pow(sin(u * 3.14159), 1.3) * mix(0.13, 1.0, filament) * (0.15 + 1.25 * streak);
    soft = 1.0 - filament;
    col = uCyan;
    twinkle = mix(1.0, 0.75 + 0.25 * twinkle, filament);
  }

  // error: everything shivers and a little red bleeds in
  p.xy += uError * 0.004 * vec2(sin(uTime * 50.0 + aSeed.x * 40.0), cos(uTime * 47.0 + aSeed.y * 40.0));
  col = mix(col, vec3(1.0, 0.35, 0.3), uError * 0.35);

  // depth of field: farther from the focal plane -> bigger, dimmer discs
  float blur = clamp(abs(p.z - uView.z) / max(uView.w, 1e-3), 0.0, 3.0);
  float dof = 1.0 + blur * 1.6;
  size *= dof;
  bright /= dof * dof * 0.7 + 0.3;
  vBokeh = smoothstep(0.6, 2.0, blur) * (1.0 - soft);
  vSoft = soft;

  float visible = step(aSeed2.y, uVisible);
  float tail = mix(0.55 + 0.45 * fract(aSeed.w * 7.31 + aSeed2.x * 3.17), 1.0, soft);
  vAlpha = bright * tail * twinkle * uIntensity * visible * mix(uBuild, 1.0, 0.25 * soft);
  vColor = col;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(size * uPointScale, 64.0) * visible;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vBokeh;
varying float vSoft;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(q, q);
  if (d2 > 1.0 || vAlpha < 0.001) discard;
  float d = sqrt(d2);
  float core = exp(-d2 * 4.5);                                    // soft round mote
  float smoke = exp(-d2 * 2.6) * (1.0 - d2);                      // wide, fades to 0 at the rim
  float disc = (1.0 - smoothstep(0.78, 1.0, d)) * (0.5 + 0.5 * smoothstep(0.35, 0.95, d)); // bokeh
  float a = mix(mix(core, disc * 0.55, vBokeh), smoke, vSoft) * vAlpha;
  gl_FragColor = vec4(vColor * a, 0.0);                           // additive, alpha untouched
}`;

/** Ellipse polygon from the anchors (fallback outline). */
function ellipseOutline(a, n) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out[i * 2] = a.center[0] + Math.cos(t) * a.radius[0];
    out[i * 2 + 1] = a.center[1] + Math.sin(t) * a.radius[1];
  }
  return out;
}

/**
 * Place each particle's halo base point on the outline (arc-length sampling weighted toward the
 * lower half and the neck sides) with its outward normal. Pure CPU, done once per head.
 * @param {Float32Array} base out (n*4) @param {ArrayLike<number>} seeds (n*4)
 * @param {ArrayLike<number>} outline [x,y,...] closed polygon @param {ParticleAnchors} a
 */
export function fillHaloBases(base, seeds, outline, a) {
  const m = outline.length / 2;
  const cx = a.center[0], cy = a.center[1];
  const top = a.center[1] + a.radius[1];
  const chin = a.center[1] - a.radius[1];
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const x0 = outline[i * 2], y0 = outline[i * 2 + 1], x1 = outline[j * 2], y1 = outline[j * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ym = 0.5 * (y0 + y1);
    const t = (top - ym) / Math.max(1e-6, top - chin);           // 0 crown .. 1 chin, >1 neck
    let w = 0.3 + 1.2 * smooth(0.35, 1.0, t);
    if (ym < a.neckBottom + 0.05) w = 0;                          // nothing along the faded neck end
    cum[i + 1] = cum[i] + len * w;
  }
  const total = cum[m] || 1;
  const n = base.length / 4;
  for (let k = 0; k < n; k++) {
    const target = seeds[k * 4] * total;
    let lo = 0, hi = m;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    const i = lo, j = (lo + 1) % m;
    const seg = cum[i + 1] - cum[i];
    const f = seg > 0 ? (target - cum[i]) / seg : 0;
    const x0 = outline[i * 2], y0 = outline[i * 2 + 1], x1 = outline[j * 2], y1 = outline[j * 2 + 1];
    const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
    let nx = y1 - y0, ny = -(x1 - x0);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    if (nx * (px - cx) + ny * (py - cy) < 0) { nx = -nx; ny = -ny; }   // point outward
    base[k * 4] = px; base[k * 4 + 1] = py; base[k * 4 + 2] = nx; base[k * 4 + 3] = ny;
  }
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class Particles {
  /**
   * @param {{ maxCount: number, count: number, seed: number, palette: { wisp: THREE.Color, mote: THREE.Color } }} opts
   */
  constructor(opts) {
    this.maxCount = Math.max(1, opts.maxCount | 0);
    const rng = mulberry32((opts.seed | 0) * 2654435761 + 12345);
    const seeds = new Float32Array(this.maxCount * 4);
    const seeds2 = new Float32Array(this.maxCount * 4);
    const kinds = new Float32Array(this.maxCount);
    const cum = [];
    let acc = 0;
    for (const [, f] of KIND_FRACTIONS) { acc += f; cum.push(acc); }
    for (let i = 0; i < this.maxCount; i++) {
      for (let k = 0; k < 4; k++) { seeds[i * 4 + k] = rng(); seeds2[i * 4 + k] = rng(); }
      const r = rng() * acc;
      let kind = 0;
      while (kind < cum.length - 1 && r > cum[kind]) kind++;
      kinds[i] = kind;
    }
    const geo = new THREE.BufferGeometry();
    // positions are computed in the shader; a dummy attribute keeps three.js happy
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxCount * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('aSeed2', new THREE.BufferAttribute(seeds2, 4));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    this._base = new Float32Array(this.maxCount * 4);
    geo.setAttribute('aBase', new THREE.BufferAttribute(this._base, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e3);
    this.geometry = geo;

    this.uniforms = {
      uTime: { value: 0 }, uPTime: { value: 0 }, uSwirl: { value: 0 }, uVisible: { value: 1 },
      uWisp: { value: 0.3 }, uIntensity: { value: 1 }, uBuild: { value: 1 }, uSpeechPulse: { value: 0 }, uPointScale: { value: 1 },
      uAnchor: { value: new THREE.Vector4(0, 0.1, 0.29, 0.4) },
      uNeck: { value: new THREE.Vector4(0, -0.3, 0.18, -0.5) },
      uView: { value: new THREE.Vector4(0.67, 1, 0, 0.3) },
      uState: { value: new THREE.Vector4() },
      uError: { value: 0 },
      uCyan: { value: new THREE.Color(opts.palette.wisp) },
      uAmber: { value: new THREE.Color(opts.palette.mote) },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.setCount(opts.count);
    this._pt = 0;
    this._swirl = 0;
  }

  /** @param {number} n number of particles drawn (<= maxCount) */
  setCount(n) {
    this.count = Math.max(0, Math.min(this.maxCount, Math.round(n)));
    this.geometry.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
  }

  /** @param {{ wisp?: THREE.ColorRepresentation, mote?: THREE.ColorRepresentation }} pal */
  setPalette(pal) {
    if (pal.wisp) this.uniforms.uCyan.value.set(pal.wisp);
    if (pal.mote) this.uniforms.uAmber.value.set(pal.mote);
  }

  /** @param {ParticleAnchors} a */
  setAnchors(a) {
    const u = this.uniforms;
    u.uAnchor.value.set(a.center[0], a.center[1], a.radius[0], a.radius[1]);
    u.uNeck.value.set(a.neckX, a.neckTop, a.neckHalfWidth, a.neckBottom);
    u.uView.value.w = a.depth;
    const outline = a.outline && a.outline.length >= 8 ? a.outline : ellipseOutline(a, 64);
    fillHaloBases(this._base, this.geometry.getAttribute('aSeed').array, outline, a);
    this.geometry.getAttribute('aBase').needsUpdate = true;
  }

  /** @param {number} viewW world @param {number} viewH world @param {number} heightPx device px */
  setView(viewW, viewH, heightPx) {
    const u = this.uniforms;
    u.uView.value.x = viewW;
    u.uView.value.y = viewH;
    u.uPointScale.value = heightPx / 584;
  }

  /**
   * @param {number} dt @param {number} time
   * @param {import('../director.js').AnimState} a
   */
  update(dt, time, a) {
    const u = this.uniforms;
    // Integrate particle time so speed changes never make the field jump.
    const speed = (1 - 0.72 * a.sleep) * (1 + 0.6 * a.think + 0.35 * a.speak * a.speech) * (1 + 0.5 * a.listen);
    if (dt > 0) {
      this._pt += dt * speed;
      this._swirl += dt * 0.32 * a.think;
    } else {
      // fixed-time renders: a deterministic function of time
      this._pt = time;
      this._swirl = 0;
    }
    u.uTime.value = time;
    u.uPTime.value = this._pt;
    u.uSwirl.value = this._swirl;
    u.uState.value.set(a.listen, a.think, a.speak, a.sleep);
    u.uError.value = a.error;
    u.uSpeechPulse.value = a.speech;
    // idle shows ~70% of the motes; attention / thinking / speech make the aura denser
    u.uVisible.value = Math.min(1, 0.7 + 0.3 * Math.max(a.listen, a.think, a.speak)) * (1 - 0.55 * a.sleep);
    // the aura builds up over the first ~12 s (as in the reference video) and with activity
    const t = Math.min(1, Math.max(0, time / 12));
    u.uBuild.value = 0.36 + 0.64 * t * t * (3 - 2 * t);
    u.uWisp.value = (0.5 + 0.4 * a.think + 0.3 * a.speak * (0.5 + a.speech) + 0.15 * a.listen) * (1 - 0.6 * a.sleep);
    u.uIntensity.value = (0.7 + 0.6 * a.energy) * (1 - 0.4 * a.error);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
