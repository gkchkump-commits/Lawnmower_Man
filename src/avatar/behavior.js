// Behaviour layer (pure, no three.js): the spontaneous repertoire of a person sitting at a screen,
// on top of the director's motion (docs/RENDERER.md, "Behaviour"). The director calls it once a
// frame through one hook (Behavior#update) and adds what it returns: head offsets, posture (lean,
// sideways shift), a gaze target of its own, and face channels outside speech.
//
//   scheduler  a semi-Markov process per track (gaze, head, face, breath): a track that is free
//              waits a random (gamma) time drawn from the total rate of the gestures that fit the
//              situation (state, typing, the camera's view of the user, boredom), then starts one
//              of them, picked by its rate; each kind has a refractory period, so nothing comes
//              twice in a row, and every instance draws its own durations, amplitudes and
//              directions. Start times are continuous (not frames), so 60 and 144 Hz show the same
//              behaviour. No clock, no loop: inter-gesture intervals are random, and so are the
//              gestures.
//   kinematics every gesture is minimum-jerk envelopes / pulses (src/avatar/motion.js) that start
//              and end at rest; the gaze jumps between fixations (the eye controller makes the
//              saccades and the head's share); posture drifts through critically damped springs
//              toward targets that change every few to tens of seconds. A gesture cut short (a
//              state change) fades out over a few hundred ms, so nothing steps.
//   scaling    rates scale with `liveliness` (0 = off, 1 = default, 2 = twice as often), sizes
//              with 0.55 + 0.45 x liveliness.
//
// Repertoire by situation:
//   idle       look-arounds (head + eyes to points in the room and back), head tilts, posture
//              shifts, brow flashes, brief smiles, lip presses, a swallow, a deep breath / sigh, a
//              slow neck roll
//   bored      (idle long, or the camera sees nobody) longer gazes away, slumping, sighs, yawns
//   typing     the user types: leans in, glances down at the chat now and then
//   listening  leans in, attentive tilts, backchannel nods with a brow / lip "mm-hm"
//   thinking   looks around in the averted region, pressed / pursed lips, a squint, a "hmm" tilt
//   speaking   the prosody leads (src/avatar/director.js): only posture drift, and energy pulses
//              on the accents for the hologram
//   camera     present and looking: engaged (fewer look-arounds, more smiles), mirrors the user's
//              head tilt a little, a smile and a brow flash when the user looks back at it

import { clamp, clamp01, mulberry32 } from './noise.js';
import { Spring, envelope, gauss, logNormal, minJerk, pulse } from './motion.js';

const RAD = Math.PI / 180;
/** liveliness range (avatar.liveliness): 0 = no spontaneous behaviour, 1 = default, 2 = lively */
export const LIVELINESS_MAX = 2;

const softOr = (a, b) => 1 - (1 - a) * (1 - b);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** The tracks a gesture can occupy (one gesture per track at a time). */
export const TRACKS = /** @type {const} */ (['gaze', 'head', 'face', 'breath']);

/**
 * @typedef {Object} BehaviorOut   what the director adds (all 0 / off at rest)
 * @property {number} yaw    rad, added to the head
 * @property {number} pitch  rad
 * @property {number} roll   rad
 * @property {number} lean   -1..1 toward (+) / away from the viewer (posture)
 * @property {number} shiftX -1..1 the head shifted sideways (posture)
 * @property {number} brow   0..1 added to the brows
 * @property {number} smile  0..1
 * @property {number} press  0..1 lips pressed (outside speech)
 * @property {number} round  0..1 lips pursed
 * @property {number} jaw    0..1 (a yawn, a sigh's parted lips)
 * @property {number} squint 0..1 the eyes narrow
 * @property {number} chin   0..1 the chin bunches (pressed lips, a swallow)
 * @property {number} nostril 0..1 (a deep breath)
 * @property {number} sigh   0..1 a deep breath in and out
 * @property {number} pulse  0..1 energy wave on an accent / emphasis (the hologram's glow)
 * @property {boolean} blink a blink now (the end of a yawn, some look-arounds)
 * @property {{ on: boolean, rel: boolean, x: number, y: number, share: number, jump: boolean }} gaze
 *   while on: the eyes look at (x, y) (world degrees; rel: relative to the director's own target)
 *   with this head share; jump: the target changed this frame
 */

/** @returns {BehaviorOut} */
export function createBehaviorOut() {
  return {
    yaw: 0, pitch: 0, roll: 0, lean: 0, shiftX: 0, brow: 0, smile: 0, press: 0, round: 0, jaw: 0, squint: 0,
    chin: 0, nostril: 0, sigh: 0, pulse: 0, blink: false, gaze: { on: false, rel: false, x: 0, y: 0, share: 0.3, jump: false },
  };
}

/**
 * Situation of a frame (computed by Behavior#update from what the director passes in).
 * @typedef {{ state: string, look: boolean, lookKind: string, typing: boolean, present: boolean|null,
 *   looking: boolean, bored: number, L: number, A: number, thinkSide: number, thinkUp: boolean }} Ctx
 */

