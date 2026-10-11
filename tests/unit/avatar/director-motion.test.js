// Director motion quality: every channel moves without velocity steps (no one-frame "ticks" at
// cues, visemes or state changes), 60 and 144 Hz displays show the same motion, the eyes keep
// eye contact while the head moves (VOR), thinking holds its look-away, blinks are varied, and
// settled renders keep the original rest pose exactly.
import { describe, expect, it } from 'vitest';
import { Director, worldGaze } from '../../../src/avatar/director.js';
import { GAZE_DEG } from '../../../src/avatar/eyes.js';

const DEG = 180 / Math.PI;

/**
 * Drive a director at `fps` through `script(t, d)` for `seconds`; records `keys` each frame.
 * `after`: the script runs after each frame's update (inputs then take effect at exactly `t`,
 * at any frame rate).
 */
function record(o, seconds, fps, script, keys, after = false) {
  const d = new Director({ seed: 3, ...o });
  const dt = 1 / fps;
  const rec = Object.fromEntries(keys.map((k) => [k, []]));
  rec.t = [];
  for (let i = 1; i <= Math.round(seconds * fps); i++) {
    const t = i * dt;
    if (!after) script(t, d, dt);
    const a = d.update(dt, t);
    rec.t.push(t);
    for (const k of keys) rec[k].push(a[k]);
    if (after) script(t, d, dt);
  }
  return rec;
}

/** Largest one-frame velocity change over the peak velocity. */
function stepRatio(xs, dt) {
  const v = [];
  for (let i = 1; i < xs.length; i++) v.push((xs[i] - xs[i - 1]) / dt);
  let step = 0;
  for (let i = 1; i < v.length; i++) step = Math.max(step, Math.abs(v[i] - v[i - 1]));
  const vpk = Math.max(...v.map(Math.abs));
  return vpk > 0 ? step / vpk : 0;
}

/** rms of the third finite difference (jerk). */
function rmsJerk(xs, dt) {
  let s = 0, n = 0;
  for (let i = 3; i < xs.length; i++) {
    const j = (xs[i] - 3 * xs[i - 1] + 3 * xs[i - 2] - xs[i - 3]) / (dt * dt * dt);
    s += j * j; n++;
  }
  return Math.sqrt(s / n);
}

/** A scripted stretch of speech: accents, an emphasis, phrase starts / ends, a breath. */
// (times on multiples of 1/12 s: frames at both 60 and 144 Hz)
const CUES = [
  [12 / 12, { type: 'phrase-start', strength: 1 }], [15 / 12, { type: 'accent', strength: 0.9 }], [18 / 12, { type: 'accent', strength: 0.9 }],
  [23 / 12, [{ type: 'accent', strength: 0.9 }, { type: 'emphasis', strength: 1 }]], [28 / 12, { type: 'phrase-end', punct: '.', fall: 5, pause: 0.4 }],
  [29 / 12, { type: 'inhale', strength: 1, lead: 0.15 }], [31 / 12, { type: 'phrase-start', strength: 1 }], [34 / 12, { type: 'accent', strength: 0.9 }],
  [37 / 12, { type: 'accent', strength: 0.9 }], [42 / 12, { type: 'phrase-end', punct: '?', rise: 4, pause: 0.5 }],
];
/** A fresh script: speaking from 0.5 s, each cue sent on the first frame at or after its time. */
function speechScript() {
  let i = 0;
  return (t, d) => {
    if (t > 0.5 && d.state !== 'speaking') d.setState('speaking');
    while (i < CUES.length && t >= CUES[i][0] - 1e-9) d.setProsody(CUES[i++][1]);
  };
}

