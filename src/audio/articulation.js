// Articulation: phonemes / visemes → timed segments → a coarticulated mouth shape at any time.
//
// Every lip-sync source ends up here: the voice server's viseme timeline, the timeline predicted
// from the words for the system voice (g2p.js), and (indirectly) audio analysis. A segment is one
// articulatory target held for an interval; the mouth at time t is the dominance-weighted mean of
// the targets around t (Cohen & Massaro, "Modeling coarticulation in synthetic visual speech",
// 1993): each segment's influence on each channel rises toward it and falls after it, so
//   * the lips dominate in p/b/m (press) and f/v (tuck), the jaw in vowels;
//   * rounding spreads ~120 ms ahead into consonants before an O / U (anticipatory rounding),
//     unless a spread vowel in between resists it;
//   * an h or a schwa adopts its neighbours' shape;
//   * closures really close: a bilabial is so dominant on jaw and press that even a 50 ms "m"
//     between two open vowels reaches press >= 0.8 and jaw <= 0.06 at its centre.
// The result is smooth (no jitter) and pure: easy to unit test and deterministic for the harness.

import { isVowel, textToWords } from './g2p.js';

/** Mouth channels (avatar.setMouth): 0..1 each. */
export const CHANNELS = /** @type {const} */ (['jaw', 'wide', 'round', 'press', 'tuck', 'teeth', 'tongue']);
const NC = CHANNELS.length;

/**
 * @typedef {{ jaw: number, wide: number, round: number, press: number, tuck: number, teeth: number,
 *   tongue: number }} MouthShape
 * @typedef {object} Segment   one articulatory target over [start, end) (seconds)
 * @property {number} start @property {number} end
 * @property {string} viseme   contract viseme id (sil PP FF TH DD kk CH SS RR aa E I O U)
 * @property {string} [ph]     ARPAbet phoneme when known
 * @property {number} [stress] 0/1/2 for vowels
 * @property {number[]} T      target per channel
 * @property {number[]} A      dominance strength per channel
 * @property {number[]} ta     anticipatory decay (s) per channel (influence BEFORE the segment)
 * @property {number[]} tc     carry-over decay (s) per channel (influence AFTER the segment)
 */

/** @param {number[]} v @returns {MouthShape} */
export function toShape(v) {
  return { jaw: v[0], wide: v[1], round: v[2], press: v[3], tuck: v[4], teeth: v[5], tongue: v[6] };
}

//                 jaw   wide  round press tuck  teeth tongue
const T = {
  sil: /*      */ [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],
  // vowels
  AA: /*       */ [0.72, 0.18, 0.00, 0.00, 0.00, 0.30, 0.05],
  AE: /*       */ [0.62, 0.45, 0.00, 0.00, 0.00, 0.45, 0.05],
  AH: /*       */ [0.50, 0.20, 0.00, 0.00, 0.00, 0.35, 0.05],
  AX: /* schwa */ [0.28, 0.12, 0.00, 0.00, 0.00, 0.25, 0.00],
  AO: /*       */ [0.56, 0.00, 0.62, 0.00, 0.00, 0.12, 0.00],
  EH: /*       */ [0.44, 0.48, 0.00, 0.00, 0.00, 0.55, 0.00],
  ER: /*       */ [0.26, 0.00, 0.38, 0.00, 0.00, 0.20, 0.00],
  IH: /*       */ [0.26, 0.58, 0.00, 0.00, 0.00, 0.60, 0.00],
  IY: /*       */ [0.16, 0.82, 0.00, 0.00, 0.00, 0.85, 0.00],
  OH: /* o of oʊ*/ [0.50, 0.00, 0.75, 0.00, 0.00, 0.10, 0.00],
  I: /* server I (ɪ and i) */ [0.20, 0.70, 0.00, 0.00, 0.00, 0.72, 0.00],
  UH: /*       */ [0.26, 0.00, 0.62, 0.00, 0.00, 0.05, 0.00],
  UW: /*       */ [0.20, 0.00, 0.95, 0.00, 0.00, 0.00, 0.00],
  // consonants
  PP: /* m b p */ [0.00, 0.00, 0.06, 1.00, 0.00, 0.00, 0.00],
  FF: /* f v   */ [0.07, 0.12, 0.00, 0.00, 1.00, 0.50, 0.00],
  TH: /*       */ [0.15, 0.18, 0.00, 0.00, 0.00, 0.45, 1.00],
  DD: /* t d   */ [0.18, 0.22, 0.00, 0.00, 0.00, 0.50, 0.35],
  N: /*        */ [0.17, 0.20, 0.00, 0.00, 0.00, 0.40, 0.20],
  L: /*        */ [0.24, 0.18, 0.00, 0.00, 0.00, 0.40, 0.75],
  kk: /* k g ŋ */ [0.24, 0.15, 0.00, 0.00, 0.00, 0.30, 0.00],
  CH: /* sh ch */ [0.14, 0.00, 0.62, 0.00, 0.00, 0.65, 0.00],
  SS: /* s z   */ [0.06, 0.42, 0.00, 0.00, 0.00, 0.85, 0.00],
  RR: /*       */ [0.16, 0.00, 0.50, 0.00, 0.00, 0.12, 0.00],
  W: /*        */ [0.08, 0.00, 1.00, 0.00, 0.00, 0.00, 0.00],
  Y: /*        */ [0.10, 0.62, 0.00, 0.00, 0.00, 0.60, 0.00],
  HH: /*       */ [0.30, 0.10, 0.00, 0.00, 0.00, 0.25, 0.00],
};