/**
 * The repertoire. rate(c): per minute at liveliness 1 (0: not now); refr: seconds before the same
 * kind again; tracks: what it occupies; make(r, c): one instance's parameters (incl. dur);
 * apply(g, x, out, c): its contribution x seconds after it started (fade-out applied outside).
 * @type {Record<string, { tracks: string[], refr: number, rate: (c: Ctx) => number,
 *   make: (r: () => number, c: Ctx) => any, apply: (g: any, x: number, o: BehaviorOut, k: number, c: Ctx) => void }>}
 */
const KINDS = {
  // ---- gaze ------------------------------------------------------------------------------------
  lookAround: {
    tracks: ['gaze'], refr: 3,
    rate: (c) => {
      if (c.look || c.typing) return 0;
      if (c.state === 'idle') return 4.5 * (c.present && c.looking ? 0.35 : 1) * (1 + 0.4 * c.bored);
      if (c.state === 'listening') return 0.4;
      return 0;
    },
    make: (r, c) => {
      // a point in the "room": mostly to the side, sometimes down-aside, rarely up; bored looks
      // are larger and much longer; listening's are short "where was I" glances
      const small = c.state === 'listening';
      const side = r() < 0.5 ? -1 : 1;
      const amp = Math.min(22, logNormal(r, small ? 7 : 12, 0.3, 5, 20) * (1 + 0.35 * c.bored) * (0.8 + 0.2 * c.A));
      const vr = r();
      const vy = vr < 0.27 ? -(0.25 + 0.35 * r()) : vr < 0.38 ? 0.15 + 0.25 * r() : (r() - 0.5) * 0.2;
      const fix = [{ x: side * amp, y: amp * vy, d: logNormal(r, small ? 0.75 : 1.25, 0.45, 0.4, 4) * (1 + 2.2 * c.bored) }];
      // sometimes a second (and third) fixation nearby: scanning
      const more = small ? 0 : r() < 0.3 ? (r() < 0.2 ? 2 : 1) : 0;
      for (let i = 0; i < more; i++) {
        const p = fix[fix.length - 1];
        // (never beyond 24 deg: the eyes stay in their range with the head's share)
        const nx = clamp(p.x + side * (2 + 5 * r()) * (r() < 0.25 ? -1 : 1), -24, 24);
        fix.push({ x: nx, y: p.y + (r() - 0.5) * 5, d: logNormal(r, 0.9, 0.4, 0.35, 3) * (1 + c.bored) });
      }
      // the head goes along with a good share of a look into the room (more when bored)
      return withHead({ fix, share: 0.3 + 0.12 * r() + 0.08 * c.bored, blink: amp > 11 && r() < 0.35 });
    },
    apply: gazeFixations,
  },
  chatGlance: {
    // the user types: the eyes go down to the chat below the face now and then
    tracks: ['gaze'], refr: 1.4,
    rate: (c) => (c.typing && (c.state === 'idle' || c.state === 'listening') ? 16 : 0),
    make: (r) => {
      const d = logNormal(r, 0.8, 0.35, 0.4, 1.8);
      // (the head dips with the eyes, more than its usual vertical share)
      return withHead({ fix: [{ x: (r() - 0.5) * 7, y: -(9.5 + 4 * r()), d }], share: 0.15, shareY: 0.12 + 0.08 * r() });
    },
    apply: gazeFixations,
  },
  search: {
    // thinking: the eyes wander within the averted region ("searching memory")
    tracks: ['gaze'], refr: 1.8,
    rate: (c) => (c.state === 'thinking' ? 8 : 0),
    make: (r, c) => {
      const n = 1 + (r() < 0.45 ? 1 : 0) + (r() < 0.15 ? 1 : 0);
      const fix = [];
      for (let i = 0; i < n; i++) {
        const a = 2.5 + 4.5 * r(), ang = r() * Math.PI * 2;
        fix.push({ x: a * Math.cos(ang) + c.thinkSide * 1.5, y: 0.7 * a * Math.sin(ang), d: logNormal(r, 0.7, 0.4, 0.3, 2) });
      }
      return withHead({ fix, rel: true, share: 0.2 });
    },
    apply: gazeFixations,
  },

  // ---- head ------------------------------------------------------------------------------------
  tilt: {
    tracks: ['head'], refr: 6,
    rate: (c) => (c.state === 'idle' && !c.typing ? 2.0 * (1 - 0.3 * c.bored) : c.state === 'listening' ? 2.2 : c.typing ? 0.5 : 0),
    make: (r, c) => {
      const a = 0.5 + 0.4 * r(), h = logNormal(r, 2.2, 0.5, 0.8, 6), rel = 0.7 + 0.5 * r();
      return {
        dur: a + h + rel, a, h, rel, dir: r() < 0.5 ? -1 : 1, roll: (2.2 + 2.8 * r()) * (c.state === 'listening' ? 1.15 : 1),
        yaw: (r() - 0.5) * 2, pitch: (r() - 0.6) * 1.2,
      };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, g.a, g.h, g.rel) * k;
      o.roll += g.dir * g.roll * RAD * e;
      o.yaw += g.yaw * RAD * e;
      o.pitch += g.pitch * RAD * e;
    },
  },
  nod: {
    // listening: backchannel nods ("mm-hm"), one or two, with a brow / lip micro-movement
    tracks: ['head'], refr: 1.7,
    rate: (c) => (c.state === 'listening' ? 8 : 0),
    make: (r) => {
      const amp = 1.1 + 1.5 * r(), k = 0.85 + 0.35 * r(), two = r() < 0.38;
      return { dur: (two ? 0.95 : 0.55) * k, amp, k, two, brow: 0.12 + 0.15 * r(), press: r() < 0.5 ? 0.2 + 0.2 * r() : 0, yaw: (r() - 0.5) * 0.6 };
    },
    apply: (g, x, o, k) => {
      let n = pulse(x, 0.17 * g.k, 0.3 * g.k);
      if (g.two) n += 0.6 * pulse(x - 0.42 * g.k, 0.15 * g.k, 0.3 * g.k);
      o.pitch -= g.amp * RAD * n * k;
      o.yaw += g.yaw * RAD * n * k;
      const mm = envelope(x, 0.12, Math.max(0, g.dur - 0.4), 0.28) * k;
      o.brow = softOr(o.brow, g.brow * mm);
      if (g.press) { o.press = softOr(o.press, g.press * mm); o.chin = softOr(o.chin, 0.5 * g.press * mm); }
    },
  },
  neckRoll: {
    // a slow, stretch-like roll of the head: to one side, down, to the other side, back up
    tracks: ['head'], refr: 50,
    rate: (c) => (c.state === 'idle' && !c.typing ? 0.15 * (1 + 3 * c.bored) : 0),
    make: (r) => ({ dur: 3.2 + 1.6 * r(), R: 3.5 + 2.5 * r(), P: 2.5 + 2 * r(), dir: r() < 0.5 ? -1 : 1, eyes: r() < 0.5 }),
    apply: (g, x, o, k) => {
      const u = minJerk(x / g.dur), ph = 2 * Math.PI * u;
      o.roll += g.dir * g.R * RAD * Math.sin(ph) * k;
      o.pitch -= g.P * RAD * 0.5 * (1 - Math.cos(ph)) * k;
      // (eyes half closed while stretching, now and then)
      if (g.eyes) o.squint = softOr(o.squint, 0.4 * Math.sin(Math.PI * u) * k);
    },
  },
  hmm: {
    // thinking: a "hmm" — the head tilts (toward the side it looks to), lips pressed, a squint
    tracks: ['head', 'face'], refr: 5,
    rate: (c) => (c.state === 'thinking' ? 3 : 0),
    make: (r, c) => {
      const a = 0.45 + 0.3 * r(), h = logNormal(r, 1.6, 0.4, 0.7, 4), rel = 0.7 + 0.4 * r();
      return { dur: a + h + rel, a, h, rel, roll: (2.5 + 2.5 * r()) * (r() < 0.75 ? c.thinkSide : -c.thinkSide), press: 0.35 + 0.35 * r(), squint: r() < 0.6 ? 0.25 + 0.2 * r() : 0, pitch: 0.5 + r() };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, g.a, g.h, g.rel) * k;
      o.roll += g.roll * RAD * e;
      o.pitch += g.pitch * RAD * e;
      o.press = softOr(o.press, g.press * e);
      o.chin = softOr(o.chin, 0.45 * g.press * e);
      if (g.squint) o.squint = softOr(o.squint, g.squint * e);
    },
  },

  // ---- face ------------------------------------------------------------------------------------
  browFlash: {
    tracks: ['face'], refr: 7,
    rate: (c) => (c.state === 'idle' ? 1.0 * (1 - 0.7 * c.bored) * (c.present && c.looking ? 1.6 : 1) : c.state === 'listening' ? 0.8 : 0),
    make: (r) => {
      const h = 0.12 + 0.22 * r();
      return { dur: 0.13 + h + 0.38, h, amp: 0.3 + 0.35 * r() };
    },
    apply: (g, x, o, k) => { o.brow = softOr(o.brow, g.amp * envelope(x, 0.13, g.h, 0.38) * k); },
  },
  smile: {
    tracks: ['face'], refr: 10,
    rate: (c) => (c.state === 'idle' ? (c.typing ? 0.3 : 0.7) * (1 - 0.8 * c.bored) * (c.present && c.looking ? 2.2 : 1) : c.state === 'listening' ? 0.5 : 0),
    make: (r) => {
      const a = 0.35 + 0.2 * r(), h = logNormal(r, 1.1, 0.5, 0.4, 3.5), rel = 0.8 + 0.5 * r();
      return { dur: a + h + rel, a, h, rel, amp: 0.15 + 0.22 * r(), brow: r() < 0.35 ? 0.15 : 0 };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, g.a, g.h, g.rel) * k;
      o.smile = softOr(o.smile, g.amp * e);
      if (g.brow) o.brow = softOr(o.brow, g.brow * e);
    },
  },
  press: {
    // lips pressed together (or rolled in) for a moment
    tracks: ['face'], refr: 8,
    rate: (c) => (c.state === 'idle' ? 0.6 : c.state === 'thinking' ? 1.5 : 0),
    make: (r) => {
      const h = logNormal(r, 0.9, 0.45, 0.35, 2.5);
      return { dur: 0.2 + h + 0.32, h, amp: 0.45 + 0.4 * r() };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, 0.2, g.h, 0.32) * k;
      o.press = softOr(o.press, g.amp * e);
      o.chin = softOr(o.chin, 0.55 * g.amp * e);
    },
  },
  purse: {
    // thinking: lips pursed (pushed forward a little)
    tracks: ['face'], refr: 7,
    rate: (c) => (c.state === 'thinking' ? 1.2 : c.state === 'idle' && !c.typing ? 0.15 : 0),
    make: (r) => {
      const h = logNormal(r, 1.0, 0.45, 0.4, 2.6);
      return { dur: 0.3 + h + 0.4, h, amp: 0.24 + 0.16 * r() };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, 0.3, g.h, 0.4) * k;
      o.round = softOr(o.round, g.amp * e);
      o.press = softOr(o.press, 0.35 * g.amp * e);
      o.chin = softOr(o.chin, 0.4 * g.amp * e);
    },
  },
  squint: {
    tracks: ['face'], refr: 6,
    rate: (c) => (c.state === 'thinking' ? 1.2 : 0),
    make: (r) => {
      const h = logNormal(r, 1.0, 0.45, 0.4, 2.5);
      return { dur: 0.3 + h + 0.5, h, amp: 0.28 + 0.22 * r() };
    },
    apply: (g, x, o, k) => { o.squint = softOr(o.squint, g.amp * envelope(x, 0.3, g.h, 0.5) * k); },
  },
  swallow: {
    // lips close, the chin bunches and the head dips a little
    tracks: ['face'], refr: 25,
    rate: (c) => (c.state === 'idle' && !c.typing ? 0.35 : c.state === 'thinking' ? 0.2 : 0),
    make: (r) => ({ dur: 0.75, amp: 0.7 + 0.25 * r(), dip: 0.5 + 0.5 * r() }),
    apply: (g, x, o, k) => {
      const e = pulse(x, 0.22, 0.45) * k;
      o.press = softOr(o.press, g.amp * e);
      o.chin = softOr(o.chin, 0.6 * e);
      o.pitch -= g.dip * RAD * pulse(x - 0.08, 0.2, 0.4) * k;
    },
  },
  yawn: {
    // bored: the mouth opens slowly with the eyes narrowing, the head tilts back, a deep breath
    tracks: ['face', 'head', 'breath'], refr: 110,
    rate: (c) => (c.state === 'idle' && !c.typing && c.bored > 0.3 ? 0.7 * c.bored * c.bored : 0),
    make: (r) => {
      const a = 1.4 + 0.5 * r(), h = 0.7 + 0.7 * r(), rel = 1.1 + 0.4 * r();
      return { dur: a + h + rel + 0.2, a, h, rel, jaw: 0.42 + 0.18 * r(), back: 2.5 + 1.5 * r(), roll: (r() - 0.5) * 3 };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, g.a, g.h, g.rel) * k;
      o.jaw = softOr(o.jaw, g.jaw * e);
      o.round = softOr(o.round, 0.18 * e);
      o.squint = softOr(o.squint, 0.7 * envelope(x - 0.3, g.a - 0.2, g.h + 0.2, g.rel * 0.8) * k);
      o.brow = softOr(o.brow, 0.25 * pulse(x, 0.5 * g.a, g.a));
      o.pitch += g.back * RAD * e;
      o.roll += g.roll * RAD * e;
      o.sigh = softOr(o.sigh, envelope(x, g.a, g.h, g.rel + 0.6) * k);
      o.nostril = softOr(o.nostril, 0.4 * envelope(x, g.a * 0.8, g.h, 0.6) * k);
      if (x >= g.a + g.h + g.rel - 0.15 && !g.blinked) { g.blinked = true; o.blink = true; }
    },
  },
  acknowledge: {
    // the camera: the user looks back at the avatar after looking away (event-driven, rate 0)
    tracks: ['face'], refr: 12,
    rate: () => 0,
    make: (r) => ({ dur: 2.6, brow: 0.45 + 0.15 * r(), smile: 0.3 + 0.12 * r() }),
    apply: (g, x, o, k) => {
      o.brow = softOr(o.brow, g.brow * envelope(x, 0.12, 0.22, 0.4) * k);
      o.smile = softOr(o.smile, g.smile * envelope(x - 0.08, 0.4, 1.2, 0.9) * k);
    },
  },

  // ---- breath ----------------------------------------------------------------------------------
  deepBreath: {
    // a deep breath in and out (a sigh when bored): the chest and head rise, the nostrils widen
    tracks: ['breath'], refr: 20,
    rate: (c) => (c.state === 'idle' ? 0.45 * (1 + 1.2 * c.bored) : c.state === 'thinking' ? 0.5 : c.state === 'listening' ? 0.15 : 0),
    make: (r, c) => {
      const a = 1.2 + 0.5 * r(), rel = 2 + 1 * r();
      return { dur: a + 0.5 + rel, a, rel, lift: 0.5 + 0.6 * r(), lips: c.bored > 0.4 || r() < 0.3 };
    },
    apply: (g, x, o, k) => {
      const e = envelope(x, g.a, 0.5, g.rel) * k;
      o.sigh = softOr(o.sigh, e);
      o.pitch += g.lift * RAD * envelope(x, g.a, 0.4, g.rel * 0.8) * k;
      o.nostril = softOr(o.nostril, 0.35 * envelope(x, g.a * 0.7, 0.3, 0.5) * k);
      // a sigh breathes out through parted lips
      if (g.lips) o.jaw = softOr(o.jaw, 0.05 * envelope(x - g.a - 0.3, 0.3, g.rel * 0.5, 0.6) * k);
    },
  },
};

