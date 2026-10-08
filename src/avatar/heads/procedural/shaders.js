// GLSL for the procedural hologram head (one draw call: skin + mouth cavity).
//
// Every surface pattern (grid, web, gold lines, eyes) is evaluated on the REST-pose position, so
// it sticks to the skin while the rig deforms it, and is anti-aliased with screen-space
// derivatives (lines keep ~1 px, dense grids fade to their mean instead of moire).
//
// Look (docs/reference/*.jpg): an emissive glass head lit from WITHIN. Brightness lives in the
// line work (fine grid, irregular web, gold contours) over a dark blue-grey body; the face
// interior, nose, eyes and lips glow, the silhouette is a translucent fresnel of brighter cyan
// lines (bloom makes the outer glow), the neck dissolves additively into the particle field.

import { CURVE_TEX_WIDTH, MAX_CHUNKS_PER_GROUP, MAX_CURVE_GROUPS, MAX_SEGMENTS_PER_CHUNK } from './format.js';

/** Compile-time knobs (material.defines). */
export const DEFAULT_DEFINES = Object.freeze({
  CURVE_TEX_W: CURVE_TEX_WIDTH,
  MAX_GROUPS: MAX_CURVE_GROUPS,
  MAX_CHUNKS: MAX_CHUNKS_PER_GROUP,
  MAX_SEG: MAX_SEGMENTS_PER_CHUNK,
  PH_WEB: 1,        // irregular web + nodes (off on the low tier)
  PH_DUST: 1,       // fine twinkling dust (off on the low tier)
});

// Rig deformation shared by the head and its halo (HEAD_VERT / HALO_VERT).
const RIG_CHUNK = /* glsl */ `
attribute vec4 aRig0;   // jaw, upperLip, lowerLip, cornerL
attribute vec4 aRig1;   // cornerR, browL, browR, cheek
uniform mat3 uJawRot;
uniform vec3 uJawPivot;
uniform mat3 uHeadRot;
uniform vec3 uHeadPivot;
uniform vec3 uCornerL;
uniform vec3 uCornerR;
uniform vec4 uLips;     // upperLift, lowerDrop, push, cheek
uniform vec4 uMouthX;   // press thinning, press roll-in, tuck draw-back (world units), tongue
uniform vec2 uBrow;
uniform float uBreathY;
uniform vec2 uNeckRot;  // rest y: head rotation weight 0 at x, 1 at y (the neck stays put)
// expression + jaw (head frame); n is carried through the jaw hinge
vec3 rigFace(vec3 p, inout vec3 n) {
  p += aRig0.w * uCornerL + aRig1.x * uCornerR;
  p.y += aRig0.y * uLips.x - aRig0.z * uLips.y;
  p.z += (aRig0.y + aRig0.z) * uLips.z;
  // pressed lips thin toward the seam (aExtra.y = seam closeness) and roll in; a tucked lower
  // lip draws back under the upper teeth
  p.y += (aRig0.z - aRig0.y) * uMouthX.x * (1.0 - aExtra.y);
  p.z -= (aRig0.y + aRig0.z) * uMouthX.y * aExtra.y + aRig0.z * uMouthX.z;
  p.y += aRig1.y * uBrow.x + aRig1.z * uBrow.y;
  p += aRig1.w * vec3(0.0, uLips.w, uLips.w * 0.35);
  // jaw hinge (weighted rotation = a smooth skin blend between skull and mandible)
  p = mix(p, uJawPivot + uJawRot * (p - uJawPivot), aRig0.x);
  n = mix(n, uJawRot * n, aRig0.x);
  return p;
}
// head rotation weight (0 on the lower neck, 1 on the head)
float headWeight(vec3 rest) { return smoothstep(uNeckRot.x, uNeckRot.y, rest.y); }
vec3 rigHead(vec3 p, float hw) {
  p = mix(p, uHeadPivot + uHeadRot * (p - uHeadPivot), hw);
  p.y += uBreathY * hw;
  return p;
}
`;