describe('director motion: smooth channels', () => {
  it('speech nods, lifts, lowering, tilts and breaths start and end without velocity steps', () => {
    const keys = ['headPitch', 'headYaw', 'headRoll', 'browUp', 'smile', 'nostrilFlare', 'breath'];
    const rec = record({ idleMotion: 0 }, 5, 60, speechScript(), keys);
    for (const k of ['headPitch', 'headYaw', 'headRoll']) {
      const xs = rec[k].slice(50);
      expect(stepRatio(xs, 1 / 60), k).toBeLessThan(0.45);
    }
    for (const k of ['browUp', 'smile', 'nostrilFlare']) expect(stepRatio(rec[k].slice(50), 1 / 60), k).toBeLessThan(0.75);
  });

  it('an accent and an emphasis together make one nod of the larger size, not two added', () => {
    const run = (cues) => {
      let sent = false;
      return record({ idleMotion: 0 }, 2, 60, (t, d) => {
        if (t > 0.5 && d.state !== 'speaking') d.setState('speaking');
        if (!sent && t >= 1.2) { d.setProsody(cues); sent = true; }
      }, ['headPitch']);
    };
    const dip = (r) => r.headPitch[70] - Math.min(...r.headPitch.slice(70));
    const accent = dip(run({ type: 'accent', strength: 1 })), emph = dip(run({ type: 'emphasis', strength: 1 }));
    const both = dip(run([{ type: 'accent', strength: 1 }, { type: 'emphasis', strength: 1 }]));
    expect(both).toBeGreaterThan(0.9 * Math.min(accent, emph));
    expect(both).toBeLessThan(0.75 * (accent + emph)); // added up, it would be ~1x the sum
  });

  it('an emphasis a few frames into an accent\'s nod grows it without a velocity step', () => {
    // (the system voice sends 'emphasis' at the word start and 'accent' at its stressed vowel)
    const run = (accent, later) => record({ idleMotion: 0 }, 2, 60, (t, d) => {
      if (t > 0.5 && d.state !== 'speaking') d.setState('speaking');
      if (accent && Math.abs(t - 1.2) < 1e-6) d.setProsody({ type: 'accent', strength: 0.3 });
      if (later && Math.abs(t - (1.2 + 3 / 60)) < 1e-6) d.setProsody({ type: 'emphasis', strength: 1 });
    }, ['headPitch']);
    /** the largest one-frame change of the head's pitch velocity (deg/s) */
    const steps = (r) => {
      let m = 0;
      for (let i = 2; i < r.headPitch.length; i++) m = Math.max(m, Math.abs(r.headPitch[i] - 2 * r.headPitch[i - 1] + r.headPitch[i - 2]));
      return m * 60 * DEG;
    };
    const one = run(true, false), alone = run(false, true), grown = run(true, true);
    const dip = (r) => r.headPitch[70] - Math.min(...r.headPitch.slice(70));
    // (v0.4: an accent's nod varies in size, log-normal, so it may be the larger one: the running
    // nod ends up as large as the larger of the two either way)
    expect(dip(grown)).toBeGreaterThan(0.95 * Math.max(dip(one), dip(alone)));
    // as smooth as the emphasis' own nod (raising the running nod's amplitude stepped its speed
    // by ~5x that)
    expect(steps(grown)).toBeLessThan(1.3 * steps(alone));
  });

  it('60 and 144 Hz show the same motion (no frame-rate dependent ticks)', () => {
    const keys = ['headPitch', 'headYaw', 'jawOpen', 'mouthPress', 'energy'];
    const mouth = (t, d) => {
      // a syllable train: open vowels and closures, as the lip-sync sends them
      const ph = (t * 4.5) % 1;
      d.setMouth(ph < 0.15 ? { press: 1, jaw: 0.04 } : { jaw: 0.55 * Math.sin(Math.PI * (ph - 0.15) / 0.85), wide: 0.3 });
    };
    const script = () => { const sp = speechScript(); return (t, d) => { sp(t, d); mouth(t, d); }; };
    const a = record({ idleMotion: 1 }, 5, 60, script(), keys, true);
    const b = record({ idleMotion: 1 }, 5, 144, script(), keys, true);
    // same trajectories (compare the 60 Hz samples with the 144 Hz ones at the same times)
    for (const k of ['headPitch', 'headYaw']) {
      let maxDiff = 0;
      for (let i = 30; i < a.t.length; i++) {
        const j = Math.round(a.t[i] * 144) - 1;
        if (j < b.t.length && Math.abs(b.t[j] - a.t[i]) < 1e-3) maxDiff = Math.max(maxDiff, Math.abs(a[k][i] - b[k][j]));
      }
      expect(maxDiff * DEG, k).toBeLessThan(0.15);
    }
    // smooth motion converges: jerk at 144 Hz about that at 60 Hz (velocity steps would be ~3.7x)
    for (const k of ['headPitch', 'headYaw']) {
      const r = rmsJerk(b[k].slice(80), 1 / 144) / rmsJerk(a[k].slice(30), 1 / 60);
      expect(r, k).toBeLessThan(1.6);
    }
  });

  it('a state change starts the posture from rest (state weights are springs)', () => {
    const rec = record({ idleMotion: 0 }, 2, 60, (t, d) => { if (Math.abs(t - 0.5) < 1e-6) d.setState('thinking'); }, ['headPitch', 'headRoll', 'think']);
    for (const k of ['headPitch', 'headRoll', 'think']) expect(stepRatio(rec[k].slice(20), 1 / 60), k).toBeLessThan(0.5);
  });
});

