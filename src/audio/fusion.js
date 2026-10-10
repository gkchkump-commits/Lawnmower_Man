// Fusion of the voice server's viseme timeline with the clip's own acoustics (acoustics.js):
// the visemes give the categories (which shape: closed, tucked, spread, rounded, open), the sound
// gives the exact timing and the amounts.
//
//   timing   the timeline is warped (monotonic, piecewise linear) onto acoustic landmarks: a
//            phrase starts where its sound starts (Kokoro's first phone often begins 50-200 ms
//            before the audio), an m / b / p between vowels spans its acoustic closure (the level
//            dip between the half-level crossings: the lips seal when the dip starts and part at
//            the release), an f / v spans its low-band dip, and an m / b / p after a consonant
//            ("and Pam", "it back") ends at its release (the steepest rise of the 0.8-5 kHz band:
//            the burst, or the end of the murmur). Kokoro's durations come on a 25 ms grid and
//            drift, so the boundaries between landmarks move with them.
//   amounts  each vowel's jaw follows its first formant (F1 rises as the jaw opens: open vowels
//            ~2-3 times the opening of close ones), normalised for the speaker; spread follows F2;
//            loud, long (stressed) vowels open more, quiet short ones (reduced vowels) less and stay
//            neutral rather than spread.
// Pure; the result feeds articulation.js (segmentsFromVisemes) like any timeline.

import { trackFrame } from './acoustics.js';

/** @typedef {{ start: number, end: number, viseme: string }} VisemeSegment */
/** @typedef {import('./acoustics.js').AcousticTrack} AcousticTrack */
/** @typedef {{ f1lo: number, f1hi: number, f2lo: number, f2hi: number }} FormantNorms */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U']);
/** Sounds that keep the voice loud on both sides of a closure: vowels, r (and glides, w y = U I). */
const VOCALIC = new Set(['aa', 'E', 'I', 'O', 'U', 'RR']);

/** The jaw a vowel category allows (before stress): close U / I, mid O / E (ɛ e ə ɜ), open aa. */
export const JAW_RANGE = Object.freeze({ U: [0.04, 0.3], I: [0.04, 0.36], O: [0.2, 0.75], E: [0.12, 0.62], aa: [0.3, 0.95] });

/** Weight of the pin at a phrase's end (a pause's start): below every acoustic landmark. */
export const PHRASE_END_PIN = 0.5;
/** How far (s) a landmark may move a timeline boundary, and how far around it a landmark is looked for. */
export const MAX_SHIFT = 0.09;
/** A phrase's first sound starts this long before its acoustic onset (the gesture lands on the sound). */
export const ONSET_PRE = 0.01;

/**
 * Typical formant ranges of a speaker before any of their vowels were heard, from the voice's
 * pitch (a higher voice: a shorter vocal tract, higher formants). Measured on Kokoro voices
 * (af_heart / bf_emma vs am_michael: close vowels' F1 ~370 / 300 Hz, open ~800 / 640 Hz).
 * @param {number} f0 Hz (0: unknown) @returns {FormantNorms}
 */
export function priorNorms(f0) {
  const k = clamp((f0 - 120) / 80, 0, 1);       // 120 Hz -> male, 200 Hz -> female
  return { f1lo: 290 + 70 * k, f1hi: 700 + 170 * k, f2lo: 1000 + 150 * k, f2hi: 2050 + 350 * k };
}

/**
 * A speaker's formant ranges, learned from the vowels heard (the p12 / p88 of their vowels' F1 and
 * F2), blended with the prior until enough vowels are in.
 */
export class SpeakerFormants {
  constructor(max = 400) {
    this.max = max;
    /** @type {number[]} */ this.f1 = [];
    /** @type {number[]} */ this.f2 = [];
  }

  /** @param {Array<{ f1: number, f2: number }>} vowels */
  add(vowels) {
    for (const v of vowels) {
      if (v.f1 > 0) this.f1.push(v.f1);
      if (v.f2 > 0) this.f2.push(v.f2);
    }
    if (this.f1.length > this.max) this.f1.splice(0, this.f1.length - this.max);
    if (this.f2.length > this.max) this.f2.splice(0, this.f2.length - this.max);
  }

