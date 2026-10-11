// The local-voice lip-sync on a clip's own audio: the loudness envelope opens the jaw (stressed,
// louder syllables wider, a sharp onset sharply), the pitch gives intonation and audio prosody
// cues, phrase-final sounds rest when the voice stops, and the player's decoded buffer is used
// when it offers one (else the clip's WAV is decoded).
import { describe, expect, it } from 'vitest';
import { FRAMES_PER_UPDATE, LipSync, clipSamples, energyJaw, stressJawScale, textEnds } from '../../../src/audio/lipsync.js';
import { warmUpAnalysis } from '../../../src/audio/prosody.js';
import { bytesToBase64, encodeWav } from '../../../src/audio/wav.js';
import { Emitter } from '../../../src/app/emitter.js';

const SR = 24000;
function buzz(dur, f, amp) {
  const x = new Float32Array(Math.round(dur * SR));
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    ph += (2 * Math.PI * f) / SR;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * ph) / k;
    x[i] = amp * 0.5 * v;
  }
  return x;
}
const silence = (d) => new Float32Array(Math.round(d * SR));
function concat(...p) {
  const o = new Float32Array(p.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of p) { o.set(x, k); k += x.length; }
  return o;
}

/** A fake AudioPlayer playing one clip; step(t) sets the playback clock. */
function rig(clip, { buffer } = {}) {
  const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, level: () => 0.05, spectrum: () => false });
  let now = 0;
  const ls = new LipSync({ player, now: () => now });
  const dt = 1 / 60;
  const run = (until, each) => {
    for (; now <= until + 1e-9; now += dt) {
      player.current = now < clip.dur ? { clip, kind: 'audio', time: now, buffer } : null;
      const m = ls.update(dt, now);
      each?.(now, m);
    }
  };
  return { player, ls, run };
}

/** Two "aa" syllables, the second 12 dB louder; a "d" the timeline holds 0.25 s past the voice. */
function makeClip() {
  const samples = concat(silence(0.15), buzz(0.2, 150, 0.08), silence(0.08), buzz(0.2, 150, 0.32), silence(0.6));
  const visemes = [
    { start: 0, end: 0.15, viseme: 'sil' }, { start: 0.15, end: 0.35, viseme: 'aa' }, { start: 0.35, end: 0.43, viseme: 'kk' },
    { start: 0.43, end: 0.6, viseme: 'aa' }, { start: 0.6, end: 0.88, viseme: 'DD' }, { start: 0.88, end: 1.23, viseme: 'sil' },
  ];
  const audioB64 = bytesToBase64(new Uint8Array(encodeWav(samples, SR)));
  return { kind: 'audio', audioB64, visemes, text: 'Ah, ahd.', dur: samples.length / SR, samples: undefined, _raw: samples };
}