describe('director motion: gaze', () => {
  it('eye contact holds while the head sways: the world gaze stays on the target (VOR)', () => {
    const d = new Director({ seed: 5, idleMotion: 1 });
    d.lookAt(0, 0);
    let t = 0;
    const yaws = [];
    let maxOff = 0;
    for (let i = 0; i < 20 * 60; i++) {
      t += 1 / 60;
      const a = d.update(1 / 60, t);
      if (t > 1) {
        yaws.push(a.headYaw * DEG);
        const g = worldGaze(a);
        maxOff = Math.max(maxOff, Math.abs(g.x), Math.abs(g.y));
      }
    }
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(1); // the head does sway
    expect(maxOff).toBeLessThan(0.03); // (0.03 gaze units ~ 0.5 deg)
  });

  it('idle saccades are quick jumps between still fixations, not glides', () => {
    const rec = record({ idleMotion: 1 }, 30, 60, () => {}, ['gazeX', 'headYaw']);
    // world gaze path (deg) by speed: most of it travelled at saccadic speed (> 40 deg/s), little
    // at drift speed (2-40 deg/s: what a 40 ms exponential "saccade" does)
    const w = rec.gazeX.map((g, i) => g * 17.16 + rec.headYaw[i] * DEG);
    let fast = 0, drift = 0;
    for (let i = 1; i < w.length; i++) {
      const dx = Math.abs(w[i] - w[i - 1]), v = dx * 60;
      if (v > 40) fast += dx;
      else if (v > 2) drift += dx;
    }
    expect(drift / (fast + drift)).toBeLessThan(0.3);
  });

  it('thinking holds one look-away per episode; it switches side rarely and not on a clock', () => {
    const d = new Director({ seed: 11, idleMotion: 1 });
    d.setState('thinking');
    let t = 0, prev = d._thinkSide;
    const switches = [];
    for (let i = 0; i < 120 * 60; i++) {
      t += 1 / 60;
      d.update(1 / 60, t);
      if (d._thinkSide !== prev) { switches.push(t); prev = d._thinkSide; }
    }
    expect(switches.length).toBeLessThan(16); // ~11 s apart on average (the old metronome: 34)
    expect(switches.length).toBeGreaterThan(2);
    const iv = switches.slice(1).map((x, i) => x - switches[i]);
    const m = iv.reduce((a, b) => a + b, 0) / iv.length;
    const cv = Math.sqrt(iv.reduce((a, b) => a + (b - m) ** 2, 0) / iv.length) / m;
    expect(cv).toBeGreaterThan(0.25);
    expect(Math.min(...iv)).toBeGreaterThanOrEqual(8 - 1e-9);
  });

  it('the head goes along with a followed cursor: with the sweep, a share of a flick, never against the eyes', () => {
    // a 30 Hz sample-and-hold cursor: a 2 s sweep across (-0.8 -> 0.8), a 2 s hold, a flick to -0.6
    const q = (t) => Math.floor(t * 30) / 30;
    const cursor = (t) => {
      const s = q(t) - 1;
      if (s < 2) return -0.8 + 1.6 * (0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, s)) / 2));
      return s < 4 ? 0.8 : -0.6;
    };
    let last = NaN;
    const rec = record({ idleMotion: 0 }, 7, 60, (t, d) => {
      if (t < 1) return;
      const x = cursor(t);
      if (x !== last) { d.lookAt(x, 0); last = x; }
    }, ['headYaw', 'gazeX']);
    const yaw = rec.headYaw.map((v) => v * DEG);
    const at = (t) => yaw[Math.round(t * 60) - 1];
    // late in the sweep (the cursor and the eyes moving right) the head turns right too
    for (let t = 1.8; t < 3; t += 1 / 60) expect(at(t + 1 / 60) - at(t), `t = ${t.toFixed(2)}`).toBeGreaterThan(-0.005);
    // it keeps up: within 0.5 s of the sweep's end it is most of the way to its share of the hold
    // (0.38 x 11.7 deg), not seconds later
    expect(at(3.5)).toBeGreaterThan(3.5);
    expect(at(4.9)).toBeGreaterThan(3.8);
    expect(at(4.9)).toBeLessThan(5.2);
    // a 20 deg flick takes ~7 deg of head along (not ~2), late but within a second
    const flick = at(4.98) - at(6.2);
    expect(flick).toBeGreaterThan(6);
    expect(flick).toBeLessThan(9);
    // the eyes do most of it and never pass the clamp
    expect(Math.max(...rec.gazeX.map(Math.abs))).toBeLessThan(1);
  });

  it('a glance away from the user\'s face is the eyes\' look; the head goes along with a cursor there', () => {
    const yawAt = (kind) => {
      const rec = record({ idleMotion: 0 }, 2.5, 60, (t, d) => {
        if (Math.abs(t - 1 / 60) < 1e-6) d.lookAt(0, 0, 'face');
        if (Math.abs(t - 1) < 1e-6) d.lookAt(0.8, 0, kind);
      }, ['headYaw']);
      return rec.headYaw[Math.round(2.0 * 60) - 1] * DEG; // 1 s into the look
    };
    const cursor = yawAt('cursor'), glance = yawAt('glance');
    expect(cursor).toBeGreaterThan(3.5);  // 0.38 of 11.7 deg, most of the way there
    expect(glance).toBeLessThan(0.65 * cursor);
    expect(glance).toBeGreaterThan(0.5);   // (the head still turns a little)
  });

  it('idle sway: ~0.8 deg rms yaw over 2 min, moving at ~0.5 deg/s (the documented amplitudes)', () => {
    // (the sway alone: the behaviour layer's look-arounds and posture shifts come on top of it,
    // tests/unit/avatar/behavior.test.js)
    for (const seed of [1, 2, 3]) {
      const d = new Director({ seed, liveliness: 0 });
      const dt = 1 / 60;
      const yaw = [];
      for (let i = 1; i <= 120 * 60; i++) yaw.push(d.update(dt, i * dt).headYaw * DEG);
      const m = yaw.reduce((a, b) => a + b, 0) / yaw.length;
      const rms = Math.sqrt(yaw.reduce((a, b) => a + (b - m) ** 2, 0) / yaw.length);
      let sp = 0;
      for (let i = 1; i < yaw.length; i++) sp += Math.abs(yaw[i] - yaw[i - 1]) / dt;
      sp /= yaw.length - 1;
      expect(rms, `seed ${seed}`).toBeGreaterThan(0.6);
      expect(rms, `seed ${seed}`).toBeLessThan(1.2);
      expect(sp, `seed ${seed}`).toBeGreaterThan(0.35);
      expect(sp, `seed ${seed}`).toBeLessThan(0.9);
    }
  });

  it('starting to speak, the first look goes to the listener, not to an old look-around', () => {
    let worst = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const d = new Director({ seed });
      const dt = 1 / 60;
      let t = 0;
      const go = (s, secs, f) => { d.setState(s); for (let i = 0; i < secs * 60; i++) { t += dt; const a = d.update(dt, t); if (f) f(i * dt, a); } };
      go('idle', 6);
      go('thinking', 4);
      go('speaking', 1, (s) => {
        // (after the ~0.1-0.25 s the eyes take to follow the state, before the next look-around)
        if (s > 0.45 && s < 0.8) worst = Math.max(worst, Math.abs(d.eyes.x));
      });
    }
    expect(worst).toBeLessThan(1.5); // deg; an idle look-around reaches ~4.8
  });

  it('a state change brings a saccade to the new gaze ~0.1-0.35 s later', () => {
    const rec = record({ idleMotion: 0 }, 2, 60, (t, d) => { if (Math.abs(t - 0.5) < 1e-6) d.setState('thinking'); }, ['gazeY', 'headPitch']);
    const w = rec.gazeY.map((g, i) => g * GAZE_DEG.y + rec.headPitch[i] * DEG);
    const start = rec.t.find((t, i) => i > 0 && Math.abs(w[i] - w[i - 1]) > 0.05);
    expect(start - 0.5).toBeGreaterThan(0.1);
    expect(start - 0.5).toBeLessThan(0.4);
    // and it is a jump: most of the shift within ~4 frames
    const i0 = rec.t.indexOf(start);
    const total = w.at(-1) - w[i0 - 1];
    expect((w[i0 + 3] - w[i0 - 1]) / total).toBeGreaterThan(0.8);
  });
});

