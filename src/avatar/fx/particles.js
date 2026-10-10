// GPU particle aura: cyan + amber bokeh motes hugging the head, rising from the dissolving
// neck, a sparse far field with large defocused discs, and smooth luminous cyan wisp ribbons
// that hug the cranium / ears and a cyan collar along the jaw.
// All motion is evaluated in the vertex shader from per-particle seeds -> zero CPU work per
// particle per frame; only a handful of uniforms change.

import * as THREE from 'three';
import { springStep } from '../motion.js';
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
 *           pose). When given, the halo and the wisps hug the real outline instead of the ellipse.
 * @property {{ center: [number,number], radius: [number,number] }} [jaw]  half ellipse of the jaw
 *           line (jaw angles -> chin) for the collar; derived from the head ellipse when missing
 * @property {[number,number,number]} [pivot]  the point the head turns about (world); the aura
 *           turns with it (parallax). Below the head centre when missing.
 */

export const KIND_FRACTIONS = [
  ['halo', 0.25],
  ['neck', 0.2],
  ['far', 0.11],
  ['wisp', 0.44],
];

/** Wisp streams per side of the head: collar (chin -> jaw angle) + three ribbons up the side. */
export const WISP_STREAMS = 4;
/** Samples of the outline radius table (polar, around the head centre). */
export const RADIUS_SAMPLES = 48;
/** Particle count the wisp sprite sizes are tuned for; sparser auras use bigger sprites. */
const REFERENCE_COUNT = 6000;