/** Head movement time (s) for a turn of `deg` degrees (gaze shifts: ~0.35 s small, ~0.75 s large). */
const headMoveDur = (deg) => clamp(0.32 + 0.035 * Math.abs(deg), 0.32, 0.8);

/**
 * A gaze gesture's head motion: a minimum-jerk step toward each fixation's share (starting a
 * moment after the saccade), and one back at the end. Steps superpose, so overlapping ones stay
 * smooth (C2). Adds `steps` and the total `dur` (the fixations plus the head's way back).
 */
function withHead(g) {
  const sx = g.share, sy = g.shareY ?? 0.5 * g.share;
  g.steps = [];
  let t = 0, hx = 0, hy = 0;
  for (const f of g.fix) {
    const nx = sx * f.x, ny = sy * f.y;
    g.steps.push({ at: t + 0.04, dur: headMoveDur(Math.hypot(nx - hx, ny - hy)), dx: nx - hx, dy: ny - hy });
    hx = nx; hy = ny;
    t += f.d;
  }
  g.gazeDur = t;
  const back = headMoveDur(Math.hypot(hx, hy));
  g.steps.push({ at: t + 0.04, dur: back, dx: -hx, dy: -hy });
  g.dur = t + 0.04 + back;
  return g;
}

/**
 * The fixations of a gaze gesture: a piecewise constant target (the eye controller makes the
 * saccades and, with share 0, no head motion of its own: the gesture moves the head itself).
 */