  /** @param {number} f0 the speaker's usual pitch (Hz, 0: unknown) @param {Array<{ f1: number, f2: number }>} [extra] the clip's own vowels */
  norms(f0, extra = []) {
    const pr = priorNorms(f0);
    const f1 = [...this.f1, ...extra.map((v) => v.f1).filter((x) => x > 0)].sort((a, b) => a - b);
    const f2 = [...this.f2, ...extra.map((v) => v.f2).filter((x) => x > 0)].sort((a, b) => a - b);
    const q = (v, p) => v[clamp(Math.round(p * (v.length - 1)), 0, v.length - 1)];
    const w1 = f1.length / (f1.length + 16), w2 = f2.length / (f2.length + 16);
    const mix = (a, b, w) => a + (b - a) * w;
    const n = {
      f1lo: f1.length ? mix(pr.f1lo, q(f1, 0.12), w1) : pr.f1lo,
      f1hi: f1.length ? mix(pr.f1hi, q(f1, 0.88), w1) : pr.f1hi,
      f2lo: f2.length ? mix(pr.f2lo, q(f2, 0.12), w2) : pr.f2lo,
      f2hi: f2.length ? mix(pr.f2hi, q(f2, 0.88), w2) : pr.f2hi,
    };
    // never a degenerate range (a clip of one vowel)
    n.f1hi = Math.max(n.f1hi, n.f1lo + 220);
    n.f2hi = Math.max(n.f2hi, n.f2lo + 500);
    return n;
  }
}

/**
 * The acoustic closure of a segment: the level dip of `arr` (dB) inside [t0 - pad, t1 + pad] — a
 * true local minimum there, not the slope of a dip that lies outside (a neighbouring stop's
 * closure in a cluster: the d of "should move") — at least `minDepth` dB below the highest level
 * on both sides (within 120 ms), between its half-level crossings, and overlapping the segment.
 * null when there is none, or the track does not reach that far yet.
 * @param {AcousticTrack} ac @param {Float32Array} arr @param {number} t0 @param {number} t1
 * @param {{ pad?: number, minDepth?: number }} [o]
 * @returns {{ t0: number, t1: number, tMin: number, depth: number }|null}
 */
export function findDip(ac, arr, t0, t1, o = {}) {
  const pad = o.pad ?? 0.05, minDepth = o.minDepth ?? 6;
  const h = ac.hop;
  const a = trackFrame(ac, t0 - pad), b = trackFrame(ac, t1 + pad);
  const flank = Math.round(0.12 / h);
  const done = ac.done ?? ac.n;
  if (b + flank >= done && done < ac.n) return null;
  let k = -1, m = Infinity;
  for (let i = a; i <= b; i++) if (arr[i] < m) { m = arr[i]; k = i; }
  if (k <= a || k >= b) return null;           // on a slope: the dip is someone else's
  let left = -Infinity, right = -Infinity;
  for (let i = Math.max(0, k - flank); i < k; i++) if (arr[i] > left) left = arr[i];
  for (let i = k + 1; i <= Math.min(ac.n - 1, k + flank); i++) if (arr[i] > right) right = arr[i];
  const fl = Math.min(left, right);
  const depth = fl - m;
  if (!(depth >= minDepth) || fl < -60) return null;
  const half = m + 0.5 * depth;
  let i0 = k, i1 = k;
  while (i0 > 0 && arr[i0 - 1] < half) i0--;
  while (i1 + 1 < ac.n && arr[i1 + 1] < half) i1++;
  const d0 = i0 * h, d1 = (i1 + 1) * h;
  // it must overlap the segment (a dip beside it belongs to a neighbour)
  if (Math.min(d1, t1) - Math.max(d0, t0) < 0.3 * Math.min(d1 - d0, t1 - t0)) return null;
  return { t0: d0, t1: d1, tMin: k * h, depth };
}

/** A closure's 0.8-5 kHz minimum must lie this much (dB) under the sound after it (its release). */
export const RELEASE_RISE = 10;