describe('director motion: blinks', () => {
  it('varied blinks: log-normal intervals with a refractory period, partial blinks, rare doubles', () => {
    const d = new Director({ seed: 21, idleMotion: 1 });
    let t = 0, prev = 0, peak = 0, inBlink = false;
    const starts = [], peaks = [];
    for (let i = 0; i < 600 * 60; i++) {
      t += 1 / 60;
      const b = d.update(1 / 60, t).blinkL;
      if (!inBlink && b > 0.05) { inBlink = true; starts.push(t); peak = 0; }
      if (inBlink) peak = Math.max(peak, b);
      if (inBlink && b < 0.02 && prev >= 0.02) { inBlink = false; peaks.push(peak); }
      prev = b;
    }
    const perMin = starts.length / 10;
    expect(perMin).toBeGreaterThan(12);
    expect(perMin).toBeLessThan(24);
    const iv = starts.slice(1).map((x, i) => x - starts[i]);
    const doubles = iv.filter((x) => x < 0.6).length;
    expect(doubles / iv.length).toBeLessThan(0.08);
    // (the onsets are detected at 5 % closure: a slow partial blink shows a frame later)
    expect(Math.min(...iv.filter((x) => x >= 0.6))).toBeGreaterThanOrEqual(0.8 - 2 / 60);
    const partial = peaks.filter((p) => p < 0.85).length / peaks.length;
    expect(partial).toBeGreaterThan(0.08);
    expect(partial).toBeLessThan(0.35);
  });
});