function gazeFixations(g, x, o, k) {
  let hx = 0, hy = 0;
  for (const s of g.steps) {
    if (x <= s.at) break;
    const u = minJerk((x - s.at) / s.dur);
    hx += s.dx * u; hy += s.dy * u;
  }
  o.yaw += hx * RAD * k;
  o.pitch += hy * RAD * k;
  if (k < 0.999) return; // fading out: the gaze is back with the director already
  let t = 0;
  for (const f of g.fix) {
    if (x < t + f.d) {
      o.gaze.on = true;
      o.gaze.rel = !!g.rel;
      o.gaze.x = f.x;
      o.gaze.y = f.y;
      o.gaze.share = 0;
      return;
    }
    t += f.d;
  }
}

/** Posture bias by situation: [yaw deg, pitch deg, roll deg, shiftX, lean]. */
function postureBias(c, side) {
  const b = [0, 0, 0, 0, 0];
  if (c.state === 'listening') { b[1] = -1.0; b[2] = 1.3 * side; b[4] = 0.55; }
  else if (c.state === 'thinking') { b[4] = -0.15; }
  else if (c.state === 'idle') {
    if (c.typing) { b[1] = -0.8; b[4] = 0.4; }
    else if (c.present && c.looking) b[4] = 0.22;
    // bored: slumping a little
    b[1] -= 1.3 * c.bored; b[4] -= 0.3 * c.bored;
  }
  return b;
}

