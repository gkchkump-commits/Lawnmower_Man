// Fusion of the voice server's viseme timeline with the clip's own acoustics (acoustics.js):
// the visemes give the categories (which shape: closed, tucked, spread, rounded, open), the sound
// gives the exact timing and the amounts.
//
//   timing   the timeline is warped (monotonic, piecewise linear) onto acoustic landmarks: a
//            phrase starts where its sound starts (Kokoro's first phone often begins 50-200 ms
//            before the audio), an m / b / p spans its acoustic closure (the level dip between the
//            half-level crossings: the lips seal when the dip starts and part at the release), an
//            f / v spans its low-band dip. Kokoro's durations come on a 25 ms grid and drift, so the
//            boundaries between landmarks move with them.
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

/**
 * Landmarks of a timeline in its clip's audio, as anchors [timeline time, audio time]: phrase
 * onsets, the closure of each m / b / p and the low-band dip of each f / v.
 * @param {VisemeSegment[]} tl @param {AcousticTrack} ac
 * @returns {{ anchors: Array<[number, number]>, exact: Set<number> }} anchors sorted, strictly
 *   increasing in both; exact: the closures / tucks whose two edges both became anchors
 */
export function landmarks(tl, ac) {
  /** @type {Array<[number, number, number, number?]>} [old, new, weight, closure segment] */
  const raw = [];
  for (let i = 0; i < tl.length; i++) {
    const s = tl[i];
    if (s.viseme === 'sil') continue;
    const prev = tl[i - 1];
    const phraseStart = !prev || (prev.viseme === 'sil' && prev.end - prev.start >= 0.1);
    if (phraseStart) {
      const on = acousticOnset(ac, s.start - 0.08, s.start + 0.35);
      if (Number.isFinite(on)) {
        if (s.viseme === 'PP') {
          // a b / p releases into the sound; an m hums first (low band strong), then releases into
          // the vowel: where the level rises within 8 dB of the vowel's
          let rel = on;
          const i0 = trackFrame(ac, on);
          if (ac.lo[i0] > ac.e[i0] - 6) {
            let ref = -Infinity;
            for (let j = i0; j <= trackFrame(ac, on + 0.3); j++) if (ac.e[j] > ref) ref = ac.e[j];
            for (let j = i0; j <= trackFrame(ac, on + 0.3); j++) if (ac.e[j] > ref - 8) { rel = j * ac.hop; break; }
          }
          raw.push([s.end, rel, 2]);
          raw.push([s.start, Math.min(rel - 0.06, on - 0.02), 1]);
        } else {
          raw.push([s.start, on - ONSET_PRE, 2]);
        }
      }
      continue;
    }
    // (only between vowels: in a cluster — "should move", "move the" — the dip is shared with the
    // neighbouring consonant and says nothing about where this one is)
    const next = tl[i + 1];
    if ((s.viseme === 'PP' || s.viseme === 'FF') && prev && next && VOCALIC.has(prev.viseme) && VOCALIC.has(next.viseme)) {
      const d = findDip(ac, s.viseme === 'PP' ? ac.e : ac.lo, s.start, s.end);
      if (!d) continue;
      const dur = d.t1 - d.t0;
      if (dur < 0.025 || dur > 0.25) continue;
      raw.push([s.start, d.t0, 1.5, i]);
      raw.push([s.end, d.t1, 1.5, i]);
    }
  }
  const anchors = monotone(raw);
  const kept = new Set(anchors.map((a) => a[0]));
  const exact = new Set();
  for (const r of raw) if (r[3] !== undefined && kept.has(tl[r[3]].start) && kept.has(tl[r[3]].end)) exact.add(r[3]);
  return { anchors, exact };
}

/**
 * Anchors that keep the warp monotonic: sorted by timeline time; an anchor that would make audio
 * time go backwards (or squeeze a span below 40 % / stretch it beyond 250 %) is dropped, the
 * lighter of two conflicting ones first.
 * @param {Array<[number, number, number, number?]>} raw @returns {Array<[number, number]>}
 */
export function monotone(raw) {
  const byWeight = raw.map((r, i) => ({ r, i })).sort((x, y) => y.r[2] - x.r[2] || x.i - y.i);
  /** @type {Array<[number, number]>} */
  let kept = [];
  for (const { r } of byWeight) {
    if (Math.abs(r[1] - r[0]) > MAX_SHIFT + 0.1) continue;
    const cand = [...kept, [r[0], r[1]]].sort((x, y) => x[0] - y[0]);
    let ok = true;
    for (let k = 1; k < cand.length && ok; k++) {
      const dOld = cand[k][0] - cand[k - 1][0], dNew = cand[k][1] - cand[k - 1][1];
      if (dOld < 1e-6) { ok = false; break; }
      const slope = dNew / dOld;
      if (!(slope >= 0.4 && slope <= 2.5) && dOld > 0.02) ok = false;
      if (dNew < 0.005) ok = false;
    }
    if (ok) kept = /** @type {Array<[number, number]>} */ (cand);
  }
  return kept;
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
 * segment at least 10 ms; a closure / tuck matched to its acoustic closure is marked `exact`).
 * @param {VisemeSegment[]} tl @param {AcousticTrack} ac
 * @returns {{ tl: Array<VisemeSegment & { exact?: boolean }>, anchors: Array<[number, number]> }}
 */
export function alignTimeline(tl, ac) {
  const { anchors, exact } = landmarks(tl, ac);
  if (!anchors.length) return { tl: tl.map((s) => ({ ...s })), anchors };
  const out = [];
  let prevEnd = -Infinity;
  tl.forEach((s, i) => {
    let a = Math.max(0, warpTime(anchors, s.start));
    let b = warpTime(anchors, s.end);
    if (Number.isFinite(prevEnd)) a = prevEnd;
    if (b < a + 0.01) b = a + 0.01;
    // (exact: its edges are the acoustic closure's: the lips may close and part right there)
    out.push(exact.has(i) ? { ...s, start: a, end: b, exact: true } : { ...s, start: a, end: b });
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
  const q = va.f1 > 0 ? clamp((va.q - 0.2) / 0.4, 0, 1) : 0;
  // F1 -> openness: close vowels ~0.07, open ones ~0.9 of the jaw's range
  const x = va.f1 > 0 ? clamp((va.f1 - n.f1lo) / (n.f1hi - n.f1lo), -0.1, 1.15) : NaN;
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
  if (viseme === 'O' || viseme === 'U') round = clamp(T[2] * (0.82 + 0.25 * (stress - 0.9)), 0, 1);
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