const VERT = /* glsl */ `
#define NRAD ${RADIUS_SAMPLES}
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
uniform float uWispBuild; // the wisp ribbons grow in later (none in the first second)
uniform float uSpeechPulse;
uniform float uPointScale;
uniform float uDensity;   // >= 1: wisp sprites grow when fewer particles are drawn
uniform vec4 uAnchor;    // cx, cy, rx, ry
uniform vec4 uNeck;      // x, top, halfWidth, bottom
uniform vec4 uJaw;       // jaw half ellipse: cx, cy, rx, ry (bottom = chin)
uniform vec4 uView;      // view width, view height, focus z, depth scale
uniform vec4 uState;     // listen, think, speak, sleep
uniform float uRad[NRAD]; // outline radius around uAnchor.xy, angle -PI..PI
uniform float uError;
uniform vec3 uCyan;
uniform vec3 uAmber;
// the head's motion, a few frames behind it: the aura turns and shifts with it about its pivot,
// each layer at its own depth (parallax against the face and each other)
uniform mat3 uHeadRot;
uniform vec3 uHeadPivot;
uniform vec3 uHeadXform;  // shift x, y (world), scale
uniform vec2 uHeadPar;    // the far field's slight counter-parallax (yaw, pitch)
varying vec3 vColor;
varying float vAlpha;
varying float vBokeh;
varying float vSoft;

const float PI = 3.14159265;

float outlineRadius(float th) {
  float f = fract((th + PI) / (2.0 * PI)) * float(NRAD);
  float i0 = floor(f);
  return mix(uRad[int(i0)], uRad[int(mod(i0 + 1.0, float(NRAD)))], f - i0);
}

void main() {
  float listen = uState.x, think = uState.y, speak = uState.z, sleep = uState.w;
  vec3 p = vec3(0.0);
  float size = 1.0;
  float bright = 0.0;
  float soft = 0.0;          // 1 = smoke sprite (wisps), 0 = mote / bokeh
  float disc = 0.0;          // 1 = large defocused bokeh disc
  // motes: size and brightness correlate -> faint dust, a few big bright bokeh dots
  float sz = aSeed2.w;
  float moteSize = mix(1.8, 5.4, pow(sz, 2.2));
  float amber = step(aSeed2.z, 0.42);
  // amber motes are fewer-looking but brighter points in the reference, cyan dust is fainter
  float moteBright = (0.1 + 0.9 * pow(sz, 3.0)) * mix(0.85, 1.5, amber);
  vec3 col = mix(uCyan, uAmber, amber);
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.3 + aSeed2.x * 4.5) + aSeed2.y * 6.2831);
  // a few halo / far motes are big soft out-of-focus discs (amber and cyan)
  float bigR = fract(aSeed.w * 7.13 + aSeed2.x * 3.71);

  if (aKind < 0.5) {
    // halo: just outside the silhouette outline (biased toward the jaw, cheeks and shoulders,
    // like the reference), thinning outward; drifts / swirls (thinking) / breathes
    float d = (-0.006 + 0.17 * pow(aSeed.y, 1.6)) * uAnchor.w * 2.0;
    d -= 0.03 * listen * (0.4 + aSeed.y) * uAnchor.w;             // listening: drift inward
    d += 0.05 * uSpeechPulse * speak * (0.3 + aSeed.w) * uAnchor.w; // speaking: pulse outward
    d += 0.012 * sin(uPTime * 0.6 + aSeed.w * 31.0) * uAnchor.w;
    float big = step(0.972, bigR);                                 // ~3% of the halo
    d += big * 0.08 * uAnchor.w;                                   // discs sit a bit further out
    vec2 q = aBase.xy + aBase.zw * d;
    // slow tangential drift + swirl around the head centre
    float rot = uSwirl * (0.25 + 0.5 * aSeed.z) + 0.02 * sin(uPTime * 0.15 + aSeed.x * 20.0);
    float cr = cos(rot), sr = sin(rot);
    vec2 rel = q - uAnchor.xy;
    p.xy = uAnchor.xy + vec2(rel.x * cr - rel.y * sr, rel.x * sr + rel.y * cr);
    p.y += 0.01 * sin(uPTime * 0.4 + aSeed.z * 17.0) * uAnchor.w;
    p.z = mix(mix(-0.35, 0.12, aSeed.z), -0.25 - 0.3 * aSeed.z, big) * uView.w;   // discs: behind the head
    size = mix(moteSize, mix(5.0, 10.0, aSeed2.w), big);
    bright = mix(0.5 * moteBright, 0.45 + 0.35 * aSeed2.x, big);
    disc = big;
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
    p.y = (fract(aSeed.y + uPTime * 0.006 * (0.4 + aSeed.z)) - 0.5) * uView.y * 1.08;
    float big = step(0.89, bigR);                                  // ~11% of the far field
    // big discs are background bokeh: behind the head, so they never sit on the face
    p.z = mix(mix(-1.2, 0.9, aSeed.w), -0.3 - 0.9 * aSeed.w, big) * uView.w;
    size = mix(moteSize, mix(6.0, 12.0, aSeed2.w), big);
    bright = mix(0.42 * moteBright, 0.45 + 0.4 * aSeed2.x, big);
    disc = big;
  } else {
    // Wisps: smooth luminous ribbons. Each stream is a path around the head; its particles are
    // spread evenly along it (aSeed.z is a low-discrepancy slot, assigned on the CPU) and flow
    // slowly upward. Soft overlapping sprites merge into a continuous band with a brighter core,
    // a width that tapers toward the ends and slow brightness waves travelling along it.
    float side = aSeed.x < 0.5 ? -1.0 : 1.0;
    float stream = floor(aSeed.y * ${WISP_STREAMS}.0);
    float spd = 0.016 + 0.006 * stream;
    float u = fract(aSeed.z + uPTime * spd + uSwirl * 0.05);
    float env = pow(sin(u * PI), 0.8);
    float off = (aSeed.w + aSeed2.x - 1.0);                     // -1..1, denser at the core
    float kindR = aSeed2.w;                                     // < 0.35 core, < 0.98 smoke, else spark
    float core = step(kindR, 0.35);
    float spark = step(stream < 0.5 ? 0.62 : 0.95, kindR);      // the collar is mostly sparkles
    float smoke = 1.0 - core - spark;
    float wave = 0.5 + 0.5 * sin(u * 9.0 - uPTime * 0.55 + stream * 2.1 + side * 1.3);
    wave = 0.2 + 0.8 * smoothstep(0.15, 0.95, wave);
    // slowly drifting gaps break each ribbon into a few luminous strands
    float seg = 0.5 + 0.5 * sin(u * 4.3 + stream * 2.7 + side * 1.9 - uPTime * 0.12)
                    * sin(u * 2.1 - stream * 1.3 + side * 0.7 + uPTime * 0.07);
    wave *= mix(0.06, 1.0, smoothstep(0.3, 0.7, seg));
    float gain = 0.65 + 0.35 * sin(uPTime * 0.21 + stream * 1.7 + side * 2.9);
    vec2 dir;
    if (stream < 0.5) {
      // collar: along (just below / outside) the jaw line, from under the chin up to the jaw angle
      float ph = mix(-0.5 * PI, -0.12, u);
      if (side < 0.0) ph = -PI - ph;
      dir = vec2(cos(ph), sin(ph));
      float w = 0.075 * env;
      float wob = 0.018 * sin(u * 7.0 + uPTime * 0.35 + side);
      p.xy = uJaw.xy + dir * uJaw.zw * vec2(1.06 + w * off + wob, 1.28 + 1.6 * (w * off + wob));
      p.z = uView.w * 1.0;                                      // in front of the neck
      env *= 0.85;
    } else {
      // up the side of the head, hugging the real outline (ears, temple, cranium)
      float s = stream - 1.0;                                   // 0, 1, 2
      float th = mix(-0.75 + 0.36 * s, 0.45 + 0.25 * s, u);     // jaw angle -> temple
      if (side < 0.0) th = PI - th;
      dir = vec2(cos(th), sin(th));
      float r = outlineRadius(th);
      float w = (0.03 + 0.01 * s) * env * (1.0 + 0.35 * sin(u * 7.0 + uPTime * 0.3 + s));
      float wob = 0.022 * sin(u * 3.6 + uPTime * 0.33 + s * 2.1 + side * 1.7)
                + 0.01 * sin(u * 9.0 - uPTime * 0.6 + s);
      // the middle ribbon flares away from the head at ear level, like the reference wisps
      float earTh = side > 0.0 ? th : PI - th;
      float flare = step(0.5, s) * step(s, 1.5) * 0.11 * exp(-pow((earTh + 0.05) / 0.3, 2.0));
      float lift = 1.005 + 0.025 * s + flare * (0.6 + 0.4 * sin(uPTime * 0.25 + side));
      p.xy = uAnchor.xy + dir * r * (lift + wob + w * off * (0.45 + 0.55 * smoke + 1.2 * spark));
      p.z = uView.w * (0.25 + 0.1 * aSeed2.y);
    }
    // along-path jitter so the sprites never line up into beads
    p.xy += vec2(-dir.y, dir.x) * (aSeed2.y - 0.5) * 0.006;
    float sc = uDensity;
    size = (core * mix(6.0, 10.0, aSeed2.x) + smoke * mix(12.0, 22.0, aSeed2.x)) * sc
         + spark * mix(2.4, 3.6, aSeed2.x);
    bright = uWisp * env * (wave * gain * (core * 0.42 + smoke * 0.27) + spark * (0.5 + 0.5 * wave));
    if (stream < 0.5) bright *= mix(0.6, 1.6, spark);   // collar: sparkles over a faint glow
    soft = smoke;
    // the ribbons are teal-cyan with near-white highlights (bluer motes keep uCyan)
    col = mix(uCyan, vec3(0.42, 1.0, 0.97), 0.45 + 0.3 * core);
    col = mix(col, vec3(0.8, 1.0, 1.0), 0.5 * spark);
    twinkle = mix(1.0, 0.55 + 0.45 * twinkle, spark);
  }

  // the aura around the head goes with it (the neck motes partly, the far field not)
  float follow = aKind < 0.5 ? 1.0 : aKind < 1.5 ? 0.35 : aKind < 2.5 ? 0.0 : 1.0;
  if (follow > 0.0) {
    vec3 hq = uHeadPivot + uHeadRot * (p - uHeadPivot) * uHeadXform.z + vec3(uHeadXform.xy, 0.0);
    p = mix(p, hq, follow);
  } else {
    p.xy -= uHeadPar * p.z;
  }

  // error: everything shivers and a little red bleeds in
  p.xy += uError * 0.004 * vec2(sin(uTime * 50.0 + aSeed.x * 40.0), cos(uTime * 47.0 + aSeed.y * 40.0));
  col = mix(col, vec3(1.0, 0.35, 0.3), uError * 0.35);

  // depth of field: farther from the focal plane -> bigger, dimmer discs (wisps excluded: they
  // are tuned in size directly)
  // (wisps and the big discs are sized directly)
  float blur = clamp(abs(p.z - uView.z) / max(uView.w, 1e-3), 0.0, 3.0) * step(aKind, 2.5) * (1.0 - disc);
  float dof = 1.0 + blur * 1.6;
  size *= dof;
  bright /= dof * dof * 0.7 + 0.3;
  vBokeh = max(smoothstep(0.6, 2.0, blur), disc) * (1.0 - soft);
  vSoft = soft;

  float visible = step(aSeed2.y, uVisible);
  float tail = mix(0.55 + 0.45 * fract(aSeed.w * 7.31 + aSeed2.x * 3.17), 1.0, step(2.5, aKind));
  vAlpha = bright * tail * twinkle * uIntensity * visible * mix(uBuild, uWispBuild, step(2.5, aKind));
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
  float smoke = exp(-d2 * 3.2) * (1.0 - d2) * (1.0 - d2);         // wide, fades smoothly to 0 at the rim
  float disc = (1.0 - smoothstep(0.55, 1.0, d)) * (0.75 + 0.25 * smoothstep(0.3, 0.9, d)); // bokeh
  float a = mix(mix(core, disc * 0.6, vBokeh), smoke, vSoft) * vAlpha;
  gl_FragColor = vec4(vColor * a, 0.0);                           // additive, alpha untouched
}`;