export const HEAD_VERT = /* glsl */ `
attribute vec4 aAux;    // ao, convexity, lips, ear
attribute vec4 aCav;    // cavity flag, u, v, side
attribute vec4 aShell;  // smoothed outer-shell normal (encoded), inner-mouth mask
attribute vec4 aExtra;  // neck (below the jaw line), seam closeness, seam side (1 = upper), -
${RIG_CHUNK}
varying vec3 vRest;
varying vec3 vDef;      // deformed position before the head rotation (head frame)
varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vAux;
varying vec4 vCav;
varying vec4 vShell;
varying vec4 vExtra;
void main() {
  vec3 n = normal;
  vec3 p = rigFace(position, n);
  vDef = p;
  float hw = headWeight(position);
  p = rigHead(p, hw);
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
  vExtra = aExtra;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Halo: the same (deformed) surface pushed out along the outer-shell normal and drawn
// additively with a fresnel profile, so the edge glows a few pixels beyond the silhouette like the
// reference's soft cyan outline (the bloom alone only catches lines brighter than its threshold).
export const HALO_VERT = /* glsl */ `
attribute vec4 aAux;
attribute vec4 aCav;
attribute vec4 aShell;
attribute vec4 aExtra;
${RIG_CHUNK}
uniform float uHaloOffset;
varying vec3 vSN;
varying vec3 vHPos;
varying vec4 vHF;       // cavity, neck, ear, rest y
void main() {
  vec3 n = normal;
  vec3 p = rigFace(position, n);
  float hw = headWeight(position);
  p = rigHead(p, hw);
  vec3 sn = normalize(mix(aShell.xyz * 2.0 - 1.0, uHeadRot * (aShell.xyz * 2.0 - 1.0), hw));
  vec4 wp = modelMatrix * vec4(p + sn * uHaloOffset * (1.0 - aCav.x), 1.0);
  vSN = normalize(mat3(modelMatrix) * sn);
  vHPos = wp.xyz;
  vHF = vec4(aCav.x, aExtra.x, aAux.w, position.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const HALO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColRim;
uniform float uHalo;
uniform float uListen;
uniform float uSleep;
uniform float uEnergy;
varying vec3 vSN;
varying vec3 vHPos;
varying vec4 vHF;
void main() {
  if (vHF.x > 0.5) discard;                         // mouth cavity
  float sdv = abs(dot(normalize(vSN), normalize(cameraPosition - vHPos)));
  // peaks just outside the head's silhouette, fades to nothing at the halo's own edge
  // (for the shell offset the head's silhouette sits at sdv ~0.25: outside it the halo fades to
  // its own edge, inside it gives way within ~10 px to the head's own rim lines)
  float g = smoothstep(0.02, 0.2, sdv) * (1.0 - smoothstep(0.2, 0.28, sdv));
  float crown = smoothstep(0.18, 0.42, vHF.w);
  g *= (1.0 - crown) * (1.0 - vHF.y) * (1.0 - 0.9 * vHF.z);
  vec3 c = uColRim * g * uHalo;
  c *= (1.0 + 0.3 * uListen + 0.4 * (uEnergy - 0.5)) * (1.0 - 0.5 * uSleep);
  gl_FragColor = vec4(c, 0.0);                      // pure light (additive)
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
uniform mat3 uJawRot;
uniform vec3 uJawPivot;
uniform vec3 uGridCenter;
uniform vec4 uGrid;        // meridians around the head, latitude step (rad), line half width, web cell
uniform vec3 uMouthC;
uniform vec4 uMouth;       // rest lip seam y(dx) = x + y dx^2 + z dx^4 (dx from the mouth centre), w = half width
uniform vec4 uMouthX;      // press thinning, press roll-in, tuck draw-back, tongue tip amount
uniform vec3 uNoseTip;
uniform vec3 uNoseBridge;
uniform vec3 uPulseOrigin;
uniform vec2 uNeck;        // rest y: fully faded, fully visible
uniform float uNeckHW;     // neck half width (the reference neck is slender)
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
varying vec3 vDef;
varying vec3 vPos;
varying vec3 vNrm;
varying vec4 vAux;
varying vec4 vCav;
varying vec4 vShell;
varying vec4 vExtra;

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
// x, y, z: distances to the nearest three cell points; w: a random value per cell pair (strand)
vec4 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0, f3 = 8.0;
  float h1 = 0.0, h2 = 0.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 hh = hash22(n + g);
    vec2 o = 0.12 + 0.76 * hh;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f3 = f2; f2 = f1; h2 = h1; f1 = d; h1 = hh.x; }
    else if (d < f2) { f3 = f2; f2 = d; h2 = hh.x; }
    else if (d < f3) { f3 = d; }
  }
  return vec4(sqrt(vec3(f1, f2, f3)), fract((h1 + h2) * 7.31));
}

// One web layer at cell coordinates uv: x = strand coverage (anti-aliased, fades to its mean
// when the cells get smaller than ~4 px), y = bright node where three cells meet (sparse),
// z = per-strand brightness.
// fwu = cell units per pixel (computed by the caller in uniform control flow).
vec3 webLayer(vec2 uv, float fwu) {
  vec4 vf = voronoi(uv);
  float fade = 1.0 - smoothstep(0.16, 0.32, fwu);
  float strand = mix(0.05, lineAA((vf.y - vf.x) * 0.5, 0.016, fwu), fade);
  float node = lineAA((vf.z - vf.x) * 0.5, 0.035, fwu) * step(0.62, vf.w) * fade;
  return vec3(strand, node, 0.45 + 1.1 * vf.w);
}