// Dominance strength per channel by articulatory class (who "owns" which channel).
const A = {
  sil: /*   */ [1.2, 1.0, 1.0, 0.6, 0.6, 1.0, 1.0],
  vowel: /* */ [1.0, 0.8, 0.8, 0.4, 0.4, 0.6, 0.3],
  spread: /**/ [1.0, 1.0, 1.0, 0.4, 0.4, 0.8, 0.3], // i e: resist rounding
  rounded: /**/ [1.0, 0.8, 2.0, 0.4, 0.4, 0.6, 0.3],
  schwa: /*  */ [0.6, 0.4, 0.4, 0.3, 0.3, 0.4, 0.2],
  PP: /*    */ [4.5, 0.3, 0.3, 16, 1.0, 3.0, 2.0],
  FF: /*    */ [6.0, 0.4, 0.3, 3.0, 12, 2.0, 2.0],
  TH: /*    */ [1.6, 0.4, 0.3, 1.0, 1.0, 1.2, 6.0],
  DD: /*    */ [0.8, 0.3, 0.2, 0.6, 0.6, 0.6, 1.0],
  L: /*     */ [0.8, 0.3, 0.2, 0.6, 0.6, 0.6, 3.0],
  kk: /*    */ [0.5, 0.25, 0.2, 0.6, 0.6, 0.4, 0.6],
  CH: /*    */ [2.5, 0.8, 3.0, 1.0, 1.0, 2.0, 1.0],
  SS: /*    */ [3.5, 0.6, 0.35, 1.0, 1.0, 3.0, 1.0],
  RR: /*    */ [0.8, 0.6, 1.4, 0.6, 0.6, 0.6, 0.6],
  W: /*     */ [0.8, 0.8, 3.0, 0.5, 0.5, 0.6, 0.5],
  Y: /*     */ [0.7, 1.0, 0.8, 0.5, 0.5, 0.7, 0.5],
  HH: /*    */ [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
};

// Decay (s) of a segment's influence before (anticipation) and after (carry-over) it.
// Rounding anticipates longest (~120 ms reach); press / tuck are sharp gestures.
const TAU_A = [0.05, 0.065, 0.11, 0.035, 0.04, 0.055, 0.045];
const TAU_C = [0.045, 0.055, 0.07, 0.03, 0.035, 0.05, 0.04];
/** Dominant consonants decay faster on the channels they own (their large strength must not
 * bleed far into the neighbouring vowels). */
const SHARP = { PP: [0.5, 1, 1, 0.6, 1, 1, 1], FF: [0.6, 1, 1, 1, 0.6, 1, 1], SS: [0.7, 1, 1, 1, 1, 0.8, 1], TH: [1, 1, 1, 1, 1, 1, 0.7] };
const scaled = (base, k) => (k ? base.map((v, i) => v * k[i]) : base);

/** Fraction of a segment's half length over which it holds full strength. */
const PLATEAU = 0.6;
/** Segments farther than this from t have no measurable influence. */
const REACH = 0.4;

/** ARPAbet phoneme → [viseme id, target key, dominance class]. Diphthongs are split below. */
const PHONE = {
  AA: ['aa', 'AA', 'vowel'], AE: ['aa', 'AE', 'spread'], AH: ['aa', 'AH', 'vowel'], AO: ['O', 'AO', 'rounded'],
  EH: ['E', 'EH', 'spread'], ER: ['RR', 'ER', 'rounded'], IH: ['I', 'IH', 'spread'], IY: ['I', 'IY', 'spread'],
  UH: ['U', 'UH', 'rounded'], UW: ['U', 'UW', 'rounded'],
  B: ['PP', 'PP', 'PP'], P: ['PP', 'PP', 'PP'], M: ['PP', 'PP', 'PP'], F: ['FF', 'FF', 'FF'], V: ['FF', 'FF', 'FF'],
  TH: ['TH', 'TH', 'TH'], DH: ['TH', 'TH', 'TH'], T: ['DD', 'DD', 'DD'], D: ['DD', 'DD', 'DD'], N: ['DD', 'N', 'DD'],
  L: ['DD', 'L', 'L'], K: ['kk', 'kk', 'kk'], G: ['kk', 'kk', 'kk'], NG: ['kk', 'kk', 'kk'],
  CH: ['CH', 'CH', 'CH'], JH: ['CH', 'CH', 'CH'], SH: ['CH', 'CH', 'CH'], ZH: ['CH', 'CH', 'CH'],
  S: ['SS', 'SS', 'SS'], Z: ['SS', 'SS', 'SS'], R: ['RR', 'RR', 'RR'], W: ['U', 'W', 'W'], Y: ['I', 'Y', 'Y'],
  HH: ['kk', 'HH', 'HH'],
};
/** Diphthongs: two targets, 55 / 45 % of the time. */
const DIPH = {
  AW: [['aa', 'AA', 'vowel'], ['U', 'UH', 'rounded']], AY: [['aa', 'AA', 'vowel'], ['I', 'IH', 'spread']],
  EY: [['E', 'EH', 'spread'], ['I', 'IY', 'spread']], OW: [['O', 'OH', 'rounded'], ['U', 'UW', 'rounded']],
  OY: [['O', 'AO', 'rounded'], ['I', 'IY', 'spread']],
};

/** Server viseme id → [target key, dominance class] (contract ids; nn is folded into DD). */
const VISEME = {
  sil: ['sil', 'sil'], PP: ['PP', 'PP'], FF: ['FF', 'FF'], TH: ['TH', 'TH'], DD: ['DD', 'DD'], nn: ['N', 'DD'],
  kk: ['kk', 'kk'], CH: ['CH', 'CH'], SS: ['SS', 'SS'], RR: ['RR', 'RR'], aa: ['AA', 'vowel'], E: ['EH', 'spread'],
  I: ['I', 'spread'], O: ['OH', 'rounded'], U: ['UW', 'rounded'],
};
export const VISEME_IDS = Object.freeze(['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'RR', 'aa', 'E', 'I', 'O', 'U']);

/** Mouth shape of each viseme id on its own (no neighbours): harness sheets, tests. */
export const VISEME_SHAPES = Object.freeze(Object.fromEntries(
  VISEME_IDS.map((id) => [id, Object.freeze(toShape(T[VISEME[id][0]]))]),
));

/**
 * Build a segment.
 * @param {number} start @param {number} end @param {string} viseme @param {string} tKey
 * @param {string} cls @param {{ ph?: string, stress?: number, jawScale?: number }} [o]
 * @returns {Segment}
 */
export function makeSegment(start, end, viseme, tKey, cls, o = {}) {
  const t = (T[tKey] || T.sil).slice();
  const js = o.jawScale ?? 1;
  if (js !== 1) {
    t[0] = Math.min(1, t[0] * js);
    t[5] = Math.min(1, t[5] * (0.6 + 0.4 * js)); // a weaker vowel also shows fewer teeth
  }
  const k = SHARP[cls];
  return {
    start, end, viseme, ph: o.ph, stress: o.stress, T: t, A: A[cls] || A.vowel, ta: scaled(TAU_A, k), tc: scaled(TAU_C, k),
  };
}

/** Segment for a contract viseme id (server timelines). @param {number} start @param {number} end @param {string} id */
export function visemeSegment(start, end, id, jawScale = 1) {
  const [tKey, cls] = VISEME[id] || VISEME.sil;
  return makeSegment(start, end, VISEME[id] ? id : 'sil', tKey, cls, { jawScale });
}

/** Index of the last segment with start <= t (binary search), -1 if none. */
function lastStartingBefore(segs, t) {
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Dominance-blended mouth at time t. `segs` sorted by start (contiguous or with gaps); outside
 * every segment's reach the mouth is at rest.
 * @param {Segment[]} segs @param {number} t @param {number[]} [out] length 7
 * @returns {number[]} channel values (CHANNELS order)
 */
export function sampleSegments(segs, t, out = new Array(NC).fill(0)) {
  const num = _num, den = _den;
  for (let c = 0; c < NC; c++) { num[c] = 0; den[c] = 0; }
  const n = segs.length;
  if (n && Number.isFinite(t)) {
    let i = lastStartingBefore(segs, t + REACH);
    for (; i >= 0; i--) {
      const s = segs[i];
      if (s.end < t - REACH) {
        // sorted by start, so earlier segments end earlier too unless they overlap: stop after a
        // few misses (timelines here never overlap)
        break;
      }
      const half = 0.5 * (s.end - s.start);
      const mid = s.start + half;
      let d = Math.abs(t - mid) - PLATEAU * half;
      if (d < 0) d = 0;
      const tau = t < mid ? s.ta : s.tc;
      for (let c = 0; c < NC; c++) {
        const x = d / tau[c];
        const w = s.A[c] * Math.exp(-x * x);
        num[c] += w * s.T[c];
        den[c] += w;
      }
    }
  }
  for (let c = 0; c < NC; c++) out[c] = den[c] > 1e-12 ? num[c] / den[c] : 0;
  return out;
}
const _num = new Array(NC).fill(0);
const _den = new Array(NC).fill(0);

/**
 * Centre time of a closure (PP) or tuck (FF) segment inside (t0, t1], or NaN. Sampling there
 * instead of at t1 guarantees that a short closure shows at least one fully closed frame even at
 * a low frame rate (a 50 ms "m" spans only 1.5 frames at 30 fps).
 * @param {Segment[]} segs @param {number} t0 @param {number} t1
 */
export function closureCentreIn(segs, t0, t1) {
  if (!(t1 > t0) || t1 - t0 > 0.12) return NaN;
  let i = lastStartingBefore(segs, t1);
  for (; i >= 0; i--) {
    const s = segs[i];
    const mid = 0.5 * (s.start + s.end);
    if (mid <= t0) break;
    if ((s.viseme === 'PP' || s.viseme === 'FF') && mid <= t1) return mid;
  }
  return NaN;
}

/** Duration-based vowel prominence (jaw scale) of a timeline segment: long vowels are stressed. */
export function durationJawScale(s, medianDur) {
  return clamp(0.72 + 0.3 * ((s.end - s.start) / (medianDur || 0.1)), 0.7, 1.08);
}

/** The target (CHANNELS order) of a contract viseme id on its own. @param {string} id @returns {number[]} */
export function visemeTarget(id) {
  return (T[(VISEME[id] || VISEME.sil)[0]] || T.sil).slice();
}

/**
 * Segments from a voice-server viseme timeline ({start, end, viseme}, seconds). Vowel
 * prominence (and so the jaw) is estimated from duration — long vowels are the stressed ones —
 * unless `o.jawScale` measures it (e.g. from the audio), or `o.amounts` gives a vowel's measured
 * jaw / spread / rounding / teeth outright (fusion.js: from its formants and loudness). `o.vary`
 * (a seed) gives every sound a small deterministic variation of its jaw, spread and rounding, as
 * no speaker says the same syllable twice exactly alike. Rest segments are added before and
 * after, so the mouth closes at the edges.
 * @param {Array<{start:number,end:number,viseme:string}>} tl
 * @param {{ jawScale?: (s: {start:number,end:number,viseme:string}, medianDur: number) => number, vary?: number,
 *   amounts?: (s: {start:number,end:number,viseme:string}, i: number) => ({ jaw: number, wide: number, round: number, teeth: number }|null),
 *   lipEdge?: number }} [o] lipEdge: scales how far the lip gesture of a closure (m b p) or a
 *   tuck (f v) whose segment is its acoustic closure (`exact`, fusion.js) reaches beyond it
 * @returns {Segment[]}
 */
export function segmentsFromVisemes(tl, o = {}) {
  if (!Array.isArray(tl) || !tl.length) return [];
  const vowelDurs = tl.filter((s) => ['aa', 'E', 'I', 'O', 'U'].includes(s.viseme)).map((s) => s.end - s.start).sort((a, b) => a - b);
  const median = vowelDurs.length ? vowelDurs[vowelDurs.length >> 1] : 0.1;
  const jawScale = o.jawScale || durationJawScale;
  const out = [visemeSegment(tl[0].start - 0.3, tl[0].start, 'sil')];
  tl.forEach((s, i) => {
    const amt = o.amounts ? o.amounts(s, i) : null;
    let js = 1;
    if (!amt && ['aa', 'E', 'I', 'O', 'U'].includes(s.viseme)) js = jawScale(s, median);
    const seg = visemeSegment(s.start, s.end, s.viseme, js);
    if (o.lipEdge && o.lipEdge !== 1 && /** @type {any} */ (s).exact && (s.viseme === 'PP' || s.viseme === 'FF')) {
      const c = s.viseme === 'PP' ? 3 : 4;
      seg.ta = seg.ta.slice(); seg.tc = seg.tc.slice();
      seg.ta[c] *= o.lipEdge; seg.tc[c] *= o.lipEdge;
    }
    if (amt) {
      seg.T[0] = clamp(amt.jaw, 0, 1);
      seg.T[1] = clamp(amt.wide, 0, 1);
      seg.T[2] = clamp(amt.round, 0, 1);
      seg.T[5] = clamp(amt.teeth, 0, 1);
    }
    if (Number.isFinite(o.vary) && s.viseme !== 'sil') varySegment(seg, o.vary * 7919 + i);
    out.push(seg);
  });
  const last = tl[tl.length - 1];
  out.push(visemeSegment(last.end, last.end + 0.3, 'sil'));
  return out;
}

/** Hash → [-1, 1). @param {number} n */
function signedHash(n) {
  const h = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return 2 * (h - Math.floor(h)) - 1;
}

/**
 * Natural variation of one sound: jaw +-8 %, spread +-0.06, rounding +-7 % (closures and tucks
 * keep their full press / tuck: they must still close). Mutates seg.T.
 * @param {Segment} seg @param {number} seed
 */
export function varySegment(seg, seed) {
  const T = seg.T;
  T[0] = clamp(T[0] * (1 + 0.08 * signedHash(seed)), 0, 1);
  T[1] = clamp(T[1] + 0.06 * signedHash(seed + 1.7) * (T[1] > 0.05 ? 1 : 0.4), 0, 1);
  T[2] = clamp(T[2] * (1 + 0.07 * signedHash(seed + 3.1)), 0, 1);
  return seg;
}

// ---------------------------------------------------------------------------------------------
// Speech plans: text → words → timed segments (plan time = seconds at rate 1)
// ---------------------------------------------------------------------------------------------

/** Inherent durations (s) at rate 1, after Klatt (1979), shortened for conversational speech. */
const VOWEL_DUR = { AA: 0.155, AE: 0.15, AH: 0.1, AO: 0.155, AW: 0.19, AY: 0.18, EH: 0.11, ER: 0.13, EY: 0.15, IH: 0.09, IY: 0.12, OW: 0.16, OY: 0.2, UH: 0.1, UW: 0.14 };
const CONS_DUR = {
  B: 0.07, P: 0.075, M: 0.07, D: 0.055, T: 0.06, N: 0.055, L: 0.06, K: 0.07, G: 0.065, NG: 0.065, F: 0.08, V: 0.06,
  TH: 0.075, DH: 0.045, S: 0.09, Z: 0.075, SH: 0.09, ZH: 0.075, CH: 0.09, JH: 0.08, R: 0.06, W: 0.06, Y: 0.055, HH: 0.055,
};
/** Global tempo: calibrated so ordinary prose comes out at ~175 words per minute at rate 1
 * (Windows' SAPI voices speak about that fast; the driver adapts to the actual voice anyway). */
export const PLAN_TEMPO = 1.22;
/** Pause after punctuation inside an utterance (s, rate 1). */
export const PAUSES = Object.freeze({ ',': 0.17, ';': 0.24, '—': 0.24, '.': 0.34, '!': 0.34, '?': 0.34 });
/** Rest before the first word and after the last one (s). */
export const LEAD_IN = 0.15;
export const TAIL = 0.3;

const FRIENDLY = new Set(['hello', 'hi', 'hey', 'thanks', 'thank', 'welcome', 'glad', 'happy', 'great', 'nice', 'love',
  'awesome', 'wonderful', 'fantastic', 'cheers', 'enjoy', 'fun', 'pleasure', 'lovely', 'congratulations', 'congrats',
  'yay', 'haha', 'good', 'morning', 'cool', 'excellent', 'perfect', 'sure', 'feeling']);
const UNFRIENDLY = new Set(['sorry', 'unfortunately', 'error', 'failed', 'fail', 'problem', "can't", 'cannot', 'unable', 'wrong', 'sad']);

/**
 * @typedef {object} PlanWord
 * @property {string} text @property {number} start @property {number} end   character offsets
 * @property {number} t0 @property {number} t1   plan time of its first / last sound
 * @property {number} pause   rest after it (plan s)
 * @property {string} punct
 * @typedef {{ t: number, type: 'accent'|'emphasis'|'phrase-start'|'phrase-end', strength: number,
 *   punct?: string, friendly?: number, word?: number }} Cue
 * @typedef {object} SpeechPlan
 * @property {string} text
 * @property {PlanWord[]} words
 * @property {Segment[]} segs      plan-time segments (with leading / trailing rest)
 * @property {Cue[]} cues          sorted by t
 * @property {number} duration     plan time of the end of the last word (+ TAIL = rest)
 */

/**
 * Turn an utterance into a timed articulation plan (rate 1; the driver scales time).
 * Durations: stressed vowels long, unstressed and function words short, stops with a closure,
 * phrase-final lengthening, pauses at punctuation.
 * @param {string} text
 * @returns {SpeechPlan}
 */
export function planSpeech(text) {
  const words = textToWords(text);
  /** @type {Segment[]} */
  const segs = [];
  /** @type {PlanWord[]} */
  const pw = [];
  /** @type {Cue[]} */
  const cues = [];
  let t = LEAD_IN;
  segs.push(makeSegment(0, t, 'sil', 'sil', 'sil'));
  // phrase structure: a phrase ends at punctuation (or the end)
  const phraseEnd = words.map((w, i) => !!w.punct || i === words.length - 1);
  let sentenceStart = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const phones = w.phones;
    const nSyl = phones.filter((p) => isVowel(p.ph)).length || 1;
    const final = phraseEnd[i];
    const lastVowel = lastIndex(phones, (p) => isVowel(p.ph));
    const atPhraseStart = i === 0 || !!words[i - 1].punct;
    const t0 = t;
    let accentAt = NaN;
    let accentStress = 0;
    for (let k = 0; k < phones.length; k++) {
      const { ph, stress } = phones[k];
      const vowel = isVowel(ph);
      let d = vowel ? VOWEL_DUR[ph] : CONS_DUR[ph] ?? 0.06;
      if (vowel) {
        d *= stress === 1 ? 1 : stress === 2 ? 0.85 : ph === 'AH' ? 0.55 : 0.6;
        d *= Math.max(0.75, 1 - 0.07 * (nSyl - 1));                 // polysyllabic shortening
        if (final && k === lastVowel) d *= 1.4;                       // phrase-final lengthening
      } else {
        const prevC = k > 0 && !isVowel(phones[k - 1].ph);
        const nextC = k + 1 < phones.length && !isVowel(phones[k + 1].ph);
        if (prevC || nextC) d *= 0.8;                                 // clusters are quicker
        if (final && k > lastVowel) d *= 1.25;
      }
      if (!w.content) d *= 0.85;
      d *= PLAN_TEMPO;
      if (PHONE[ph]?.[0] === 'PP') d = Math.max(d, 0.055);          // a closure must stay visible
      if (PHONE[ph]?.[0] === 'FF') d = Math.max(d, 0.05);
      // vowel strength: stressed content vowels open the jaw most
      const js = vowel ? (stress === 1 ? (w.content ? 1 : 0.85) : stress === 2 ? 0.85 : 0.72) * (w.emphasis ? 1.12 : 1) : 1;
      if (vowel && stress === 1 && w.content && !(accentStress >= 1)) { accentAt = t; accentStress = 1; }
      if (DIPH[ph]) {
        const [a, b] = DIPH[ph];
        const m = t + d * 0.55;
        pushSeg(segs, makeSegment(t, m, a[0], a[1], a[2], { ph, stress, jawScale: js }));
        pushSeg(segs, makeSegment(m, t + d, b[0], b[1], b[2], { ph, stress, jawScale: js * 0.9 }));
      } else {
        const p = PHONE[ph];
        if (!p) { t += d; continue; }
        const key = ph === 'AH' && stress === 0 ? 'AX' : p[1];
        const cls = ph === 'AH' && stress === 0 ? 'schwa' : p[2];
        pushSeg(segs, makeSegment(t, t + d, p[0], key, cls, { ph, stress, jawScale: js }));
      }
      t += d;
    }
    const t1 = t;
    const pause = w.punct && i < words.length - 1 ? PAUSES[w.punct] ?? 0.17 : 0;
    pw.push({ text: w.text, start: w.start, end: w.end, t0, t1, pause, punct: w.punct });
    // prosody cues
    if (atPhraseStart) cues.push({ t: t0, type: 'phrase-start', strength: i === 0 || /[.!?]/.test(words[i - 1]?.punct || '.') ? 1 : 0.6, word: i });
    if (Number.isFinite(accentAt)) {
      // the last content word of a phrase carries the nuclear accent
      const nuclear = !words.slice(i + 1, nextPhraseEnd(phraseEnd, i) + 1).some((x) => x.content);
      cues.push({ t: accentAt, type: 'accent', strength: (nuclear ? 1 : atPhraseStart ? 0.7 : 0.45) * (w.emphasis ? 1.2 : 1), word: i });
    }
    if (w.emphasis) cues.push({ t: t0, type: 'emphasis', strength: 0.8, word: i });
    if (final) {
      const punct = w.punct || '.';
      let friendly = 0;
      if (/[.!?]/.test(punct) || i === words.length - 1) {
        friendly = sentenceFriendliness(words.slice(sentenceStart, i + 1), punct);
        sentenceStart = i + 1;
      }
      cues.push({ t: t1, type: 'phrase-end', strength: 1, punct, friendly, word: i });
    }
    if (pause > 0) {
      pushSeg(segs, makeSegment(t, t + pause, 'sil', 'sil', 'sil'));
      t += pause;
    }
  }
  const duration = t;
  pushSeg(segs, makeSegment(t, t + TAIL, 'sil', 'sil', 'sil'));
  cues.sort((a, b) => a.t - b.t);
  return { text: String(text || ''), words: pw, segs, cues, duration };
}

/** Append, merging a repeat of the same target (e.g. "m p" → one closure, two pauses). */
function pushSeg(segs, s) {
  const prev = segs[segs.length - 1];
  if (prev && prev.viseme === s.viseme && prev.end >= s.start - 1e-9 && prev.T.every((v, i) => Math.abs(v - s.T[i]) < 1e-6)) {
    prev.end = s.end;
    return;
  }
  segs.push(s);
}

function nextPhraseEnd(phraseEnd, i) {
  for (let k = i; k < phraseEnd.length; k++) if (phraseEnd[k]) return k;
  return phraseEnd.length - 1;
}

function lastIndex(arr, f) {
  for (let i = arr.length - 1; i >= 0; i--) if (f(arr[i])) return i;
  return -1;
}

/** 0..1: greetings, thanks and good news end with a micro-smile. */
export function sentenceFriendliness(words, punct) {
  const ws = words.map((w) => String(w.text).toLowerCase().replace(/’/g, "'"));
  if (ws.some((w) => UNFRIENDLY.has(w))) return 0;
  let f = ws.some((w) => FRIENDLY.has(w)) ? 0.7 : 0;
  if (punct === '!') f += f ? 0.2 : 0.35;
  return clamp(f, 0, 1);
}

/** Mouth at rest. */
export const REST = Object.freeze(toShape(T.sil));

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