/**
 * Rotation Rz(roll) * Ry(yaw) * Rx(-pitch), column-major mat3 (the heads' convention: yaw > 0 turns
 * toward screen right, pitch > 0 looks up, roll > 0 tilts counter-clockwise on screen).
 */
export function yprMatrix(yaw, pitch, roll, out) {
  const ax = -pitch;
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(yaw), sy = Math.sin(yaw), cz = Math.cos(roll), sz = Math.sin(roll);
  out[0] = cz * cy; out[1] = sz * cy; out[2] = -sy;
  out[3] = cz * sy * sx - sz * cx; out[4] = sz * sy * sx + cz * cx; out[5] = cy * sx;
  out[6] = cz * sy * cx + sz * sx; out[7] = sz * sy * cx - cz * sx; out[8] = cy * cx;
  return out;
}

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
 * Polar radius table of a closed outline around `center`: for each of `n` angles (from -PI, step
 * 2PI/n) the farthest crossing of the ray with the polygon (so ears count), or `fallback(angle)`
 * when the ray misses. Pure; used for the wisp paths.
 * @param {ArrayLike<number>} outline [x,y,...] @param {[number,number]} center @param {number} n
 * @param {(angle:number) => number} fallback
 * @returns {Float32Array}
 */
export function outlineRadii(outline, center, n, fallback) {
  const out = new Float32Array(n);
  const m = outline.length / 2;
  const [cx, cy] = center;
  for (let k = 0; k < n; k++) {
    const th = -Math.PI + (k / n) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    let best = -1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = outline[i * 2] - cx, ay = outline[i * 2 + 1] - cy;
      const bx = outline[j * 2] - cx, by = outline[j * 2 + 1] - cy;
      // ray t*(dx,dy) vs segment a + s*(b-a)
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= 0 && s <= 1 && t > best) best = t;
    }
    out[k] = best > 0 ? best : fallback(th);
  }
  return out;
}