/**
 * A closure segment [t0, t1] (m / b / p) in the 0.8-5 kHz band: its minimum (within 30 ms of the
 * segment), where the band falls into it fastest (the lips meet: the vowel's upper formants go)
 * and where it rises out of it fastest (they part: the burst of a b / p — the broadband level
 * lags it at a p, whose burst and aspiration are quiet — or the end of an m's murmur, whose low
 * band keeps the level up). The minimum must lie `minRight` dB under the sound after it and
 * `minLeft` dB under the sound before it (within 120 ms); the fall / rise are looked for up to
 * 90 ms before / after the segment, sub-frame (a parabola through the slope's peak). null when
 * there is none, the track has no 0.8-5 kHz band or does not reach that far yet; `off` NaN when
 * nothing rises after it (a closure before a pause), `on` NaN when nothing falls into it.
 * `from` / `to` bound the fall / rise further (the vowels beside the closure must keep part of
 * their length: in "probably" the schwa between the two b's is so short that the band only
 * comes back after the second one).
 * @param {AcousticTrack} ac @param {number} t0 @param {number} t1 @param {number} [minLeft]
 * @param {number} [minRight] @param {number} [from] @param {number} [to]
 * @returns {{ on: number, off: number, tMin: number }|null} times (s)
 */
export function bandClosure(ac, t0, t1, minLeft = RELEASE_RISE, minRight = RELEASE_RISE, from = -Infinity, to = Infinity) {
  const arr = ac.mid;
  if (!arr) return null;
  const h = ac.hop, n = ac.n;
  const a = trackFrame(ac, t0 - 0.03), b = trackFrame(ac, t1 + 0.03);
  const end = trackFrame(ac, Math.min(t1 + 0.09, to)), begin = trackFrame(ac, Math.max(t0 - 0.09, from));
  const flank = Math.round(0.12 / h);
  const done = ac.done ?? n;
  if (end + flank >= done && done < n) return null;
  let k = -1, m = Infinity;
  for (let i = a; i <= b; i++) if (arr[i] < m) { m = arr[i]; k = i; }
  if (k < 2 || k >= n - 2) return null;
  let left = -Infinity, right = -Infinity;
  for (let i = Math.max(0, k - flank); i < k; i++) if (arr[i] > left) left = arr[i];
  for (let i = k + 1; i <= Math.min(n - 1, k + flank); i++) if (arr[i] > right) right = arr[i];
  if (!(right - m >= minRight) || !(left - m >= minLeft) || Math.max(left, right) < -60) return null;
  const slope = (i) => arr[i + 1] - arr[i - 1];
  // the steepest slope of sign `sg` over frames [i0, i1], refined to a fraction of a frame
  const steepest = (i0, i1, sg) => {
    let best = 0, r = -1;
    for (let i = Math.max(1, i0); i <= Math.min(i1, n - 2); i++) {
      const d = sg * slope(i);
      if (d > best) { best = d; r = i; }
    }
    if (r < 0) return NaN;
    let off = 0;
    if (r > 1 && r < n - 2) {
      const y0 = sg * slope(r - 1), y2 = sg * slope(r + 1);
      const den = y0 - 2 * best + y2;
      if (den < 0) off = clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5);
    }
    return (r + off) * h;
  };
  const on = steepest(begin, k, -1);
  let off = steepest(k, end, 1);
  // (a gradual release — an m into a back rounded vowel, "the morning" — rises for 40-60 ms and
  // its steepest point is late in it: the lips have parted by the time it is half way up)
  if (Number.isFinite(off)) {
    let peak = -Infinity;
    for (let i = k; i <= Math.min(end, n - 1); i++) if (arr[i] > peak) peak = arr[i];
    const half = m + 0.5 * (peak - m);
    for (let i = k + 1; i <= Math.min(end, n - 1); i++) {
      if (arr[i] >= half) {
        const t = (i - 1 + (half - arr[i - 1]) / Math.max(1e-6, arr[i] - arr[i - 1])) * h;
        if (t < off) off = t;
        break;
      }
    }
  }
  if (!Number.isFinite(on) && !Number.isFinite(off)) return null;
  return { on, off, tMin: k * h };
}

/**
 * Where a phrase's sound starts: the first frame from `from` on that is within 22 dB of the
 * phrase's loudest frame in the next 0.4 s and stays there for 10 ms. NaN when not found.
 * @param {AcousticTrack} ac @param {number} from @param {number} [to]
 */
export function acousticOnset(ac, from, to = from + 0.4) {
  const a = trackFrame(ac, Math.max(0, from)), b = trackFrame(ac, to);
  if (b >= (ac.done ?? ac.n) && (ac.done ?? ac.n) < ac.n) return NaN;
  let ref = -Infinity;
  for (let i = a; i <= b; i++) if (ac.e[i] > ref) ref = ac.e[i];
  if (!(ref > -60)) return NaN;
  for (let i = a; i + 1 <= b; i++) if (ac.e[i] > ref - 22 && ac.e[i + 1] > ref - 22) return i * ac.hop;
  return NaN;
}

