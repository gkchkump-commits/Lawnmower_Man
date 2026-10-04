// Placeholder head: an asset-free glowing hologram ellipsoid (grid + rim + amber eyes + gold
// mouth line). Last-resort fallback and used in tests.

/** @typedef {import('../../types.js').HeadContext} HeadContext */
/** @typedef {import('../../director.js').AnimState} AnimState */

const VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vNormalV;
void main() {
  vObj = position;
  // egg -> head: narrower jaw and chin
  vec3 p = position;
  float taper = 1.0 - 0.28 * smoothstep(0.15, -1.0, p.y);
  p.x *= taper;
  p.z *= 1.0 - 0.12 * smoothstep(0.0, -1.0, p.y);
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uEnergy;
uniform vec2 uBlink;
uniform vec2 uGaze;
uniform float uJaw;
uniform float uSmile;
uniform vec3 uGrid;
uniform vec3 uRim;
uniform vec3 uEye;
uniform vec3 uLine;
uniform float uDim;
varying vec3 vObj;
varying vec3 vNormalV;

float lineAA(float d, float width) {
  float w = fwidth(d);
  return 1.0 - smoothstep(width, width + w * 1.5, abs(d));
}

void main() {
  vec3 p = normalize(vObj);
  float facing = clamp(vNormalV.z, 0.0, 1.0);
  float rim = pow(1.0 - facing, 2.2);
  // lat/long grid
  float lon = atan(p.x, p.z) / 6.2831853;
  float lat = asin(clamp(p.y, -1.0, 1.0)) / 3.14159265;
  float gl = max(lineAA(fract(lon * 36.0 + 0.5) - 0.5, 0.04), lineAA(fract(lat * 28.0 + 0.5) - 0.5, 0.04));
  vec3 col = uGrid * (0.10 + 0.25 * gl) * (0.4 + 0.6 * facing);
  col += uRim * rim * (0.6 + 0.4 * uEnergy);
  // centre line + brow arcs in gold
  col += uLine * lineAA(p.x, 0.004) * smoothstep(0.1, 0.6, p.y) * 0.6 * step(0.0, p.z);
  // eyes
  for (int i = 0; i < 2; i++) {
    float sx = i == 0 ? -1.0 : 1.0;
    float b = i == 0 ? uBlink.x : uBlink.y;
    vec2 c = vec2(sx * 0.36, 0.06);
    vec2 d = p.xy - c - uGaze * vec2(0.05, 0.03);
    float open = max(0.03, 1.0 - b);
    float e = exp(-dot(d / vec2(0.13, 0.06 * open), d / vec2(0.13, 0.06 * open)) * 2.5);
    float ring = exp(-pow(length(d / vec2(1.0, open)) - 0.035, 2.0) * 3000.0) * open;
    col += uEye * (e * (1.2 + 1.2 * uEnergy) + ring) * step(0.0, p.z);
  }
  // mouth: gold line that opens into a dark gap with the jaw
  float my = -0.42 + 0.03 * uSmile * p.x * p.x * 30.0;
  float halfH = 0.02 + 0.07 * uJaw;
  float inMouth = step(abs(p.x), 0.22 + 0.04 * uSmile) * step(0.0, p.z);
  float edge = lineAA(abs(p.y - my) - halfH, 0.006) * inMouth;
  float gap = (1.0 - smoothstep(halfH - 0.01, halfH, abs(p.y - my))) * inMouth * smoothstep(0.0, 0.2, uJaw);
  col = mix(col, vec3(0.02, 0.01, 0.01), gap * 0.9);
  col += uLine * edge * 1.1;
  col *= uDim;
  float a = clamp(0.55 + 0.45 * rim, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

export default class PlaceholderHead {
  /** @param {HeadContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'placeholder';
    this.group = null;
  }

  async load() {
    const { THREE, scene, palette } = this.ctx;
    const geo = new THREE.SphereGeometry(1, 72, 54);
    this.uniforms = {
      uTime: { value: 0 }, uEnergy: { value: 0.5 }, uBlink: { value: new THREE.Vector2() },
      uGaze: { value: new THREE.Vector2() }, uJaw: { value: 0 }, uSmile: { value: 0 }, uDim: { value: 1 },
      uGrid: { value: palette.grid.clone() }, uRim: { value: palette.rim.clone() },
      uEye: { value: palette.eye.clone() }, uLine: { value: palette.line.clone() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: false, depthWrite: true, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.set(0.29, 0.4, 0.33);
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.position.set(0, 0.08, 0);
    scene.add(this.group);
  }

  /** @param {number} dt @param {number} time @param {AnimState} a */
  update(dt, time, a) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uEnergy.value = a.energy;
    u.uBlink.value.set(a.blinkL, a.blinkR);
    u.uGaze.value.set(a.gazeX, a.gazeY);
    u.uJaw.value = a.jawOpen;
    u.uSmile.value = a.smile;
    u.uDim.value = (1 - 0.45 * a.sleep) * (1 - 0.3 * a.error);
    this.group.rotation.set(-a.headPitch, a.headYaw, a.headRoll, 'ZYX');
    this.group.position.y = 0.08 + (a.breath - 0.5) * 0.003;
  }

  framing() {
    return { center: [0, 0, 0], height: 1.0, width: 0.67, projection: 'perspective', fov: 20 };
  }

  /** @returns {import('../../fx/particles.js').ParticleAnchors} */
  particleAnchors() {
    return { center: [0, 0.08], radius: [0.29, 0.4], neckX: 0, neckTop: -0.3, neckBottom: -0.52,
      neckHalfWidth: 0.12, depth: 0.3 };
  }

  /** Outline in world units (rest pose) for hit testing. */
  hitPolygon() {
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      pts.push(Math.cos(t) * 0.29, 0.08 + Math.sin(t) * 0.4);
    }
    return new Float32Array(pts);
  }

  /** @param {{ palette?: any }} o */
  setOptions(o) {
    if (o.palette && this.uniforms) {
      this.uniforms.uGrid.value.copy(o.palette.grid);
      this.uniforms.uRim.value.copy(o.palette.rim);
      this.uniforms.uEye.value.copy(o.palette.eye);
      this.uniforms.uLine.value.copy(o.palette.line);
    }
  }

  dispose() {
    if (!this.group) return;
    this.ctx.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.group = null;
  }
}
