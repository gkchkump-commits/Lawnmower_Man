import { describe, it, expect } from 'vitest';
import { OnsetRecipe } from '../../../electron/wake/recipe.js';

// Fakes. Audio: speech = 0.3 (the fake VAD's threshold is 0.1), silence = a tiny ramp below it
// (so the pre-roll's content can be checked). Keyword markers inside speech: 0.75 = HEY_JADE,
// 0.65 = HEY_JUDE, 0.55 = JADE; a fake spotter reports a marker LAG samples after it saw it,
// with timestamps [marker − 0.3 s, marker] relative to its stream's first sample.
const SR = 16000;
const LAG = 3200; // 200 ms detection latency
const MARK = { HEY_JADE: 0.75, HEY_JUDE: 0.65, JADE: 0.55 };
const close = (a, b) => Math.abs(a - b) < 1e-6;

function fakeVad() {
  return {
    resets: 0,
    accept(x) {
      let m = 0;
      for (const v of x) m = Math.max(m, Math.abs(v));
      return m > 0.1;
    },
    reset() { this.resets++; },
  };
}

/**
 * @param {string[]} [hears] which markers this spotter fires on
 * @param {{ gained?: boolean }} [o] gained: the input is scaled by a normaliser, so a marker is
 *   recognised by its ratio to the speech sample before it (0.75 / 0.3), not by its value
 */
function fakeSpotter(hears = ['HEY_JADE', 'HEY_JUDE'], o = {}) {
  const sp = {
    streams: [],
    newStream() {
      const s = { n: 0, fed: [], due: [], prev: 0 };
      sp.streams.push(s);
      return s;
    },
    accept(s, x) {
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        for (const kw of hears) {
          const isMark = o.gained ? s.prev > 0 && close(v / s.prev, MARK[kw] / 0.3) : close(v, MARK[kw]);
          if (isMark) s.due.push({ kw, at: s.n + i });
        }
        s.fed.push(v);
        s.prev = v;
      }
      s.n += x.length;
    },
    drain(s) {
      const out = [];
      s.due = s.due.filter((d) => {
        if (s.n - d.at < LAG) return true;
        out.push({ keyword: d.kw, timestamps: [(d.at - 4800) / SR, d.at / SR], tokens: [] });
        return false;
      });
      return out;
    },
  };
  return sp;
}

