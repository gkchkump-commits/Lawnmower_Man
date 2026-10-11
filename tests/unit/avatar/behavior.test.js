// The behaviour layer (src/avatar/behavior.js) through the director: a person's spontaneous
// repertoire by situation, never on a clock, with smooth kinematics, scaled by liveliness, off in
// settled renders and with no idle motion.
import { describe, expect, it } from 'vitest';
import { ACK_AWAY, Behavior, KINDS, LIVELINESS_MAX, TRACKS } from '../../../src/avatar/behavior.js';
import { mulberry32 } from '../../../src/avatar/noise.js';
import { Director } from '../../../src/avatar/director.js';
import { GAZE_DEG } from '../../../src/avatar/eyes.js';

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
  const r = { t: [], yaw: [], pitch: [], roll: [], gx: [], gy: [], lean: [], squint: [], smile: [], brow: [], press: [], jaw: [], pulse: [], eyeX: [], round: [], own: [], bb: [] };
  for (let i = 1; i <= Math.round(seconds * fps); i++) {
    const t = i * dt;
    script(t, d);
    const a = d.update(dt, t);
    r.t.push(t);
    r.yaw.push(a.headYaw * DEG); r.pitch.push(a.headPitch * DEG); r.roll.push(a.headRoll * DEG);
    r.gx.push(d.eyes.x); r.gy.push(d.eyes.y);
    r.lean.push(a.lean); r.squint.push(a.squint); r.smile.push(a.smile); r.brow.push(a.browUp);
    r.press.push(a.mouthPress); r.jaw.push(a.jawOpen); r.pulse.push(a.pulse);
    r.eyeX.push(a.gazeX); r.round.push(a.mouthRound); r.own.push(d.behavior.out.gaze.on); r.bb.push(d.behavior.out.brow);
  }
  return { r, d, log: d.behavior.log.slice() };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const kinds = (log, k) => log.filter((e) => e.kind === k);
/** Rising crossings of `on` (back below `off` in between): event onsets (s). */
function onsets(xs, on, off, fps = 60) {
  const out = [];
  let up = false;
  for (let i = 0; i < xs.length; i++) {
    if (!up && xs[i] > on) { up = true; out.push((i + 1) / fps); } else if (up && xs[i] < off) up = false;
  }
  return out;
}

/**
 * A talking user for the mic (level 0..1 as the app's meter): stretches of voice of 1.5-4 s with
 * pauses of 0.35-1.5 s between them (deterministic). Returns level(t) and the pause onsets.
 */
function talker(seed, seconds) {
  const r = mulberry32(seed);
  const segs = [];
  let t = 2;
  while (t < seconds) { const on = 1.5 + 2.5 * r(), off = 0.35 + 1.15 * r(); segs.push([t, t + on]); t += on + off; }
  const level = (x) => (segs.some(([a, b]) => x >= a && x < b) ? 0.7 + 0.12 * Math.sin(x * 17) : 0.12);
  return { level, pauses: segs.map(([, b]) => b) };
}

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
    // (minutes long, over seeds and situations: the same gestures at the same moments)
    for (const [seed, state] of [[9, 'idle'], [3, 'idle'], [21, 'idle'], [2, 'thinking'], [5, 'listening']]) {
      const go = (t, d) => { if (d.state !== state) d.setState(state); };
      const a = run({ seed }, 240, go, 60), b = run({ seed }, 240, go, 144);
      expect(b.log.map((e) => e.kind), `seed ${seed} ${state}`).toEqual(a.log.map((e) => e.kind));
      for (let i = 0; i < a.log.length; i++) expect(Math.abs(b.log[i].t - a.log[i].t)).toBeLessThan(0.05);
      if (state !== 'idle') continue;
      let worst = 0;
      for (let i = 60; i < a.r.t.length; i += 7) {
        const j = Math.round(a.r.t[i] * 144) - 1;
        worst = Math.max(worst, Math.abs(a.r.yaw[i] - b.r.yaw[j]), Math.abs(a.r.roll[i] - b.r.roll[j]));
      }
      expect(worst, `seed ${seed}`).toBeLessThan(2.5); // deg (a saccade-onset frame apart at most)
    }
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
    // a yawn: the mouth gapes slowly (not a rounded "oh"), the eyes squeeze half shut, the head
    // tips back, and the brows come up early and are down again before the peak
    const y = kinds(lonely.log, 'yawn')[0].t;
    const i0 = Math.round(y * 60);
    const seg = (xs) => xs.slice(i0, i0 + 6 * 60);
    const jaw = seg(lonely.r.jaw), peak = jaw.indexOf(Math.max(...jaw));
    expect(jaw[peak]).toBeGreaterThan(0.7);
    expect(peak / 60).toBeGreaterThan(1.8);                       // slow: ~2 s to open
    expect(seg(lonely.r.round)[peak]).toBeLessThan(0.05);
    expect(seg(lonely.r.squint)[peak]).toBeGreaterThan(0.9);
    const brow = seg(lonely.r.brow);
    expect(brow.indexOf(Math.max(...brow))).toBeLessThan(peak * 0.6);
  });

  it('yawns rarely: never twice within 4 minutes, and fewer as one bored stretch goes on', () => {
    for (const seed of [5, 6, 7]) {
      const { log } = run({ seed }, 1500);
      const ys = kinds(log, 'yawn').map((e) => e.t);
      expect(ys.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(ys.length, `seed ${seed}`).toBeLessThanOrEqual(4);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(240);
    }
  });
});