/** Visemes whose sound is a hiss (frication) rather than the voice. */
const FRICATIVES = new Set(['FF', 'SS', 'TH', 'CH']);

/**
 * Where any sound starts in [from, to]: the first frame within 40 dB of the loudest in the next
 * 0.4 s (and above -62 dBFS) that stays there for 10 ms (a fricative's hiss before the voice).
 * NaN when there is none before `to`. @param {AcousticTrack} ac @param {number} from @param {number} to
 */
export function soundStart(ac, from, to) {
  const a = trackFrame(ac, Math.max(0, from)), b = trackFrame(ac, to);
  let ref = -Infinity;
  for (let i = a; i <= trackFrame(ac, from + 0.4); i++) if (ac.e[i] > ref) ref = ac.e[i];
  const thr = Math.max(ref - 40, -62);
  for (let i = a; i + 2 <= b; i++) if (ac.e[i] > thr && ac.e[i + 1] > thr && ac.e[i + 2] > thr) return i * ac.hop;
  return NaN;
}

/**
 * Landmarks of a timeline in its clip's audio, as anchors [timeline time, audio time]: phrase
 * onsets, the closure of each m / b / p and the low-band dip of each f / v between vowels, and the
 * release of an m / b / p after a consonant.
 * @param {VisemeSegment[]} tl @param {AcousticTrack} ac
 * @returns {{ anchors: Array<[number, number]>, exact: Set<number>, exactStart: Set<number>, exactEnd: Set<number> }}
 *   anchors sorted, strictly increasing in both; exactStart / exactEnd: the closures / tucks whose
 *   start / end became an anchor (the lips close / part right there); exact: both
 */
