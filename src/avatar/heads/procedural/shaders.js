// GLSL for the procedural hologram head (one draw call: skin + mouth cavity).
//
// Every surface pattern (grid, web, gold lines, eyes) is evaluated on the REST-pose position, so
// it sticks to the skin while the rig deforms it, and is anti-aliased with screen-space
// derivatives (lines keep ~1 px, dense grids fade to their mean instead of moire).

import { CURVE_TEX_WIDTH, MAX_CHUNKS_PER_GROUP, MAX_CURVE_GROUPS, MAX_SEGMENTS_PER_CHUNK } from './format.js';

/** Compile-time knobs (material.defines). */
export const DEFAULT_DEFINES = Object.freeze({
  CURVE_TEX_W: CURVE_TEX_WIDTH,
  MAX_GROUPS: MAX_CURVE_GROUPS,
  MAX_CHUNKS: MAX_CHUNKS_PER_GROUP,
  MAX_SEG: MAX_SEGMENTS_PER_CHUNK,
  PH_WEB: 1,        // irregular web + nodes (off on the low tier)
});

export const HEAD_VERT = /* glsl */ `
attribute vec4 aRig0;   // jaw, upperLip, lowerLip, cornerL
attribute vec4 aRig1;   // cornerR, browL, browR, cheek
attribute vec4 aAux;    // ao, convexity, lips, ear
attribute vec4 aCav;    // cavity flag, u, v, side
attribute vec4 aShell;  // smoothed outer-shell normal (encoded), inner-mouth mask
uniform mat3 uJawRot;
uniform vec3 uJawPivot;
uniform mat3 uHeadRot;
uniform vec3 uHeadPivot;
uniform vec3 uCornerL;
uniform vec3 uCornerR;
uniform vec4 uLips;     // upperLift, lowerDrop, push, cheek
uniform vec2 uBrow;
uniform float uBreathY;
uniform vec2 uNeckRot;  // rest y: head rotation weight 0 at x, 1 at y (the neck stays put)
varying vec3 vRest;
varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vAux;
varying vec4 vCav;
varying vec4 vShell;
void main() {
  vec3 p = position;
  vec3 n = normal;
  p += aRig0.w * uCornerL + aRig1.x * uCornerR;
  p.y += aRig0.y * uLips.x - aRig0.z * uLips.y;
  p.z += (aRig0.y + aRig0.z) * uLips.z;
  p.y += aRig1.y * uBrow.x + aRig1.z * uBrow.y;
  p += aRig1.w * vec3(0.0, uLips.w, uLips.w * 0.35);
  // jaw hinge (weighted rotation = a smooth skin blend between skull and mandible)
  p = mix(p, uJawPivot + uJawRot * (p - uJawPivot), aRig0.x);
  n = mix(n, uJawRot * n, aRig0.x);
  float hw = smoothstep(uNeckRot.x, uNeckRot.y, position.y);
  p = mix(p, uHeadPivot + uHeadRot * (p - uHeadPivot), hw);
  p.y += uBreathY * hw;
  n = mix(n, uHeadRot * n, hw);
  // the double-sided mouth cavity has zero-length normals (opposite faces cancel)
  float nl = length(n);
  n = nl > 1e-6 ? n / nl : vec3(0.0, 0.0, 1.0);
  vRest = position;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPos = wp.xyz;
  vNrm = mat3(modelMatrix) * n;
  vAux = aAux;
  vCav = aCav;
  vShell.xyz = normalize(mat3(modelMatrix) * mix(aShell.xyz * 2.0 - 1.0, uHeadRot * (aShell.xyz * 2.0 - 1.0), hw));
  vShell.w = aShell.w;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const HEAD_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform float uTime;
uniform float uEnergy;
uniform float uSpeech;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uError;
uniform float uSleep;
uniform float uFx;
uniform vec3 uColLine;
uniform vec3 uColRim;
uniform vec3 uColEye;
uniform vec3 uColGrid;
uniform mat3 uHeadRot;
uniform vec3 uGridCenter;
uniform vec4 uGrid;        // meridians around the head, latitude step (rad), line half width, web cell
uniform vec3 uMouthC;
uniform vec3 uNoseTip;
uniform vec3 uPulseOrigin;
uniform vec2 uNeck;        // rest y: fully faded, fully visible
uniform sampler2D tCurves;
uniform int uChunkBase;
uniform int uGroupBase;
uniform int uGroupCount;
uniform float uCurveRange;
uniform vec3 uEyeC[2];
uniform vec3 uEyeX[2];
uniform vec3 uEyeY[2];
uniform vec4 uEyeUp[2];    // upper lid coefficients c0 c1 c2, half width
uniform vec4 uEyeLo[2];    // lower lid coefficients, crease offset
uniform vec4 uEyeBall[2];  // centre, radius
uniform vec2 uEyeIris[2];  // iris / pupil angular radius on the ball
uniform vec3 uGaze[2];
uniform vec2 uBlink;
uniform float uSquint;
varying vec3 vRest;
varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vAux;
varying vec4 vCav;
varying vec4 vShell;

const float PI = 3.14159265;
const float TAU = 6.2831853;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// Anti-aliased line of half width w at distance d, fw = pixel footprint in the same units.
// Sub-pixel lines keep their energy (dimmer, not wider).
float lineAA(float d, float w, float fw) {
  float we = max(w, 0.5 * fw);
  return (1.0 - smoothstep(we - 0.5 * fw, we + 0.5 * fw, d)) * (w / we);
}
// Periodic lines along u (period 1); fades to the mean coverage before it can alias.
float gridLines(float u, float w) {
  float fw = fwidth(u);
  float l = lineAA(abs(fract(u + 0.5) - 0.5), w, fw);
  return mix(l, 2.0 * w, smoothstep(0.3, 0.6, fw));
}

// ---- gold contour curves (polylines in a float texture) -------------------------------------
vec4 fetchT(int i) { return texelFetch(tCurves, ivec2(i % CURVE_TEX_W, i / CURVE_TEX_W), 0); }

// x: distance to the nearest curve, y: its intensity, z: distance of that point to the pulse origin.
// Two-level culling: curve bounding spheres, then chunk spheres, then the segments.
vec3 nearestCurve(vec3 p) {
  float best = 1e9;
  float inten = 0.0;
  vec3 at = p;
  for (int g = 0; g < MAX_GROUPS; g++) {
    if (g >= uGroupCount) break;
    vec4 gb = fetchT(uGroupBase + 2 * g);
    vec3 dg = p - gb.xyz;
    if (dot(dg, dg) > gb.w * gb.w) continue;
    vec4 gi = fetchT(uGroupBase + 2 * g + 1);
    int c0 = int(gi.x + 0.5);
    int nc = int(gi.y + 0.5);
    for (int k = 0; k < MAX_CHUNKS; k++) {
      if (k >= nc) break;
      vec4 b = fetchT(uChunkBase + 2 * (c0 + k));
      vec3 dc = p - b.xyz;
      if (dot(dc, dc) > b.w * b.w) continue;
      vec4 info = fetchT(uChunkBase + 2 * (c0 + k) + 1);
      int s = int(info.x + 0.5);
      int cnt = int(info.y + 0.5);
      vec4 a = fetchT(s);
      for (int i = 1; i <= MAX_SEG; i++) {
        if (i > cnt) break;
        vec4 c = fetchT(s + i);
        vec3 ab = c.xyz - a.xyz;
        float t = clamp(dot(p - a.xyz, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
        vec3 q = a.xyz + ab * t;
        vec3 dq = q - p;
        float d2 = dot(dq, dq);
        if (d2 < best) { best = d2; inten = mix(a.w, c.w, t); at = q; }
        a = c;
      }
    }
  }
  return vec3(sqrt(best), inten, length(at - uPulseOrigin));
}

// ---- irregular web (2D Voronoi on an arc-length parametrisation) ----------------------------
vec3 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0, f3 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = 0.12 + 0.76 * hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f3 = f2; f2 = f1; f1 = d; }
    else if (d < f2) { f3 = f2; f2 = d; }
    else if (d < f3) { f3 = d; }
  }
  return sqrt(vec3(f1, f2, f3));
}

// ---- eyes ---------------------------------------------------------------------------------------
// Analytic eyeball behind an almond aperture on the lid surface. Writes the eye colour into
// col (coverage-mixed) and returns (aperture coverage, eye-region mask).
vec2 eye(int i, vec3 p, vec3 rd, float px, float blink, float glow, inout vec3 col) {
  vec3 q = p - uEyeC[i];
  float hwid = uEyeUp[i].w;
  float t = dot(q, uEyeX[i]) / hwid;
  float y = dot(q, uEyeY[i]);
  if (abs(t) > 1.7 || abs(y) > hwid * 1.3) return vec2(0.0);
  float tt = clamp(t, -1.0, 1.0);
  float base = 1.0 - tt * tt;
  float yu = base * (uEyeUp[i].x + (uEyeUp[i].y + uEyeUp[i].z * tt) * tt);
  float yl = base * (uEyeLo[i].x + (uEyeLo[i].y + uEyeLo[i].z * tt) * tt);
  yl = mix(yl, yu, uSquint);
  float yc = mix(yl, yu, 0.3);                    // where the lids meet when closed
  float yu2 = mix(yu, yc, blink);
  float yl2 = mix(yl, yc, blink);
  float corner = 1.0 - smoothstep(0.9, 1.08, abs(t));
  float open = max(yu2 - yl2, 0.0);
  float aa = max(px, 1e-5);
  float inside = smoothstep(-aa, aa, yu2 - y) * smoothstep(-aa, aa, y - yl2) * (1.0 - smoothstep(0.96, 1.0, abs(t)));
  inside *= smoothstep(0.0, 2.0 * aa, open);

  vec3 ec = vec3(0.0);
  if (inside > 0.0) {
    vec4 B = uEyeBall[i];
    vec3 oc = p - B.xyz;
    float bb = dot(oc, rd);
    float cc = dot(oc, oc) - B.w * B.w;
    float disc = bb * bb - cc;
    vec3 hit = disc > 0.0 ? p + rd * (-bb - sqrt(disc)) : B.xyz + normalize(oc - rd * bb) * B.w;
    vec3 nb = normalize(hit - B.xyz);
    vec3 g = uGaze[i];
    float ang = acos(clamp(dot(nb, g), -1.0, 1.0));
    float fa = fwidth(ang) + 1e-4;
    float irisA = uEyeIris[i].x, pupA = uEyeIris[i].y;
    vec3 gx = normalize(cross(vec3(0.0, 1.0, 0.0), g));
    vec3 gy = cross(g, gx);
    float phi = atan(dot(nb, gy), dot(nb, gx));
    // sunburst iris: bright radial rays around a dark pupil, amber-white sclera
    float fib = hash12(vec2(floor(phi * 14.0 + 40.0), float(i)));
    float rays = 0.5 + 0.5 * sin(phi * 46.0 + fib * 5.0 + 2.0 * sin(phi * 9.0));
    rays = mix(rays, 1.0, smoothstep(irisA * 0.85, irisA, ang) * 0.5);
    float irisM = 1.0 - smoothstep(irisA - fa, irisA + fa, ang);
    float pupM = 1.0 - smoothstep(pupA - fa, pupA + fa, ang);
    float limb = exp(-pow((ang - irisA * 0.97) / (irisA * 0.09 + fa), 2.0));
    float pupRing = exp(-pow((ang - pupA * 1.3) / (pupA * 0.35 + fa), 2.0));
    vec3 hot = mix(uColEye, vec3(1.0, 0.94, 0.82), 0.6);
    vec3 sclera = uColEye * (0.6 + 0.6 * smoothstep(irisA * 2.3, irisA, ang));
    float radial = smoothstep(pupA, irisA, ang);
    vec3 iris = mix(hot * 1.5, uColEye, radial * 0.6) * (0.6 + 0.8 * rays);
    ec = mix(sclera, iris, irisM) + hot * (limb * 0.8 + pupRing * 1.1);
    ec = mix(ec, vec3(0.045, 0.025, 0.012), pupM * 0.95);
    // the lids shade the ball toward the edges of the opening
    float edgeD = min(yu2 - y, y - yl2) / max(open * 0.5, 1e-4);
    ec *= (0.55 + 0.45 * smoothstep(0.0, 0.9, edgeD)) * (0.75 + 0.25 * corner);
    ec *= glow;
  }
  col = mix(col, ec, inside);

  // lid margins (gold), brighter when the lids meet; soft warm halo around the almond
  float wl = max(0.0007, 0.55 * px);
  float lu = lineAA(abs(y - yu2), wl, 1.4 * px);
  float ll = lineAA(abs(y - yl2), wl * 0.8, 1.4 * px);
  float margin = max(lu, ll * 0.75) * corner;
  float dOut = max(y - yu2, yl2 - y);
  float halo = exp(-max(dOut, 0.0) / (0.008 + 0.004 * blink)) * (1.0 - inside) * (1.0 - smoothstep(0.85, 1.3, abs(t)));
  col += uColEye * (margin * (1.3 + 1.6 * blink) + halo * (0.42 + 0.35 * blink)) * glow;
  // upper-lid crease: a fainter gold arc above the opening
  float yCrease = yu + uEyeLo[i].w * (0.4 + 0.6 * base);
  col += uColLine * lineAA(abs(y - yCrease), wl * 0.8, 1.4 * px) * 0.5 * (1.0 - smoothstep(0.8, 1.1, abs(t)));
  // region: the almond and the lid margins around it (keeps crease darkening off the eye)
  float region = (1.0 - smoothstep(0.95, 1.1, abs(t))) * (1.0 - smoothstep(0.0, 0.004, max(y - yu, yl - y)));
  return vec2(inside, region);
}

void main() {
  vec3 p = vRest;
  vec3 N = normalize(vNrm);
  vec3 Vv = normalize(cameraPosition - vPos);
  if (!gl_FrontFacing) N = -N;
  float NdV = clamp(dot(N, Vv), 0.0, 1.0);
  float SdV = clamp(dot(normalize(vShell.xyz), Vv), 0.0, 1.0);   // outer-shell facing (edge glow)
  // world units per pixel at this fragment (rest space; the rig barely scales it)
  float px = max(length(fwidth(p)) * 0.7, 1e-6);
  float e = uEnergy - 0.5;
  float glow = (1.0 + 0.55 * e + 0.25 * uListen + 0.2 * uSpeech * uSpeak) * (1.0 - 0.45 * uSleep);

  // ---- mouth cavity -------------------------------------------------------------------------
  if (vCav.x > 0.5) {
    float s = vCav.z;                       // 0 at the lips .. 1 at the throat
    float upper = step(0.75, vCav.w);
    vec3 c = vec3(0.012, 0.007, 0.006) * (1.0 - 0.7 * s);
    // teeth hint: a row just behind each lip, with dark gaps between the teeth
    float tu = (vCav.y - 0.5) * 2.0;        // -1 .. 1 across the mouth
    float band = upper > 0.5 ? smoothstep(0.03, 0.08, s) * (1.0 - smoothstep(0.24, 0.34, s))
                             : smoothstep(0.05, 0.1, s) * (1.0 - smoothstep(0.2, 0.28, s));
    float tooth = abs(fract(tu * (upper > 0.5 ? 4.0 : 4.6) + 0.5) - 0.5);
    float gap = smoothstep(0.02, 0.09, tooth);
    float centre = 1.0 - smoothstep(0.55, 0.95, abs(tu));
    vec3 teeth = mix(vec3(0.62, 0.6, 0.56), uColLine * 0.6, 0.2) * (upper > 0.5 ? 0.75 : 0.3);
    c += teeth * band * gap * centre * glow;
    gl_FragColor = vec4(c, 1.0);
    return;
  }

  // ---- lighting (world space: the light stays put while the head turns) ---------------------
  vec3 Lk = normalize(vec3(0.36, 0.2, 0.9));
  float dif = clamp((dot(N, Lk) + 0.1) / 1.1, 0.0, 1.0);
  float fill = clamp(dot(N, normalize(vec3(-0.55, -0.1, 0.6))), 0.0, 1.0);
  vec3 H = normalize(Lk + Vv);
  float spec = pow(clamp(dot(N, H), 0.0, 1.0), 30.0);
  float ao = mix(1.0, vAux.x, 0.9);
  float conv = vAux.y * 2.0 - 1.0;                      // >0 ridges (nose, lips), <0 sockets / folds
  float cav = clamp(1.0 - 0.9 * max(-conv, 0.0), 0.0, 1.0);
  float ridge = clamp(conv * 1.4, 0.0, 1.0);
  float facing = smoothstep(0.05, 0.8, NdV);
  float crown = mix(1.0, 0.5, smoothstep(0.3, 0.47, p.y));   // the top of the head stays dim
  float lit = (0.05 + 0.45 * pow(dif, 1.8) + 0.1 * fill + 0.15 * ridge * ridge * facing) * ao * cav * (0.3 + 0.7 * facing) * crown;
  float side = pow(1.0 - SdV, 0.95);                    // hologram: the outer shell's edges glow
  float lips = vAux.z;
  float ear = vAux.w;
  // warmth: the glow of eyes, nose and mouth tints the surrounding grid gold
  float warm = 0.0;
  for (int i = 0; i < 2; i++) warm = max(warm, exp(-length(p - uEyeC[i]) / 0.06));
  warm = max(warm, 0.8 * exp(-length((p - uMouthC) * vec3(0.7, 1.0, 1.0)) / 0.05));
  warm = max(warm, 0.85 * exp(-length((p - uNoseTip) * vec3(1.0, 0.55, 1.0)) / 0.045));
  warm = max(warm, lips);

  // ---- dark glass body ----------------------------------------------------------------------
  vec3 col = vec3(0.012, 0.016, 0.022) * (0.4 + 2.6 * lit) + mix(vec3(0.03, 0.04, 0.048), uColRim * 0.09, 0.55) * side * side * (0.4 + 0.6 * crown);
  col += mix(vec3(0.5, 0.52, 0.56), uColLine, 0.4 * warm) * spec * (0.25 + 0.5 * ridge) * ao * cav;
  // soft sheen on the facial features (nose, lips, brow and cheek bones), as on polished glass
  float sheen = pow(clamp(dot(N, H), 0.0, 1.0), 6.0) * ridge * (0.25 + 0.75 * warm) * ao * cav;
  col += mix(vec3(0.62, 0.64, 0.68), uColLine, 0.45 * warm) * sheen * 0.45;
  float rim = pow(1.0 - SdV, 6.0) * smoothstep(0.55, 0.9, ao);

  // ---- grid ---------------------------------------------------------------------------------
  // spherical grid around the cranium centre, pole tilted back so the latitude lines arc over
  // the forehead like the reference's edge flow
  vec3 d = p - uGridCenter;
  const vec3 POLE = vec3(0.0, 0.94, -0.34);
  const vec3 FRONT = vec3(0.0, 0.34, 0.94);
  float dz = dot(d, FRONT);
  float rxz = length(vec2(d.x, dz));
  float lon = atan(d.x, dz);
  float lat = atan(dot(d, POLE), rxz);
  float w = uGrid.z;
  float g = max(gridLines(lon * uGrid.x / TAU, w * 0.85), gridLines(lat / uGrid.y, w));
  // concentric loops + spokes around the eyes and along the lips (the reference's edge loops)
  float loopsW = 0.0, loops = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 q = p - uEyeC[i];
    vec2 l2 = vec2(dot(q, uEyeX[i]), dot(q, uEyeY[i]) * 1.25);
    float r = length(l2);
    float wgt = 1.0 - smoothstep(0.05, 0.1, r);
    if (wgt > 0.0) {
      float ring = gridLines(r / 0.0072, w * 1.1);
      float spoke = gridLines(atan(l2.y, l2.x) * 72.0 / TAU, w) * smoothstep(0.012, 0.03, r);
      loops = max(loops, max(ring, spoke) * wgt);
      loopsW = max(loopsW, wgt);
    }
  }
  {
    vec3 q = p - uMouthC;
    vec2 l2 = vec2(q.x * 0.62, (q.y + 0.004) * 1.45);
    float r = length(l2);
    float wgt = (1.0 - smoothstep(0.045, 0.08, r)) * smoothstep(-0.1, -0.03, q.z);
    if (wgt > 0.0) {
      float ring = gridLines(r / 0.0052, w * 1.1);
      float spoke = gridLines(atan(l2.y, l2.x) * 64.0 / TAU, w) * smoothstep(0.02, 0.035, r);
      // on the lips themselves: lines running along the lips, crossed by the meridians
      float along = gridLines((q.y + 6.0 * q.x * q.x) / 0.0034, w * 1.1);
      float lipLoops = max(along, gridLines(lon * uGrid.x / TAU, w));
      float onLips = smoothstep(0.2, 0.6, lips);
      loops = max(loops, mix(max(ring, spoke * 0.8), lipLoops, onLips) * wgt);
      loopsW = max(loopsW, wgt);
    }
  }
  g = max(g * (1.0 - 0.85 * loopsW), loops);
  // shimmer: slow travelling variations of the grid brightness
  float shimmer = 0.7 + 0.6 * vnoise(p * 9.0 + vec3(0.0, uTime * 0.35, uTime * 0.12));
  float gridLit = (0.08 + 1.1 * lit + 1.8 * side * side * (0.5 + 0.5 * crown) + 1.0 * warm * ao) * shimmer;
  vec3 neutral = vec3(0.66, 0.67, 0.7);
  vec3 gridCol = mix(neutral, uColGrid, 0.3);
  gridCol = mix(gridCol, uColRim, 0.75 * pow(1.0 - SdV, 2.5));
  gridCol = mix(gridCol, uColRim, 0.35 * (1.0 - crown) / 0.5);   // the crown is cooler
  gridCol = mix(gridCol, uColLine, 0.8 * warm);
  col += gridCol * g * gridLit * 0.26;

  // ---- irregular web (warm) + bright nodes ------------------------------------------------------
  vec2 wuv = vec2(lon * max(rxz, 0.12), lat * 0.36) / uGrid.w;
  float fwu = length(fwidth(wuv)) * 0.7 + 1e-5;
#if PH_WEB
  {
    vec3 vf = voronoi(wuv);
    // small windows: cells under ~20 px would read as a coarse scaly texture -> fade to the mean
    float webFade = 1.0 - smoothstep(0.045, 0.12, fwu);
    float edge = mix(0.02, lineAA((vf.y - vf.x) * 0.5, 0.014, fwu), webFade);
    float node = lineAA((vf.z - vf.x) * 0.5, 0.024, fwu) * (0.35 + 0.65 * webFade);
    vec3 webCol = mix(mix(uColLine, neutral, 0.2), uColRim, 0.6 * pow(1.0 - SdV, 3.0));
    float vary = 0.45 + 1.1 * vnoise(p * 55.0);           // some strands brighter than others
    col += webCol * edge * gridLit * 0.5 * vary + vec3(0.92, 0.96, 1.0) * node * gridLit * 0.6;
  }
#endif
  // sparkles at random grid crossings (twinkle)
  {
    vec2 gc = vec2(lon * uGrid.x / TAU, lat / uGrid.y);
    vec2 cell = floor(gc + 0.5);
    float h = hash12(cell);
    vec2 fc = (gc - cell) * vec2(1.0, 0.65);
    float fws = length(fwidth(gc)) + 1e-5;
    float rs = max(0.1, 0.5 * fws);
    float dot_ = exp(-dot(fc, fc) / (rs * rs)) * smoothstep(0.62, 0.95, h) * (0.1 / rs);
    float tw = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * (1.2 + 3.0 * h) + h * 40.0), 3.0);
    vec3 sc = mix(vec3(0.85, 0.92, 1.0), uColRim, step(0.93, fract(h * 13.7)));
    col += sc * min(dot_, 1.5) * tw * (0.25 + 0.9 * lit + 0.6 * side) * 0.9 * uFx;
  }

  // fine dust: tiny glints on a finer lattice (the reference's "stardust" skin)
  {
    vec2 gc = vec2(lon * uGrid.x / TAU, lat / uGrid.y) * vec2(2.0, 1.5) + 17.0;
    vec2 cell = floor(gc);
    float h = hash12(cell + 91.0);
    vec2 o = hash22(cell + 7.0) * 0.8 + 0.1;
    vec2 fc = (gc - cell - o);
    float fws = length(fwidth(gc)) + 1e-5;
    float rs = max(0.08, 0.55 * fws);
    float dust = exp(-dot(fc, fc) / (rs * rs)) * smoothstep(0.45, 0.95, h) * min(1.0, 0.08 / rs);
    float tw = 0.4 + 0.6 * sin(uTime * (0.8 + 2.0 * h) + h * 30.0) * 0.5 + 0.3;
    col += mix(vec3(0.8, 0.88, 1.0), uColLine, warm * 0.6) * dust * tw * (0.2 + 0.8 * lit + 0.5 * side) * 0.7 * uFx;
  }

  // ---- gold contour lines + energy pulses ---------------------------------------------------
  // per-vertex distance to the nearest curve (baked) lets most fragments skip the search; the
  // margin covers the interpolation error over a triangle
  vec3 nc = vCav.y * uCurveRange > 0.022 ? vec3(1.0, 0.0, 0.0) : nearestCurve(p);
  float wg = max(0.00055, 0.38 * px);
  float gl = lineAA(nc.x, wg, 1.5 * px) * nc.y;
  float gglow = exp(-nc.x / 0.0022) * nc.y * 0.1;
  float pulseAmt = 0.15 + 0.9 * uThink + 0.5 * uSpeak * (0.3 + uSpeech) + 0.35 * uListen;
  float wave = fract(nc.z * 2.2 - uTime * (0.3 + 0.45 * uThink));
  float band = smoothstep(0.0, 0.05, wave) * (1.0 - smoothstep(0.05, 0.2, wave));
  float lineLit = 0.45 + 0.7 * lit + 0.3 * warm;
  vec3 gold = mix(uColLine, vec3(1.0, 0.93, 0.82), 0.25);
  col += gold * (gl * (0.75 * lineLit + band * pulseAmt * 1.6 * uFx) + gglow * lineLit) * glow;

  // ---- lips: warm glowing vermilion ------------------------------------------------------------
  vec3 lipTint = mix(uColLine, vec3(0.95, 0.9, 0.84), 0.3);
  vec3 lipCol = lipTint * (0.09 + 0.32 * pow(dif, 1.4) * ao * cav + 0.15 * ridge + 0.8 * spec) * (1.0 + 0.9 * uSpeech * uSpeak);
  col = mix(col, col * 0.75 + lipCol, lips * 0.7);

  // ---- eyes (+ warm light spilling into the sockets) ------------------------------------------
  vec3 rd = transpose(uHeadRot) * normalize(vPos - cameraPosition);
  for (int i = 0; i < 2; i++) {
    vec3 q = p - uEyeC[i];
    float r = length(vec2(dot(q, uEyeX[i]), dot(q, uEyeY[i]) * 1.6));
    col += uColEye * (exp(-r / 0.05) * 0.42 + exp(-r / 0.012) * 0.25) * (1.0 - (i == 0 ? uBlink.x : uBlink.y) * 0.5) * glow * ao * facing;
  }
  // the whole mid-face catches a little of that warm light (an inner glow, as in the reference)
  vec2 fc2 = (p.xy - vec2(uNoseTip.x, uNoseTip.y + 0.04)) / vec2(0.15, 0.2);
  float faceGlow = exp(-dot(fc2, fc2)) * facing;
  col += uColEye * (0.05 * warm * lit + 0.045 * faceGlow * (0.4 + lit)) * glow;
  vec2 eyeA = eye(0, p, rd, px, uBlink.x, glow, col);
  vec2 eyeB = eye(1, p, rd, px, uBlink.y, glow, col);
  float eyeCov = max(eyeA.x, eyeB.x);
  float eyeRegion = max(eyeA.y, eyeB.y);

  // deep creases (inner lip walls, nostril holes) sink into darkness like the mouth cavity
  // skin stretched far beyond its rest size (the inner lip walls when the jaw opens) carries no
  // pattern either: treat it as mouth interior
  float stretch = length(fwidth(vPos)) / max(length(fwidth(p)), 1e-7);
  float deep = max(max(smoothstep(0.55, 0.22, vAux.x), vShell.w), smoothstep(1.6, 2.6, stretch));
  deep *= 1.0 - eyeRegion;              // the scan's closed-lid crease lies inside the open eye
  col = mix(col, vec3(0.012, 0.007, 0.006), deep * 0.92);

  // ---- fresnel rim, ears, scan line -------------------------------------------------------------
  vec3 rimCol = mix(uColRim, vec3(0.8, 0.95, 1.0), 0.35) * rim * (0.4 + 0.8 * max(e, 0.0) + 0.7 * uListen);
  col += rimCol * (1.0 - eyeCov) * smoothstep(uNeck.y - 0.04, uNeck.y + 0.1, p.y);
  col *= 1.0 - 0.6 * ear;
  float scanY = 0.55 - fract(uTime * 0.07) * 1.3;
  col += uColRim * exp(-pow((p.y - scanY) * 55.0, 2.0)) * (0.03 + 0.2 * lit) * 0.6 * uFx;

  // ---- neck dissolves into the particle field ------------------------------------------------
  float nz = vnoise(p * 22.0 + vec3(0.0, -uTime * 0.3, uTime * 0.1));
  float neck = smoothstep(uNeck.x, uNeck.y, p.y + (nz - 0.5) * 0.07);
  col *= smoothstep(uNeck.x + 0.05, uNeck.y + 0.1, p.y) * 0.97 + 0.03 * neck;
  float alpha = neck * (1.0 - 0.6 * ear);

  // ---- states -----------------------------------------------------------------------------------
  if (uError > 0.001) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    float fl = 0.72 + 0.28 * step(0.45, hash12(vec2(floor(uTime * 17.0), 3.0)));
    col = mix(col, vec3(l * 1.2, l * 0.42, l * 0.38) * fl, uError * 0.7);
  }
  col *= (1.0 - 0.45 * uSleep) * (1.0 + 0.3 * e);
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(col * alpha, alpha);      // premultiplied
}`;
