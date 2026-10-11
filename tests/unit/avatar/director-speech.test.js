// Director: the lip-sync channels (press, tuck, teeth, tongue, asymmetry) and the secondary
// speech motion driven by prosody cues (nods, brows, phrase-end blinks, micro-smiles).
import { describe, expect, it } from 'vitest';
import { Director, JAW_BEHIND_SEAL, MOUTH_OMEGA, NOD_REFRACTORY, createAnimState, LIP_CONTACT, lipContact } from '../../../src/avatar/director.js';

/** Run a director at a fixed frame rate, calling `each(t, a)` every frame. */
function run(d, seconds, fps = 60, each = () => {}, t0 = 0) {
  const dt = 1 / fps;
  let t = t0;
  let a;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    t += dt;
    a = d.update(dt, t);
    each(t, a);
  }
  return { t, a };
}

const CH = { jaw: 'jawOpen', wide: 'mouthWide', round: 'mouthRound', press: 'mouthPress', tuck: 'mouthTuck', teeth: 'mouthTeeth', tongue: 'mouthTongue' };

describe('Director: speech channels', () => {
  it('rests at zero (the rest pose is unchanged) and treats missing fields as 0', () => {
    const d = new Director({ seed: 1 });
    const a = d.update(0, 1, { settle: true });
    for (const k of Object.values(CH)) expect(a[k]).toBe(0);
    expect(a.mouthAsym).toBe(0);
    d.setMouth({ jaw: 0.5 }); // an old caller: only jaw
    const b = d.update(0, 1.1, { settle: true });
    expect(b.jawOpen).toBe(0.5);
    expect(b.mouthPress).toBe(0);
    d.setMouth({ jaw: 0.2, press: 2, tuck: -1, teeth: NaN, tongue: 0.4 });
    const c = d.update(0, 1.2, { settle: true });
    expect(c.mouthPress).toBe(1); // clamped
    expect(c.mouthTuck).toBe(0);
    expect(c.mouthTeeth).toBe(0);
    expect(c.mouthTongue).toBe(0.4);
    expect(Object.keys(MOUTH_OMEGA).sort()).toEqual(Object.keys(CH).sort());
  });

  it('smooths every channel (no frame jumps) and settles on the target', () => {
    const d = new Director({ seed: 2, idleMotion: 0 });
    d.setState('speaking');
    run(d, 0.5);
    const target = { jaw: 0.6, wide: 0.5, round: 0.7, press: 0.9, tuck: 0.8, teeth: 0.7, tongue: 0.6 };
    d.setMouth(target);
    const first = { ...d.update(1 / 60, 0.5 + 1 / 60) };
    for (const [m, k] of Object.entries(CH)) {
      expect(first[k], k).toBeGreaterThan(0);
      expect(first[k], k).toBeLessThan(target[m]); // one frame does not jump all the way
    }
    let a;
    for (let i = 2; i < 30; i++) { d.setMouth(target); a = d.update(1 / 60, 0.5 + i / 60); }
    // (pressing and tucking lips meet in contact: their shown value saturates, lipContact; with
    // the lips closed for a sound the jaw waits behind them, JAW_BEHIND_SEAL: a 0.6 jaw under a
    // 0.9 press is held at 0.4 — v0.4 let it drop behind the sealed lips, so the release popped)
    const shown = (m) => (m === 'press' || m === 'tuck' ? lipContact(target[m], target[m], JAW_BEHIND_SEAL)
      : m === 'jaw' ? Math.min(target.jaw, JAW_BEHIND_SEAL) : target[m]);
    for (const [m, k] of Object.entries(CH)) expect(a[k], k).toBeCloseTo(shown(m), 2);
    expect(a.mouthPress).toBeGreaterThan(Math.min(1, LIP_CONTACT * target.press) - 0.02);   // in contact
    for (let i = 30; i < 70; i++) { d.setMouth({}); a = d.update(1 / 60, 0.5 + i / 60); }
    for (const k of Object.values(CH)) expect(a[k], k).toBeLessThan(0.01);
  });

  it('the lips meet in contact (still moving fast, not easing to a touch) and part abruptly', () => {
    let time = 0;
    const d = new Director({ seed: 5, idleMotion: 0 });
    d.setState('speaking');
    const step = (m) => { d.setMouth(m); time += 1 / 60; return d.update(1 / 60, time).mouthPress; };
    for (let i = 0; i < 30; i++) step({ jaw: 0.5 });
    const closing = [0];
    while (closing[closing.length - 1] < 1 && closing.length < 20) closing.push(step({ jaw: 0.1, press: 1 }));
    expect(closing.length).toBeLessThanOrEqual(5);                       // sealed within ~65 ms
    // the last step into contact is still a big one (a critically damped approach ends in tiny steps)
    expect(closing[closing.length - 1] - closing[closing.length - 2]).toBeGreaterThan(0.1);
    // ... but the approach takes a few frames: no frame closes more than ~40 % of the way (v0.3's
    // 110 rad/s spring went 0 -> 0.6 in one frame: a wide-open vowel snapped shut; the lip-sync
    // now starts the approach LIP_CLOSE_EARLY sooner instead)
    for (let i = 1; i < closing.length; i++) expect(closing[i] - closing[i - 1]).toBeLessThan(0.4);
    expect(closing.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < 10; i++) step({ jaw: 0.1, press: 1 });
    const opening = [1];
    for (let i = 0; i < 4; i++) opening.push(step({ jaw: 0.5 }));
    expect(opening[3]).toBeLessThan(0.35);                               // parted within 50 ms
    expect(LIP_CONTACT).toBeGreaterThan(1);
  });

  it('the lips hold contact only while closing for a sound; the jaw waits behind them', () => {
    // contact while the target is full; a falling target (a release, a short vowel between two
    // closures) shows the spring as it is, so the lips part as soon as they move
    expect(lipContact(0.85, 1, 0.5)).toBe(1);
    expect(lipContact(0.85, 0.2, 0.5)).toBeCloseTo(0.85, 9);
    expect(lipContact(0, 1, 0.5)).toBe(0);
    // from a small opening the lips meet sooner (a shorter way)
    expect(lipContact(0.6, 1, 0)).toBe(1);
    expect(lipContact(0.6, 1, 0.5)).toBeCloseTo(0.6 * LIP_CONTACT, 9);
    // the jaw: an open vowel's target behind sealed lips waits at JAW_BEHIND_SEAL, then opens
    // over several frames as they part
    let time = 0;
    const d = new Director({ seed: 7, idleMotion: 0 });
    d.setState('speaking');
    const step = (m) => { d.setMouth(m); time += 1 / 60; return d.update(1 / 60, time); };
    for (let i = 0; i < 40; i++) step({ jaw: 0.1, press: 1 });
    let a;
    for (let i = 0; i < 6; i++) a = step({ jaw: 0.8, press: 1 });
    expect(a.jawOpen).toBeLessThan(JAW_BEHIND_SEAL + 0.01);
    expect(a.mouthPress).toBe(1);
    const jaws = [a.jawOpen], presses = [a.mouthPress];
    for (let i = 0; i < 12; i++) { a = step({ jaw: 0.8 }); jaws.push(a.jawOpen); presses.push(a.mouthPress); }
    expect(presses[2]).toBeLessThan(0.6);                  // parted within two frames
    expect(jaws.at(-1)).toBeGreaterThan(0.72);             // then the jaw goes on to the vowel
    for (let i = 1; i < jaws.length; i++) expect(jaws[i] - jaws[i - 1]).toBeLessThan(0.17);
  });

  it('presses and tucks fast, rounds slower; the jaw follows into a closure faster than into rest', () => {
    let time = 0;
    const step = (d, m) => { d.setMouth(m); time += 1 / 60; return d.update(1 / 60, time); };
    const d1 = new Director({ seed: 3 });
    for (let i = 0; i < 30; i++) step(d1, {});
    let p = 0;
    for (let i = 0; i < 3; i++) p = step(d1, { press: 1 }).mouthPress;
    const d2 = new Director({ seed: 3 });
    for (let i = 0; i < 30; i++) step(d2, {});
    let r = 0;
    for (let i = 0; i < 3; i++) r = step(d2, { round: 1 }).mouthRound;
    expect(p).toBeGreaterThan(r + 0.3);                 // (after 50 ms; v0.3 compared one frame)
    // jaw closing: plain (vowel → rest) vs into an m
    const d3 = new Director({ seed: 4 }), d4 = new Director({ seed: 4 });
    for (let i = 0; i < 30; i++) { step(d3, { jaw: 0.7 }); step(d4, { jaw: 0.7 }); }
    let plain = 1, closure = 1, press = 0;
    for (let i = 0; i < 3; i++) {
      plain = step(d3, { jaw: 0 }).jawOpen;
      const a = step(d4, { jaw: 0, press: 1 });
      closure = a.jawOpen; press = a.mouthPress;
    }
    // the lips seal first (the rigs bring the lower lip up over a jaw still open): by the 4th frame
    // of a sudden closure; the jaw comes up behind them, faster than it closes into rest but
    // without snapping shut in a frame or two
    expect(press).toBeGreaterThan(0.8);
    expect(step(d4, { jaw: 0, press: 1 }).mouthPress).toBeGreaterThan(0.95);
    expect(closure).toBeLessThan(0.8 * plain);
    expect(closure).toBeGreaterThan(0.1);
    expect(plain).toBeGreaterThan(0.15);
  });

  it('adds a small, seed-stable lip asymmetry only while talking', () => {
    const d = new Director({ seed: 5, idleMotion: 0 });
    run(d, 1, 60, () => d.setMouth({ jaw: 0.5 }));
    expect(d.out.mouthAsym).toBe(0); // not speaking
    d.setState('speaking');
    let maxA = 0;
    run(d, 2, 60, (t, a) => { d.setMouth({ jaw: 0.5, wide: 0.3 }); maxA = Math.max(maxA, Math.abs(a.mouthAsym)); }, 1);
    expect(maxA).toBeGreaterThan(0.05);
    expect(maxA).toBeLessThan(0.5);
  });

  it('keeps the idle blink / saccade sequence of a seed (prosody uses its own random stream)', () => {
    const trace = () => {
      const d = new Director({ seed: 7 });
      const out = [];
      run(d, 6, 60, (t, a) => out.push(a.blinkL, a.gazeX));
      return out;
    };
    expect(trace()).toEqual(trace());
  });
});