export function landmarks(tl, ac) {
  /** @type {Array<[number, number, number, number?, number?]>} [old, new, weight, closure segment, edge 0 start 1 end] */
  const raw = [];
  for (let i = 0; i < tl.length; i++) {
    const s = tl[i];
    if (s.viseme === 'sil') {
      // a pause pins the end of the phrase before it (weakly): the next phrase's onset moves its
      // own start, and the pause absorbs it, instead of dragging the whole phrase before it along
      if (i > 0 && tl[i - 1].viseme !== 'sil' && s.end - s.start >= 0.1) raw.push([s.start, s.start, PHRASE_END_PIN]);
      continue;
    }
    const prev = tl[i - 1];
    // (the clip's own leading rest counts however short it is: Kokoro often gives it 20-60 ms)
    const phraseStart = !prev || (prev.viseme === 'sil' && (i === 1 || prev.end - prev.start >= 0.1));
    const next = tl[i + 1];
    if (phraseStart) {
      const on = acousticOnset(ac, s.start - 0.08, s.start + 0.35);
      if (Number.isFinite(on)) {
        if (s.viseme === 'PP') {
          // a b / p releases into the sound (a p with its burst, out of the silence); an m hums
          // first (low band strong), then releases into the vowel: where the vowel's upper formants come in (the 0.8-5 kHz band's share of the
          // level rises fastest; the murmur itself can be nearly as loud as the vowel), else (no
          // such band) where the level rises within 8 dB of the vowel's
          let rel = on;
          const i0 = trackFrame(ac, on);
          // (a p's burst comes out of the silence well before the voice: its aspiration is too quiet
          // to count as the phrase's sound, and the voiced l / r after it can look like a hum)
          let burst = NaN;
          for (let j = Math.max(2, trackFrame(ac, on - 0.12)); j <= trackFrame(ac, on - 0.02); j++) {
            if (ac.e[j] - ac.e[j - 2] >= 15 && ac.e[j] > -60) { burst = (j - 1) * ac.hop; break; }
          }
          // (a hum: the voice comes in with little of the vowels' upper formants — 25 dB or more
          // under the level for 30 ms; any voiced sound has a strong low band)
          let hum = ac.lo[i0] > ac.e[i0] - 6;
          if (ac.mid) {
            let acc = 0, n = 0;
            for (let j = trackFrame(ac, on + 0.01); j <= trackFrame(ac, on + 0.04); j++) { acc += ac.mid[j] - ac.e[j]; n++; }
            hum = n > 0 && acc / n < -25;
          }
          if (Number.isFinite(burst)) rel = burst;
          else if (hum) {
            const i1 = trackFrame(ac, on + 0.3);
            if (ac.mid) {
              let best = 0;
              const tilt = (j) => ac.mid[j] - ac.e[j];
              // (within reach of the timeline's own release: not the next closure's)
              const j1 = Math.min(i1, trackFrame(ac, s.end + MAX_SHIFT), ac.n - 2);
              for (let j = Math.max(1, trackFrame(ac, on + 0.02)); j <= j1; j++) {
                const d = tilt(j + 1) - tilt(j - 1);
                if (d > best) { best = d; rel = j * ac.hop; }
              }
            } else {
              let ref = -Infinity;
              for (let j = i0; j <= i1; j++) if (ac.e[j] > ref) ref = ac.e[j];
              for (let j = i0; j <= i1; j++) if (ac.e[j] > ref - 8) { rel = j * ac.hop; break; }
            }
          }
          raw.push([s.end, rel, 2, i, 1]);
          raw.push([s.start, Math.min(rel - 0.06, on - 0.02), 1]);
        } else if (FRICATIVES.has(s.viseme)) {
          // a fricative's hiss starts well before the voice ("Five", "So"), too quiet to count as
          // the phrase's sound: it starts where any sound does, and an f / v tuck releases where
          // the voice comes in
          const hiss = soundStart(ac, s.start - 0.1, on);
          raw.push([s.start, (Number.isFinite(hiss) ? hiss : on) - ONSET_PRE, 2]);
          if (s.viseme === 'FF' && Number.isFinite(hiss) && on - hiss >= 0.03 && Math.abs(on - s.end) <= MAX_SHIFT) raw.push([s.end, on, 1.5, i, 1]);
        } else {
          raw.push([s.start, on - ONSET_PRE, 2]);
        }
      }
      continue;
    }
    const vPrev = !!prev && VOCALIC.has(prev.viseme), vNext = !!next && VOCALIC.has(next.viseme);
    if (s.viseme === 'PP' && (vPrev || vNext)) {
      // m / b / p: where the vowels' upper formants go and come back (0.8-5 kHz band, steepest
      // fall / rise). Between vowels both edges; after a consonant ("and Pam", "it back") only the
      // release — the silence is shared with that consonant and says nothing about where this
      // closure starts; before one ("stopped", "bumpy") only the closing.
      // (a closure must clearly rise into the vowel after it, 6 dB between vowels — an m before a
      // rounded vowel, "should move", brings back little of the band — 10 after a consonant; one
      // before a consonant must clearly fall)
      const c = bandClosure(ac, s.start, s.end, vNext ? 6 : RELEASE_RISE, !vNext ? 0 : vPrev ? 6 : RELEASE_RISE,
        prev.start + 0.4 * (prev.end - prev.start), next ? next.end - 0.4 * (next.end - next.start) : Infinity);
      const span = c ? c.off - c.on : NaN;
      if (vPrev && vNext) {
        if (span >= 0.025 && span <= 0.25) {
          raw.push([s.start, c.on, 1.5, i, 0]);
          raw.push([s.end, c.off, 1.5, i, 1]);
        } else {
          // no band landmarks (a quiet or a noisy closure): the level's own dip
          const d = findDip(ac, ac.e, s.start, s.end);
          if (d && d.t1 - d.t0 >= 0.025 && d.t1 - d.t0 <= 0.25) {
            raw.push([s.start, d.t0, 1.5, i, 0]);
            raw.push([s.end, d.t1, 1.5, i, 1]);
          }
        }
      } else if (vNext) {
        if (c && Number.isFinite(c.off) && Math.abs(c.off - s.end) <= MAX_SHIFT) {
          raw.push([s.end, c.off, 1.5, i, 1]);
          // (a closure lasts 50 ms at least: if the timeline starts it later, it starts then)
          if (s.start > c.off - 0.05) raw.push([s.start, c.off - 0.06, 0.8]);
        }
      } else if (c && Number.isFinite(c.on) && Math.abs(c.on - s.start) <= MAX_SHIFT && c.on < s.end) {
        // before a consonant or a pause ("stopped", "Bob,"): only the closing
        raw.push([s.start, c.on, 1.5, i, 0]);
      }
    } else if (s.viseme === 'FF' && vPrev && vNext) {
      // f / v between vowels: the low band's dip (the voicing / the vowel goes, the frication is high)
      const d = findDip(ac, ac.lo, s.start, s.end);
      if (d && d.t1 - d.t0 >= 0.025 && d.t1 - d.t0 <= 0.25) {
        raw.push([s.start, d.t0, 1.5, i, 0]);
        raw.push([s.end, d.t1, 1.5, i, 1]);
      }
    }
  }
  const anchors = monotone(raw);
  const kept = new Set(anchors.map((a) => a[0]));
  const exactStart = new Set(), exactEnd = new Set();
  for (const r of raw) {
    if (r[3] === undefined) continue;
    const seg = tl[r[3]];
    if (r[4] === 0 && kept.has(seg.start)) exactStart.add(r[3]);
    if (r[4] === 1 && kept.has(seg.end)) exactEnd.add(r[3]);
  }
  const exact = new Set([...exactStart].filter((k) => exactEnd.has(k)));
  return { anchors, exact, exactStart, exactEnd };
}