// ---- eyes ---------------------------------------------------------------------------------------
// Analytic eyeball behind an almond aperture on the lid surface. Writes the eye colour into
// col (coverage-mixed) and returns (aperture coverage, eye-region mask). gridG = the skin grid
// coverage at this point (it continues faintly over the ball, as in the reference).
vec2 eye(int i, vec3 p, vec3 rd, float px, float blink, float glow, float gridG, inout vec3 col) {
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
    // sunburst iris: a white-gold disc of radial rays around a dark pupil, brightest in a ring
    // just outside the pupil, amber toward the limbus; amber sclera dimming toward the corners
    float fib = hash12(vec2(floor(phi * 14.0 + 40.0), float(i)));
    float rays = 0.5 + 0.5 * sin(phi * 46.0 + fib * 5.0 + 2.0 * sin(phi * 9.0));
    float irisM = 1.0 - smoothstep(irisA - fa, irisA + fa, ang);
    float pupM = 1.0 - smoothstep(pupA - fa, pupA + fa, ang);
    float radial = clamp((ang - pupA) / max(irisA - pupA, 1e-4), 0.0, 1.0);
    float ring = exp(-pow((radial - 0.22) / 0.2, 2.0));
    float limb = exp(-pow((ang - irisA * 0.97) / (irisA * 0.07 + fa), 2.0));
    vec3 hot = vec3(1.0, 0.86, 0.6);
    vec3 irisC = mix(hot, uColEye, smoothstep(0.25, 1.0, radial));
    vec3 iris = irisC * (0.66 + 0.3 * rays + 0.25 * ring) + uColEye * limb * 0.25;
    vec3 scl = mix(uColEye, vec3(1.0, 0.86, 0.66), 0.2);
    vec3 sclera = scl * (0.5 + 0.45 * smoothstep(irisA * 2.8, irisA * 1.05, ang)) * (0.8 + 0.9 * gridG);
    ec = mix(sclera, iris, irisM);
    ec = mix(ec, vec3(0.1, 0.05, 0.025), pupM * 0.93);
    // the lids shade the ball toward the edges of the opening
    float edgeD = min(yu2 - y, y - yl2) / max(open * 0.5, 1e-4);
    ec *= (0.6 + 0.4 * smoothstep(0.0, 0.9, edgeD)) * (0.75 + 0.25 * corner);
    ec *= glow;
  }
  col = mix(col, ec, inside);

  // lid margins (gold), brighter when the lids meet; soft warm halo around the almond
  float wl = max(0.0006, 0.5 * px);
  float lu = lineAA(abs(y - yu2), wl, 1.4 * px);
  float ll = lineAA(abs(y - yl2), wl * 0.8, 1.4 * px);
  float margin = max(lu, ll * 0.75) * corner;
  float dOut = max(y - yu2, yl2 - y);
  float halo = exp(-max(dOut, 0.0) / (0.009 + 0.004 * blink)) * (1.0 - inside) * (1.0 - smoothstep(0.85, 1.3, abs(t)));
  col += uColEye * (margin * (1.3 + 1.5 * blink) + halo * (0.62 + 0.3 * blink)) * glow;
  // upper-lid crease: a fainter gold arc above the opening
  float yCrease = yu + uEyeLo[i].w * (0.4 + 0.6 * base);
  col += uColLine * lineAA(abs(y - yCrease), wl * 0.7, 1.4 * px) * 0.45 * (1.0 - smoothstep(0.8, 1.1, abs(t)));
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
  float glow = (1.0 + 0.55 * e + 0.15 * uListen + 0.2 * uSpeech * uSpeak) * (1.0 - 0.45 * uSleep);

  // ---- mouth cavity: dark warm interior, rows of teeth behind the lips -------------------------
  if (vCav.x > 0.5) {
    float s = vCav.z;                       // 0 at the lips .. 1 at the throat
    vec3 c = vec3(0.03, 0.016, 0.011) * (1.0 - 0.85 * s);
    // Teeth live in the head frame (vDef): the upper row hangs from the (static) upper lip edge,
    // the lower row rides on the jaw. The opening is lens shaped (the corners stay closed).
    float hwm = uMouth.w;
    float dx = vDef.x - uMouthC.x;
    float ux = clamp(dx / hwm, -1.0, 1.0);
    float seamY = uMouth.x + (uMouth.y + uMouth.z * dx * dx) * dx * dx;
    vec3 jm = uJawPivot + uJawRot * (vec3(vDef.x, seamY, uMouthC.z) - uJawPivot);
    float lens = sqrt(max(1.0 - ux * ux, 0.0));
    float lowY = seamY + (jm.y - seamY) * lens;
    float upLen = 0.0072 * (1.0 - 0.5 * ux * ux);
    float loLen = 0.0035 * (1.0 - 0.6 * ux * ux);
    float py = max(px, 1e-5);
    float upT = smoothstep(seamY - upLen - py, seamY - upLen + py, vDef.y);
    float loT = 1.0 - smoothstep(lowY + loLen - py, lowY + loLen + py, vDef.y);
    // tooth boundaries (narrower toward the corners, as the arch turns away); rounded edges
    float tc = asin(ux * 0.97) * 3.4;
    float tf = fract(tc + 0.5) - 0.5;                     // -0.5 .. 0.5 across one tooth
    float gap = smoothstep(0.02, 0.1, 0.5 - abs(tf));
    float round_ = 1.0 - 0.45 * tf * tf * 4.0;           // the tooth's edge curves up at its sides
    upT *= smoothstep(seamY - upLen * round_ - py, seamY - upLen * round_ + py, vDef.y);
    float centre = 1.0 - smoothstep(0.55, 0.92, abs(ux));
    vec3 enamel = mix(vec3(0.5, 0.49, 0.46), uColLine * 0.55, 0.3);
    // lit from the front, shadowed under the lip and toward the corners
    float shadeU = (0.45 + 0.55 * smoothstep(seamY - 0.0012, seamY - upLen * 0.7, vDef.y)) * (0.55 + 0.45 * lens);
    float inMouth = smoothstep(0.0, 0.04, s);
    c = mix(c, enamel * 0.28 * lens * glow, loT * gap * centre * inMouth * (1.0 - upT));
    c = mix(c, enamel * shadeU * glow, upT * gap * centre * inMouth);
    // tongue tip (th, l): at the edge of the upper incisors, in front of the lower row
    if (uMouthX.w > 0.004) {
      float top = seamY - upLen;
      float hh = 0.0045 + 0.25 * max(top - (lowY + loLen), 0.0);
      vec2 tq = vec2(dx / (0.3 * hwm), (vDef.y - (top - 0.35 * hh)) / hh);
      float tr = length(tq);
      float tm = (1.0 - smoothstep(0.7, 1.0, tr)) * smoothstep(0.0, 0.25, uMouthX.w) * inMouth;
      vec3 tongue = mix(vec3(0.075, 0.03, 0.024), uColLine * 0.2, 0.3) * glow;
      tongue *= 0.55 + 0.9 * smoothstep(-0.4, 0.9, tq.y) * (1.0 - 0.7 * tr);
      // only its upper edge tucks behind the incisors
      c = mix(c, tongue, tm * (1.0 - 0.6 * upT * smoothstep(0.2, 0.8, tq.y)));
    }
    gl_FragColor = vec4(c, 1.0);
    return;
  }

  // ---- lighting (world space: the light stays put while the head turns) ---------------------
  vec3 Lk = normalize(vec3(0.5, 0.22, 0.84));        // front-right key, like the reference
  float dif = clamp((dot(N, Lk) + 0.1) / 1.1, 0.0, 1.0);
  vec3 H = normalize(Lk + Vv);
  float NdH = clamp(dot(N, H), 0.0, 1.0);
  float spec = pow(NdH, 30.0);
  float ao = mix(1.0, vAux.x, 0.9);
  float conv = vAux.y * 2.0 - 1.0;                      // >0 ridges (nose, lips), <0 sockets / folds
  float cav = clamp(1.0 - 0.9 * max(-conv, 0.0), 0.0, 1.0);
  float ridge = clamp(conv * 1.4, 0.0, 1.0);
  float facing = smoothstep(0.05, 0.8, NdV);
  float lit = (0.22 + 0.78 * pow(dif, 1.5)) * ao * cav * (0.35 + 0.65 * facing);
  // the visual edge: the outer shell's silhouette, and on the lower face (where the jaw stands in
  // front of the darkened neck) the jaw contour itself, from the true normal
  float lowerFace = smoothstep(-0.06, -0.15, p.y) * (1.0 - vExtra.x);
  float edge = max(1.0 - SdV, lowerFace * smoothstep(0.3, 0.9, 1.0 - NdV) * 0.95);
  float side = pow(edge, 0.95);                          // hologram: the outer shell's edges glow
  float side2 = side * side;
  float crown = smoothstep(0.26, 0.46, p.y);             // the top of the cranium stays dim
  float lips = vAux.z;
  float ear = vAux.w;
  // lit from within: the face interior (an oval around the nose) carries the most light
  // a central strip (forehead -> nose -> lips -> chin) inside a broad face oval
  vec2 fo = (p.xy - vec2(uNoseTip.x + 0.01, uNoseTip.y + 0.05)) / vec2(0.15, 0.25);
  vec2 fs = (p.xy - vec2(uNoseTip.x + 0.005, uNoseTip.y + 0.04)) / vec2(0.06, 0.24);
  float inner = smoothstep(0.25, 0.95, NdV) * (0.55 * exp(-dot(fo, fo)) + 0.6 * exp(-dot(fs, fs))) * ao;
  // cool blue-white on the cranium and forehead, warmer (gold-silver) over the lower face
  float eyeY = 0.5 * (uEyeC[0].y + uEyeC[1].y);
  float lowFace = smoothstep(eyeY + 0.03, eyeY - 0.09, p.y) * (1.0 - smoothstep(0.35, 0.8, edge)) * (1.0 - vExtra.x);
  // nose: a capsule from the bridge to the tip, on the front of the face
  vec2 nab = uNoseTip.xy - uNoseBridge.xy;
  float nt = clamp(dot(p.xy - uNoseBridge.xy, nab) / max(dot(nab, nab), 1e-8), 0.0, 1.0);
  vec2 nd = (p.xy - uNoseBridge.xy - nab * nt) / vec2(0.026 + 0.018 * nt, 0.03);
  float nose = exp(-dot(nd, nd)) * smoothstep(uNoseTip.z - 0.1, uNoseTip.z - 0.04, p.z) * cav;
  // warmth: the glow of eyes, nose and mouth tints the surrounding lines gold
  float warm = 0.0;
  for (int i = 0; i < 2; i++) warm = max(warm, exp(-length(p - uEyeC[i]) / 0.068));
  warm = max(warm, 0.75 * exp(-length((p - uMouthC) * vec3(0.7, 1.0, 1.0)) / 0.045));
  warm = max(warm, 0.9 * nose);
  warm = max(warm, lips);

  // ---- gold contour lines (searched first: their energy pulses also light the nearby web) ---
  // per-vertex distance to the nearest curve (baked) lets most fragments skip the search; the
  // margin covers the interpolation error over a triangle
  vec3 nc = vCav.y * uCurveRange > 0.014 ? vec3(1.0, 0.0, 0.0) : nearestCurve(p);
  float pulseAmt = (0.12 + 1.6 * uThink + 0.5 * uSpeak * (0.3 + uSpeech) + 0.3 * uListen) * uFx;
  float wave = fract(nc.z * 2.2 - uTime * (0.3 + 0.45 * uThink));
  float band = smoothstep(0.0, 0.04, wave) * (1.0 - smoothstep(0.04, 0.3, wave)) * nc.y;
  float pulseNear = exp(-nc.x / 0.0055) * band * min(pulseAmt, 1.3);   // grid + web brighten under a pulse

  // ---- dark glass body ----------------------------------------------------------------------
  // a dim blue-grey fill; most brightness is carried by the line work below. The silhouette
  // turns translucent (the outer cyan glow comes from bloom on the edge lines, not a band).
  vec3 col = mix(vec3(0.011, 0.016, 0.022), vec3(0.017, 0.017, 0.018), smoothstep(0.1, 0.6, inner)) * (0.4 + 1.6 * lit) * (1.0 - 0.45 * crown);
  // emissive core: the face interior and above all the nose glow from within (warm silver)
  vec3 core = mix(mix(vec3(0.62, 0.68, 0.76), uColGrid, 0.3), mix(vec3(0.7, 0.71, 0.74), uColLine, 0.4), max(lowFace, nose));
  col += core * (0.07 * inner + 0.22 * nose * (0.45 + ridge)) * (0.55 + 0.7 * lit);
  col *= 1.0 - 0.8 * smoothstep(0.45, 0.95, edge);
  // soft sheen on the facial features (nose, brow and cheek bones), as on polished glass
  float sheen = pow(NdH, 6.0) * ridge * (0.25 + 0.75 * warm) * ao * cav * (1.0 - lips);
  col += mix(vec3(0.62, 0.64, 0.68), uColLine, 0.5 * warm) * (sheen * 0.3 + spec * (0.12 + 0.3 * nose) * ao * cav * (1.0 - lips));

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
  // a few faint loops close to the eye openings and lines along the lips (the reference's edge
  // loops); no rings around the mouth (they read as a muzzle)
  float loopsW = 0.0, loops = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 q = p - uEyeC[i];
    vec2 l2 = vec2(dot(q, uEyeX[i]), dot(q, uEyeY[i]) * 1.5);
    float r = length(l2);
    float wgt = (1.0 - smoothstep(0.03, 0.05, r)) * 0.8;
    if (wgt > 0.0) {
      float ring = gridLines(r / 0.0068, w * 1.1);
      float spoke = gridLines(atan(l2.y, l2.x) * 64.0 / TAU, w) * smoothstep(0.012, 0.03, r) * 0.6;
      loops = max(loops, max(ring, spoke) * wgt);
      loopsW = max(loopsW, wgt);
    }
  }
  {
    vec3 q = p - uMouthC;
    float onLips = smoothstep(0.2, 0.6, lips) * smoothstep(-0.1, -0.03, q.z);
    if (onLips > 0.0) {
      float along = gridLines((q.y + 6.0 * q.x * q.x) / 0.0034, w * 1.1);
      loops = max(loops, max(along, gridLines(lon * uGrid.x / TAU, w)) * onLips);
      loopsW = max(loopsW, onLips);
    }
  }
  g = max(g * (1.0 - 0.85 * loopsW), loops);
  // the reference's edge is out of focus: toward the silhouette the lines melt into their mean
  // (a soft glow) instead of packing into hard streaks parallel to the outline
  float defocus = smoothstep(0.86, 0.99, edge);
  g = mix(g, 1.9 * w, defocus);
  // shimmer: slow travelling variations of the grid brightness
  float shimmer = 0.75 + 0.5 * vnoise(p * 9.0 + vec3(0.0, uTime * 0.35, uTime * 0.12));
  // energy of the line work: interior glow, nose, warm features, a little key light
  float lineE = (0.06 + 0.3 * lit * facing + 0.35 * ridge * facing * ao + 0.85 * inner + 1.8 * nose * (0.4 + ridge) + 0.8 * warm * ao) * shimmer * (1.0 - 0.6 * crown);
  lineE *= 1.0 + 2.5 * pulseNear;
  // the fresnel edge brightens the LINES (cyan), not the fill
  // brightest along the temples and cheeks, dim over the crown, off on the ears
  float rimH = (1.0 - 0.85 * smoothstep(0.16, 0.4, p.y)) * (1.0 - ear);
  // the brightest lines sit just inside the silhouette; the outermost pixels fade (true normal
  // grazing) so the outline is soft and bloom makes the halo
  float outer = mix(1.0, smoothstep(0.0, 0.4, NdV), smoothstep(0.6, 0.85, edge));
  float rimE = pow(smoothstep(0.55, 0.96, edge), 2.2) * outer;
  rimE *= rimH * (1.0 + 0.25 * uListen + 0.4 * max(e, 0.0)) * smoothstep(0.55, 0.9, ao);
  // a gentle, wide fresnel ramp: the lines brighten and cool from the face toward the edge, so
  // the luminous interior runs into the rim without a dark gap (no separate "helmet" band)
  // (on the reference this band is wide: the temples and the sides of the cheeks are among the
  // brightest areas, made of dense cyan-white lines)
  float fres = smoothstep(0.12, 0.7, edge) * outer * mix(rimH, 1.0, 0.25 * (1.0 - crown)) * smoothstep(0.55, 0.9, ao);
  lineE += 1.5 * fres;
  vec3 neutral = vec3(0.64, 0.66, 0.7);
  vec3 rimCol = mix(uColRim, vec3(0.8, 0.94, 1.0), 0.22);
  vec3 gridCol = mix(neutral, uColGrid, 0.5);
  gridCol = mix(gridCol, uColLine, clamp(0.35 * lowFace + 0.3 * inner + 0.75 * warm, 0.0, 0.85));
  gridCol = mix(gridCol, mix(rimCol, vec3(0.85, 0.95, 1.0), 0.4), 0.7 * fres);
  // interior lines carry the inner glow; at the fresnel edge the (densely packed) lines turn
  // bright cyan-white: that is the hologram's rim, made of line work, not of fill
  col += gridCol * lineE * g * 0.3 + rimCol * rimE * (2.0 * g + 0.05);
  // the silhouette band itself: a faint cyan sheen of unresolved (defocused) lines, fading at the
  // very edge so the geometric outline never reads as a hard shell
  float rimBand = smoothstep(0.7, 0.95, edge) * outer;
  col += mix(uColRim, rimCol, 0.5) * rimBand * rimH * smoothstep(0.55, 0.9, ao) * (0.035 + 0.02 * uListen);

  // ---- irregular web + bright nodes --------------------------------------------------------------
  // Two scales, as on the reference: fine cells over the face (eyes, nose, cheeks, mouth), larger
  // vertically elongated "vein" cells over the forehead and cranium. Both live on an arc-length
  // parametrisation of the grid sphere; only fragments in the blend band evaluate both.
  vec2 arc = vec2(lon * max(rxz, 0.12), lat * 0.36);
  vec2 farc = fwidth(arc);
  float faceW = (1.0 - smoothstep(0.1, 0.17, p.y)) * smoothstep(-0.02, 0.1, dz) * (1.0 - crown);
