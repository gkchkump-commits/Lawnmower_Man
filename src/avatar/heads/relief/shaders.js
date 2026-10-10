// GLSL for the relief head: shared rig vertex chunk, face shader, mouth-cavity shader.

/** Vertex rig shared by the face and the cavity (keeps the lip slit and the teeth in sync). */
export const RIG_CHUNK = /* glsl */ `
attribute vec4 aW0;   // jaw, lowerLip, upperLip, cornerL
attribute vec4 aW1;   // cornerR, lidUpperL, lidLowerL, lidUpperR
attribute vec4 aW2;   // lidLowerR, browL, browR, face
uniform mat3 uHeadRot;
uniform vec3 uHeadPivot;
uniform float uJawDrop;
uniform float uUpperLift;
uniform float uLowerDrop;
uniform float uLipPush;
uniform float uBreathY;
uniform vec3 uHeadXform;  // posture: shift x, y (world) and scale about the pivot (1 at rest)
uniform float uPlateAspect;
uniform vec2 uCornerL;
uniform vec2 uCornerR;
uniform vec2 uBrows;
uniform vec4 uLids;   // upperL, lowerL, upperR, lowerR travel (world units, + closes)
uniform vec2 uNeckBand; // world y: the neck below .x stays put, everything above .y turns with the head
uniform vec4 uHinge;    // jaw: centre line x, half width (angle to angle), slit y, chin y (world, rest)
uniform vec3 uHingeK;   // side falloff, chin stretch, back swing
uniform vec4 uFaceMove; // cheek lift, chin boss lift, nostril wings out, cheeks out (world units)
uniform vec4 uCheekC;   // cheek centres: L.xy, R.xy (world, rest)
uniform vec4 uChinC;    // chin boss centre xy, radii xy
uniform vec4 uAlaC;     // nostril wing centres: L.xy, R.xy
uniform vec3 uFaceR;    // cheek radii xy, nostril wing radius
uniform vec3 uMouth;    // mouth centre x, y (world, rest), half width (world)
uniform vec2 uLens;     // the opening's half width (x mouth half widths: the corners move), the
                        // share of the jaw drop the commissures take
uniform float uLowerClose; // the part of uLowerDrop that closes the lips over the jaw (press, tuck)

// The lips part as a lens: fully in the middle, tapering to closed corners (the commissures move
// together, down by a share of the jaw drop), never as a flat-topped slot running into the
// corners. lensUp / lensLo: 1 at the centre, 0 at and beyond the (current) corners. Over the last
// LENS_END of the way the lips close smoothly into the seam (the contours meet it without a kink
// and the mesh, ~5 px apart there, resolves the end: no sharp dark tip).
#define LENS_END 0.72
float lensEnd(float u) { return 1.0 - smoothstep(LENS_END, 1.0, u); }
float lensOf(float u, float e) { return pow(clamp(1.0 - u * u, 0.0, 1.0), e) * lensEnd(u); }

// slitD: rest plate px below the closed-mouth slit (+ below, - above)
vec3 applyRig(vec3 p, float slitD) {
  // eyelids: upper lids move down, lower lids move up
  p.y += -aW1.y * uLids.x + aW1.z * uLids.y - aW1.w * uLids.z + aW2.x * uLids.w;
  // brows
  p.y += aW2.y * uBrows.x + aW2.z * uBrows.y;
  // lips: the upper lip rises in the middle (most under the philtrum); the tissue at the corners
  // (both lips, close to the slit, fading out beyond the corners) goes down with them by a share
  // of the jaw drop, the lower lip's own parting tapers the same way
  float ax = abs(position.x - uMouth.x) / max(1e-4, uMouth.z);
  float mu = ax / max(1e-4, uLens.x);
  float lensUp = lensOf(mu, 0.75), lensLo = lensOf(mu, 0.55);
  float fLo = mix(uLens.y, 1.0, lensLo);
  float reach = 1.0 - smoothstep(1.05, 1.7, ax);
  float nearUp = (1.0 - smoothstep(0.0, 28.0, -slitD)) * reach;
  float nearLo = (1.0 - smoothstep(0.0, 36.0, slitD)) * reach;
  float lowerFace = aW0.x;                 // (the jaw's weight: the lower lip and below)
  p.y += aW0.z * uUpperLift * lensUp - (1.0 - lowerFace) * uLens.y * uJawDrop * (1.0 - lensUp) * nearUp;
  // (its own parting tapers to closed corners; the closure part cancels the jaw's share exactly)
  p.y -= aW0.y * ((uLowerDrop + uLowerClose) * lensLo - uLowerClose * fLo);
  p.xy += aW0.w * uCornerL + aW1.x * uCornerR;
  p.z += (aW0.y + aW0.z) * uLipPush;
  // the face moving with the mouth: soft regions around landmark centres (all zero at rest, so
  // the rest pose is the baked plate; displacements stay far below the regions' size: no folds)
  if (uFaceMove.x + uFaceMove.y + uFaceMove.z > 0.0) {
    vec2 q = position.xy;
    vec2 cl = (q - uCheekC.xy) / uFaceR.xy, cr = (q - uCheekC.zw) / uFaceR.xy;
    float wl = exp(-dot(cl, cl)), wr = exp(-dot(cr, cr));
    // cheeks and the nasolabial folds beside them lift and widen (the lips have their own rig)
    float cw = (1.0 - clamp(aW0.y + aW0.z, 0.0, 1.0)) * aW2.w;
    p.y += (wl + wr) * cw * uFaceMove.x;
    p.x += (wr - wl) * cw * uFaceMove.w;
    // the chin boss bunches up under pressed lips (mentalis)
    vec2 cc = (q - uChinC.xy) / uChinC.zw;
    p.y += exp(-dot(cc, cc)) * (1.0 - aW0.y) * uFaceMove.y;
    // the nostril wings widen on a breath in
    vec2 al = (q - uAlaC.xy) / uFaceR.z, ar = (q - uAlaC.zw) / uFaceR.z;
    p.x += (exp(-dot(ar, ar)) - exp(-dot(al, al))) * uFaceMove.z;
  }
  // jaw: a hinge about the joints in front of the ears. With its weight the jaw drops; its sides
  // near the joints drop less than the chin and lips, the chin travels a little farther than the
  // lips (the lower face lengthens) and swings back the more the farther below the joint it is.
  // (A weighted translation shaped like this avoids the depth-order trouble a large rotation
  // causes in a 2.5D relief.)
  // (the lower lip takes the jaw drop only in the middle: at the corners it stays with the upper lip)
  float j = lowerFace * uJawDrop * (1.0 - (1.0 - fLo) * nearLo);
  float side = smoothstep(0.45, 1.05, abs(position.x - uHinge.x) / uHinge.y);
  float below = clamp((uHinge.z - position.y) / max(1e-4, uHinge.z - uHinge.w), 0.0, 1.0);
  p.y -= j * (1.0 - uHingeK.x * side) * (1.0 + uHingeK.y * below);
  p.z -= j * (0.25 + uHingeK.z * below);
  return p;
}

vec3 applyHead(vec3 p) {
  // the bust turns, the lower neck does not (a rigid card would swing the whole neck sideways)
  vec3 r = uHeadPivot + uHeadRot * (p - uHeadPivot) * uHeadXform.z + vec3(uHeadXform.xy, 0.0);
  return mix(p, r, smoothstep(uNeckBand.x, uNeckBand.y, p.y)) + vec3(0.0, uBreathY, 0.0);
}

// world (relief, pre-rotation) -> plate uv
vec2 plateUv(vec3 p) {
  return vec2(p.x / uPlateAspect + 0.5, p.y + 0.5);
}
`;