/**
 * Anchors that keep the warp monotonic: sorted by timeline time; an anchor that would make audio
 * time go backwards (or squeeze a span below 40 % / stretch it beyond 250 %) is dropped, the
 * lighter of two conflicting ones first. The span between the two edges of one closure may
 * stretch or shrink further (20 %-600 %): Kokoro gives an m 25 ms whose acoustic closure lasts 70.
 * @param {Array<[number, number, number, number?, number?]>} raw @returns {Array<[number, number]>}
 */
export function monotone(raw) {
  const byWeight = raw.map((r, i) => ({ r, i })).sort((x, y) => y.r[2] - x.r[2] || x.i - y.i);
  /** @type {Array<[number, number, number|undefined]>} */
  let kept = [];
  for (const { r } of byWeight) {
    if (Math.abs(r[1] - r[0]) > MAX_SHIFT + 0.1) continue;
    const cand = [...kept, /** @type {[number, number, number|undefined]} */ ([r[0], r[1], r[3]])].sort((x, y) => x[0] - y[0]);
    let ok = true;
    for (let k = 1; k < cand.length && ok; k++) {
      const dOld = cand[k][0] - cand[k - 1][0], dNew = cand[k][1] - cand[k - 1][1];
      if (dOld < 1e-6) { ok = false; break; }
      const slope = dNew / dOld;
      const own = cand[k][2] !== undefined && cand[k][2] === cand[k - 1][2];
      if (!(own ? slope >= 0.2 && slope <= 6 : slope >= 0.4 && slope <= 2.5) && dOld > 0.02) ok = false;
      if (dNew < 0.005) ok = false;
    }
    if (ok) kept = cand;
  }
  return kept.map((a) => /** @type {[number, number]} */ ([a[0], a[1]]));
}

/**
 * Warp time t through the anchors (piecewise linear; before the first / after the last anchor
 * shifted by its offset, which fades out over 0.4 s away from it).
 * @param {Array<[number, number]>} anchors @param {number} t
 */
export function warpTime(anchors, t) {
  const n = anchors.length;
  if (!n) return t;
  if (t <= anchors[0][0]) return t + (anchors[0][1] - anchors[0][0]) * Math.max(0, 1 - (anchors[0][0] - t) / 0.4);
  if (t >= anchors[n - 1][0]) return t + (anchors[n - 1][1] - anchors[n - 1][0]) * Math.max(0, 1 - (t - anchors[n - 1][0]) / 0.4);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid][0] <= t) lo = mid; else hi = mid;
  }
  const [a0, b0] = anchors[lo], [a1, b1] = anchors[hi];
  return b0 + ((t - a0) * (b1 - b0)) / (a1 - a0);
}

/**
 * The timeline warped onto the audio's landmarks (a new array; contiguous like the input, every
 * segment at least 10 ms). A closure / tuck whose start / end is an acoustic landmark is marked
 * `exactStart` / `exactEnd` (the lips close / part right there), `exact` when both are.
 * @param {VisemeSegment[]} tl @param {AcousticTrack} ac
 * @returns {{ tl: Array<VisemeSegment & { exact?: boolean, exactStart?: boolean, exactEnd?: boolean }>, anchors: Array<[number, number]> }}
 */