#if PH_WEB
  {
    vec3 web = vec3(0.0);                                   // strand coverage, node, strand brightness
    vec2 cellB = uGrid.w * vec2(1.95, 3.3);
    if (faceW > 0.01) web += webLayer(arc / uGrid.w, length(farc / uGrid.w) * 0.7 + 1e-5) * faceW;
    if (faceW < 0.99) web += webLayer(arc / cellB + 31.0, length(farc / cellB) * 0.7 + 1e-5) * (1.0 - faceW);
    web.xy = mix(web.xy, vec2(0.05, 0.0), defocus);
    vec3 webCol = mix(mix(uColGrid, vec3(0.85, 0.93, 1.0), 0.3), mix(vec3(1.0, 0.9, 0.76), uColLine, 0.3 + 0.35 * warm), max(lowFace, warm));
    webCol = mix(webCol, rimCol, 0.75 * pow(edge, 1.5));
    float webE = min(lineE, 0.4 + 0.45 * lineE) * (1.0 - 0.55 * nose) * (1.0 - 0.3 * faceW);   // fine on the face, faint on the nose
    col += webCol * web.x * web.z * (webE * 0.36 + rimE * 1.0) + vec3(0.95, 0.97, 1.0) * web.y * (webE + 1.5 * rimE) * 0.9;
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
    float dot_ = exp(-dot(fc, fc) / (rs * rs)) * smoothstep(0.62, 0.92, h) * (0.1 / rs);
    float tw = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * (1.2 + 3.0 * h) + h * 40.0), 3.0);
    vec3 sc = mix(vec3(0.88, 0.94, 1.0), uColRim, step(0.6, fract(h * 13.7)) * side);
    col += sc * min(dot_, 1.5) * tw * (0.25 + 0.9 * lineE + 1.6 * rimE) * 1.2 * uFx;
  }