export const FACE_VERT = /* glsl */ `
${RIG_CHUNK}
attribute float aEdge;
attribute float aSlitD;     // rest px below the closed-mouth slit (+ = below; lip warp)
attribute vec3 aNormal;     // the relief's surface normal at rest (world; the light, below)
varying vec3 vNrm0;         // ... at rest
varying vec3 vNrm1;         // ... turned with the head
varying vec2 vUv;
varying vec2 vUv2;
varying float vEdge;
varying float vFace;
varying vec2 vLip;          // (px below the slit, x across the mouth in half widths)
void main() {
  vUv = uv;
  vec3 p = applyRig(position, aSlitD);
  vUv2 = plateUv(p);
  vEdge = aEdge;
  vFace = aW2.w;
  vLip = vec2(aSlitD, (position.x - uMouth.x) / uMouth.z);
  vNrm0 = aNormal;
  vNrm1 = mix(aNormal, uHeadRot * aNormal, smoothstep(uNeckBand.x, uNeckBand.y, p.y));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(applyHead(p), 1.0);
}`;

export const FACE_FRAG = /* glsl */ `
uniform sampler2D tPlate;
uniform sampler2D tClosed;
uniform sampler2D tMaskA;   // r alpha, g gold lines, b sparkle
uniform sampler2D tMaskB;   // r eye aperture, g eye region, b mouth region
uniform sampler2D tMaskC;   // r lid coordinate (0.5 + 0.5 w), g upper lid, b occlusion
uniform sampler2D tSclera;  // the plate with its irises painted over (what a moving iris uncovers)
uniform sampler2D tOpen;    // r: the plate shows the open eye's inside here (no lid, no lid glow)
uniform float uIrisLayer;   // 1: tSclera / tOpen exist (the iris moves as a disc); 0: uv warp
uniform float uHasLids;     // 1 when the pack has masks_c (lid wipe); 0 = legacy cross-fade
uniform vec2 uPlateSize;    // px
uniform vec4 uEyeL;         // iris: uv.xy, disc radius and feather (plate heights)
uniform vec4 uEyeR;
uniform vec2 uGaze;         // uv offset of the irises
uniform vec2 uBlink;
uniform vec2 uPulseOrigin;  // uv
uniform float uTime;
uniform float uEnergy;
uniform float uSpeech;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uError;
uniform float uSleep;
uniform float uFx;          // living-effects amount (0 = plain baked plate)
uniform float uChinV;       // plate v of the chin
uniform vec3 uColLine;
uniform vec3 uColRim;
uniform vec3 uColEye;
uniform vec3 uColGrid;
uniform vec4 uLipWarp;      // px: upper thinning, contact, lower lip rise, lower thinning
uniform vec3 uOpen;         // the opening at the centre (plate px): upper lip lift, lower lip drop; lens width
// ---- the hologram's light and life (life lane)
uniform vec4 uLight;        // key light change with the head's turn, specular glint, rim, sharpening
uniform vec2 uPulseW;       // an energy wave on emphasis: its front's radius (plate heights), amplitude
uniform float uBreath;      // the breathing cycle (the eyes' glow breathes with it)
uniform float uPop;         // the hologram's emissive strength (eyes, lines, edges)
uniform float uPixelRatio;  // device px per CSS px (the scan lines' pitch is in CSS px)
varying vec3 vNrm0;
varying vec3 vNrm1;
varying vec2 vUv;
varying vec2 vUv2;
varying float vEdge;
varying float vFace;
varying vec2 vLip;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Gaze: the iris (with its pupil and glow) is a disc that slides rigidly inside the open eye;
// where it uncovers its rest place, the eye white shows (tSclera: the plate with the irises
// painted over, src/avatar/heads/relief/iris.js, which also located the painted irises: uEyeL/R).
// Outside the open eye nothing moves: the lids, the lid lines and the eye's outline never follow
// the gaze, and the pupil stays round. The open eye is the lid coordinate's inside (w > 0, just in
// from the lid lines; packs without masks_c: the aperture mask).
float openEye(vec2 uv) {
  if (uHasLids > 0.5) return smoothstep(0.03, 0.09, texture2D(tMaskC, uv).r * 2.0 - 1.0);
  return smoothstep(0.3, 0.75, texture2D(tMaskB, uv).r);
}
// tOpen: the plate shows the inside of the open eye here (eye white or iris), not a lid or the
// glowing lid margins, which lie over the eyeball.
float seen(vec2 uv) { return smoothstep(0.05, 0.85, texture2D(tOpen, uv).r); }
// The same radius of the iris turned toward the horizontal (which the lids never hide), on side
// sx: a third, two thirds or all the way, whichever is the nearest seen.
vec3 irisTurned(vec4 eye, vec2 asp, float rho, float th, float sx, vec2 gdx, vec2 gdy) {
  vec2 p = eye.xy + vec2(sx, 0.0) * rho / asp.x;
  vec3 c = textureGrad(tPlate, p, gdx, gdy).rgb;
  p = eye.xy + vec2(sx * cos(0.67 * th), sin(0.67 * th)) * rho / asp;
  c = mix(c, textureGrad(tPlate, p, gdx, gdy).rgb, seen(p));
  p = eye.xy + vec2(sx * cos(0.33 * th), sin(0.33 * th)) * rho / asp;
  return mix(c, textureGrad(tPlate, p, gdx, gdy).rgb, seen(p));
}
// The moved iris at a texel whose rest source is src: the plate where the source was seen at rest;
// where a lid or its glow hid it, the iris rebuilt from what was seen (an iris looks alike all
// round): its mirror image across the horizontal axis, which is exact near the axis, blended
// toward the turned radius farther from it (the two meet without a seam).
vec3 irisAt(vec2 src, vec4 eye, vec2 asp, vec2 gdx, vec2 gdy) {
  vec3 own = textureGrad(tPlate, src, gdx, gdy).rgb;
  float sSrc = seen(src);
  if (sSrc >= 1.0) return own;
  vec2 dv = (src - eye.xy) * asp;
  float rho = length(dv);
  float th = atan(dv.y, abs(dv.x));         // from the horizontal, on its side
  float side = smoothstep(-0.25, 0.25, dv.x / max(1e-5, rho));
  vec3 turned = mix(irisTurned(eye, asp, rho, th, -1.0, gdx, gdy), irisTurned(eye, asp, rho, th, 1.0, gdx, gdy), side);
  vec2 mir = vec2(src.x, 2.0 * eye.y - src.y);
  float near = 1.0 - smoothstep(0.25, 0.6, abs(dv.y) / max(1e-5, eye.z));
  vec3 rebuilt = mix(turned, textureGrad(tPlate, mir, gdx, gdy).rgb, seen(mir) * near);
  return mix(rebuilt, own, sSrc);
}
// eye: uv centre, disc radius (plate heights: iris + glow; the fill's rim), feather; plate: this
// texel of the plate. The moved iris shows only where the eye's inside is seen; on the lid
// margins' glow the plate stays (the iris it had there at rest) as far as the moved disc still
// covers it, and the eye white (the fill) where the disc has left.
vec3 eyeLayer(vec2 uv, vec4 eye, vec3 plate, vec2 gdx, vec2 gdy) {
  vec2 asp = vec2(uPlateSize.x / uPlateSize.y, 1.0);
  vec2 src = uv - uGaze;                    // where this texel of the moved iris comes from
  float inIris = 1.0 - smoothstep(eye.z, eye.z + eye.w, length((src - eye.xy) * asp));
  vec3 sclera = textureGrad(tSclera, uv, gdx, gdy).rgb;
  if (inIris <= 0.0) return sclera;
  float vis = seen(uv);
  vec3 iris = vis > 0.0 ? mix(plate, irisAt(src, eye, asp, gdx, gdy), vis) : plate;
  return mix(sclera, iris, inIris);
}
// (packs whose plate cannot be read back: the old uv warp around the iris)
vec2 gazeWarp(vec2 uv, vec4 eye) {
  vec2 d = abs(uv - eye.xy) * vec2(uPlateSize.x / uPlateSize.y, 1.0) / eye.z;
  return uGaze * (1.0 - smoothstep(1.05, 2.5, d.x)) * (1.0 - smoothstep(0.95, 1.8, d.y));
}

void main() {
  vec4 mA = texture2D(tMaskA, vUv);
  float alpha = mA.r;
  if (alpha < 0.012) discard;                 // keep invisible fringe out of the depth buffer
  vec4 mB = texture2D(tMaskB, vUv);
  vec3 mC = texture2D(tMaskC, vUv).rgb;
  float w = mC.r * 2.0 - 1.0;                 // lid coordinate (see the blink below)
  float fw = clamp(fwidth(w), 1e-3, 0.5);     // (derivatives outside any branch)
  float ap = mB.r;
  vec2 suv = vUv;
  if (uIrisLayer < 0.5 && mB.g > 0.001) suv -= (vUv.x < 0.5 ? gazeWarp(vUv, uEyeL) : gazeWarp(vUv, uEyeR));
  // Lips pressed (m b p) or tucked (f v): the lip texture is compressed toward the seam (thinner,
  // rolled-in lips), the rest gap is skipped (the lips meet) and a tucked lower lip rises; rounded
  // lips (a negative thinning) fill out instead. The displacement fades out over ~1.5 lip heights,
  // so the mapping never folds.
  // (sampling gradients of the unwarped uv: the warp is discontinuous at the seam, where
  // implicit derivatives would pick a blurry mip level; 0.66 = the -0.6 LOD bias below)
  vec2 gdx = dFdx(vUv) * 0.66, gdy = dFdy(vUv) * 0.66;
  float contact = 0.0;
  bool lipWarp = false;
  if (abs(vLip.y) < 1.25 && abs(vLip.x) < 120.0 && dot(abs(uLipWarp), vec4(1.0)) > 0.001) {
    float d = vLip.x;
    float ad = abs(d);
    float lower = step(0.0, d);
    float band = mix(32.0, 48.0, lower);
    // the skin around the lips takes up the displacement over ~2 lip heights (gently, so the
    // grid is never visibly stretched); a purely geometric falloff: the mouth mask's edge is
    // too uneven to shape a displacement with
    float fall = (1.0 - smoothstep(0.5, 2.2, ad / band)) * (1.0 - smoothstep(0.85, 1.2, abs(vLip.y)));
    float k = mix(uLipWarp.x, uLipWarp.w, lower);
    float shift = (k * min(ad, band) + uLipWarp.y + lower * uLipWarp.z) * fall;
    suv.y -= (lower * 2.0 - 1.0) * shift / uPlateSize.y;
    contact = uLipWarp.y * fall * exp(-d * d / 2.5);
    lipWarp = abs(shift) > 0.01;
  }
  // (mipmapped: a slight negative LOD bias keeps the fine grid crisp when minified)
  vec3 col = texture2D(tPlate, suv, -0.6).rgb;
  if (lipWarp) col = textureGrad(tPlate, suv, gdx, gdy).rgb;
  // crisper lines and eyes: the plate's mid frequencies lifted (an unsharp mask against the same
  // texel ~1.7 mip levels coarser) on the gold lines and in the eyes, only a little elsewhere and
  // not on the fine wire grid, whose sub-pixel lines would crawl and sparkle as the head moves
  float shk = uLight.w * mix(0.1, 1.0, clamp(max(1.6 * mA.g, mB.r), 0.0, 1.0)) * (1.0 - 0.85 * mA.b * (1.0 - mA.g));
  if (shk > 0.001) col = max(col + shk * (col - textureGrad(tPlate, suv, gdx * 3.2, gdy * 3.2).rgb), 0.0);
  if (uIrisLayer > 0.5 && abs(uGaze.x) + abs(uGaze.y) > 1e-6 && mB.g > 0.001) {
    vec4 eye = vUv.x < 0.5 ? uEyeL : uEyeR;
    // (fading in over the first ~6 % of the disc radius of travel: the plate itself at rest and a
    // sub-pixel blend just off it, never a pop when the gaze crosses zero)
    float moved = smoothstep(0.0, 0.06, length(uGaze * vec2(uPlateSize.x / uPlateSize.y, 1.0)) / eye.z);
    float open = openEye(vUv) * moved;
    if (open > 0.001) col = mix(col, eyeLayer(vUv, eye, textureGrad(tPlate, vUv, gdx, gdy).rgb, gdx, gdy), open);
  }
  col *= 1.0 - 0.14 * contact;    // the line where pressed lips meet
  // Parted lips: their inner edges roll into the mouth (a soft shadow over the last ~4 px) and
  // the moist inner lip catches a thin highlight just outside it, instead of a hard cut-out.
  float openC = uOpen.x + uOpen.y;
  if (openC > 0.5 && abs(vLip.y) < 1.3 && abs(vLip.x) < 12.0) {
    float mu = abs(vLip.y) / max(0.05, uOpen.z);
    float lensAt = pow(clamp(1.0 - mu * mu, 0.0, 1.0), 0.6) * (1.0 - smoothstep(0.72, 1.0, mu));
    float k = smoothstep(0.5, 6.0, openC * lensAt) * mB.b;
    float ad = abs(vLip.x);
    col *= 1.0 - 0.55 * k * (1.0 - smoothstep(0.0, 4.5, ad));
    col += uColLine * 0.16 * k * exp(-pow((ad - 5.5) / 1.8, 2.0)) * (0.4 + 0.6 * mA.g);
  }
  float baseLum = dot(col, vec3(0.2126, 0.7152, 0.0722));

  // Blink = lid wipe. w (baked per pixel) is 0 on the open eye's lid margins, 1 on the closed
  // lid line of the blink frame and < 0 outside the eye. Where w < blink the lids have swept
  // over the pixel and the closed-eye frame shows (at the REST uv, nothing slides); elsewhere
  // the open plate stays untouched, so mid-blink there is no double exposure. The lid skin
  // around the eye (w < 0, both frames nearly alike there) cross-fades quickly, and a thin
  // amber lid margin glows along the moving edge.
  float bl = vUv.x < 0.5 ? uBlink.x : uBlink.y;
  float lidF = 0.0;
  if (bl > 0.001 && mB.g > 0.001) {
    vec3 closedCol = texture2D(tClosed, vUv, -0.6).rgb;
    if (uHasLids > 0.5) {
      float inEye = smoothstep(-fw, fw, w);
      float skin = smoothstep(0.0, 0.3, bl);
      float covered = (1.0 - smoothstep(bl - fw, bl + fw, w)) * mix(skin, 1.0, smoothstep(0.0, 0.15, w));
      lidF = mix(skin, covered, inEye) * mB.g;
      col = mix(col, closedCol, lidF);
      // the moving lid margin (upper lid bright, the rising lower lid faint)
      float edge = exp(-pow((w - bl) / (1.3 * fw), 2.0)) * inEye
                 * smoothstep(0.0, 0.06, bl) * (1.0 - smoothstep(0.88, 1.0, bl));
      col += uColEye * edge * mix(0.3, 1.0, mC.g) * 0.85;
    } else {
      lidF = smoothstep(0.15, 0.85, bl) * mB.g;
      col = mix(col, closedCol, lidF);
    }
    ap *= 1.0 - lidF;
  }

  float e = uEnergy - 0.5;                    // 0 at idle: the rest look stays the baked plate
  // eyes glow with energy / attention / speech
  float eyeBoost = clamp(e * 0.9 + 0.3 * uListen + 0.25 * uSpeech * uSpeak, -0.45, 1.2);
  col += (col * 0.7 + uColEye * 0.12) * ap * eyeBoost;

  // twinkle on the brighter grid nodes
  vec2 cell = floor(vUv * uPlateSize / 3.0);
  float seed = hash12(cell);
  float tw = hash12(cell + floor(uTime * 5.0 + seed * 7.0));
  col += uColGrid * mA.b * pow(tw, 8.0) * 0.6 * uFx;

  // energy pulses travelling outward along the gold contour lines
  float gold = mA.g;
  float pulseAmt = 0.12 + 0.9 * uThink + 0.55 * uSpeak * (0.35 + uSpeech) + 0.3 * uListen;
  vec2 dp = (vUv - uPulseOrigin) * vec2(uPlateSize.x / uPlateSize.y, 1.0);
  float wave = fract(length(dp) * 2.4 - uTime * (0.32 + 0.4 * uThink));
  float band = smoothstep(0.0, 0.04, wave) * (1.0 - smoothstep(0.04, 0.16, wave));
  col += uColLine * gold * band * pulseAmt * 1.6 * uFx;
  // lips light up with the voice
  col += uColLine * mB.b * gold * uSpeech * uSpeak * 0.9;

  // cyan rim light at the silhouette edge (cranium / cheeks only: the neck dissolves instead)
  // (peaks a few px inside the edge: the baked plate already carries the outer glow)
  // (peaks a few px inside the edge: the baked plate already carries the outer glow). Effects
  // scale with the local brightness: small linear additions in near-black pixels would turn
  // into visible fog after sRGB encoding.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float lit = 0.015 + 1.6 * lum;
  float rim = smoothstep(0.0, 3.0, vEdge) * exp(-vEdge / 6.0) * smoothstep(uChinV - 0.06, uChinV + 0.03, vUv.y);
  col += uColRim * rim * lit * (0.25 + 1.6 * max(e, 0.0) + 1.2 * uListen) * uFx;

  // faint scanline sweep
  float scan = exp(-pow((vUv2.y - (1.0 - fract(uTime * 0.085))) * 70.0, 2.0));
  col += uColRim * scan * lit * 0.35 * uFx;

  // ---- light and life (life lane) ----------------------------------------------------------
  // A key light from the upper left front lights the relief as the 3-D head it is: turning
  // toward it brightens that side, away from it darkens it (relative to the rest pose, whose
  // light is baked into the plate: at rest this changes nothing), a glint slides over the brow,
  // nose and cheekbones, and the edges turning away catch more rim light.
  {
    vec3 n0 = normalize(vNrm0), n1 = normalize(vNrm1);
    const vec3 KEY = vec3(-0.4, 0.52, 0.754);
    float dif = max(dot(n1, KEY), 0.0) - max(dot(n0, KEY), 0.0);
    col *= 1.0 + uLight.x * dif;
    vec3 hv = normalize(KEY + vec3(0.0, 0.0, 1.0));
    // (a tight highlight in the hologram's own cyan: the coarse mesh normals would spread a
    // broad exponent into a plastic white sheen)
    float g1 = pow(max(dot(n1, hv), 0.0), 90.0), g0 = pow(max(dot(n0, hv), 0.0), 90.0);
    // (the glint is the change: where the head turns it on; a little of it at rest)
    float glint = max(g1 - g0, 0.0) + 0.18 * g1;
    float skin = smoothstep(0.02, 0.12, baseLum) * (1.0 - ap);
    col += mix(uColRim, vec3(1.0), 0.2) * glint * uLight.y * skin * (0.4 + lit);
    // the edges turning away catch more of the cyan rim (never toward white: over a white
    // desktop a whitened edge would melt into it)
    float f1 = pow(1.0 - clamp(n1.z, 0.0, 1.0), 3.0), f0 = pow(1.0 - clamp(n0.z, 0.0, 1.0), 3.0);
    // (on the solid head only, the face and cranium that occlude the desktop: on the soft fringe,
    // the ears and the glow around them a rim reads as a haze around the head)
    float edgeIn = smoothstep(uChinV - 0.06, uChinV + 0.03, vUv.y) * smoothstep(0.0, 2.0, vEdge) * smoothstep(0.35, 0.85, alpha)
      * mix(1.0, smoothstep(0.3, 0.8, mC.b), uHasLids);
    col += uColRim * (0.45 * f1 + 0.6 * max(f1 - f0, 0.0)) * uLight.z * edgeIn * (0.2 + lit);
    // emissive: the eyes' bright parts and the lit gold lines glow past white (the bloom takes
    // them: crisp lines with a halo, not a haze over the face); the eyes breathe, and glow up
    // with the voice
    float hot = smoothstep(0.42, 0.95, baseLum);
    float eyeGlow = 0.36 + 0.05 * (uBreath - 0.5) + 0.2 * uSpeech * uSpeak + 0.2 * uListen;
    col += uColEye * ap * hot * eyeGlow * uPop * (1.0 - 0.6 * uSleep);
    // (a soft knee in the eyes that keeps their hue: the iris centre glows amber, never white-hot,
    // and its fibres survive; the bloom still takes what is above the knee)
    float em = max(col.r, max(col.g, col.b));
    if (ap > 0.01 && em > 0.78) col *= mix(1.0, (0.78 + 0.3 * (1.0 - exp(-(em - 0.78) / 0.3))) / em, ap);
    col += uColLine * gold * smoothstep(0.12, 0.55, baseLum) * 0.32 * uPop;
    // an energy wave on emphasis: a bright front runs out from the brow over the lines and grid
    if (uPulseW.y > 0.002) {
      float front = exp(-pow((length(dp) - uPulseW.x) / 0.05, 2.0));
      col += (uColLine * gold * 2.4 + uColGrid * mA.b * 1.0 + uColRim * 0.4 * lit) * front * uPulseW.y * uFx;
    }
    // hologram scan lines (a 3 CSS px pitch at any display scale, drifting slowly; faint, and
    // fainter still asleep)
    float sl = 0.5 + 0.5 * sin(gl_FragCoord.y / uPixelRatio * 2.1 - uTime * 1.1);
    col *= 1.0 - 0.03 * uFx * (1.0 - 0.7 * uSleep) * sl * smoothstep(0.0, 0.08, baseLum);
  }

  if (uError > 0.001) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    float fl = 0.72 + 0.28 * step(0.45, hash12(vec2(floor(uTime * 17.0), 3.0)));
    col = mix(col, vec3(l * 1.15, l * 0.45, l * 0.42) * fl, uError * 0.7);
  }
  col *= (1.0 - 0.5 * uSleep) * (1.0 + e * 0.35);
  // Colour is premultiplied by the silhouette alpha, but only the face and cranium (and only
  // where they visibly glow) claim desktop coverage: ears, the gap next to them, the fringe and
  // the dissolving neck stay pure light, so a light desktop shows no grey "dirt" through them.
  // (masks_c B is baked with a blurred brightness gate; legacy packs approximate it from a coarse
  // mip level, never per texel, which would let the desktop through between the grid lines)
  float occl = uHasLids > 0.5 ? mC.b
    : smoothstep(uChinV - 0.02, uChinV + 0.05, vUv.y)
      * smoothstep(0.002, 0.012, dot(texture2D(tPlate, vUv, 4.0).rgb, vec3(0.2126, 0.7152, 0.0722)));
  gl_FragColor = vec4(col * alpha, alpha * occl);
  // Only solid, visibly lit head pixels occlude the particle aura. The soft fringe and the black
  // background enclosed by the silhouette (e.g. between ear and cranium) write "far" depth so
  // motes behind them are not cut out (that would leave a dark band around the head).
  gl_FragDepth = (alpha > 0.45 && baseLum > 0.006) ? gl_FragCoord.z : 1.0;
}`;

