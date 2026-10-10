// The behaviour layer (src/avatar/behavior.js) through the director: a person's spontaneous
// repertoire by situation, never on a clock, with smooth kinematics, scaled by liveliness, off in
// settled renders and with no idle motion.
import { describe, expect, it } from 'vitest';
import { Behavior, LIVELINESS_MAX, TRACKS } from '../../../src/avatar/behavior.js';
import { Director } from '../../../src/avatar/director.js';

const DEG = 180 / Math.PI;

/**
 * Run a director through a script; records head angles (deg), world gaze (deg), some channels and
 * the behaviour's gesture log.
 * @param {object} o Director options @param {number} seconds @param {(t: number, d: Director) => void} [script]
 * @param {number} [fps]
 */
function run(o, seconds, script = () => {}, fps = 60) {
  const d = new Director({ seed: 1, ...o });
  const dt = 1 / fps;
  const r = { t: [], yaw: [], pitch: [], roll: [], gx: [], gy: [], lean: [], squint: [], smile: [], brow: [], press: [], jaw: [], pulse: [] };
  for (let i = 1; i <= Math.round(seconds * fps); i++) {
    const t = i * dt;
    script(t, d);
    const a = d.update(dt, t);
    r.t.push(t);
    r.yaw.push(a.headYaw * DEG); r.pitch.push(a.headPitch * DEG); r.roll.push(a.headRoll * DEG);
    r.gx.push(d.eyes.x); r.gy.push(d.eyes.y);
    r.lean.push(a.lean); r.squint.push(a.squint); r.smile.push(a.smile); r.brow.push(a.browUp);
    r.press.push(a.mouthPress); r.jaw.push(a.jawOpen); r.pulse.push(a.pulse);
  }
  return { r, d, log: d.behavior.log.slice() };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const kinds = (log, k) => log.filter((e) => e.kind === k);

/** Autocorrelation at lag k (samples). */
function acf(xs, k) {
  const m = mean(xs);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - m) ** 2;
    if (i + k < xs.length) num += (xs[i] - m) * (xs[i + k] - m);
  }
  return num / den;
}

/** Largest one-frame velocity change over the peak speed. */
function stepRatio(xs, fps) {
  let step = 0, vpk = 0, pv = NaN;
  for (let i = 1; i < xs.length; i++) {
    const v = (xs[i] - xs[i - 1]) * fps;
    vpk = Math.max(vpk, Math.abs(v));
    if (Number.isFinite(pv)) step = Math.max(step, Math.abs(v - pv));
    pv = v;
  }
  return vpk > 0 ? step / vpk : 0;
}

