// Director: the speech motion that comes from the voice's prosody (audio cues, intonation),
// the face moving with the mouth, conversational glances, and avatar.expressiveness scaling it.
import { describe, expect, it } from 'vitest';
import { ANIM_KEYS, Director, EXPRESSIVENESS_MAX, createAnimState } from '../../../src/avatar/director.js';

function run(d, seconds, t0, each = () => {}, fps = 60) {
  const dt = 1 / fps;
  let t = t0;
  let a;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    t += dt;
    each(t);
    a = d.update(dt, t);
  }
  return { t, a };
}

/** A director already speaking (state weights settled), idle motion off. */
function speaking(o = {}) {
  const d = new Director({ seed: 3, idleMotion: 0, ...o });
  d.setState('speaking');
  const { t } = run(d, 1.5, 0);
  return { d, t };
}

/** Largest |headPitch - its value before| in the `seconds` after cues sent at the start. */
function pitchSwing(d, t0, cues, seconds = 1.2) {
  const base = d.out.headPitch;
  let m = 0;
  d.setProsody(cues);
  run(d, seconds, t0, () => { m = Math.max(m, Math.abs(d.out.headPitch - base)); });
  return m;
}

describe('expressiveness', () => {
  it('is clamped to 0..2 (default 1) and new channels exist at rest', () => {
    expect(new Director().expressiveness).toBe(1);
    expect(new Director({ expressiveness: 5 }).expressiveness).toBe(EXPRESSIVENESS_MAX);
    const d = new Director({ expressiveness: -1 });
    expect(d.expressiveness).toBe(0);
    d.setExpressiveness('x');
    expect(d.expressiveness).toBe(1);
    for (const k of ['cheekRaise', 'chinRaise', 'nostrilFlare']) {
      expect(ANIM_KEYS).toContain(k);
      expect(createAnimState()[k]).toBe(0);
    }
    const rest = new Director({ seed: 1 }).update(0, 1, { settle: true });
    expect(rest.cheekRaise).toBe(0);
    expect(rest.chinRaise).toBe(0);
    expect(rest.nostrilFlare).toBe(0);
  });

  it('scales the nods and brows of the same cues: 0 = still, 2 = twice as animated', () => {
    const cues = [{ type: 'accent', strength: 1 }, { type: 'emphasis', strength: 1 }];
    const swing = (ex) => {
      const { d, t } = speaking({ expressiveness: ex });
      return pitchSwing(d, t, cues);
    };
    const s0 = swing(0), s1 = swing(1), s2 = swing(2);
    expect(s0).toBeLessThan(0.002);
    expect(s1).toBeGreaterThan(0.01);
    expect(s2 / s1).toBeGreaterThan(1.7);
    const brow = (ex) => {
      const { d, t } = speaking({ expressiveness: ex });
      d.setProsody({ type: 'emphasis', strength: 1 });
      let m = 0;
      run(d, 1, t, () => { m = Math.max(m, d.out.browUp); });
      return m;
    };
    expect(brow(0)).toBeLessThan(0.01);
    expect(brow(1)).toBeGreaterThan(0.12);
    expect(brow(2)).toBeGreaterThan(brow(1) * 1.5);
  });
});