#if PH_DUST
  // fine dust: tiny glints on a finer lattice (the reference's "stardust" skin)
  {
    vec2 gc = vec2(lon * uGrid.x / TAU, lat / uGrid.y) * vec2(2.0, 1.5) + 17.0;
    vec2 cell = floor(gc);
    float h = hash12(cell + 91.0);
    vec2 o = hash22(cell + 7.0) * 0.8 + 0.1;
    vec2 fc = (gc - cell - o);
    float fws = length(fwidth(gc)) + 1e-5;
    float rs = max(0.08, 0.55 * fws);
    float dust = exp(-dot(fc, fc) / (rs * rs)) * smoothstep(0.5, 0.95, h) * min(1.0, 0.08 / rs);
    float tw = 0.4 + 0.6 * sin(uTime * (0.8 + 2.0 * h) + h * 30.0) * 0.5 + 0.3;
    col += mix(vec3(0.8, 0.88, 1.0), uColLine, warm * 0.6) * dust * tw * (0.15 + 0.7 * lineE + 0.6 * rimE) * 0.6 * uFx;
  }
#endif

  // ---- gold contour lines + energy pulses ---------------------------------------------------
  float wg = max(0.00034, 0.22 * px);
  float gl = lineAA(nc.x, wg, 1.5 * px) * nc.y;
  float gglow = exp(-nc.x / 0.0018) * nc.y;
  float lineLit = 0.6 + 0.5 * lit + 0.6 * inner + 0.3 * warm;
  vec3 gold = mix(uColLine, vec3(1.0, 0.93, 0.82), 0.3);
  // (the travelling glint is capped so a pulse brightens the gold, never burns it white)
  float pulse = band * min(pulseAmt, 1.3);
  // under a pulse the line also gets a wider glow (readable at small window sizes)
  float pglow = exp(-nc.x / 0.004) * nc.y;
  col += gold * (gl * (1.25 * lineLit + pulse * 2.0) + gglow * 0.08 * lineLit + pglow * pulse * 0.32) * glow;

  // ---- lips: warm gold glass with bright line work (never a white specular blob) --------------
  vec3 lipTint = uColLine * vec3(1.0, 0.92, 0.82);
  float lipE = (0.045 + 0.05 * dif * ao + 0.04 * ridge + 0.025 * spec) * (1.0 + 0.9 * uSpeech * uSpeak);
  col += lipTint * lipE * lips * cav;

  // ---- eyes (+ warm light spilling into the sockets) ------------------------------------------
  vec3 rd = transpose(uHeadRot) * normalize(vPos - cameraPosition);
  for (int i = 0; i < 2; i++) {
    vec3 q = p - uEyeC[i];
    float r = length(vec2(dot(q, uEyeX[i]), dot(q, uEyeY[i]) * 1.6));
    col += uColEye * (exp(-r / 0.055) * 0.2 + exp(-r / 0.016) * 0.28) * (1.0 - (i == 0 ? uBlink.x : uBlink.y) * 0.5) * glow * ao * facing;
  }
  // (cheap bounding test first: most fragments are nowhere near an eye)
  vec2 eyeA = vec2(0.0), eyeB = vec2(0.0);
  vec3 qa = p - uEyeC[0], qb = p - uEyeC[1];
  float er = 1.8 * max(uEyeUp[0].w, uEyeUp[1].w);
  if (dot(qa, qa) < er * er) eyeA = eye(0, p, rd, px, uBlink.x, glow, g, col);
  else if (dot(qb, qb) < er * er) eyeB = eye(1, p, rd, px, uBlink.y, glow, g, col);
  float eyeCov = max(eyeA.x, eyeB.x);
  float eyeRegion = max(eyeA.y, eyeB.y);

  // deep creases (nostril holes) and the inner lip walls (baked mask) sink into darkness like
  // the mouth cavity; smooth rest-space attributes, so the edges follow the lip curve
  float deep = max(smoothstep(0.34, 0.1, vAux.x), smoothstep(0.15, 0.85, vShell.w));
  deep *= 1.0 - eyeRegion;              // the scan's closed-lid crease lies inside the open eye
  col = mix(col, vec3(0.02, 0.011, 0.008), deep * 0.9);
  // the mouth line: a thin dark line just under the bright upper-lip edge (baked seam closeness,
  // so it follows the lip curve smoothly and opens with the lips)
  float seamProx = vExtra.y, seamUp = vExtra.z;
  col = mix(col, vec3(0.02, 0.011, 0.008), smoothstep(0.5, 0.93, seamProx) * (1.0 - seamUp) * 0.85);
  col += gold * 0.08 * smoothstep(0.55, 1.0, seamProx) * seamUp * glow;

  // ---- ears, scan line ----------------------------------------------------------------------
  col *= 1.0 - 0.85 * ear;
  float scanY = 0.55 - fract(uTime * 0.07) * 1.3;
  col += uColRim * exp(-pow((p.y - scanY) * 55.0, 2.0)) * (0.02 + 0.12 * lineE) * 0.6 * uFx * (1.0 - eyeCov);

  // ---- neck dissolves into the particle field (additively: alpha fades before colour) ---------
  // below the jaw line (baked mask) the reference is dark: the lower face reads as a narrow V
  // and the under-jaw / neck only glow faintly before they dissolve
  float neckM = vExtra.x;
  // (the reference neck is a faint translucent column, a little cyan, with motes in front)
  col = col * (1.0 - 0.86 * neckM) + rimCol * 0.008 * neckM * (0.5 + g * 4.0);
  float alpha = 1.0 - 0.85 * neckM;
  // the fade follows the jaw line (it rises toward the jaw angles)
  float neckTop = uNeck.y + 3.0 * p.x * p.x;
  if (p.y < neckTop + 0.06) {
    float nz = vnoise(p * vec3(14.0, 5.0, 14.0) + vec3(0.0, -uTime * 0.25, uTime * 0.08));
    float ny = (p.y - uNeck.x) / (neckTop - uNeck.x);
    float fadeC = smoothstep(-0.15, 1.1, ny + (nz - 0.5) * 0.6);
    // the reference neck is slender: its sides fall dark first
    float slim = 1.0 - 0.85 * smoothstep(0.55, 1.05, abs(p.x) / uNeckHW) * max(1.0 - smoothstep(0.85, 1.2, ny), neckM);
    col *= fadeC * slim;
    alpha *= smoothstep(0.35, 1.15, ny) * slim;
  }
  alpha *= (1.0 - 0.8 * ear) * mix(1.0, 0.4, smoothstep(0.7, 1.0, edge));

  // ---- states -----------------------------------------------------------------------------------
  if (uError > 0.001) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    float fl = 0.72 + 0.28 * step(0.45, hash12(vec2(floor(uTime * 17.0), 3.0)));
    col = mix(col, vec3(l * 1.2, l * 0.42, l * 0.38) * fl, uError * 0.7);
  }
  col *= (1.0 - 0.45 * uSleep) * (1.0 + 0.3 * e);
  if (alpha < 0.004 && dot(col, vec3(1.0)) < 0.003) discard;
  // premultiplied; the colour is already faded by the neck dissolve, so dim tails stay additive
  gl_FragColor = vec4(col, alpha);
}`;