describe('jaw from the audio', () => {
  it('energyJaw: smooth, monotonic, 0.58 near silence and 1.08 at full voice', () => {
    expect(energyJaw(-80)).toBeCloseTo(0.58, 9);
    expect(energyJaw(0)).toBeCloseTo(1.08, 9);
    let prev = 0;
    for (let db = -60; db <= 0; db += 2) {
      expect(energyJaw(db)).toBeGreaterThanOrEqual(prev);
      prev = energyJaw(db);
    }
  });

  it('stressJawScale: louder and longer vowels open wider, within bounds', () => {
    expect(stressJawScale(4, 1)).toBeGreaterThan(stressJawScale(0, 1));
    expect(stressJawScale(0, 1.6)).toBeGreaterThan(stressJawScale(0, 1));
    expect(stressJawScale(-30, 0.2)).toBe(0.66);
    expect(stressJawScale(30, 5)).toBe(1.24);
  });

  it('the louder syllable opens the jaw clearly wider than the quiet one with the same viseme', () => {
    const clip = makeClip();
    const { run } = rig(clip);
    const jaw = [];
    run(1.3, (t, m) => jaw.push({ t, jaw: m.jaw, teeth: m.teeth, source: m.source }));
    const at = (t0, t1) => Math.max(...jaw.filter((q) => q.t >= t0 && q.t <= t1).map((q) => q.jaw));
    const quiet = at(0.2, 0.32), loud = at(0.47, 0.58);
    expect(jaw.find((q) => q.t > 0.3).source).toBe('visemes');
    expect(loud).toBeGreaterThan(quiet * 1.4);
    expect(quiet).toBeGreaterThan(0.2);                    // the quiet one still opens
  });

  it('the jaw opens with a syllable\'s onset, not after it', () => {
    const clip = makeClip();
    const { run } = rig(clip);
    let opened = NaN;
    run(0.5, (t, m) => { if (t > 0.38 && Number.isNaN(opened) && m.jaw > 0.3) opened = t; });
    // the loud syllable starts at 0.43 s; with the visual lead the mouth is open by then
    expect(opened).toBeGreaterThan(0.36);
    expect(opened).toBeLessThan(0.45);
  });

  it('rests when the voice stops, though the timeline holds the final sound longer', () => {
    const clip = makeClip();
    const { run } = rig(clip);
    const late = [];
    run(1.0, (t, m) => { if (t >= 0.75 && t <= 0.86) late.push(m.jaw + m.teeth); });
    // (untrimmed, the DD would still hold jaw ~0.18 and teeth ~0.5 here)
    expect(Math.max(...late)).toBeLessThan(0.12);
  });
});

describe('audio prosody through the lip-sync', () => {
  it('gives cues (a breath, the phrase, its end) and the intonation of the voice', () => {
    const clip = makeClip();
    const { ls, run } = rig(clip);
    const cues = [];
    let voiced = 0;
    run(1.3, (t, m) => {
      if (m.cues) cues.push(...m.cues.map((c) => c.type));
      if (m.intonation.voiced) voiced++;
    });
    expect(cues[0]).toBe('inhale');
    expect(cues).toContain('phrase-start');
    expect(cues).toContain('phrase-end');
    expect(voiced).toBeGreaterThan(10);
    expect(ls.f0Ref).toBeGreaterThan(140);                 // learned the speaker's pitch
    expect(ls.f0Ref).toBeLessThan(160);
  });

  it('the intonation rises above the speaker\'s usual pitch on a high syllable', () => {
    // mostly at 150 Hz (the speaker's usual pitch, learned from the clip), one syllable 5 st higher
    const samples = concat(silence(0.1), buzz(0.6, 150, 0.2), silence(0.05), buzz(0.25, 150 * 2 ** (5 / 12), 0.2), silence(0.3));
    const clip = {
      kind: 'audio', samples, sampleRate: SR, dur: samples.length / SR, text: '',
      visemes: [{ start: 0, end: 0.1, viseme: 'sil' }, { start: 0.1, end: 0.7, viseme: 'aa' }, { start: 0.7, end: 0.75, viseme: 'kk' },
        { start: 0.75, end: 1.0, viseme: 'E' }, { start: 1.0, end: 1.3, viseme: 'sil' }],
    };
    const { ls, run } = rig(clip);
    const p = [];
    run(1.3, (t, m) => p.push({ t, pitch: m.intonation.pitch }));
    expect(Math.abs(ls.f0Ref - 150)).toBeLessThan(3);
    const lo = p.find((q) => q.t > 0.5).pitch, hi = p.find((q) => q.t > 0.92).pitch;
    expect(Math.abs(lo)).toBeLessThan(1);
    expect(hi).toBeGreaterThan(3.5);
    // and it relaxes back toward 0 in the pause after the voice
    expect(Math.abs(p[p.length - 1].pitch)).toBeLessThan(hi);
  });
});