export class Behavior {
  /** @param {{ seed?: number, liveliness?: number }} [o] */
  constructor(o = {}) {
    this.seed = (o.seed ?? 1) | 0;
    this.rng = mulberry32(this.seed * 49979687 + 29);
    this.liveliness = 1;
    this.setLiveliness(o.liveliness ?? 1);
    this.out = createBehaviorOut();
    /** @type {Array<{ kind: string, t0: number, dur: number, fadeAt: number, fadeDur: number, p: any }>} */
    this._active = [];
    /** next start time per track (NaN: to be drawn; Infinity: nothing fits until the situation changes) */
    this._next = Object.fromEntries(TRACKS.map((k) => [k, NaN]));
    this._ctxKey = '';
    /** when each track became free (the origin of its next wait: continuous time, not a frame) */
    this._freeAt = Object.fromEntries(TRACKS.map((k) => [k, NaN]));
    /** @type {Record<string, number>} last start per kind */
    this._last = {};
    this._state = 'idle';
    this._stateAt = 0;
    this._time = 0;
    this._started = false;
    // the user, as the app sees them
    this._typedAt = -Infinity;
    this._engagedAt = 0;
    /** @type {boolean|null} null: no camera */
    this._present = null;
    this._absentAt = -Infinity;
    this._looking = false;
    this._lookChangedAt = 0;
    this._userRoll = 0;
    this._ackWanted = false;
    /** @type {number|undefined} a blink requested by a gesture, at this time */
    this._blinkAt = undefined;
    /** @type {Ctx} this frame's situation (one object, updated in place) */
    this._c = /** @type {any} */ ({});
    // posture: springs toward targets that change every few to tens of seconds
    this._post = { yaw: new Spring(), pitch: new Spring(), roll: new Spring(), shiftX: new Spring(), lean: new Spring() };
    this._postTarget = [0, 0, 0, 0, 0];
    this._postOmega = 2;
    this._postNext = NaN;
    this._postSide = 1;
    this._mirror = new Spring();
    this._pulses = /** @type {Array<{ at: number, amp: number }>} */ ([]);
    /** recent gestures { t, kind } (tools, tests) */
    this.log = /** @type {Array<{ t: number, kind: string }>} */ ([]);
  }