describe('Director: prosody (secondary speech motion)', () => {
  /** A speaking director without idle motion, after 1 s. */
  function speaking(seed = 1) {
    const d = new Director({ seed, idleMotion: 0 });
    d.setState('speaking');
    const r = run(d, 1);
    return { d, t: r.t };
  }

  it('nods on an accent: the head dips briefly and comes back', () => {
    const { d, t } = speaking();
    const p0 = d.out.headPitch;
    d.setProsody({ type: 'accent', strength: 1 });
    let minP = Infinity, tMin = 0;
    const r = run(d, 0.8, 60, (tt, a) => { if (a.headPitch < minP) { minP = a.headPitch; tMin = tt - t; } }, t);
    expect(p0 - minP).toBeGreaterThan(0.012); // ~1 degree: subtle
    expect(p0 - minP).toBeLessThan(0.04);
    expect(tMin).toBeGreaterThan(0.05);
    expect(tMin).toBeLessThan(0.25);
    expect(Math.abs(r.a.headPitch - p0)).toBeLessThan(0.004); // back
  });

  it('weaker accents vary: nods of many sizes, turns and tilts, brow flicks, or nothing; strong ones nod', () => {
    const DEG = 180 / Math.PI;
    const outcomes = { nod: 0, beat: 0, still: 0 }, nods = [];
    for (let seed = 1; seed <= 60; seed++) {
      const { d, t } = speaking(seed);
      const p0 = d.out.headPitch, y0 = d.out.headYaw, r0 = d.out.headRoll;
      d.setProsody({ type: 'accent', strength: 0.45 });
      let dip = 0, turn = 0;
      run(d, 0.6, 60, (tt, a) => {
        dip = Math.max(dip, (p0 - a.headPitch) * DEG);
        turn = Math.max(turn, Math.abs(a.headYaw - y0) * DEG, Math.abs(a.headRoll - r0) * DEG);
      }, t);
      if (dip > 0.15) { outcomes.nod++; nods.push(dip); } else if (turn > 0.15) outcomes.beat++; else outcomes.still++;
    }
    expect(outcomes.nod).toBeGreaterThan(18);
    expect(outcomes.nod).toBeLessThan(42);
    expect(outcomes.beat).toBeGreaterThan(5);
    expect(outcomes.still).toBeGreaterThan(3);
    const mean = nods.reduce((a, b) => a + b, 0) / nods.length;
    const sd = Math.sqrt(nods.reduce((a, b) => a + (b - mean) ** 2, 0) / nods.length);
    expect(sd / mean).toBeGreaterThan(0.2);          // (they used to be within +-20 %, sd/mean ~0.11)
    // a phrase's nuclear accent always nods
    for (let seed = 1; seed <= 12; seed++) {
      const { d, t } = speaking(seed);
      const p0 = d.out.headPitch;
      d.setProsody({ type: 'accent', strength: 1 });
      let dip = 0;
      run(d, 0.6, 60, (tt, a) => { dip = Math.max(dip, (p0 - a.headPitch) * DEG); }, t);
      expect(dip, `seed ${seed}`).toBeGreaterThan(0.3);
    }
  });

  it('weaker accents do not nod in a rhythm: none within NOD_REFRACTORY of the last nod', () => {
    let again = 0, later = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { d, t } = speaking(seed);
      const nods = () => d._kicks.filter((k) => k.kind === 'nod').length;
      d.setProsody({ type: 'accent', strength: 1 });          // a nuclear accent: it nods
      expect(nods()).toBe(1);
      let tt = run(d, 0.35, 60, () => {}, t).t;
      d.setProsody({ type: 'accent', strength: 0.9 });        // too soon for another nod
      if (nods() > 1) again++;
      tt = run(d, NOD_REFRACTORY[1] + 0.1, 60, () => {}, tt).t;
      d.setProsody({ type: 'accent', strength: 0.9 });        // a while later it may nod again
      if (nods() > 1) later++;
    }
    expect(again).toBe(0);
    expect(later).toBeGreaterThan(10);
    expect(NOD_REFRACTORY[0]).toBeGreaterThanOrEqual(0.5);
  });

  it('one nod per syllable at most', () => {
    const { d, t } = speaking(6);
    d.setProsody({ type: 'accent', strength: 1 });
    d.setProsody({ type: 'accent', strength: 1 });
    expect(d._kicks.filter((k) => k.kind === 'nod')).toHaveLength(1);
    // (a strong accent 0.3 s later used to nod again; now it waits out NOD_REFRACTORY: no
    // nod-per-syllable rhythm, it gets a beat or a brow instead)
    const tt = run(d, 0.3, 60, () => {}, t).t;
    d.setProsody({ type: 'accent', strength: 1 });
    expect(d._kicks.filter((k) => k.kind === 'nod')).toHaveLength(1);
    run(d, NOD_REFRACTORY[1], 60, () => {}, tt);
    d.setProsody({ type: 'accent', strength: 1 });
    expect(d._kicks.filter((k) => k.kind === 'nod')).toHaveLength(2);
  });

  it('raises the brows (and tilts the head) after a question, smiles after a friendly sentence', () => {
    const { d, t } = speaking(2);
    const b0 = d.out.browUp, s0 = d.out.smile;
    d.setProsody([{ type: 'phrase-end', punct: '?', friendly: 0.8 }]);
    let maxB = 0, maxS = 0, maxRoll = 0;
    run(d, 1.2, 60, (tt, a) => {
      maxB = Math.max(maxB, a.browUp); maxS = Math.max(maxS, a.smile); maxRoll = Math.max(maxRoll, Math.abs(a.headRoll));
    }, t);
    expect(maxB - b0).toBeGreaterThan(0.15);
    expect(maxS - s0).toBeGreaterThan(0.08);
    expect(maxS).toBeLessThan(0.35); // a micro-smile
    expect(maxRoll).toBeGreaterThan(0.01);
    const r = run(d, 4, 60, () => {}, t + 1.2);
    expect(r.a.browUp).toBeCloseTo(b0, 2);
    expect(r.a.smile).toBeCloseTo(s0, 2);
  });

  it('emphasis raises the brows; a plain statement end does not', () => {
    const a = speaking(3);
    const a0 = a.d.out.browUp;
    a.d.setProsody({ type: 'emphasis', strength: 1 });
    let maxB = 0;
    run(a.d, 0.6, 60, (tt, s) => { maxB = Math.max(maxB, s.browUp); }, a.t);
    expect(maxB - a0).toBeGreaterThan(0.1);
    const b = speaking(3);
    const b0 = b.d.out.browUp;
    b.d.setProsody({ type: 'phrase-end', punct: '.' });
    let maxB2 = 0;
    run(b.d, 0.6, 60, (tt, s) => { maxB2 = Math.max(maxB2, s.browUp); }, b.t);
    expect(maxB2 - b0).toBeLessThan(0.01);
  });

  it('blinks at phrase boundaries rather than mid-word', () => {
    const d = new Director({ seed: 9, idleMotion: 0 });
    d.setState('speaking');
    // 20 s of speech: an accent every 0.3 s, a phrase end every 2.4 s
    const blinkStarts = [];
    const phraseEnds = [];
    let prev = 0, t = 0;
    for (let i = 0; i < 20 * 60; i++) {
      t += 1 / 60;
      if (i % 18 === 0) d.setProsody({ type: 'accent', strength: 0.6 });
      if (i % 144 === 143) { d.setProsody({ type: 'phrase-end', punct: '.' }); phraseEnds.push(t); }
      const a = d.update(1 / 60, t);
      if (prev < 0.5 && a.blinkL >= 0.5) blinkStarts.push(t);
      prev = a.blinkL;
    }
    expect(blinkStarts.length).toBeGreaterThanOrEqual(4);
    const atBoundary = blinkStarts.filter((b) => phraseEnds.some((e) => b - e >= 0 && b - e < 0.15));
    expect(atBoundary.length / blinkStarts.length).toBeGreaterThan(0.6);
  });

  it('ignores cues in settle mode and copes with junk', () => {
    const d = new Director({ seed: 4, idleMotion: 0 });
    d.setProsody({ type: 'accent', strength: 1 });
    d.setProsody({ type: 'phrase-end', punct: '?', friendly: 1 });
    const a = d.update(0, 0.1, { settle: true });
    const rest = new Director({ seed: 4, idleMotion: 0 }).update(0, 0.1, { settle: true });
    expect(a.headPitch).toBeCloseTo(rest.headPitch, 9);
    expect(a.headRoll).toBeCloseTo(rest.headRoll, 9);
    expect(a.browUp).toBe(0);
    expect(a.smile).toBe(0);
    expect(createAnimState().mouthPress).toBe(0);
    expect(() => d.setProsody(null)).not.toThrow();
    expect(() => d.setProsody({ type: 'nonsense' })).not.toThrow();
  });
});