describe('the speaker\'s usual pitch', () => {
  it('starts over when the voice changes (a male voice after a female one is not -10 st)', () => {
    const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, level: () => 0.05, spectrum: () => false });
    let now = 0;
    const ls = new LipSync({ player, now: () => now });
    const dt = 1 / 60;
    const mk = (f, voice) => {
      const samples = concat(silence(0.1), buzz(0.7, f, 0.2), silence(0.3));
      return {
        kind: 'audio', samples, sampleRate: SR, dur: samples.length / SR, text: '', voice,
        visemes: [{ start: 0, end: 0.1, viseme: 'sil' }, { start: 0.1, end: 0.8, viseme: 'aa' }, { start: 0.8, end: 1.1, viseme: 'sil' }],
      };
    };
    const play = (clip) => {
      const pitches = [];
      for (let t = 0; t <= clip.dur + 0.2; t += dt) {
        now += dt;
        player.current = t < clip.dur ? { clip, kind: 'audio', time: t } : null;
        const m = ls.update(dt, now);
        if (m.intonation.voiced) pitches.push(m.intonation.pitch);
      }
      expect(pitches.length).toBeGreaterThan(10); // the voice was heard as voiced
      return pitches.sort((x, y) => x - y)[pitches.length >> 1];
    };
    for (let k = 0; k < 10; k++) play(mk(200, 'af_heart'));
    expect(Math.abs(ls.f0Ref - 200)).toBeLessThan(4);
    const male = play(mk(110, 'am_michael'));
    expect(Math.abs(male)).toBeLessThan(2);
    expect(Math.abs(ls.f0Ref - 110)).toBeLessThan(3);
    // the same voice again keeps what it learned
    play(mk(110, 'am_michael'));
    expect(Math.abs(ls.f0Ref - 110)).toBeLessThan(3);
  });
});

describe('the acoustics of a clip and the user\'s offset', () => {
  it('prepare() analyses a clip before it plays (synchronously without a worker)', async () => {
    const clip = makeClip();
    const { ls } = rig(clip);
    const track = await ls.prepare(clip);
    expect(track.n).toBe(Math.ceil(clip.dur / 0.005));
    expect(await ls.prepare(clip)).toBe(track);           // once per clip
    expect(await ls.prepare({ kind: 'speech', text: 'hi' })).toBe(null);
    expect(await ls.prepare({ kind: 'audio', audioB64: clip.audioB64, visemes: null })).toBe(null);
  });

  it('the fused timeline drives the clip (its acoustics retime and size the vowels)', () => {
    const clip = makeClip();
    const { ls, run } = rig(clip);
    let fused = null;
    run(0.3, () => { fused = ls._clips.get(clip)?.st?.fused ?? fused; });
    expect(fused).toBeTruthy();
    // the louder second "aa" gets more jaw than the quiet first one
    const aa = fused.tl.map((s, i) => (s.viseme === 'aa' ? fused.amounts[i].jaw : null)).filter((x) => x !== null);
    expect(aa[1]).toBeGreaterThan(aa[0] * 1.2);
  });

  it('setOffset(+s) moves the mouth (and what the voice drives) later; it is clamped to +-0.2 s', () => {
    const traceWith = (off) => {
      const clip = makeClip();
      const { ls, run } = rig(clip);
      ls.setOffset(off);
      const jaw = [];
      run(1.0, (t, m) => jaw.push(m.jaw));
      return jaw;
    };
    const a = traceWith(0), b = traceWith(0.1);
    // b lags a by 6 frames (100 ms at 60 Hz)
    let best = 0, lag = 0;
    for (let L = 0; L <= 10; L++) {
      let c = 0;
      for (let i = 0; i + L < b.length; i++) c += a[i] * b[i + L];
      if (c > best) { best = c; lag = L; }
    }
    expect(lag).toBe(6);
    const { ls } = rig(makeClip());
    ls.setOffset(5);
    expect(ls.offset).toBe(0.2);
    ls.setOffset(-5);
    expect(ls.offset).toBe(-0.2);
    ls.setOffset('x');
    expect(ls.offset).toBe(0);
  });
});

