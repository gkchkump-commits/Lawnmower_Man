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
uniform float uPlateAspect;
uniform vec2 uCornerL;
uniform vec2 uCornerR;
uniform vec2 uBrows;
uniform vec4 uLids;   // upperL, lowerL, upperR, lowerR travel (world units, + closes)

vec3 applyRig(vec3 p) {
  // eyelids: upper lids move down, lower lids move up
  p.y += -aW1.y * uLids.x + aW1.z * uLids.y - aW1.w * uLids.z + aW2.x * uLids.w;
  // brows
  p.y += aW2.y * uBrows.x + aW2.z * uBrows.y;
  // lips
  p.y += aW0.z * uUpperLift - aW0.y * uLowerDrop;
  p.xy += aW0.w * uCornerL + aW1.x * uCornerR;
  p.z += (aW0.y + aW0.z) * uLipPush;
  // jaw: drops (and slightly recedes) with its weight; the weights already fall off toward the
  // cheeks and neck, so a weighted translation reads as a hinge without the depth ordering
  // problems a large rotation causes in a 2.5D relief
  float j = aW0.x * uJawDrop;
  p.y -= j;
  p.z -= j * 0.3;
  return p;
}

vec3 applyHead(vec3 p) {
  return uHeadPivot + uHeadRot * (p - uHeadPivot) + vec3(0.0, uBreathY, 0.0);
}

// world (relief, pre-rotation) -> plate uv
vec2 plateUv(vec3 p) {
  return vec2(p.x / uPlateAspect + 0.5, p.y + 0.5);
}
`;

export const FACE_VERT = /* glsl */ `
${RIG_CHUNK}
attribute float aEdge;
varying vec2 vUv;
varying vec2 vUv2;
varying float vEdge;
varying float vFace;
void main() {
  vUv = uv;
  vec3 p = applyRig(position);
  vUv2 = plateUv(p);
  vEdge = aEdge;
  vFace = aW2.w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(applyHead(p), 1.0);
}`;

export const FACE_FRAG = /* glsl */ `
uniform sampler2D tPlate;
uniform sampler2D tClosed;
uniform sampler2D tMaskA;   // r alpha, g gold lines, b sparkle
uniform sampler2D tMaskB;   // r eye aperture, g eye region, b mouth region
uniform vec2 uPlateSize;    // px
uniform vec4 uEyeL;         // uv.xy, iris radius (plate heights), -
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
varying vec2 vUv;
varying vec2 vUv2;
varying float vEdge;
varying float vFace;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Gaze: the iris (and the glow around it) slides rigidly; the displacement falls off smoothly
// (separably, gradient < 0.5 so the texture never folds) toward the eye corners and the brow.
// MediaPipe's lid polygon is tighter than the hologram's visible iris, so no lid mask here.
vec2 gazeWarp(vec2 uv, vec4 eye) {
  vec2 d = abs(uv - eye.xy) * vec2(uPlateSize.x / uPlateSize.y, 1.0) / eye.z;
  return uGaze * (1.0 - smoothstep(1.05, 2.5, d.x)) * (1.0 - smoothstep(0.95, 1.8, d.y));
}

void main() {
  vec4 mA = texture2D(tMaskA, vUv);
  float alpha = mA.r;
  if (alpha < 0.012) discard;                 // keep invisible fringe out of the depth buffer
  vec4 mB = texture2D(tMaskB, vUv);
  float ap = mB.r;
  vec2 suv = vUv;
  if (mB.g > 0.001) suv -= (vUv.x < 0.5 ? gazeWarp(vUv, uEyeL) : gazeWarp(vUv, uEyeR));
  vec3 col = texture2D(tPlate, suv).rgb;
  float baseLum = dot(col, vec3(0.2126, 0.7152, 0.0722));

  // blink: cross-fade to the closed-eye frame, sampled where the (squashed) lids now are
  float bl = vUv2.x < 0.5 ? uBlink.x : uBlink.y;
  if (bl > 0.001) {
    // (the region's soft falloff lies on the lid skin, where both frames look alike)
    float region = clamp(texture2D(tMaskB, vUv2).g * 1.25, 0.0, 1.0);
    float f = smoothstep(0.15, 0.85, bl) * region;
    col = mix(col, texture2D(tClosed, vUv2).rgb, f);
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

  if (uError > 0.001) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    float fl = 0.72 + 0.28 * step(0.45, hash12(vec2(floor(uTime * 17.0), 3.0)));
    col = mix(col, vec3(l * 1.15, l * 0.45, l * 0.42) * fl, uError * 0.7);
  }
  col *= (1.0 - 0.5 * uSleep) * (1.0 + e * 0.35);
  gl_FragColor = vec4(col * alpha, alpha);    // premultiplied
  // Only solid, visibly lit head pixels occlude the particle aura. The soft fringe and the black
  // background enclosed by the silhouette (e.g. between ear and cranium) write "far" depth so
  // motes behind them are not cut out (that would leave a dark band around the head).
  gl_FragDepth = (alpha > 0.45 && baseLum > 0.006) ? gl_FragCoord.z : 1.0;
}`;

export const CAVITY_VERT = /* glsl */ `
${RIG_CHUNK}
attribute float aLayer;
attribute float aSlit;
varying vec2 vUvM;
varying float vLayer;
varying float vSlit;
void main() {
  vUvM = uv;
  vLayer = aLayer;
  vSlit = aSlit;
  vec3 p = applyRig(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(applyHead(p), 1.0);
}`;

export const CAVITY_FRAG = /* glsl */ `
uniform sampler2D tMouth;
uniform float uOpen;
uniform vec3 uDark;
uniform float uSleep;
varying vec2 vUvM;
varying float vLayer;
varying float vSlit;
void main() {
  vec3 c = texture2D(tMouth, vUvM).rgb;
  float vis = smoothstep(0.02, 0.2, uOpen);   // teeth only once the lips actually part
  if (vLayer > 0.5) {
    float a = smoothstep(0.03, 0.16, max(c.r, max(c.g, c.b))) * vis;
    if (a < 0.01) discard;
    gl_FragColor = vec4(c * a * 0.92, a);
  } else {
    float shade = mix(0.3, 1.0, smoothstep(0.0, 6.0, vSlit));   // shadow under the upper lip
    c = mix(uDark, c, vis) * shade * (1.0 - 0.4 * uSleep);
    gl_FragColor = vec4(c, 1.0);
  }
}`;