export const CAVITY_VERT = /* glsl */ `
${RIG_CHUNK}
attribute float aLayer;
attribute float aSlit;
uniform float uPxPerUnit;   // plate px per world unit
varying vec2 vUvM;
varying float vLayer;
varying float vSlit;
varying vec2 vTongue;       // (x across the mouth in half widths, px below the slit where it is now)
void main() {
  vUvM = uv;
  vLayer = aLayer;
  vSlit = aSlit;
  vec3 p = applyRig(position, aSlit);
  vTongue = vec2((p.x - uMouth.x) / uMouth.z, aSlit + (position.y - p.y) * uPxPerUnit);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(applyHead(p), 1.0);
}`;

export const CAVITY_FRAG = /* glsl */ `
uniform sampler2D tMouth;
uniform float uTeeth;      // teeth visibility (an O / U pucker shows the dark interior, few teeth)
uniform vec3 uDark;
uniform float uSleep;
uniform float uTongue;     // tongue tip at the teeth (th, l)
uniform float uTeethShift; // mouth-texture v: the upper incisors follow a lifted upper lip
uniform float uJawPx;      // jaw drop (plate px)
uniform vec3 uColLine;
uniform vec3 uOpen;        // the opening at the centre (plate px): upper lip lift, lower lip drop; lens width
varying vec2 vUvM;
varying float vLayer;
varying float vSlit;
varying vec2 vTongue;

// Where in the opening a fragment is: 0 at the upper lip's edge, 1 at the lower lip's, and how far
// from the corners (1 in the middle). The interior is deepest (darkest) in the middle and lit
// warmly by the lips near their edges; open vowels show the body of the tongue low in the mouth.
vec2 openingAt() {
  float mu = abs(vTongue.x) / max(0.05, uOpen.z);
  float lens = pow(clamp(1.0 - mu * mu, 0.0, 1.0), 0.6) * (1.0 - smoothstep(0.72, 1.0, mu));   // (as the rig's lensOf)
  float up = uOpen.x * lens, lo = uOpen.y * lens;
  return vec2(clamp((vTongue.y + up) / max(1.0, up + lo), 0.0, 1.0), lens);
}

// Tongue tip: a soft rounded tip between the teeth, just under the upper incisors, riding half
// way down with the jaw. Warm and dim like the rest of the interior (lit by the gold lips).
vec4 tongueTip() {
  if (uTongue < 0.004) return vec4(0.0);
  float cy = 4.0 + 0.45 * uJawPx;
  vec2 q = vec2(vTongue.x / (0.3 + 0.06 * uTongue), (vTongue.y - cy) / (5.5 + 0.12 * uJawPx));
  float r = length(q);
  float m = (1.0 - smoothstep(0.7, 1.0, r)) * smoothstep(0.0, 0.25, uTongue);
  vec3 body = mix(vec3(0.075, 0.03, 0.024), uColLine * 0.2, 0.3);
  body *= 0.55 + 0.9 * smoothstep(0.4, -0.9, q.y) * (1.0 - 0.7 * r);  // its upper edge catches light
  return vec4(body, m);
}

void main() {
  float vis = smoothstep(0.02, 0.2, uTeeth);  // teeth only once the lips actually part
  vec4 tg = tongueTip();
  if (vLayer > 0.5) {
    vec3 c = texture2D(tMouth, vUvM).rgb;
    // the tongue tip sits in front of the lower teeth
    float a = smoothstep(0.03, 0.16, max(c.r, max(c.g, c.b))) * vis * (1.0 - tg.a);
    if (a < 0.01) discard;
    gl_FragColor = vec4(c * a * 0.92, a);
  } else {
    vec3 c = texture2D(tMouth, vUvM - vec2(0.0, uTeethShift)).rgb;
    float shade = mix(0.3, 1.0, smoothstep(0.0, 6.0, vSlit));   // shadow under the upper lip
    c = mix(uDark, c, vis);
    vec2 op = openingAt();
    float depth = sin(3.14159 * op.x) * op.y;                   // 0 at the lips, 1 deep inside
    vec3 lipLight = mix(uDark, uColLine * 0.3, 0.45);
    float teethLum0 = smoothstep(0.05, 0.25, max(c.r, max(c.g, c.b))) * vis;
    c = mix(c, lipLight, (1.0 - teethLum0) * 0.22 * (1.0 - smoothstep(0.0, 0.3, depth)));
    c *= 1.0 - 0.55 * smoothstep(0.15, 0.85, depth);
    // the body of the tongue, low in an open mouth (dim: it is in the mouth's shadow)
    float body = smoothstep(0.6, 0.9, op.x) * smoothstep(0.3, 0.7, uJawPx / 30.0) * smoothstep(0.2, 0.7, op.y);
    vec3 tongueC = mix(vec3(0.07, 0.03, 0.026), uColLine * 0.12, 0.2) * (0.75 + 0.4 * smoothstep(0.75, 1.0, op.x));
    c = mix(c, tongueC, body * (1.0 - teethLum0) * 0.7);
    // ... and behind the upper incisors' edge
    float teethLum = smoothstep(0.05, 0.25, max(c.r, max(c.g, c.b))) * vis;
    c = mix(c, tg.rgb, tg.a * (1.0 - 0.45 * teethLum));
    c = c * shade * (1.0 - 0.4 * uSleep);
    gl_FragColor = vec4(c, 1.0);
  }
}`;