  /** @param {number} k 0..2 */
  setLiveliness(k) {
    const n = Number(k);
    this.liveliness = Number.isFinite(n) ? clamp(n, 0, LIVELINESS_MAX) : 1;
    if (this._started) this._postNext = this._time;
  }

  /** The director's state changed (at time t): gestures that do not fit fade out, tracks re-draw. */
  setState(s, t) {
    if (s === this._state) return;
    const prev = this._state;
    this._state = s;
    this._stateAt = t;
    if (s !== 'idle' || prev === 'sleep') this._engagedAt = t;
    for (const g of this._active) {
      const K = KINDS[g.kind];
      const fits = (K.rate(this._ctxFor(s, t)) > 0 || g.kind === 'acknowledge') && !K.tracks.includes('gaze');
      // speech owns the face and the head's motion: everything fades quickly as it starts
      if (s === 'speaking' || s === 'sleep' || s === 'error' || !fits) this._fade(g, t, s === 'speaking' ? 0.25 : 0.45);
    }
    for (const k of TRACKS) { this._next[k] = NaN; this._freeAt[k] = t; }
    // the posture follows the new situation soon
    this._postNext = Math.min(Number.isFinite(this._postNext) ? this._postNext : Infinity, t + 0.15 + 0.35 * this.rng());
  }

  /**
   * What the app knows about the user. typing: a key was typed now; present / looking / roll: the
   * camera's view (null present = no camera); roll: the user's head tilt in radians as seen in the
   * selfie view (+ = counter-clockwise on screen).
   * @param {{ typing?: boolean, present?: boolean|null, looking?: boolean, roll?: number }} u @param {number} t
   */
  setUser(u, t) {
    if (!u || typeof u !== 'object') return;
    if (u.typing) { this._typedAt = t; this._engagedAt = t; }
    if (u.present !== undefined) {
      const p = u.present === null ? null : !!u.present;
      if (p === false && this._present !== false) this._absentAt = t;
      if (p) this._engagedAt = Math.max(this._engagedAt, t - 1);
      this._present = p;
      if (!p) this._looking = false;
    }
    if (u.looking !== undefined && this._present !== false) {
      const l = !!u.looking;
      if (l && !this._looking && t - this._lookChangedAt >= 1.5) this._ackWanted = true;
      if (l !== this._looking) this._lookChangedAt = t;
      this._looking = l;
      if (l) this._engagedAt = t;
    }
    if (u.roll !== undefined && Number.isFinite(Number(u.roll))) this._userRoll = clamp(Number(u.roll), -0.6, 0.6);
  }

  /** The user did something the avatar sees (the cursor moved). @param {number} t */
  engage(t) { this._engagedAt = t; }

  /** A speech prosody cue (the director's setProsody): accents send energy through the hologram. */
  cue(c, t) {
    if (!c || typeof c !== 'object') return;
    const s = clamp01(Number(c.strength ?? 1));
    const amp = c.type === 'emphasis' ? 0.85 * s : c.type === 'accent' ? 0.4 * s : c.type === 'phrase-start' ? 0.18 * s : 0;
    if (amp <= 0) return;
    this._pulses.push({ at: t, amp });
    if (this._pulses.length > 8) this._pulses.shift();
  }

  /** Kinds of the gestures running now ('a+b', '' when none): tools, tests. */
  active() { return this._active.filter((g) => this._time < g.fadeAt + g.fadeDur).map((g) => g.kind).join('+'); }

  /** The situation at time t (written into `out`, a fresh object by default). @returns {Ctx} */
  _ctxFor(state, t, out = /** @type {any} */ ({})) {
    const idleFor = state === 'idle' ? t - Math.max(this._engagedAt, this._stateAt) : 0;
    let bored = state === 'idle' ? smoothstep(45, 180, idleFor) : 0;
    if (state === 'idle' && this._present === false) bored = Math.max(bored, smoothstep(5, 40, t - this._absentAt));
    out.state = state; out.look = false; out.lookKind = 'cursor'; out.typing = t - this._typedAt < 1.6;
    out.present = this._present; out.looking = this._looking; out.bored = bored;
    out.L = this.liveliness; out.A = 0.55 + 0.45 * this.liveliness; out.thinkSide = 1; out.thinkUp = true;
    return out;
  }