export function alignTimeline(tl, ac) {
  const { anchors, exact, exactStart, exactEnd } = landmarks(tl, ac);
  if (!anchors.length) return { tl: tl.map((s) => ({ ...s })), anchors };
  const out = [];
  let prevEnd = -Infinity;
  tl.forEach((s, i) => {
    let a = Math.max(0, warpTime(anchors, s.start));
    let b = warpTime(anchors, s.end);
    if (Number.isFinite(prevEnd)) a = prevEnd;
    if (b < a + 0.01) b = a + 0.01;
    const o = { ...s, start: a, end: b };
    if (exactStart.has(i)) o.exactStart = true;
    if (exactEnd.has(i)) o.exactEnd = true;
    if (exact.has(i)) o.exact = true;
    out.push(o);
    prevEnd = b;
  });
  return { tl: out, anchors };
}

/**
 * Acoustic description of a vowel segment: its median F1 / F2 over the middle 60 % (voiced frames
 * with formants), the fraction of frames that had them, and its peak loudness (dBFS).
 * @param {AcousticTrack} ac @param {VisemeSegment} s
 */
export function vowelAcoustics(ac, s) {
  const d = s.end - s.start;
  const a = trackFrame(ac, s.start + 0.2 * d), b = Math.max(a, trackFrame(ac, s.end - 0.2 * d));
  const f1 = [], f2 = [];
  let peak = -Infinity;
  for (let i = trackFrame(ac, s.start); i <= trackFrame(ac, s.end); i++) if (ac.e[i] > peak) peak = ac.e[i];
  for (let i = a; i <= b; i++) {
    if (!(ac.voiced[i] > 0.3) || !(ac.f1[i] > 0)) continue;
    f1.push(ac.f1[i]);
    if (ac.f2[i] > 0) f2.push(ac.f2[i]);
  }
  const med = (v) => (v.length ? v.sort((x, y) => x - y)[v.length >> 1] : 0);
  return { f1: med(f1), f2: med(f2), q: f1.length / (b - a + 1), e: peak, dur: d };
}

/**
 * The amounts of one vowel from its acoustics: jaw opening from F1 (speaker-normalised), spread
 * from F2, both scaled by the vowel's prominence (loudness against the clip's typical vowel, length
 * against its median). Returns targets for articulation.js (null: nothing measured, keep the
 * viseme's own).
 * @param {string} viseme @param {{ f1: number, f2: number, q: number, e: number, dur: number }} va
 * @param {FormantNorms} n @param {{ e: number, dur: number }} clipNorm median vowel peak (dBFS) and length (s)
 * @param {number[]} T the viseme's target (CHANNELS order)
 * @returns {{ jaw: number, wide: number, round: number, teeth: number, stress: number }|null}
 */
export function vowelAmounts(viseme, va, n, clipNorm, T) {
  const eRel = va.e - clipNorm.e;
  const durRel = va.dur / Math.max(0.03, clipNorm.dur);
  // prominence: a stressed syllable is louder and longer; a reduced one quieter and shorter
  const stress = clamp(0.92 + 0.03 * eRel + 0.14 * (durRel - 1), 0.62, 1.18);
  let q = va.f1 > 0 ? clamp((va.q - 0.2) / 0.4, 0, 1) : 0;
  // F1 -> openness: close vowels ~0.07, open ones ~0.9 of the jaw's range
  const x = va.f1 > 0 ? clamp((va.f1 - n.f1lo) / (n.f1hi - n.f1lo), -0.1, 1.15) : NaN;
  // (an open vowel whose "F1" reads as low as the speaker's closest ones is a nasal pole the
  // tracker took for it — the æ of "Pam" before its m — not a closed jaw: it gets no say)
  if (viseme === 'aa' && Number.isFinite(x)) q *= clamp((x - 0.05) / 0.2, 0, 1);
  // (the category bounds what the sound may say: a U is a close vowel whatever the tracker claims
  // — the weak F1 of a back rounded vowel lets F2 pass for it — and an open vowel is open)
  const [jlo, jhi] = JAW_RANGE[viseme] || [0.03, 0.95];
  const jawAc = Number.isFinite(x) ? clamp(0.07 + 0.86 * Math.max(0, x), jlo, jhi) : T[0];
  const jaw = clamp((T[0] + (jawAc - T[0]) * 0.9 * q) * stress, 0.03, 0.95);
  let wide = T[1], teeth = T[5], round = T[2];
  if (viseme === 'E' || viseme === 'I') {
    // front vowels spread with F2; a reduced (schwa-like) one is neutral, not spread
    const y = va.f2 > 0 ? clamp((va.f2 - 0.5 * (n.f2lo + n.f2hi)) / (0.5 * (n.f2hi - n.f2lo)), -1, 1) : 0;
    wide = T[1] * clamp(0.8 + 0.35 * y * q, 0.45, 1.15);
    const reduced = clamp((0.9 - stress) / 0.25, 0, 1);
    wide *= 1 - 0.45 * reduced;
    teeth *= 1 - 0.4 * reduced;
  }
  // rounded vowels: a stressed "oo" / "o" is fully rounded, a reduced one less (not a pucker)
  if (viseme === 'O' || viseme === 'U') round = clamp(T[2] * clamp(0.9 + 0.3 * (stress - 0.9), 0.75, 1), 0, 1);
  teeth = clamp(teeth * (0.6 + 0.4 * Math.min(1.1, stress)), 0, 1);
  return { jaw, wide, round, teeth, stress };
}