describe('behaviour: by situation', () => {
  it('listening: leans in, nods back ("mm-hm") at the pauses of the user\'s voice, no room look-arounds to speak of', () => {
    const voice = talker(6, 90);
    const { r, log } = run({ seed: 6 }, 90, (t, d) => {
      if (t >= 1 && d.state !== 'listening') d.setState('listening');
      d.setUser({ voice: voice.level(t) });
    });
    const nods = kinds(log, 'nod').map((e) => e.t);
    expect(nods.length / 1.5).toBeGreaterThan(3);
    expect(nods.length / 1.5).toBeLessThan(12);
    // a listener nods when the speaker pauses (a quarter of a second in), not in the middle of words
    const atPause = nods.filter((t) => voice.pauses.some((p) => t - p >= 0.2 && t - p <= 0.5));
    expect(atPause.length / nods.length).toBeGreaterThan(0.7);
    // ... and a nod comes with a brow "mm-hm" only now and then
    expect(onsets(r.bb, 0.08, 0.03).length).toBeLessThan(nods.length * 0.6 + 2);
    expect(mean(r.lean.slice(20 * 60))).toBeGreaterThan(0.25);
    expect(kinds(log, 'lookAround').length).toBeLessThan(4);
    // nobody talking: only the odd nod
    const quiet = run({ seed: 6 }, 90, (t, d) => { if (t >= 1 && d.state !== 'listening') d.setState('listening'); });
    expect(kinds(quiet.log, 'nod').length / 1.5).toBeLessThan(4);
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

  it('thinking: one look at a time: while a search holds a spot, the director\'s own small shifts pause', () => {
    const tx = [], on = [];
    const { log } = run({ seed: 7 }, 180, (t, d) => {
      if (t >= 1 && d.state !== 'thinking') d.setState('thinking');
      tx.push(d._tg?.x ?? 0); on.push(!!d._B?.gaze.on);
    });
    const searches = kinds(log, 'search');
    expect(searches.length / 3).toBeLessThan(4.5);        // per minute (it was 8)
    expect(searches.length).toBeGreaterThan(2);
    // the target the eyes are sent to holds still within a search fixation (it used to dart
    // between the search's spot and the director's micro-shifts on top of it)
    let moved = 0, held = 0;
    for (let i = 2; i < tx.length; i++) {
      if (on[i] && on[i - 1] && on[i - 2]) { held++; if (Math.abs(tx[i] - tx[i - 1]) > 0.5) moved++; }
    }
    expect(held).toBeGreaterThan(60);
    expect(moved / (held / 60)).toBeLessThan(0.4);      // jumps per second of a held search (the lane before: 1.1-1.4)
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
    // with eye contact the eyes stay on the user: no look-arounds
    expect(kinds(flat.log, 'lookAround').length).toBe(0);
  });

  it('camera: a look back after a while is now and then acknowledged (smile, brow flash) once the eyes are on the user', () => {
    // the user looks away for `away` s at 6 s (and the avatar looks into the room meanwhile)
    const trial = (seed, away) => run({ seed }, 6 + away + 6, (t, d) => {
      if (Math.abs(t - 1 / 60) < 1e-9) { d.lookAt(0, 0.1, 'face'); d.setUser({ present: true, looking: true }); }
      if (Math.abs(t - 6) < 1e-9) { d.lookAt(null); d.setUser({ looking: false }); }
      if (Math.abs(t - (6 + away)) < 1e-9) { d.lookAt(0, 0.1, 'face'); d.setUser({ looking: true }); }
    });
    let fired = 0;
    for (let seed = 1; seed <= 24; seed++) {
      // a glance away of a second or two: never
      expect(kinds(trial(seed, 2).log, 'acknowledge').length).toBe(0);
      const { r, log } = trial(seed, 25);
      const acks = kinds(log, 'acknowledge');
      expect(acks.length).toBeLessThanOrEqual(1);
      if (!acks.length) continue;
      fired++;
      // after the return saccade: 0.2 s or more after the look back, with the eyes on the user
      const t0 = acks[0].t, back = 6 + 25;
      expect(t0 - back).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(t0 - back).toBeLessThan(0.45);
      const i0 = Math.round(t0 * 60);
      for (let i = i0 - 1; i < i0 + 60; i++) expect(r.own[i]).toBe(false);
      expect(Math.max(...r.smile.slice(i0, i0 + 90))).toBeGreaterThan(0.2);
      expect(Math.max(...r.brow.slice(i0, i0 + 60))).toBeGreaterThan(0.3);
    }
    // not every time (it would be cloying): about ACK_AWAY.p x smoothstep(3, 20, 25) = 0.6
    expect(fired).toBeGreaterThanOrEqual(8);
    expect(fired).toBeLessThanOrEqual(21);
    expect(ACK_AWAY.p).toBeLessThan(1);
    // and at most once a minute
    const many = run({ seed: 3 }, 200, (t, d) => {
      if (Math.abs(t - 1 / 60) < 1e-9) { d.lookAt(0, 0.1, 'face'); d.setUser({ present: true, looking: true }); }
      const k = Math.round(t * 60) % (30 * 60);
      if (k === 1) d.setUser({ looking: false });
      if (k === 25 * 60) d.setUser({ looking: true });
    });
    const at = kinds(many.log, 'acknowledge').map((e) => e.t);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(60);
  });

  it('the user gone (camera): bored within a minute', () => {
    const away = run({ seed: 14 }, 300, (t, d) => { if (Math.abs(t - 1 / 60) < 1e-9) d.setUser({ present: false }); });
    const there = run({ seed: 14 }, 300, (t, d) => { if (Math.abs(t - 1 / 60) < 1e-9) d.setUser({ present: true, looking: true }); });
    const longLooks = (log) => kinds(log, 'lookAround').length;
    expect(longLooks(away.log)).toBeGreaterThan(longLooks(there.log));
    expect(kinds(away.log, 'yawn').length).toBeGreaterThanOrEqual(1);
  });
});

describe('behaviour: the user comes first', () => {
  /** Run idle until one of the avatar's own looks has been on for 0.3 s (after `from` s). */
  function midLook(seed, from, setup) {
    const d = new Director({ seed });
    d.setState('idle');
    setup?.(d);
    let t = 0;
    while (t < 900) {
      t += 1 / 60;
      d.update(1 / 60, t);
      const g = d.behavior.log.at(-1);
      if (t > from && g?.kind === 'lookAround' && t - g.t > 0.3 && d.behavior.out.gaze.on) return { d, t };
    }
    throw new Error('no look-around');
  }
  /** Seconds until the eyes are on the target (world gaze within 2 deg, the avatar's own look gone). */
  function reach(d, t0, step) {
    let t = t0;
    for (let i = 0; i < 600; i++) {
      t += 1 / 60;
      if (i % 2 === 0) step(d);
      const a = d.update(1 / 60, t);
      const wx = a.gazeX * GAZE_DEG.x + a.headYaw * DEG;
      if (!d.behavior.out.gaze.on && Math.abs(wx - d._tg.x) < 2) return t - t0;
    }
    return Infinity;
  }

  it('the cursor cuts a look into the room short: the eyes are on it within a third of a second', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const { d, t } = midLook(seed, 5);
      expect(reach(d, t, (x) => x.lookAt(0.5, 0, 'cursor')), `seed ${seed}`).toBeLessThan(0.35);
    }
  });

  it('the user coming back (camera) cuts a bored look-away short; the acknowledgment waits for the eyes', () => {
    let acks = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const { d, t } = midLook(seed, 60, (x) => x.setUser({ present: false }));
      let ackSeen = false;
      const dt = reach(d, t, (x) => {
        x.setUser({ present: true, looking: true, roll: 0 });
        x.lookAt(0, 0, 'face');
        // (whenever the acknowledgment is on, the avatar's own look is gone)
        if (x.behavior.active().includes('acknowledge')) { ackSeen = true; expect(x.behavior.out.gaze.on).toBe(false); }
      });
      expect(dt, `seed ${seed}`).toBeLessThan(0.35);
      for (let i = 0; i < 120; i++) {
        d.update(1 / 60, t + dt + (i + 1) / 60);
        if (d.behavior.active().includes('acknowledge')) { ackSeen = true; expect(d.behavior.out.gaze.on).toBe(false); }
      }
      if (ackSeen) acks++;
    }
    expect(acks).toBeGreaterThan(3);   // (p 0.6 after a long absence)
    expect(acks).toBeLessThan(16);
  });

  it('no look of its own while the user moves the cursor, nor for a moment after', () => {
    const { log } = run({ seed: 2 }, 60, (t, d) => {
      if (t > 10 && t < 30 && Math.round(t * 60) % 2 === 0) d.lookAt(0.4 * Math.sin(t * 0.7), 0.2 * Math.cos(t * 0.5), 'cursor');
      if (Math.abs(t - 30) < 1e-9) d.lookAt(null);
    });
    expect(log.filter((e) => e.kind === 'lookAround' && e.t > 10 && e.t < 31.2).length).toBe(0);
  });
});