  _fade(g, t, d) {
    if (g.fadeAt <= t) return;
    g.fadeAt = t;
    g.fadeDur = d;
  }

  /** @param {string} kind @param {number} t0 @param {Ctx} c */
  _start(kind, t0, c) {
    const K = KINDS[kind];
    const p = K.make(this.rng, c);
    const g = { kind, t0, dur: p.dur, fadeAt: Infinity, fadeDur: 0.3, p };
    this._active.push(g);
    this._last[kind] = t0;
    this.log.push({ t: +t0.toFixed(3), kind });
    if (this.log.length > 512) this.log.shift();
    if (p.blink) this._blinkAt = t0 + 0.02;
    return g;
  }

  /**
   * Advance to `t` and return the (shared) output.
   * @param {number} dt @param {number} t
   * @param {{ state: string, look?: boolean, lookKind?: string, idleMotion?: number, thinkSide?: number,
   *   thinkUp?: boolean }} d  what the director knows: its state, whether lookAt holds a target
   * @returns {BehaviorOut}
   */
  update(dt, t, d) {
    this._time = t;
    const o = this.out;
    o.yaw = o.pitch = o.roll = o.lean = o.shiftX = 0;
    o.brow = o.smile = o.press = o.round = o.jaw = o.squint = o.chin = o.nostril = o.sigh = o.pulse = 0;
    o.blink = false;
    const wasOn = o.gaze.on, wx = o.gaze.x, wy = o.gaze.y;
    o.gaze.on = false;
    if (!this._started) {
      this._started = true;
      this._engagedAt = Math.max(this._engagedAt, t);
      this._postNext = t + 1 + 4 * this.rng();
    }
    const state = d.state;
    if (state !== this._state) this.setState(state, t);
    const c = this._ctxFor(state, t, this._c);
    c.look = !!d.look;
    c.lookKind = d.lookKind || 'cursor';
    c.thinkSide = d.thinkSide ?? 1;
    c.thinkUp = d.thinkUp ?? true;
    // (no idle motion: no spontaneous behaviour either, e.g. visual diffs)
    const L = this.liveliness * Math.min(1, Math.max(0, d.idleMotion ?? 1));
    c.L = L;
    c.A = 0.55 + 0.45 * L;
    const calm = state === 'speaking' || state === 'sleep' || state === 'error' || L <= 0;

    // ---- the camera: the user looks back -> a smile and a brow flash
    if (this._ackWanted) {
      this._ackWanted = false;
      const ok = !calm && (state === 'idle' || state === 'listening') && this._present !== false
        && t - (this._last.acknowledge ?? -Infinity) >= KINDS.acknowledge.refr;
      if (ok) {
        for (const g of this._active) if (KINDS[g.kind].tracks.includes('face')) this._fade(g, t, 0.2);
        this._start('acknowledge', t, c);
      }
    }

    // ---- schedule: per free track, a random wait drawn from the total rate of the kinds that fit
    // the situation now; a change of situation (state, typing, the camera's view, boredom,
    // liveliness) draws the pending waits again. At the end of a wait one kind is picked by its
    // rate; one still in its refractory period does not happen (thinned).
    const key = `${state}|${c.typing}|${c.present}|${c.looking}|${c.look}|${Math.round(c.bored * 10)}|${L}`;
    if (key !== this._ctxKey) {
      // (the posture follows the new situation soon, e.g. leaning in as the user starts typing)
      if (this._ctxKey && this._ctxKey.split('|').slice(0, 5).join() !== key.split('|').slice(0, 5).join()) {
        this._postNext = Math.min(this._postNext, t + 0.2 + 0.5 * this.rng());
      }
      this._ctxKey = key;
      for (const k of TRACKS) if (Number.isFinite(this._next[k]) || this._next[k] === Infinity) { this._next[k] = NaN; this._freeAt[k] = t; }
    }
    if (!calm) {
      for (const track of TRACKS) {
        if (this._busy(track, t) || t < this._next[track]) continue;
        const rates = this._rates(track, c);
        const R = rates.reduce((s, [, r]) => s + r, 0) * L;
        if (Number.isNaN(this._next[track])) {
          const from = Number.isFinite(this._freeAt[track]) && this._freeAt[track] <= t ? this._freeAt[track] : t;
          // (a gamma(2) wait: random, but fewer very short or very long gaps than a pure Poisson;
          // the first one in a new state is half as long: settling into it, a person adjusts)
          const settle = t - this._stateAt < 1 ? 0.5 : 1;
          this._next[track] = R > 0 ? from + 0.25 - settle * (30 / R) * Math.log(Math.max(1e-9, this.rng() * this.rng())) : Infinity;
          continue;
        }
        const at = this._next[track];
        this._next[track] = NaN;
        this._freeAt[track] = at;
        if (!(R > 0)) continue;
        let pick = this.rng() * R / L;
        let kind = rates[rates.length - 1][0];
        for (const [k, r] of rates) { if ((pick -= r) <= 0) { kind = k; break; } }
        if (at - (this._last[kind] ?? -Infinity) < KINDS[kind].refr) continue;
        // a gesture that needs other tracks too happens only when they are free
        if (KINDS[kind].tracks.some((tr) => tr !== track && this._busy(tr, t))) continue;
        const g = this._start(kind, at, c);
        // the next one on these tracks: drawn from the moment this one ends
        for (const tr of KINDS[kind].tracks) { this._next[tr] = NaN; this._freeAt[tr] = g.t0 + g.dur; }
      }
    }

    // ---- active gestures
    let keep = 0;
    for (const g of this._active) {
      const x = t - g.t0;
      const end = Math.min(g.t0 + g.dur, g.fadeAt + g.fadeDur);
      if (t >= end) continue;
      this._active[keep++] = g;
      if (x < 0) continue;
      const k = g.fadeAt < Infinity ? 1 - minJerk((t - g.fadeAt) / g.fadeDur) : 1;
      KINDS[g.kind].apply(g.p, x, o, k, c);
    }
    this._active.length = keep;
    // (a gaze gesture ended or was cut: the next frame's target is the director's again)
    if (!o.gaze.on && wasOn) o.gaze.jump = true;
    else o.gaze.jump = o.gaze.on && (!wasOn || o.gaze.x !== wx || o.gaze.y !== wy);
    if (this._blinkAt !== undefined && t >= this._blinkAt) { o.blink = true; this._blinkAt = undefined; }

    // ---- posture: a new target every 4-45 s (log-normal), reached through slow springs; the
    // change happens at its own time inside the frame (the same motion at any frame rate)
    const P = this._post;
    let rest = dt;
    if (t >= this._postNext) {
      const pre = clamp(dt - (t - this._postNext), 0, dt);
      this._stepPosture(pre);
      rest = dt - pre;
      const r = this.rng;
      this._postSide = r() < 0.5 ? -1 : 1;
      const A = calm && state !== 'speaking' ? 0 : c.A * (state === 'speaking' ? 0.5 : 1) * (1 + 0.6 * c.bored);
      const b = L > 0 && !(state === 'sleep' || state === 'error') ? postureBias(c, this._postSide) : [0, 0, 0, 0, 0];
      const ks = Math.min(1, L);
      this._postTarget = [
        (gauss(r) * 1.5 * A + b[0] * ks) * RAD, (gauss(r) * 0.8 * A + b[1] * ks) * RAD, (gauss(r) * 1.3 * A + b[2] * ks) * RAD,
        clamp(gauss(r) * 0.35 * A + b[3] * ks, -1, 1), clamp(gauss(r) * 0.13 * A + b[4] * ks, -1, 1),
      ];
      this._postOmega = 1.5 + 1.1 * r();
      // (from the scheduled time, not the frame's)
      const from = Number.isFinite(this._postNext) && t - this._postNext < 1 ? this._postNext : t;
      this._postNext = from + logNormal(r, 13, 0.55, 4, 45) * (state === 'speaking' ? 1.6 : 1) * (1 + 0.4 * c.bored);
    }
    this._stepPosture(rest);
    o.yaw += P.yaw.x; o.pitch += P.pitch.x; o.roll += P.roll.x; o.shiftX += P.shiftX.x; o.lean += P.lean.x;
    // ---- the camera: mirror the user's head tilt a little (a few hundred ms behind)
    const mirrorOn = !calm && this._present === true && this._looking && state !== 'thinking';
    o.roll += this._mirror.step(mirrorOn ? 0.28 * Math.min(1, L) * clamp(this._userRoll, -0.25, 0.25) : 0, 2.4, dt);
    // ---- energy pulses on accents (while speaking)
    for (const q of this._pulses) o.pulse = softOr(o.pulse, q.amp * envelope(t - q.at, 0.06, 0.05, 0.65));
    if (this._pulses.length && t - this._pulses[0].at > 1) this._pulses.shift();
    o.lean = clamp(o.lean, -1, 1);
    o.shiftX = clamp(o.shiftX, -1, 1);
    return o;
  }

  /** Advance the posture springs by `h` seconds toward the current targets. @param {number} h */
  _stepPosture(h) {
    if (!(h > 0)) return;
    const P = this._post, T = this._postTarget, w = this._postOmega;
    P.yaw.step(T[0], w, h); P.pitch.step(T[1], w, h); P.roll.step(T[2], w, h);
    P.shiftX.step(T[3], w, h); P.lean.step(T[4], w, h);
  }

  /** The kinds that fit the situation on a track: [kind, rate per minute at liveliness 1][] */
  _rates(track, c) {
    const out = [];
    for (const [k, K] of Object.entries(KINDS)) {
      if (K.tracks[0] !== track) continue;
      const r = K.rate(c);
      if (r > 0) out.push([k, r]);
    }
    return out;
  }

  /** A gesture is running on the track. @param {string} track @param {number} t */
  _busy(track, t) {
    return this._active.some((g) => t < g.fadeAt + g.fadeDur && t < g.t0 + g.dur && KINDS[g.kind].tracks.includes(track));
  }
}