/**
 * Round a polar radius table: circular max-filter over +-`dilate` samples (fills notches such as
 * the gap between ear and cranium), then a circular Gaussian blur (sigma in samples). Pure.
 * @param {Float32Array} r @param {number} dilate @param {number} sigma
 */
export function smoothRadii(r, dilate, sigma) {
  const n = r.length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = -Infinity;
    for (let k = -dilate; k <= dilate; k++) v = Math.max(v, r[(i + k + n) % n]);
    m[i] = v;
  }
  const out = new Float32Array(n);
  const R = Math.ceil(sigma * 3);
  for (let i = 0; i < n; i++) {
    let acc = 0, wsum = 0;
    for (let k = -R; k <= R; k++) {
      const w = Math.exp(-0.5 * (k / sigma) ** 2);
      acc += w * m[(i + k + n) % n];
      wsum += w;
    }
    out[i] = acc / wsum;
  }
  return out;
}

/**
 * Wisp sprite scale for a particle count: sparser auras use somewhat bigger sprites so the
 * ribbons stay continuous, but only mildly (huge sprites read as blobs, esp. on light desktops).
 * @param {number} count
 */
export function wispDensity(count) {
  return Math.min(1.6, Math.max(1, (REFERENCE_COUNT / Math.max(1, count)) ** 0.3));
}