describe('director motion: settled renders keep the original rest pose', () => {
  // values of the closed-form settled pose before the motion rewrite (src/avatar/director.js at
  // f96ca62): the rest render, the visual-diff reference, must not change
  const GOLDEN = [
    [1, 'idle', 1, [0.00473491783997, 0.00130596389846, -0.00197356822877, 0, 0, 0.462634953207, 0.5, 0, 0, 0]],
    [1, 'idle', 3.3, [0.008808608449, -0.00471671910391, -0.00180718298254, 0, 0, 0.388739533022, 0.5, 0, 0, 0]],
    // (gazeY 0.48 in the original units: 6.78 deg each; now 12.77 deg each, the same iris offset)
    [7, 'thinking', 17.25, [0.050693113379, 0.0751568083956, 0.045884551368, 0.42, 0.48 * 6.78 / 12.77, 0.109084258766, 0.648164649335, 0.1, 0, 0]],
    [42, 'listening', 0.5, [-0.00112404981207, -0.0380723232657, 0.0306385435295, 0, 0, 0.133474064085, 0.78, 0.18, 0.08, 0]],
    [3, 'sleep', 5, [0.000401337149336, -0.102549152048, 0.0405902775464, 0, -0.2 * 6.78 / 12.77, 0.317329487817, 0.14, 0, 0, 1]],
  ];
  const KEYS = ['headYaw', 'headPitch', 'headRoll', 'gazeX', 'gazeY', 'breath', 'energy', 'browUp', 'smile', 'blinkL'];
  for (const [seed, state, t, want] of GOLDEN) {
    it(`seed ${seed}, ${state}, t = ${t}`, () => {
      const d = new Director({ seed });
      d.setState(/** @type {any} */ (state));
      const a = d.update(0, t, { settle: true });
      KEYS.forEach((k, i) => expect(a[k], k).toBeCloseTo(want[i], 10));
    });
  }
});
