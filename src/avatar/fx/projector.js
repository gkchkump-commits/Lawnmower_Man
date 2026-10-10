// Projector light (optional, avatar.projector): the hologram is projected from a small emitter
// below the bust: a faint cone of light rises from it into the dissolving neck, with slow beam
// streaks and scan lines running up it. One quad, additive, behind the head (the head occludes
// it), evaluated in the fragment shader from a handful of uniforms.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uEmit;      // emitter x, y (world) and the cone's height (to the chin)
uniform float uHalf;     // the cone's half width at the top (world)
uniform float uTime;
uniform float uLevel;    // brightness (energy, states)
uniform vec3 uColor;
varying vec2 vP;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) { float i = floor(x), f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  vec2 d = vP - uEmit.xy;
  float h = d.y / uEmit.z;                         // 0 at the emitter, 1 at the chin
  // the emitter: a small bright ellipse with a soft glow
  float e = exp(-pow(d.x / (0.09 * uHalf), 2.0) - pow(d.y / (0.012 * uEmit.z + 0.004), 2.0));
  float glow = exp(-dot(d / vec2(0.5 * uHalf, 0.1 * uEmit.z), d / vec2(0.5 * uHalf, 0.1 * uEmit.z)));
  vec3 col = uColor * (1.6 * e + 0.25 * glow);
  if (h > 0.0 && h < 1.2) {
    // the cone: wider as it rises, its edges soft
    float w = mix(0.08, 1.0, h) * uHalf;
    float x = d.x / w;
    float cone = (1.0 - smoothstep(0.55, 1.0, abs(x)));
    // beams: streaks along the cone's rays, drifting slowly; scan lines running up
    float ray = x * 9.0;
    float beams = 0.55 + 0.45 * noise(ray + uTime * 0.15) * noise(ray * 2.3 - uTime * 0.1 + 7.0);
    float scan = 0.75 + 0.25 * sin((h * 26.0 - uTime * 1.6) * 6.2832 / 3.0);
    // brightest just above the emitter, fading out into the neck (no light on the face)
    float fade = smoothstep(0.0, 0.08, h) * pow(1.0 - smoothstep(0.15, 1.05, h), 1.5);
    col += uColor * cone * beams * scan * fade * 0.34;
  }
  gl_FragColor = vec4(col * uLevel, 0.0);
}`;

export class Projector {
  /** @param {{ palette: { wisp: THREE.Color } }} opts */
  constructor(opts) {
    this.uniforms = {
      uEmit: { value: new THREE.Vector3(0, -0.5, 0.3) }, uHalf: { value: 0.15 }, uTime: { value: 0 },
      uLevel: { value: 1 }, uColor: { value: new THREE.Color(opts.palette.wisp) },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /**
   * Place it under the bust: the emitter at the bottom of the view below the neck, the cone up to
   * the chin. @param {import('./particles.js').ParticleAnchors} a @param {number} viewBottom world y
   * @param {number} viewW world width
   */
  setAnchors(a, viewBottom, viewW) {
    const ey = viewBottom + 0.015;
    const top = a.neckTop;
    const u = this.uniforms;
    u.uEmit.value.set(a.neckX, ey, Math.max(0.05, top - ey));
    u.uHalf.value = Math.min(viewW * 0.45, a.neckHalfWidth * 1.9);
    // the quad covers the cone (behind the head: the face occludes it)
    const h = top - ey + 0.06, w = 2.4 * u.uHalf.value;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(a.neckX, ey - 0.03 + h / 2, -0.25 * (a.depth || 0.3));
  }

  /** @param {boolean} on */
  setVisible(on) { this.mesh.visible = !!on; }

  /** @param {number} time @param {import('../director.js').AnimState} a */
  update(time, a) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uLevel.value = (0.65 + 0.6 * a.energy + 0.25 * (a.pulse ?? 0)) * (1 - 0.7 * a.sleep) * (1 - 0.5 * a.error);
  }

  /** @param {{ wisp?: THREE.ColorRepresentation }} pal */
  setPalette(pal) { if (pal.wisp) this.uniforms.uColor.value.set(pal.wisp); }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