describe('behaviour: calm and active stretches', () => {
  it('gestures come in clusters with quiet stretches between: over-dispersed, and a half minute of calm in most 2-minute windows', () => {
    for (const seed of [1, 2, 3]) {
      const { log } = run({ seed }, 600, (t, d) => { if (Math.round(t * 60) % 2400 === 0) d.behavior.engage(t); });
      const ts = log.map((e) => e.t).filter((t) => t > 20);
      // Fano factor of the onsets in 30 s windows (1 = Poisson; a clock or a regular process < 1)
      const cnt = [];
      for (let w = 20; w + 30 <= 600; w += 30) cnt.push(ts.filter((t) => t >= w && t < w + 30).length);
      const m = mean(cnt), v = mean(cnt.map((c) => (c - m) ** 2));
      expect(v / m, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      let ok = 0, n = 0;
      for (let w = 20; w + 120 <= 600; w += 60) {
        const p = [w, ...ts.filter((t) => t >= w && t < w + 120), w + 120];
        n++;
        if (Math.max(...p.slice(1).map((x, i) => x - p[i])) >= 30) ok++;
      }
      expect(ok / n, `seed ${seed}`).toBeGreaterThan(0.5);
      // still a lively avatar overall
      expect(ts.length / (580 / 60), `seed ${seed}`).toBeGreaterThan(3.5);
      // and the activity state really alternates
    }
    const b = new Behavior({ seed: 4 });
    const seen = new Set();
    for (let i = 1; i <= 600 * 10; i++) { b.update(0.1, i * 0.1, { state: 'idle' }); seen.add(b.activity); }
    expect([...seen].sort()).toEqual(['active', 'calm']);
  });

  it('no social signals at nobody: brow flashes and smiles are rare without someone to see them', () => {
    let n = 0;
    for (const seed of [1, 2, 3]) {
      const { log } = run({ seed }, 600, (t, d) => { if (Math.round(t * 60) % 2400 === 0) d.behavior.engage(t); });
      n += kinds(log, 'browFlash').length + kinds(log, 'smile').length;
    }
    // (the lane before: 1.2-2.6 per minute; now ~0.5 plus the greetings)
    expect(n / 30).toBeLessThan(0.9);
  });

  it('greets the user back after a quiet minute: a brow flash and / or a smile a moment after the first sign of life', () => {
    let greeted = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const { log } = run({ seed }, 100, (t, d) => {
        if (Math.abs(t - 5) < 1e-9 || Math.abs(t - 30) < 1e-9 || Math.abs(t - 95) < 1e-9) d.lookAt(0.3, 0.1, 'cursor');
      });
      const near = (t0) => log.filter((e) => (e.kind === 'browFlash' || e.kind === 'smile') && e.t - t0 > 0.15 && e.t - t0 < 0.6);
      if (near(95).length) greeted++;
      // (the cursor 25 s after the last time: no greeting; 5 s is the first time: may be)
      expect(near(30).length).toBe(0);
    }
    expect(greeted).toBeGreaterThanOrEqual(6);    // p 0.65
    expect(greeted).toBeLessThan(16);
  });

  it('keeps the eyes inside their range: the head takes its share of a large look', () => {
    for (const seed of [1, 4]) {
      const { r } = run({ seed }, 600);
      const pinned = r.eyeX.filter((x) => Math.abs(x) >= 0.999).length / r.eyeX.length;
      expect(pinned, `seed ${seed}`).toBeLessThan(0.002);  // (the lane before: 0.3-1.2 %)
    }
  });

  it('a held tilt is never dead flat: it settles back a little and wanders', () => {
    const r = mulberry32(5);
    const c = new Behavior()._ctxFor('idle', 1);
    for (const kind of ['tilt', 'hmm']) {
      const g = KINDS[kind].make(r, { ...c, thinkSide: 1 });
      const rolls = [];
      for (let x = g.a; x < g.a + g.h; x += 1 / 60) {
        const o = { yaw: 0, pitch: 0, roll: 0, brow: 0, smile: 0, press: 0, chin: 0, squint: 0 };
        KINDS[kind].apply(g, x, o, 1, c);
        rolls.push(o.roll * DEG);
      }
      expect(std(rolls), kind).toBeGreaterThan(0.08);
      expect(Math.abs(rolls.at(-1)), kind).toBeLessThan(Math.abs(rolls[0]));
    }
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