/** Build audio from segments: ['s', ms] speech, ['q', ms] quiet, ['k', 'HEY_JADE'] one marker sample inside speech. */
function audio(segs) {
  const parts = [];
  let n = 0;
  for (const [kind, v] of segs) {
    if (kind === 'k') {
      parts.push(Float32Array.of(MARK[v]));
      n += 1;
      continue;
    }
    const len = Math.round((v * SR) / 1000);
    const a = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = kind === 's' ? 0.3 : ((n + i) % 1000) / 1e6;
    parts.push(a);
    n += len;
  }
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Feed in 683-sample frames (like the renderer's resampled worklet blocks). */
function feed(rec, x, at0 = 0, frame = 683) {
  const hits = [];
  for (let p = 0; p < x.length; p += frame) hits.push(...rec.push(x.subarray(p, Math.min(x.length, p + frame)), at0 + p));
  return hits;
}

function make(o = {}) {
  const a = fakeSpotter(o.aHears);
  const b = fakeSpotter(o.bHears);
  const spotters = [{ name: 'zhen', spotter: a }, { name: 'giga', spotter: b }];
  if (o.name) spotters.push({ name: 'name', spotter: o.name });
  const vad = fakeVad();
  const rec = new OnsetRecipe({ spotters, vad, ...o.recipe });
  return { rec, a, b, vad };
}

describe('OnsetRecipe', () => {
  it('starts fresh streams only after ≥ 600 ms without speech, never after short pauses ("Hey, | Jade")', () => {
    const { rec, a, b } = make();
    feed(rec, audio([['q', 1000], ['s', 300], ['q', 300], ['s', 300], ['q', 400], ['s', 300], ['q', 650], ['s', 300], ['q', 1000]]));
    expect(rec.stats.onsets).toBe(4);
    expect(a.streams.length).toBe(2); // the 300/400 ms pauses kept the stream; the 650 ms one renewed it
    expect(b.streams.length).toBe(2);
    expect(rec.stats.fresh).toBe(2);
  });

  it('feeds a 400 ms pre-roll equal to the audio before the onset, then the speech', () => {
    const { rec, a } = make();
    const x = audio([['q', 1000], ['s', 300], ['q', 1000]]);
    feed(rec, x);
    const s = a.streams[0];
    const onset = 16000;
    // the onset block is the 20 ms block containing the first speech sample
    expect(Array.from(s.fed.slice(0, 6400))).toEqual(Array.from(x.subarray(onset - 6400, onset)));
    expect(s.fed[6400]).toBeCloseTo(0.3);
  });

  it('feeds nothing after the 700 ms hangover', () => {
    const { rec, a } = make();
    feed(rec, audio([['q', 1000], ['s', 500], ['q', 3000]]));
    const fed = a.streams[0].fed.length;
    const expected = 6400 + 8000 + 11200; // pre-roll + speech + 700 ms
    expect(fed).toBeGreaterThanOrEqual(expected);
    expect(fed).toBeLessThanOrEqual(expected + 2 * 320);
    expect(rec.active).toBe(false);
  });

  it('reports one hit per stream, then renews every stream without a pre-roll', () => {
    const { rec, a, b } = make();
    // both spotters hear the same marker: one hit, not two
    const hits = feed(rec, audio([['q', 1000], ['s', 600], ['k', 'HEY_JADE'], ['s', 1200], ['q', 2000]]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ keyword: 'HEY_JADE', model: 'zhen' });
    expect(a.streams.length).toBe(2);
    expect(b.streams.length).toBe(2);
    // the renewed streams start at the hit's block end (no pre-roll)
    expect(a.streams[1].fed[0]).toBeCloseTo(0.3);
    expect(rec.stats.hits).toBe(1);
  });

  it('a second call in the same breath is heard by the renewed streams', () => {
    const { rec } = make();
    const hits = feed(rec, audio([['q', 1000], ['s', 600], ['k', 'HEY_JADE'], ['s', 900], ['k', 'HEY_JADE'], ['s', 900], ['q', 2000]]));
    expect(hits.map((h) => h.keyword)).toEqual(['HEY_JADE', 'HEY_JADE']);
  });

  it('reports HEY_JUDE too (the renderer counts them), and HEY_JADE wins in the same block', () => {
    const { rec } = make({ aHears: ['HEY_JUDE'], bHears: ['HEY_JADE'] });
    const hits = feed(rec, audio([['q', 1000], ['s', 600], ['k', 'HEY_JUDE'], ['s', 1000], ['q', 1500]]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ keyword: 'HEY_JUDE', model: 'zhen' });
    const { rec: r2 } = make({ aHears: ['HEY_JUDE'], bHears: ['HEY_JUDE', 'HEY_JADE'] });
    // one marker that A reads as Jude and B as Jade, decided in the same block
    const x = audio([['q', 1000], ['s', 600], ['k', 'HEY_JUDE'], ['s', 1000], ['q', 1500]]);
    // make B hear it as HEY_JADE: give B a spotter that maps 0.65 to HEY_JADE
    const both = r2._spotters[1].spotter;
    both.accept = function (s, y) {
      for (let i = 0; i < y.length; i++) if (close(y[i], MARK.HEY_JUDE)) s.due.push({ kw: 'HEY_JADE', at: s.n + i });
      s.n += y.length;
    };
    const h2 = feed(r2, x);
    expect(h2).toHaveLength(1);
    expect(h2[0]).toMatchObject({ keyword: 'HEY_JADE', model: 'giga' });
  });

  it('counts JADE (the name stream) only when it starts within 720 ms of the stream start', () => {
    const name = fakeSpotter(['JADE']);
    const { rec } = make({ name });
    // stream start = onset − 400 ms; the fake's first token = marker − 300 ms
    // early: marker 500 ms after the onset → first token at 600 ms into the stream ✓
    const early = feed(rec, audio([['q', 1000], ['s', 500], ['k', 'JADE'], ['s', 800], ['q', 2000]]));
    expect(early.map((h) => h.keyword)).toEqual(['JADE']);
    expect(early[0].model).toBe('name');
    // late: marker 900 ms after the onset → first token at 1000 ms ✗ (and the name stream is spent)
    const late = feed(rec, audio([['s', 900], ['k', 'JADE'], ['s', 800], ['q', 2000]]), 16000 + 8000 + 1 + 12800 + 32000);
    expect(late).toEqual([]);
  });

  it('stops feeding the name stream once a call at the start can no longer complete', () => {
    const name = fakeSpotter(['JADE']);
    const { rec } = make({ name });
    feed(rec, audio([['q', 1000], ['s', 5000], ['q', 1000]]));
    // 720 ms + 2 s after the stream start, at most one block late
    expect(name.streams[0].n).toBeLessThanOrEqual(Math.round(2.72 * SR) + 320);
  });

  it('computes startAt / endAt from the stream start (pre-roll included)', () => {
    const { rec } = make();
    const x = audio([['q', 1000], ['s', 600], ['k', 'HEY_JADE'], ['s', 1000], ['q', 1000]]);
    const at0 = 5_000_000;
    const [h] = feed(rec, x, at0);
    const marker = at0 + 16000 + 9600;
    expect(h.streamAt).toBe(at0 + 16000 - 6400);
    expect(h.endAt).toBe(marker);
    expect(h.startAt).toBe(marker - 4800);
    expect(h.emitAt).toBeGreaterThanOrEqual(marker + LAG);
    expect(h.emitAt - (marker + LAG)).toBeLessThan(320);
  });

  it('a gap in the sample indices ends the stream and resets the VAD', () => {
    const { rec, a, vad } = make();
    const x = audio([['q', 1000], ['s', 1000]]);
    feed(rec, x);
    expect(rec.active).toBe(true);
    // the mic reopened: indices jump; the speech goes on, but in a new stream
    feed(rec, audio([['s', 500], ['q', 1500]]), x.length + 48000);
    expect(vad.resets).toBe(1);
    expect(rec.stats.gaps).toBe(1);
    expect(a.streams.length).toBe(2);
    // the ring was cleared: the new stream got no pre-roll from before the gap
    expect(a.streams[1].fed[0]).toBeCloseTo(0.3);
  });

  it('reset() drops the streams; the next onset starts fresh ones', () => {
    const { rec, a } = make();
    feed(rec, audio([['q', 1000], ['s', 500]]));
    rec.reset();
    expect(rec.active).toBe(false);
    feed(rec, audio([['s', 200], ['q', 200], ['s', 300], ['q', 1000]]), 16000 + 8000);
    // still speaking at the reset: no stream until the next rising edge (after the 200 ms pause)
    expect(a.streams.length).toBe(2);
  });

  it('setSpotters() takes effect at the next fresh stream, never mid-utterance', () => {
    const { rec, a } = make();
    const c = fakeSpotter();
    feed(rec, audio([['q', 1000], ['s', 300]]));
    rec.setSpotters([{ name: 'giga', spotter: c }]);
    feed(rec, audio([['s', 300], ['q', 1000]]), 16000 + 4800);
    expect(c.streams.length).toBe(0);
    expect(rec.spotterNames).toEqual(['giga']); // swapped when that stream ended
    feed(rec, audio([['s', 300], ['q', 1000]]), 16000 + 4800 + 4800 + 16000);
    expect(c.streams.length).toBe(1);
    expect(a.streams.length).toBe(1);
  });

  it('maxStreamMs renews the streams in continuous speech (8 s by default; 0 = off)', () => {
    // (changed on purpose: on by default now, with the old streams overlapping)
    const { rec, a } = make({ recipe: { maxStreamMs: 2000 } });
    feed(rec, audio([['q', 1000], ['s', 7000], ['q', 1000]]));
    expect(a.streams.length).toBeGreaterThanOrEqual(3);
    expect(rec.stats.renewals).toBeGreaterThanOrEqual(2);
    const { rec: def, a: a2 } = make();
    feed(def, audio([['q', 1000], ['s', 7000], ['q', 1000]]));
    expect(a2.streams.length).toBe(1); // 7 s: no renewal at 8 s
    feed(def, audio([['s', 20000], ['q', 1000]]), 16000 * 9);
    expect(def.stats.renewals).toBe(2);
    const { rec: off } = make({ recipe: { maxStreamMs: 0 } });
    feed(off, audio([['q', 1000], ['s', 20000], ['q', 1000]]));
    expect(off.stats.renewals).toBe(0);
  });

  /** fires only on a marker it saw at least `needSamples` into its own stream (a keyword needs its context) */
  function contextSpotter(needSamples) {
    const sp = fakeSpotter();
    const accept = sp.accept;
    sp.accept = (s, x) => {
      const before = s.due.length;
      accept(s, x);
      s.due = s.due.filter((d, i) => i < before || d.at >= needSamples);
    };
    return sp;
  }

  it('a call across a renewal is still heard: the old streams run on for overlapMs (no recall lost to renewing)', () => {
    const need = 16000; // a spotter that needs 1 s of the call in its stream
    const mk = (overlapMs) => {
      const a = contextSpotter(need);
      const rec = new OnsetRecipe({ spotters: [{ name: 'zhen', spotter: a }], vad: fakeVad(), maxStreamMs: 8000, overlapMs });
      return { rec, a };
    };
    // continuous speech from 1 s; the streams began at 0.6 s (the pre-roll), so they are renewed at
    // 8.6 s; the marker 0.2 s after that
    const x = audio([['q', 1000], ['s', 7800], ['k', 'HEY_JADE'], ['s', 2000], ['q', 1000]]);
    const withOverlap = mk(2000);
    const hits = feed(withOverlap.rec, x);
    expect(withOverlap.rec.stats.renewals).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0].streamAt).toBe(16000 - 6400); // from the old stream (it began at the onset, minus the pre-roll)
    // a plain renewal (no overlap) loses it: the new stream has not heard enough of the call
    const plain = mk(0);
    expect(feed(plain.rec, x)).toHaveLength(0);
    // the old streams stop after the overlap
    const fedOld = withOverlap.a.streams[0].fed.length;
    expect(fedOld).toBeLessThan(16000 * 11);
  });

  it('re-anchors a hit whose timestamps drifted (long streams): endAt = emitAt − 0.45 s, its length kept', () => {
    // a spotter whose stamps are 5 s early
    const drift = fakeSpotter();
    const drain = drift.drain;
    drift.drain = (s) => drain(s).map((h) => ({ ...h, timestamps: h.timestamps.map((t) => t - 5) }));
    const rec = new OnsetRecipe({ spotters: [{ name: 'zhen', spotter: drift }], vad: fakeVad(), maxStreamMs: 0 });
    const hits = feed(rec, audio([['q', 1000], ['s', 7000], ['k', 'HEY_JADE'], ['s', 1200], ['q', 2000]]));
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.reanchored).toBe(true);
    expect(h.emitAt - h.endAt).toBe(Math.round(0.45 * SR));
    expect(h.endAt - h.startAt).toBe(4800); // the keyword's own length (0.3 s)
    expect(rec.stats.reanchored).toBe(1);
    // a plausible stamp (200 ms before the decision) is left alone
    const { rec: ok } = make();
    const [g] = feed(ok, audio([['q', 1000], ['s', 600], ['k', 'HEY_JADE'], ['s', 1200], ['q', 2000]]));
    expect(g.reanchored).toBeUndefined();
    expect(g.emitAt - g.endAt).toBeLessThan(0.9 * SR);
  });

  it('applies the level normaliser to what the spotters see, observing the raw input', () => {
    const seen = [];
    const agc = {
      observe: (x, speaking) => seen.push(speaking),
      apply: (x) => x.map((v) => v * 2),
    };
    const a = fakeSpotter();
    const rec = new OnsetRecipe({ spotters: [{ name: 'giga', spotter: a }], vad: fakeVad(), agc, agcLookaheadMs: 0 });
    feed(rec, audio([['q', 500], ['s', 200], ['q', 1000]]));
    expect(seen.length).toBe(rec.stats.blocks);
    expect(seen.filter(Boolean).length).toBe(10);
    expect(a.streams[0].fed[6400]).toBeCloseTo(0.6);
  });

  /** A fake normaliser whose gain is set by the speech it has observed since beginUtterance(). */
  function lookaheadAgc() {
    const agc = {
      gain: 1,
      begins: 0,
      observed: 0,
      observe(x, speaking) {
        if (speaking) agc.observed += x.length;
        agc.gain = 1 + Math.min(agc.observed, 1600) / 16000; // grows with the first 100 ms of speech, then settles
      },
      beginUtterance() {
        agc.begins++;
        agc.observed = 0;
      },
      apply: (x) => x.map((v) => v * agc.gain),
    };
    return agc;
  }

  it('with a look-ahead, an utterance waits for its own level, then the spotters get it all at once', () => {
    const agc = lookaheadAgc();
    const a = fakeSpotter();
    const rec = new OnsetRecipe({ spotters: [{ name: 'giga', spotter: a }], vad: fakeVad(), agc, agcLookaheadMs: 100 });
    const x = audio([['q', 1000], ['s', 600], ['q', 1500]]);
    // up to 80 ms into the speech: the stream exists, nothing fed yet
    feed(rec, x.subarray(0, 16000 + 1280));
    expect(a.streams).toHaveLength(1);
    expect(agc.begins).toBe(1);
    expect(a.streams[0].n).toBe(0);
    // at 100 ms: the pre-roll and the held speech arrive together, all with the gain after 100 ms
    feed(rec, x.subarray(16000 + 1280, 16000 + 1600), 16000 + 1280);
    const s = a.streams[0];
    expect(s.n).toBe(6400 + 1600);
    expect(s.fed[6400]).toBeCloseTo(0.3 * (1 + 1600 / 16000), 5); // the first speech sample got the later gain
    // later blocks follow block by block
    feed(rec, x.subarray(16000 + 1600, 16000 + 1920), 16000 + 1600);
    expect(s.n).toBe(6400 + 1920);
    feed(rec, x.subarray(16000 + 1920), 16000 + 1920);
    expect(s.n).toBeGreaterThan(6400 + 9600);
  });

  it('an utterance shorter than the look-ahead is still decoded before its stream ends', () => {
    const agc = lookaheadAgc();
    const a = fakeSpotter(undefined, { gained: true });
    const rec = new OnsetRecipe({ spotters: [{ name: 'giga', spotter: a }], vad: fakeVad(), agc, agcLookaheadMs: 500 });
    const hits = feed(rec, audio([['q', 1000], ['s', 200], ['k', 'HEY_JADE'], ['s', 100], ['q', 2000]]));
    expect(a.streams[0].n).toBeGreaterThan(6400 + 4800);
    expect(hits.map((h) => h.keyword)).toEqual(['HEY_JADE']);
  });

  it('renewed streams after a hit are not held (the level is already known)', () => {
    const agc = lookaheadAgc();
    const a = fakeSpotter(undefined, { gained: true });
    const rec = new OnsetRecipe({ spotters: [{ name: 'giga', spotter: a }], vad: fakeVad(), agc, agcLookaheadMs: 100 });
    feed(rec, audio([['q', 1000], ['s', 600], ['k', 'HEY_JADE'], ['s', 1200], ['q', 1500]]));
    expect(a.streams).toHaveLength(2);
    expect(agc.begins).toBe(1);
    expect(a.streams[1].fed[0]).toBeGreaterThan(0.3); // fed at once, gained
  });
});