/** Jaw half ellipse for the collar (world units). @param {ParticleAnchors} a */
export function jawEllipse(a) {
  if (a.jaw && a.jaw.center && a.jaw.radius) return a.jaw;
  const chin = a.center[1] - a.radius[1];
  const ry = 0.36 * a.radius[1];
  return { center: [a.center[0], chin + ry], radius: [0.62 * a.radius[0], ry] };
}

/**
 * Wisp particles get deterministic, evenly spread slots: side alternates, the stream cycles and
 * the position along the stream is a golden-ratio sequence, so ANY prefix of the particle buffer
 * (the draw range shrinks with the quality tier) still covers every ribbon evenly.
 * Writes aSeed.x (side), aSeed.y (stream) and aSeed.z (slot along the stream) of wisp particles.
 * @param {Float32Array} seeds n*4 @param {Float32Array} kinds n @param {number} wispKind
 */
export function assignWispSlots(seeds, kinds, wispKind) {
  const PHI = 0.6180339887498949;
  const per = 2 * WISP_STREAMS;
  let k = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== wispKind) continue;
    const lane = k % per;
    const j = Math.floor(k / per);
    seeds[i * 4] = lane % 2 === 0 ? 0.25 : 0.75;                        // side
    seeds[i * 4 + 1] = (Math.floor(lane / 2) + 0.5) / WISP_STREAMS;    // stream
    seeds[i * 4 + 2] = (j * PHI + lane * 0.137) % 1;                     // slot along the stream
    k++;
  }
  return k;
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
    // (wisps never read aBase, so overwriting their seeds is safe)
    assignWispSlots(seeds, kinds, KIND_FRACTIONS.findIndex(([k]) => k === 'wisp'));
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
      uDensity: { value: 1 }, uWispBuild: { value: 1 },
      uAnchor: { value: new THREE.Vector4(0, 0.1, 0.29, 0.4) },
      uNeck: { value: new THREE.Vector4(0, -0.3, 0.18, -0.5) },
      uJaw: { value: new THREE.Vector4(0, -0.2, 0.18, 0.12) },
      uView: { value: new THREE.Vector4(0.67, 1, 0, 0.3) },
      uState: { value: new THREE.Vector4() },
      uRad: { value: new Float32Array(RADIUS_SAMPLES).fill(0.35) },
      uError: { value: 0 },
      uCyan: { value: new THREE.Color(opts.palette.wisp) },
      uAmber: { value: new THREE.Color(opts.palette.mote) },
      uHeadRot: { value: new THREE.Matrix3() },
      uHeadPivot: { value: new THREE.Vector3() },
      uHeadXform: { value: new THREE.Vector3(0, 0, 1) },
      uHeadPar: { value: new THREE.Vector2() },
    };
    // the head's motion as the aura follows it: springs a few frames behind (yaw, pitch, roll,
    // shiftX, lean)
    this._follow = [0, 0, 0, 0, 0].map(() => ({ x: 0, v: 0 }));
    this._rot = new Float32Array(9);
    this._faceH = 0.6;
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
    // fewer, bigger wisp sprites keep the ribbons continuous at low particle counts
    this.uniforms.uDensity.value = wispDensity(this.count);
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
    const jaw = jawEllipse(a);
    u.uJaw.value.set(jaw.center[0], jaw.center[1], jaw.radius[0], jaw.radius[1]);
    u.uView.value.w = a.depth;
    const outline = a.outline && a.outline.length >= 8 ? a.outline : ellipseOutline(a, 64);
    fillHaloBases(this._base, this.geometry.getAttribute('aSeed').array, outline, a);
    this.geometry.getAttribute('aBase').needsUpdate = true;
    const [rx, ry] = a.radius;
    const pv = a.pivot ?? [a.center[0], a.center[1] - 0.45 * ry, 0];
    u.uHeadPivot.value.set(pv[0], pv[1], pv[2]);
    this._faceH = 1.6 * ry;
    const raw = outlineRadii(outline, a.center, RADIUS_SAMPLES,
      (th) => 1 / Math.hypot(Math.cos(th) / rx, Math.sin(th) / ry));
    // ribbons pass around the ears instead of tracing every notch of the silhouette
    u.uRad.value.set(smoothRadii(raw, 1, 1.5));
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
    // the aura follows the head a few frames behind (t90 ~0.3 s); fixed-time renders: at once
    const tgt = [a.headYaw ?? 0, a.headPitch ?? 0, a.headRoll ?? 0, a.shiftX ?? 0, a.lean ?? 0];
    for (let k = 0; k < 5; k++) {
      const s = this._follow[k];
      if (dt > 0) springStep(s, tgt[k], 12, dt);
      else { s.x = tgt[k]; s.v = 0; }
    }
    const f = this._follow;
    u.uHeadRot.value.fromArray(yprMatrix(f[0].x, f[1].x, f[2].x, this._rot));
    // (as the heads: 2 % of the face height sideways, 3 % larger and a little lower leaning in)
    u.uHeadXform.value.set(0.02 * this._faceH * f[3].x, -0.012 * this._faceH * f[4].x, 1 + 0.03 * f[4].x);
    u.uHeadPar.value.set(0.12 * f[0].x, 0.12 * f[1].x);
    u.uTime.value = time;
    u.uPTime.value = this._pt;
    u.uSwirl.value = this._swirl;
    u.uState.value.set(a.listen, a.think, a.speak, a.sleep);
    u.uError.value = a.error;
    // (an emphasis sends a pulse of energy out through the aura)
    u.uSpeechPulse.value = Math.max(a.speech, a.pulse ?? 0);
    // idle shows ~70% of the motes; attention / thinking / speech make the aura denser
    u.uVisible.value = Math.min(1, 0.7 + 0.3 * Math.max(a.listen, a.think, a.speak)) * (1 - 0.55 * a.sleep);
    // the aura builds up over the first ~12 s (as in the reference video) and with activity
    const t = Math.min(1, Math.max(0, time / 12));
    u.uBuild.value = 0.36 + 0.64 * t * t * (3 - 2 * t);
    // ... the wisp ribbons only start after ~1 s and reach full strength at ~12 s (reference video)
    const w = Math.min(1, Math.max(0, (time - 1) / 11));
    u.uWispBuild.value = 0.04 + 0.96 * w * w * (3 - 2 * w);
    u.uWisp.value = (1.0 + 0.45 * a.think + 0.35 * a.speak * (0.5 + a.speech) + 0.2 * a.listen) * (1 - 0.6 * a.sleep);
    u.uIntensity.value = (0.7 + 0.6 * a.energy + 0.3 * (a.pulse ?? 0)) * (1 - 0.4 * a.error);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