describe('behaviour: idle', () => {
  // (the user is around: moving the cursor now and then, which the avatar sees, so it is not bored)
  const idle = run({ seed: 4 }, 240, (t, d) => { if (Math.round(t * 60) % 1200 === 0) d.behavior.engage(t); });

  it('looks around the room every so often: head and eyes to points 8-24 deg away, then back', () => {
    const looks = kinds(idle.log, 'lookAround');
    expect(looks.length / 4).toBeGreaterThan(2);     // per minute
    expect(looks.length / 4).toBeLessThan(8);
    // the world gaze goes well off the user (the old idle never went past ~5 deg)
    const far = idle.r.gx.filter((x, i) => Math.hypot(x, idle.r.gy[i]) > 8).length / idle.r.gx.length;
    expect(far).toBeGreaterThan(0.04);
    expect(far).toBeLessThan(0.45);                  // and mostly it is with the user
    expect(Math.max(...idle.r.gx.map(Math.abs))).toBeLessThan(30);
    // the head goes along (a share), but stays inside what the relief head can show
    expect(Math.max(...idle.r.yaw.map(Math.abs))).toBeGreaterThan(3);
    expect(Math.max(...idle.r.yaw.map(Math.abs))).toBeLessThan(14);
  });

  it('has a varied repertoire: tilts, posture, brows, smiles or lips, breaths', () => {
    const seen = new Set(idle.log.map((e) => e.kind));
    for (const k of ['lookAround', 'tilt', 'deepBreath']) expect(seen.has(k), k).toBe(true);
    expect(['browFlash', 'smile', 'press', 'swallow', 'purse'].filter((k) => seen.has(k)).length).toBeGreaterThanOrEqual(2);
    // the posture drifts: the head's roll and lean wander between positions
    expect(std(idle.r.roll)).toBeGreaterThan(0.6);
    expect(std(idle.r.lean)).toBeGreaterThan(0.02);
  });

  it('never runs on a clock: random intervals, no autocorrelation peak over minutes', () => {
    const t = kinds(idle.log, 'lookAround').map((e) => e.t);
    const iv = t.slice(1).map((x, i) => x - t[i]);
    expect(std(iv) / mean(iv)).toBeGreaterThan(0.4);   // a clock: ~0
    const sub = (xs) => xs.filter((_, i) => i % 6 === 0); // 10 Hz
    for (const k of ['yaw', 'pitch', 'roll', 'gx']) {
      const xs = sub(idle.r[k]);
      // once the motion's own correlation has decayed, nothing comes back (a loop would)
      let lag = 20;
      while (lag < 600 && acf(xs, lag) > 0.2) lag += 5;
      let peak = -1;
      for (; lag <= 600; lag += 5) peak = Math.max(peak, acf(xs, lag));
      expect(peak, k).toBeLessThan(0.45);
    }
  });

  it('respects each gesture\'s refractory period and never overlaps two gestures on a track', () => {
    const last = {};
    for (const e of idle.log) {
      if (last[e.kind] !== undefined) expect(e.t - last[e.kind], e.kind).toBeGreaterThanOrEqual(1.4 - 1e-6);
      last[e.kind] = e.t;
    }
    const looks = kinds(idle.log, 'lookAround').map((e) => e.t);
    for (let i = 1; i < looks.length; i++) expect(looks[i] - looks[i - 1]).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it('moves smoothly: no velocity steps in the head, and 60 and 144 Hz show the same behaviour', () => {
    for (const k of ['yaw', 'pitch', 'roll']) expect(stepRatio(idle.r[k].slice(60), 60), k).toBeLessThan(0.45);
    const a = run({ seed: 9 }, 40, () => {}, 60), b = run({ seed: 9 }, 40, () => {}, 144);
    expect(b.log.map((e) => e.kind)).toEqual(a.log.map((e) => e.kind));
    for (let i = 0; i < a.log.length; i++) expect(Math.abs(b.log[i].t - a.log[i].t)).toBeLessThan(1 / 60);
    let worst = 0;
    for (let i = 60; i < a.r.t.length; i += 7) {
      const j = Math.round(a.r.t[i] * 144) - 1;
      worst = Math.max(worst, Math.abs(a.r.yaw[i] - b.r.yaw[j]), Math.abs(a.r.roll[i] - b.r.roll[j]));
    }
    expect(worst).toBeLessThan(0.6); // deg (a saccade-onset frame apart at most)
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const a = run({ seed: 2 }, 30), b = run({ seed: 2 }, 30), c = run({ seed: 3 }, 30);
    expect(b.r.yaw).toEqual(a.r.yaw);
    expect(b.log).toEqual(a.log);
    expect(c.log).not.toEqual(a.log);
  });

  it('gets bored when nobody engages for minutes: longer looks away, yawns; engaged, never', () => {
    const lonely = run({ seed: 5 }, 420);
    const busy = run({ seed: 5 }, 420, (t, d) => { if (Math.abs((t * 60) % 600) < 1e-6) d.setUser({ typing: true }); });
    expect(kinds(lonely.log, 'yawn').length).toBeGreaterThanOrEqual(1);
    expect(kinds(lonely.log, 'yawn').every((e) => e.t > 60)).toBe(true);
    expect(kinds(busy.log, 'yawn').length).toBe(0);
    // a yawn opens the mouth slowly with the eyes narrowing
    const y = kinds(lonely.log, 'yawn')[0].t;
    const i0 = Math.round(y * 60);
    const seg = (xs) => xs.slice(i0, i0 + 5 * 60);
    expect(Math.max(...seg(lonely.r.jaw))).toBeGreaterThan(0.3);
    expect(Math.max(...seg(lonely.r.squint))).toBeGreaterThan(0.4);
  });
});

describe('behaviour: by situation', () => {
  it('listening: leans in, nods back ("mm-hm"), no room look-arounds to speak of', () => {
    const { r, log } = run({ seed: 6 }, 90, (t, d) => { if (t >= 1 && d.state !== 'listening') d.setState('listening'); });
    expect(kinds(log, 'nod').length / 1.5).toBeGreaterThan(2.5);
    expect(mean(r.lean.slice(20 * 60))).toBeGreaterThan(0.25);
    expect(kinds(log, 'lookAround').length).toBeLessThan(4);
  });

  it('thinking: looks around the averted region, pressed / pursed lips, a squint, a "hmm" tilt', () => {
    const { r, log } = run({ seed: 7 }, 180, (t, d) => { if (t >= 1 && d.state !== 'thinking') d.setState('thinking'); });
    const seen = new Set(log.map((e) => e.kind));
    for (const k of ['search', 'hmm']) expect(seen.has(k), k).toBe(true);
    expect(['press', 'purse', 'squint'].filter((k) => seen.has(k)).length).toBeGreaterThanOrEqual(2);
    expect(seen.has('lookAround')).toBe(false);
    expect(Math.max(...r.press)).toBeGreaterThan(0.3);
    expect(Math.max(...r.squint)).toBeGreaterThan(0.2);
  });

  it('typing: glances down at the chat now and then and leans in', () => {
    const { r, log } = run({ seed: 8 }, 30, (t, d) => {
      // keystrokes 5-25 s
      if (t > 5 && t < 25 && Math.round(t * 60) % 9 === 0) d.setUser({ typing: true });
    });
    const glances = kinds(log, 'chatGlance');
    expect(glances.length).toBeGreaterThanOrEqual(2);
    expect(glances.every((e) => e.t > 5 && e.t < 27)).toBe(true);
    const down = r.gy.slice(5 * 60, 26 * 60);
    expect(Math.min(...down)).toBeLessThan(-8);   // world gaze down at the chat
    expect(mean(r.lean.slice(12 * 60, 25 * 60))).toBeGreaterThan(0.1);
  });

  it('speaking: no gestures start, and running ones are gone within half a second', () => {
    const { r, log } = run({ seed: 10 }, 100, (t, d) => {
      if (t >= 20 && t < 40 && d.state !== 'speaking') d.setState('speaking');
      if (t >= 40 && d.state === 'speaking') d.setState('idle');
    });
    expect(log.filter((e) => e.t > 20.05 && e.t < 40).length).toBe(0);
    for (const k of ['smile', 'press', 'squint']) {
      const xs = r[k].slice(Math.round(20.5 * 60), 40 * 60);
      expect(Math.max(...xs), k).toBeLessThan(0.02);
    }
    // and after speech the repertoire comes back
    expect(log.filter((e) => e.t > 40).length).toBeGreaterThan(0);
  });

  it('speaking: accents and emphasis send energy pulses through the hologram', () => {
    const { r } = run({ seed: 11 }, 6, (t, d) => {
      if (t > 1 && d.state !== 'speaking') d.setState('speaking');
      if (Math.abs(t - 3) < 1e-6) d.setProsody({ type: 'emphasis', strength: 1 });
    });
    expect(Math.max(...r.pulse.slice(0, 170))).toBe(0);
    expect(Math.max(...r.pulse.slice(180, 230))).toBeGreaterThan(0.6);
    expect(r.pulse.at(-1)).toBeLessThan(0.01);
  });

  it('camera: engaged while looked at, mirrors the user\'s tilt a little, smiles when looked back at', () => {
    const script = (roll) => (t, d) => {
      if (Math.abs(t - 1 / 60) < 1e-9) { d.lookAt(0, 0.1, 'face'); d.setUser({ present: true, looking: true, roll: 0 }); }
      if (Math.abs(t - 10) < 1e-9) d.setUser({ roll });
    };
    const flat = run({ seed: 12 }, 20, script(0)), tilted = run({ seed: 12 }, 20, script(0.16));
    const late = (r) => mean(r.roll.slice(14 * 60, 20 * 60));
    // 0.28 x 0.16 rad = 2.6 deg toward the same side on screen
    expect(late(tilted.r) - late(flat.r)).toBeGreaterThan(1.8);
    expect(late(tilted.r) - late(flat.r)).toBeLessThan(3.4);
    // looking away and back: a smile and a brow flash within a second
    const ack = run({ seed: 13 }, 12, (t, d) => {
      if (Math.abs(t - 1 / 60) < 1e-9) { d.lookAt(0, 0.1, 'face'); d.setUser({ present: true, looking: true }); }
      if (Math.abs(t - 4) < 1e-9) d.setUser({ looking: false });
      if (Math.abs(t - 7) < 1e-9) d.setUser({ looking: true });
    });
    expect(kinds(ack.log, 'acknowledge').map((e) => Math.round(e.t))).toEqual([7]);
    const w = (xs) => Math.max(...xs.slice(7 * 60, 8 * 60));
    expect(w(ack.r.smile)).toBeGreaterThan(0.2);
    expect(w(ack.r.brow)).toBeGreaterThan(0.3);
    // with eye contact the eyes stay on the user: no look-arounds
    expect(kinds(flat.log, 'lookAround').length).toBe(0);
  });

  it('the user gone (camera): bored within a minute', () => {
    const away = run({ seed: 14 }, 300, (t, d) => { if (Math.abs(t - 1 / 60) < 1e-9) d.setUser({ present: false }); });
    const there = run({ seed: 14 }, 300, (t, d) => { if (Math.abs(t - 1 / 60) < 1e-9) d.setUser({ present: true, looking: true }); });
    const longLooks = (log) => kinds(log, 'lookAround').length;
    expect(longLooks(away.log)).toBeGreaterThan(longLooks(there.log));
    expect(kinds(away.log, 'yawn').length).toBeGreaterThanOrEqual(1);
  });
});

describe('behaviour: liveliness', () => {
  it('scales the rates: 0 = none, 2 = about twice the default', () => {
    const n = (L) => run({ seed: 15, liveliness: L }, 180).log.length;
    expect(n(0)).toBe(0);
    const one = n(1), two = n(2);
    expect(two / one).toBeGreaterThan(1.4);
    expect(two / one).toBeLessThan(2.8);
  });

  it('is off without idle motion and in settled renders', () => {
    const still = run({ seed: 16, idleMotion: 0 }, 60);
    expect(still.log.length).toBe(0);
    expect(Math.max(...still.r.lean.map(Math.abs))).toBe(0);
    const d = new Director({ seed: 16 });
    d.setState('listening');
    const a = d.update(0, 12, { settle: true });
    for (const k of ['lean', 'shiftX', 'squint', 'pulse']) expect(a[k], k).toBe(0);
  });

  it('is clamped to 0..2 and can change at run time', () => {
    expect(new Behavior({ liveliness: 9 }).liveliness).toBe(LIVELINESS_MAX);
    expect(new Behavior({ liveliness: -1 }).liveliness).toBe(0);
    expect(new Behavior({ liveliness: 'x' }).liveliness).toBe(1);
    expect(TRACKS).toEqual(['gaze', 'head', 'face', 'breath']);
    const { log } = run({ seed: 17 }, 120, (t, d) => { if (Math.abs(t - 60) < 1e-9) d.setLiveliness(0); });
    expect(log.length).toBeGreaterThan(0);
    expect(log.filter((e) => e.t > 60).length).toBe(0);
  });
});