describe('preparing a clip', () => {
  it('spreads the analysis over the first frames (no frame does it all) and plays the timeline meanwhile', () => {
    const clip = makeClip();
    const player = Object.assign(new Emitter(), { current: null, sampleRate: 48000, level: () => 0.05, spectrum: () => false });
    const ls = new LipSync({ player, now: () => 0 });
    const stages = [];
    for (let f = 0; f < 6; f++) {
      player.current = { clip, kind: 'audio', time: f / 60 };
      const m = ls.update(1 / 60, f / 60);
      const p = ls._clips.get(clip);
      stages.push([p.stage, p.st?.a?.done ?? -1, m.source, m.cues]);
    }
    // one step per frame: base64 → WAV → envelope + plan; then the pitch, FRAMES_PER_UPDATE a frame
    expect(stages.map((s) => s[0])).toEqual(['base64', 'bytes', 'samples', 'ready', 'ready', 'ready']);
    expect(stages[3][1]).toBe(0);
    expect(stages[4][1]).toBe(FRAMES_PER_UPDATE);
    expect(stages[5][1]).toBe(2 * FRAMES_PER_UPDATE);
    // the timeline-only mouth plays meanwhile, without its own cues (they come from the audio)
    expect(stages.every((s) => s[2] === 'visemes')).toBe(true);
    expect(stages.slice(0, 4).every((s) => s[3] === null)).toBe(true);
    expect(stages[4][3]?.[0]?.type).toBe('inhale');
    // with the player's decoded buffer, two frames
    const clip2 = makeClip();
    const buffer = { sampleRate: SR, getChannelData: () => clip2._raw };
    const st2 = [];
    for (let f = 0; f < 3; f++) {
      player.current = { clip: clip2, kind: 'audio', time: f / 60, buffer };
      ls.update(1 / 60, f / 60);
      st2.push(ls._clips.get(clip2).stage);
    }
    expect(st2).toEqual(['samples', 'ready', 'ready']);
  });

  it('warms the analysis up once', () => {
    expect(typeof warmUpAnalysis()).toBe('boolean');
    expect(warmUpAnalysis()).toBe(false);
  });
});

describe('clip samples', () => {
  it('prefers the player\'s decoded buffer, then raw samples, then decodes the WAV', () => {
    const clip = makeClip();
    let asked = 0;
    const buf = { sampleRate: SR, getChannelData: (c) => { asked++; expect(c).toBe(0); return clip._raw; } };
    const a = clipSamples({ clip, buffer: buf });
    expect(asked).toBe(1);
    expect(a.samples).toBe(clip._raw);
    const b = clipSamples({ clip: { samples: clip._raw, sampleRate: SR } });
    expect(b.samples).toBe(clip._raw);
    const c = clipSamples({ clip });
    expect(c.sampleRate).toBe(SR);
    expect(c.samples.length).toBe(clip._raw.length);
    expect(Math.abs(c.samples[5000] - clip._raw[5000])).toBeLessThan(1e-4);
    expect(clipSamples({ clip: { audioB64: 'not a wav' } })).toBeNull();
    expect(clipSamples({ clip: {} })).toBeNull();
  });

  it('a clip without decodable audio keeps the timeline-only path', () => {
    const clip = { kind: 'audio', audioB64: '', text: 'Hi.', dur: 0.5, visemes: [{ start: 0, end: 0.1, viseme: 'sil' }, { start: 0.1, end: 0.4, viseme: 'aa' }, { start: 0.4, end: 0.5, viseme: 'sil' }] };
    const { run } = rig(clip);
    let max = 0;
    run(0.45, (t, m) => { max = Math.max(max, m.jaw); expect(m.source).toBe(t < 0.5 ? 'visemes' : 'none'); });
    expect(max).toBeGreaterThan(0.3);
  });

  it('textEnds gives each phrase end its place in the text', () => {
    const e = textEnds("Hello! I'm Claude. How are you?");
    expect(e.map((x) => x.punct)).toEqual(['!', '.', '?']);
    expect(e[0].pos).toBeLessThan(e[1].pos);
    expect(e[2].pos).toBe(1);
    expect(e[0].friendly).toBeGreaterThan(0);
  });
});