describe('audio prosody', () => {
  it('the head follows the intonation a little; brows lift only well above the usual pitch', () => {
    const at = (pitch) => {
      const { d, t } = speaking();
      d.setIntonation({ pitch, voiced: true });
      return run(d, 1, t).a;
    };
    const flat = at(0), high = at(6), mid = at(2), low = at(-4);
    expect(high.headPitch - flat.headPitch).toBeGreaterThan(0.015);
    expect(low.headPitch).toBeLessThan(flat.headPitch);
    expect(high.browUp - flat.browUp).toBeGreaterThan(0.08);
    expect(mid.browUp - flat.browUp).toBeLessThan(0.01);
    // nothing while not speaking, and NaN / null are ignored
    const d = new Director({ seed: 3, idleMotion: 0 });
    d.setIntonation({ pitch: 8, voiced: true });
    const idle = run(d, 1, 0).a;
    expect(Math.abs(idle.headPitch)).toBeLessThan(0.002);
    d.setIntonation(null);
    d.setIntonation({ pitch: NaN });
    expect(d._into.pitch).toBe(0);
  });

  it('a phrase-final fall lowers the head; a question raises the brows and tilts it', () => {
    const { d, t } = speaking();
    const before = d.out.headPitch;
    d.setProsody({ type: 'phrase-end', punct: '.', fall: 5, rise: 0, pause: 0.5 });
    let low = Infinity;
    run(d, 1.2, t, () => { low = Math.min(low, d.out.headPitch); });
    expect(before - low).toBeGreaterThan(0.01);
    const q = speaking();
    q.d.setProsody({ type: 'phrase-end', punct: '?', fall: 0, rise: 4, pause: 0.5 });
    let brow = 0, roll = 0;
    run(q.d, 1.2, q.t, () => { brow = Math.max(brow, q.d.out.browUp); roll = Math.max(roll, Math.abs(q.d.out.headRoll)); });
    expect(brow).toBeGreaterThan(0.2);
    expect(roll).toBeGreaterThan(0.015);
    // a rising end without a question mark asks a little (continuation)
    const c = speaking();
    c.d.setProsody({ type: 'phrase-end', punct: ',', fall: 0, rise: 5, pause: 0.3 });
    let cb = 0;
    run(c.d, 1.2, c.t, () => { cb = Math.max(cb, c.d.out.browUp); });
    expect(cb).toBeGreaterThan(0.08);
    expect(cb).toBeLessThan(brow);
  });

  it('an inhale flares the nostrils and parts free lips, once per pause', () => {
    const { d, t } = speaking();
    d.setProsody({ type: 'inhale', strength: 1 });
    let flare = 0, jaw = 0, n = 0;
    run(d, 0.7, t, () => {
      flare = Math.max(flare, d.out.nostrilFlare);
      jaw = Math.max(jaw, d.out.jawOpen);
    });
    expect(flare).toBeGreaterThan(0.4);
    expect(jaw).toBeGreaterThan(0.03);
    expect(d.out.breath).toBeGreaterThan(0.5);               // the chest rose
    d.setProsody({ type: 'inhale', strength: 1 });
    d.setProsody({ type: 'inhale', strength: 1 });
    n = d._kicks.filter((k) => k.kind === 'inhale').length;
    expect(n).toBe(2);                                         // one more (the first is 0.7 s old), not two
    // pressed lips stay closed
    const p = speaking();
    p.d.setMouth({ press: 1 });
    p.d.setProsody({ type: 'inhale', strength: 1 });
    let pj = 0;
    run(p.d, 0.5, p.t, () => { p.d.setMouth({ press: 1 }); pj = Math.max(pj, p.d.out.jawOpen); });
    expect(pj).toBeLessThan(0.01);
  });

  it('defers a due blink while the voice is sounding, then blinks in the pause', () => {
    const { d, t } = speaking();
    d._nextBlink = t + 0.05;
    d.setIntonation({ pitch: 0, voiced: true });
    let blinked = -1;
    let { t: t1 } = run(d, 1, t, (tt) => { if (blinked < 0 && d.out.blinkL > 0.5) blinked = tt; });
    expect(blinked).toBe(-1);
    d.setIntonation({ pitch: 0, voiced: false });
    d.setSpeechLevel(0);
    run(d, 1, t1, (tt) => { if (blinked < 0 && d.out.blinkL > 0.5) blinked = tt; });
    expect(blinked).toBeGreaterThan(t1);
  });
});

describe('the face moving with the mouth', () => {
  const settle = (m, o) => {
    const d = new Director({ seed: 1, idleMotion: 0, ...o });
    d.setState('speaking');
    run(d, 1, 0);
    d.setMouth(m);
    return run(d, 0.6, 1, () => d.setMouth(m)).a;
  };

  it('spread vowels lift the cheeks, pressed lips the chin; a wide-open jaw lifts the cheeks less', () => {
    const wide = settle({ jaw: 0.2, wide: 0.9, teeth: 0.6 });
    expect(wide.cheekRaise).toBeGreaterThan(0.4);
    expect(wide.chinRaise).toBeLessThan(0.05);
    const open = settle({ jaw: 0.9, wide: 0.9 });
    expect(open.cheekRaise).toBeLessThan(wide.cheekRaise);
    const press = settle({ press: 1 });
    expect(press.chinRaise).toBeGreaterThan(0.7);
    expect(press.cheekRaise).toBeLessThan(0.05);
    const round = settle({ jaw: 0.3, round: 1 });
    expect(round.chinRaise).toBeGreaterThan(0.08);
    expect(round.chinRaise).toBeLessThan(press.chinRaise);
  });

  it('is anatomical, so it stays partly on at expressiveness 0', () => {
    const still = settle({ press: 1 }, { expressiveness: 0 });
    const norm = settle({ press: 1 }, { expressiveness: 1 });
    expect(still.chinRaise).toBeGreaterThan(0.25);
    expect(still.chinRaise).toBeLessThan(norm.chinRaise);
  });
});

describe('conversational gaze', () => {
  it('glances away at some phrase starts, on top of lookAt, and is back on the listener by the phrase end', () => {
    const { d, t: t0 } = speaking();
    d.lookAt(0.5, 0.2);
    let t = run(d, 0.5, t0).t;
    const target = { x: d.out.gazeX, y: d.out.gazeY };
    expect(target.x).toBeCloseTo(0.5 * 0.85, 1);
    let glances = 0;
    for (let k = 0; k < 8; k++) {
      d.setProsody({ type: 'phrase-start', strength: 1 });
      let away = 0;
      ({ t } = run(d, 0.3, t, () => { away = Math.max(away, Math.abs(d.out.gazeX - target.x)); }));
      if (away > 0.1) glances++;
      d.setProsody({ type: 'phrase-end', punct: '.', pause: 0.4 });
      ({ t } = run(d, 0.3, t));
      // eye contact again: back at the lookAt target (within the micro-saccades)
      expect(Math.abs(d.out.gazeX - target.x)).toBeLessThan(0.06);
    }
    expect(glances).toBeGreaterThan(0);
    expect(glances).toBeLessThan(8);
  });

  it('no glances at expressiveness 0', () => {
    const { d, t: t0 } = speaking({ expressiveness: 0 });
    let t = t0;
    let away = 0;
    for (let k = 0; k < 6; k++) {
      d.setProsody({ type: 'phrase-start', strength: 1 });
      ({ t } = run(d, 0.3, t, () => { away = Math.max(away, Math.abs(d.out.gazeX)); }));
    }
    expect(away).toBeLessThan(0.06);
  });
});