/**
 * Everything the lip-sync needs from a clip's acoustics: the aligned timeline and, per segment of
 * it, the vowel amounts (null for consonants and rests).
 * @param {VisemeSegment[]} tl the (phrase-end trimmed) timeline @param {AcousticTrack} ac
 * @param {SpeakerFormants|null} speaker @param {number} f0 the speaker's usual pitch (Hz, 0 unknown)
 * @param {(viseme: string) => number[]} targetOf the viseme's own target (articulation.js)
 * @returns {{ tl: VisemeSegment[], amounts: Array<ReturnType<typeof vowelAmounts>>, vowels: Array<{ f1: number, f2: number }>, anchors: Array<[number, number]> }}
 */
export function fuseTimeline(tl, ac, speaker, f0, targetOf) {
  const done = (ac.done ?? ac.n) * ac.hop;
  const { tl: al, anchors } = alignTimeline(tl, ac);
  const vas = al.map((s) => (VOWELS.has(s.viseme) && s.end <= done ? vowelAcoustics(ac, s) : null));
  const measured = vas.filter((v) => v && v.f1 > 0);
  const norms = speaker ? speaker.norms(f0, measured) : new SpeakerFormants().norms(f0, measured);
  const es = vas.filter(Boolean).map((v) => v.e).sort((a, b) => a - b);
  const ds = vas.filter(Boolean).map((v) => v.dur).sort((a, b) => a - b);
  const clipNorm = { e: es.length ? es[es.length >> 1] : -24, dur: ds.length ? ds[ds.length >> 1] : 0.09 };
  const amounts = al.map((s, i) => (vas[i] ? vowelAmounts(s.viseme, vas[i], norms, clipNorm, targetOf(s.viseme)) : null));
  return { tl: al, amounts, vowels: measured.map((v) => ({ f1: v.f1, f2: v.f2 })), anchors };
}

let _warm = false;
/**
 * Run the fusion once on a small synthetic clip so the JavaScript engine has compiled it before
 * the first real clip (cold, the first rebuild costs several milliseconds). Idempotent.
 * @param {(viseme: string) => number[]} targetOf @returns {boolean} true when it ran now
 */
export function warmUpFusion(targetOf) {
  if (_warm) return false;
  _warm = true;
  const n = 120, hop = 0.005;
  const mk = () => new Float32Array(n);
  const ac = { hop, n, done: n, duration: n * hop, e: mk(), lo: mk(), hi: mk(), f1: mk(), f2: mk(), f3: mk(), voiced: mk() };
  for (let i = 0; i < n; i++) {
    const t = i * hop, on = t > 0.1 && t < 0.5 && !(t > 0.3 && t < 0.34);
    ac.e[i] = on ? -22 : -70; ac.lo[i] = ac.e[i] - 3; ac.hi[i] = -80;
    ac.f1[i] = on ? 700 : 0; ac.f2[i] = on ? 1500 : 0; ac.voiced[i] = on ? 0.9 : 0;
  }
  const tl = [{ start: 0, end: 0.08, viseme: 'sil' }, { start: 0.08, end: 0.3, viseme: 'aa' }, { start: 0.3, end: 0.34, viseme: 'PP' },
    { start: 0.34, end: 0.5, viseme: 'E' }, { start: 0.5, end: 0.6, viseme: 'sil' }];
  fuseTimeline(tl, ac, null, 150, targetOf);
  return true;
}
