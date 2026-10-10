// Lip-sync: turns what is being played into mouth targets for the avatar,
// { jaw, wide, round, press, tuck, teeth, tongue } (0..1 each, avatar.setMouth), a loudness level
// (setSpeechLevel) and prosody cues (avatar.setProsody: nods, brows, blinks, smiles).
//
// Three drivers, best first; all of them go through the same coarticulation model
// (articulation.js: dominance-blended targets, crisp closures, anticipatory rounding):
//   (a) the voice server's viseme timeline, sampled at the playback clock (+ a small visual lead),
//       with the jaw scaled by vowel prominence and the measured loudness;
//   (b) audio analysis of the playing clip when no visemes came with it: RMS → jaw with a noise
//       gate, band-energy ratios → spread (E / I / S) vs round (O / U);
//   (c) the system voice (Web Speech: no samples, no phonemes): the words of the utterance are
//       converted to phonemes (g2p.js) and timed (planSpeech); the voice's word-boundary events
//       anchor each word, the gaps between them are predicted at a speaking rate learned from the
//       boundaries, a word that arrives early compresses the rest of the previous one, the mouth
//       rests at punctuation pauses, and voices without boundary events play the whole timeline
//       at the estimated rate.
// The mapping functions are pure and unit-tested; LipSync wires them to the player.

import {
  CHANNELS, LEAD_IN, REST, TAIL, VISEME_SHAPES, closureCentreIn, nextLipClosure, planSpeech, sampleSegments, segmentsFromVisemes,
  toShape, visemeTarget,
} from './articulation.js';
import { bandEnergies, dbToUnit, toDb } from './dsp.js';
import { springStep } from '../avatar/motion.js';
import { ClipProsody, VoiceAnalysis, peakEnergy, trimPhraseEnds, vowelNorms, warmUpAnalysis } from './prosody.js';
import { AcousticsClient } from './acoustics-client.js';
import { SpeakerFormants, fuseTimeline, warmUpFusion } from './fusion.js';
import { base64ToBytes, decodeWav } from './wav.js';

export { CHANNELS, VISEME_SHAPES, planSpeech };

/** @typedef {import('./articulation.js').MouthShape} MouthShape */
/** @typedef {import('./articulation.js').Cue} Cue */
/** @typedef {{ start: number, end: number, viseme: string }} VisemeSegment */

const SIL = REST;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** @param {string} id @returns {MouthShape} */
export function visemeShape(id) {
  return /** @type {any} */ (VISEME_SHAPES)[id] || SIL;
}

/** @param {MouthShape} a @param {MouthShape} b @param {number} t @returns {MouthShape} */
export function mixShapes(a, b, t) {
  const o = /** @type {any} */ ({});
  for (const k of CHANNELS) o[k] = (a[k] || 0) + ((b[k] || 0) - (a[k] || 0)) * t;
  return o;
}

/**
 * Index of the segment containing time t (binary search), -1 before the first, n after the last.
 * @param {VisemeSegment[]} tl @param {number} t
 */
export function visemeIndexAt(tl, t) {
  if (!tl.length || t < tl[0].start) return -1;
  if (t >= tl[tl.length - 1].end) return tl.length;
  let lo = 0;
  let hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Coarticulation segments of a server timeline, built once per timeline array. */
const _segCache = new WeakMap();
/** @param {VisemeSegment[]} tl */
function segmentsFor(tl) {
  let s = _segCache.get(tl);
  if (!s) {
    s = segmentsFromVisemes(tl);
    _segCache.set(tl, s);
  }
  return s;
}

/**
 * Default visual lead: the mouth shapes a sound slightly before it is heard. (58 ms: 50 ms of
 * lead plus the ~8 ms more the director's mouth springs take to get under way.)
 */
export const VISEME_LEAD = 0.058;

/**
 * Visual leads of a clip whose timeline is aligned with its own sound (fusion.js): its closures
 * ARE the acoustic closures, so the lips need only the lead of their fast springs and of the
 * display (one to two frames); the heavier jaw is sampled further ahead (its spring is slower), so
 * a vowel's opening peaks with its sound. Calibrated on 36 real Kokoro clips
 * (tools/visual/lipsync-align.mjs and docs/VOICE.md).
 */
export const FUSED_LEAD = Object.freeze({ lips: 0.026, jaw: 0.06 });
/** How far a closure's / tuck's lip gesture reaches beyond its (acoustic) segment, re the timeline's. */
export const FUSED_LIP_EDGE = 0.6;
/**
 * The lips start closing for m b p / f v this much earlier than they part: the closing gesture is
 * a ~60 ms approach (the director's slower closing springs), the release a burst. Press and tuck
 * are the larger of their value now and LIP_CLOSE_EARLY ahead, so the approach starts sooner and
 * the contact lands where it did with a fast spring, while the release keeps its time.
 */
export const LIP_CLOSE_EARLY = 0.016;

/**
 * Sample the segments at t with the lips' closing anticipated (LIP_CLOSE_EARLY): press and tuck
 * are the larger of t's and t + early's, `early` scaled by the coming closure's own share
 * (earlyK: a closure after a short vowel takes less of it, so the lips part for the vowel). A
 * closure whose centre lies between prevT and t (or between their early counterparts) is sampled
 * at its centre, never skipped.
 * @param {import('./articulation.js').Segment[]} segs @param {number} t @param {number} [prevT]
 * @param {number} [early] @returns {number[]} CHANNELS order
 */
export function sampleLips(segs, t, prevT, early = LIP_CLOSE_EARLY) {
  const at = (x, px) => {
    if (Number.isFinite(px)) {
      const c = closureCentreIn(segs, /** @type {number} */ (px), x);
      if (Number.isFinite(c)) x = c;
    }
    return sampleSegments(segs, x);
  };
  const v = at(t, prevT);
  if (early > 0) early *= nextLipClosure(segs, t)?.earlyK ?? 1;
  if (!(early > 0)) return v;
  const e = at(t + early, Number.isFinite(prevT) ? /** @type {number} */ (prevT) + early : prevT);
  v[3] = Math.max(v[3], e[3]);
  v[4] = Math.max(v[4], e[4]);
  return v;
}

/**
 * The lips' timeline of a clip aligned with its sound (fusion.js). A closure / tuck edge that is
 * an acoustic landmark (exactStart / exactEnd) is sampled at the lips' fused lead
 * (FUSED_LEAD.lips). One that is not ("and Pam": the closure's start after the n; an f before a
 * consonant) keeps the timeline's timing as warped between the landmarks around it; where the
 * warp has not moved it, Kokoro's own timing is late by about as much as the plain lead
 * (VISEME_LEAD) makes up for, so it moves earlier by up to the difference: by what the warp has
 * not already moved it. The segment beside it gives way. Only the press / tuck are sampled from it.
 * @param {Array<VisemeSegment & { exact?: boolean, exactStart?: boolean, exactEnd?: boolean }>} tl
 *   the aligned timeline @param {VisemeSegment[]} [orig] the timeline before alignment (same
 *   segments; without it every free edge moves the whole difference) @param {number} [shift]
 * @returns {VisemeSegment[]}
 */
export function lipTimeline(tl, orig, shift = VISEME_LEAD - FUSED_LEAD.lips) {
  const out = tl.map((s) => ({ ...s }));
  const by = (t, o) => (o && Number.isFinite(o) ? clamp(shift + (t - o), 0, shift) : shift);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.viseme !== 'PP' && s.viseme !== 'FF') continue;
    const o = orig && orig.length === tl.length ? orig[i] : null;
    if (!s.exact && !s.exactStart) {
      const prev = out[i - 1];
      const a = Math.max(prev ? prev.start + 0.01 : -Infinity, s.start - by(tl[i].start, o?.start));
      if (prev) prev.end = a;
      s.start = a;
    }
    if (!s.exact && !s.exactEnd) {
      const b = Math.max(s.start + 0.015, s.end - by(tl[i].end, o?.end));
      if (out[i + 1]) out[i + 1].start = b;
      s.end = b;
    }
  }
  return out;
}

/** How long (s) a clip's segments crossfade when they are rebuilt while it plays (LipSync._refuse). */
export const XFADE = 0.08;

/** The user's lip-sync offset (settings voice.lipSyncOffsetMs, s): + moves the mouth later. */
export const OFFSET_MAX = 0.2;
/** Settings > Voice > Test lip-sync: closures (m b p) to judge the timing by, and a pause. */
export const LIPSYNC_TEST_LINE = 'Bob, pop by at five. Maybe my mom made muffins.';

/**
 * Smooth maximum of two values (dB): exact where they are equal (a steady vowel), within `d`
 * below the larger one when they are far apart (an onset), with no corner where they cross.
 * @param {number} a @param {number} b @param {number} [d]
 */
export function smoothMax(a, b, d = 0.5) {
  const h = 0.5 * (a - b);
  return 0.5 * (a + b) + Math.sqrt(h * h + d * d) - d;
}

/**
 * The playback clock as the mouth samples it. AudioContext time advances in audio-callback
 * blocks (~10 ms on Windows), so per frame it steps 10 or 20 ms at 60 Hz and not at all in a
 * third of the frames at 144 Hz. This clock advances by the frame time and is pulled toward the
 * reported time by at most 2 ms per frame (a phase-locked loop), never steps backwards, never
 * runs more than one callback block (12 ms) ahead of the reported time (an audio stall or a
 * paused clock: it waits) and re-syncs when it is far behind (> 30 ms).
 */
export class PlaybackClock {
  constructor() {
    this.key = null;
    this.t = 0;
    this.started = false;
  }

  /**
   * @param {any} key the clip (a new one restarts the clock) @param {number} reported its
   *   playback time as the player reports it @param {number} dt seconds since the last sample
   */
  sample(key, reported, dt) {
    if (key !== this.key || !this.started) {
      this.key = key;
      this.t = reported;
      this.started = reported > 0;
      return this.t;
    }
    const prev = this.t;
    const pred = prev + Math.max(0, dt);
    const err = reported - pred;
    if (err > 0.03) this.t = reported;
    else this.t = pred + clamp(err * (1 - Math.exp(-Math.max(0, dt) / 0.1)), -0.002, 0.002);
    this.t = Math.max(prev, Math.min(this.t, reported + 0.012));
    return this.t;
  }
}

/** Pitch frames analysed per update at most (~25 µs each), and how far ahead of playback. Even
 * at 30 fps that is 6x faster than the clip plays, so the cues' look-ahead fills within frames. */
export const FRAMES_PER_UPDATE = 20;
export const LOOKAHEAD = 0.8;

/**
 * The samples of a playing audio clip: the player's decoded (dry) buffer when it offers one, the
 * clip's raw samples, or its WAV decoded here. null when there are none.
 * @param {{ clip: any, buffer?: { sampleRate: number, getChannelData: (c: number) => Float32Array } }} cur
 * @returns {{ samples: Float32Array, sampleRate: number }|null}
 */
export function clipSamples(cur) {
  const b = cur?.buffer;
  if (b && typeof b.getChannelData === 'function' && b.sampleRate > 0) {
    try {
      return { samples: b.getChannelData(0), sampleRate: b.sampleRate };
    } catch { /* fall through to the clip's own audio */ }
  }
  const c = cur?.clip;
  if (c?.samples?.length && c.sampleRate > 0) return { samples: c.samples, sampleRate: c.sampleRate };
  if (c?.audioB64 || c?.wav) {
    try {
      const d = decodeWav(c.wav ? new Uint8Array(c.wav) : base64ToBytes(c.audioB64));
      return { samples: d.samples, sampleRate: d.sampleRate };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Jaw scale of a vowel from its measured loudness (dB above the clip's median vowel) and length
 * (/ the median vowel's): stressed syllables open wider, reduced ones less.
 * @param {number} eRel @param {number} durRel
 */
export function stressJawScale(eRel, durRel) {
  return clamp(0.96 + 0.035 * eRel + 0.12 * (durRel - 1), 0.66, 1.24);
}

/**
 * How far the loudness at the mouth's moment lets the jaw open (multiplies the viseme's jaw):
 * 0.58 near silence, 1.08 at full voice, smooth in between. The envelope is the clip's own, so a
 * syllable's sharp onset opens the jaw as sharply, and a dip (a closure, a pause) lets it close.
 * @param {number} db loudness re the clip's loudest frame
 */
export function energyJaw(db) {
  const x = clamp01((db + 30) / 26);
  return 0.58 + 0.5 * x * x * (3 - 2 * x);
}

/**
 * The loudness factor on a jaw whose amounts already come from the sound (fusion.js: F1 and
 * stress): a gentler one, 0.72 near silence to 1.05 at full voice (the jaw still eases in
 * closures and pauses and follows a syllable's onset).
 * @param {number} db loudness re the clip's loudest frame
 */
export function energyJawFused(db) {
  const x = clamp01((db + 30) / 26);
  return 0.72 + 0.33 * x * x * (3 - 2 * x);
}

/**
 * The text's phrase ends (punctuation, friendliness) with their relative position in the text,
 * for ClipProsody. @param {string} text
 */
export function textEnds(text) {
  if (!text) return [];
  const plan = planSpeech(text);
  const n = Math.max(1, plan.words.length);
  return plan.cues.filter((c) => c.type === 'phrase-end').map((c) => ({ punct: c.punct, friendly: c.friendly || 0, pos: ((c.word ?? n - 1) + 1) / n }));
}

/** Small integer hash of a string (the seed of a clip's natural variation). @param {string} s */
function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100003;
}

/**
 * Mouth shape at playback time t from a viseme timeline, with coarticulation.
 * @param {VisemeSegment[]} tl
 * @param {number} t seconds into the clip
 * @param {{ lead?: number, leadLips?: number, prevT?: number, closeEarly?: number, segs?: import('./articulation.js').Segment[],
 *   segsLips?: import('./articulation.js').Segment[] }} [opts]
 *   lead: the mouth leads the sound (default VISEME_LEAD); leadLips: the lips' own lead (press,
 *   tuck: default the same); prevT: the previous sample time — a closure whose centre lies in
 *   between is sampled at its centre (never skipped); segs: the timeline's segments when the
 *   caller built them itself (measured prominence, variation); segsLips: the segments the press
 *   and tuck are sampled from (default segs; lipTimeline); closeEarly: how much sooner the lips
 *   start closing than they part (default LIP_CLOSE_EARLY; 0: not)
 * @returns {MouthShape}
 */
export function mouthFromVisemes(tl, t, opts = {}) {
  if (!Array.isArray(tl) || !tl.length || !Number.isFinite(t)) return { ...SIL };
  const lead = opts.lead ?? VISEME_LEAD;
  const leadLips = opts.leadLips ?? lead;
  const segs = opts.segs || segmentsFor(tl);
  const pt = Number.isFinite(opts.prevT) ? /** @type {number} */ (opts.prevT) + leadLips : undefined;
  const lips = toShape(sampleLips(opts.segsLips || segs, t + leadLips, pt, opts.closeEarly));
  if (leadLips === lead && !opts.segsLips) return lips;
  // the jaw, spread, rounding, teeth and tongue at their own lead; the lips' closures at theirs
  const m = toShape(sampleSegments(segs, t + lead));
  m.press = lips.press;
  m.tuck = lips.tuck;
  return m;
}

/**
 * Validate / normalise a server viseme timeline (drops malformed entries, sorts).
 * @param {unknown} v @returns {VisemeSegment[]|null}
 */
export function normalizeVisemes(v) {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && typeof s.viseme === 'string')
    .map((s) => ({ start: Number(s.start), end: Number(s.end), viseme: String(s.viseme) }))
    .sort((a, b) => a.start - b.start);
  return out.length ? out : null;
}

/** Analysis bands (Hz): low (F1 of open/back vowels), mid, high (front-vowel F2, sibilants). */
export const AUDIO_BANDS = /** @type {Array<[number, number]>} */ ([[200, 900], [900, 2200], [2200, 6000]]);

/**
 * Mouth shape from audio analysis.
 * @param {number} rmsLevel linear RMS of the current audio block (0..1)
 * @param {number[]} bands  linear band magnitudes for AUDIO_BANDS (low, mid, high)
 * @param {{ gateDb?: number, rangeDb?: number }} [opts] noise gate (default -48 dBFS) and range to full open (30 dB)
 * @returns {MouthShape}
 */
export function mouthFromAudio(rmsLevel, bands, opts = {}) {
  const gateDb = opts.gateDb ?? -48;
  const rangeDb = opts.rangeDb ?? 30;
  const db = toDb(rmsLevel);
  const open = clamp01((db - gateDb) / rangeDb);
  if (open <= 0) return { ...SIL };
  const jaw = 0.85 * open ** 0.8;
  const [lo = 0, mid = 0, hi = 0] = bands || [];
  const total = lo + mid + hi;
  if (!(total > 0)) return { ...SIL, jaw, teeth: 0.3 * jaw };
  const lf = lo / total;
  const hf = hi / total;
  const mf = mid / total;
  // dark, low-heavy spectrum → rounded (O/U); bright → spread (E/I) or sibilant (S)
  const round = clamp01((lf - 0.6) * 3.2) * (0.4 + 0.6 * open);
  const wide = clamp01((hf + 0.5 * mf - 0.38) * 2.6) * (1 - round);
  // a quiet, hissy block is a sibilant: teeth together, lips spread
  const hiss = clamp01((hf - 0.55) * 3) * (1 - open);
  return { ...SIL, jaw: jaw * (1 - 0.6 * hiss), wide, round, teeth: clamp01(0.35 * jaw + 0.5 * wide + 0.6 * hiss) };
}

/**
 * Rough syllable count of a word (vowel groups, silent final e). Digits count one each.
 * @param {string} word
 */
export function countSyllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return 0;
  const digits = (w.match(/\d/g) || []).length;
  const letters = w.replace(/\d/g, '');
  if (!letters) return digits;
  let n = (letters.match(/[aeiouy]+/g) || []).length;
  if (letters.length > 2 && /[^aeiouy]e$/.test(letters) && !/le$/.test(letters)) n--;
  return Math.max(1, n) + digits;
}

// ---------------------------------------------------------------------------------------------
// System voice (Web Speech): plan time driven by word boundaries
// ---------------------------------------------------------------------------------------------

/** Plan seconds the mouth runs ahead of a word boundary (visual lead; it includes the ~15 ms the
 * director's mouth springs take to get under way). */
export const BOUNDARY_LEAD = 0.05;
/** Errors larger than this (plan s) jump instead of catching up. */
const SNAP = 0.35;

/**
 * Plays one utterance's articulation plan in wall time.
 *
 * Plan time p advances at `speed` plan-seconds per second. A word boundary sets where p should
 * be (the word's start + a small lead); the error is closed smoothly: quickly when the voice is
 * ahead (the rest of the previous word is compressed), gently when it is behind. With boundary
 * events, p does not run more than a few ms into a word whose boundary has not arrived (at a
 * planned pause it waits at rest, otherwise the last sound of the word is held), and gives up
 * waiting after a while (some voices skip boundaries for some words). Without boundary events
 * it simply plays the plan at `speed`.
 */
export class SpeechTrack {
  /**
   * @param {import('./articulation.js').SpeechPlan} plan
   * @param {{ speed?: number, now?: number }} [o] speed: plan seconds per second (rate × learned factor)
   */
  constructor(plan, o = {}) {
    this.plan = plan;
    this.speed = o.speed > 0 ? o.speed : 1;
    /** @type {'waiting'|'free'|'boundary'} */
    this.mode = 'waiting';
    this.p = 0;
    this.pPrev = 0;
    this.anchor = { p: 0, t: o.now ?? 0 };
    this.created = o.now ?? 0;
    this.began = NaN;           // wall time the voice started
    this.guessed = false;       // began is only the fallback's guess (no onstart, no boundary yet)
    this.confirmed = -1;        // last word whose boundary arrived (or was given up on)
    this.boundaries = 0;
    /** @type {{ k: number, t: number }|null} */
    this.lastBoundary = null;
    this.holdSince = NaN;
    this._cue = 0;
    /** @type {Cue[]} */
    this._cues = [];
    /** @type {number[]} learned speed samples (plan s per wall s), consumed by LipSync */
    this.speedSamples = [];
  }

  /**
   * The voice started speaking (utterance onstart). `guessed`: the fallback for a voice that has
   * not reported its start yet. A real start after a guess (a slow audio device, the engine's
   * first utterance) re-anchors: the free run was only a guess, so the mouth goes back to rest
   * at the start of the plan instead of leading the voice for the whole utterance.
   * @param {number} now @param {boolean} [guessed]
   */
  begin(now, guessed = false) {
    const restart = !guessed && this.guessed && this.mode === 'free' && !this.boundaries;
    if (this.mode !== 'waiting' && !restart) return;
    this.mode = 'free';
    this.guessed = guessed;
    this.began = now;
    this.anchor = { p: LEAD_IN + BOUNDARY_LEAD, t: now };
    if (restart) {
      this.p = this.pPrev = 0;
      this._cue = 0;
      this._cues = [];
    }
  }

  /**
   * Index of the plan word a boundary event refers to: by character index when the voice sends
   * one, else the next word (in order) whose text matches, else simply the next word.
   * @param {{ charIndex?: number, word?: string }} ev
   */
  wordIndex(ev) {
    const words = this.plan.words;
    if (!words.length) return -1;
    const ci = Number(ev?.charIndex);
    if (Number.isFinite(ci) && ci >= 0) {
      // the word containing charIndex, or the first one after it (an index on a space / mark)
      for (let k = 0; k < words.length; k++) if (ci < words[k].end) return k;
      return words.length - 1;
    }
    const want = String(ev?.word || '').toLowerCase().replace(/[^a-z0-9']/g, '');
    for (let k = this.confirmed + 1; k < Math.min(words.length, this.confirmed + 4); k++) {
      if (want && words[k].text.toLowerCase().replace(/[^a-z0-9']/g, '').startsWith(want.slice(0, 3))) return k;
    }
    return Math.min(words.length - 1, this.confirmed + 1);
  }

  /** A word boundary event. @param {number} now @param {{ charIndex?: number, word?: string }} ev */
  boundary(now, ev) {
    const k = this.wordIndex(ev);
    if (k < 0) return;
    if (this.lastBoundary && k <= this.lastBoundary.k) return; // repeat (e.g. "42" read as two words)
    const words = this.plan.words;
    if (this.mode === 'waiting' || (this.guessed && !this.boundaries)) {
      // the first sign of the voice: it started now; a guessed start may have run ahead of it
      this.began = now;
      this.guessed = false;
      const at = words[k].t0 + BOUNDARY_LEAD;
      if (this.p > at) this.p = this.pPrev = at;
    }
    const lb = this.lastBoundary;
    if (lb && lb.k === k - 1 && !(words[lb.k].pause > 0)) {
      // consecutive words without a planned pause: how fast does this voice really speak?
      const span = words[k].t0 - words[lb.k].t0;
      const wall = now - lb.t;
      if (span > 0.08 && wall > 0.04) this.speedSamples.push(span / wall);
    }
    this.mode = 'boundary';
    this.boundaries++;
    this.lastBoundary = { k, t: now };
    this.confirmed = Math.max(this.confirmed, k);
    this.anchor = { p: words[k].t0 + BOUNDARY_LEAD, t: now };
    this.holdSince = NaN;
  }

  /** Plan position the mouth may not pass before the next word's boundary. */
  _limit() {
    if (this.mode !== 'boundary') return Infinity;
    const words = this.plan.words;
    const j = this.confirmed + 1;
    if (j >= words.length) return Infinity;
    // planned pause before it: wait at rest; else hold the end of the current word's last sound
    return words[j - 1].pause > 0 ? words[j].t0 - 0.07 : words[j].t0 - 0.01;
  }

  /** @param {number} dt @param {number} now */
  update(dt, now) {
    this.pPrev = this.p;
    if (this.mode === 'waiting') {
      // a voice that never reports its start: assume it started shortly after the request
      if (now - this.created > 0.6) this.begin(now, true);
      else return;
    }
    let limit = this._limit();
    if (Number.isFinite(limit) && this.p >= limit - 0.005) {
      if (!Number.isFinite(this.holdSince)) this.holdSince = now;
      const j = this.confirmed + 1;
      const maxHold = this.plan.words[j - 1]?.pause > 0 ? 0.7 : 0.3;
      if (now - this.holdSince > maxHold) {
        // no boundary for this word: carry on as if it had arrived
        this.confirmed = j;
        this.anchor = { p: this.p, t: now };
        this.holdSince = NaN;
        limit = this._limit();
      }
    }
    const v0 = this.speed;
    const desired = Math.min(limit, this.anchor.p + v0 * (now - this.anchor.t));
    const e = desired - this.p;
    if (Math.abs(e) > SNAP) {
      this.p = desired;
    } else {
      const v = clamp(v0 + e / (e > 0 ? 0.05 : 0.12), e < 0 && desired >= limit ? 0 : 0.25 * v0, 5 * v0);
      this.p = Math.min(limit, this.p + v * Math.max(0, dt));
    }
    if (this.p < this.pPrev) this.p = this.pPrev; // plan time never runs backwards (no stutter)
    // prosody cues passed on the way
    const cues = this.plan.cues;
    while (this._cue < cues.length && cues[this._cue].t <= this.p) {
      const c = cues[this._cue++];
      if (this.p - c.t < 0.4) this._cues.push(c); // skip what a jump flew over
    }
  }

  /**
   * Mouth channels at the current plan position (a closure passed since the last frame is shown).
   * @param {number} [shift] plan seconds the mouth runs behind the plan position (the user's offset)
   */
  sample(shift = 0) {
    return sampleLips(this.plan.segs, this.p - shift, this.pPrev - shift, LIP_CLOSE_EARLY * this.speed);
  }

  /** Cues crossed since the last call. @returns {Cue[]|null} */
  takeCues() {
    if (!this._cues.length) return null;
    const c = this._cues;
    this._cues = [];
    return c;
  }

  /** The whole plan has been played (only rest is left). */
  get finished() {
    return this.p >= this.plan.duration + TAIL;
  }
}

/**
 * Prosody cues for an audio clip with a server timeline: phrase starts/ends at the rest gaps,
 * accents on long (stressed) vowels, punctuation and friendliness from the clip's text.
 * @param {VisemeSegment[]} tl @param {string} [text] @returns {Cue[]}
 */
export function cuesFromVisemes(tl, text = '') {
  if (!Array.isArray(tl) || !tl.length) return [];
  const ends = text ? planSpeech(text).cues.filter((c) => c.type === 'phrase-end') : [];
  /** @type {Array<[number, number]>} speech runs between rests >= 100 ms */
  const runs = [];
  let start = NaN;
  let last = NaN;
  for (const s of tl) {
    const rest = s.viseme === 'sil';
    if (!rest && !Number.isFinite(start)) start = s.start;
    if (!rest) last = s.end;
    if (rest && Number.isFinite(start) && s.end - s.start >= 0.1) {
      runs.push([start, last]);
      start = NaN;
    }
  }
  if (Number.isFinite(start)) runs.push([start, last]);
  /** @type {Cue[]} */
  const cues = [];
  runs.forEach(([a, b], r) => {
    cues.push({ t: a, type: 'phrase-start', strength: r === 0 ? 1 : 0.7 });
    const e = ends.length === runs.length ? ends[r] : r === runs.length - 1 ? ends[ends.length - 1] : null;
    cues.push({ t: b, type: 'phrase-end', strength: 1, punct: e?.punct || (r === runs.length - 1 ? '.' : ','), friendly: e?.friendly || 0 });
  });
  const vowels = tl.filter((s) => ['aa', 'E', 'I', 'O', 'U'].includes(s.viseme));
  const durs = vowels.map((s) => s.end - s.start).sort((x, y) => x - y);
  const median = durs.length ? durs[(durs.length - 1) >> 1] : 0.1;
  let lastAccent = -Infinity;
  for (const s of vowels) {
    const d = s.end - s.start;
    if (d >= Math.max(0.08, 1.3 * median) && s.start - lastAccent >= 0.25) {
      cues.push({ t: s.start, type: 'accent', strength: clamp01(d / (1.8 * median)) });
      lastAccent = s.start;
    }
  }
  return cues.sort((x, y) => x.t - y.t);
}

/**
 * Per-frame lip-sync driver over an AudioPlayer-like object:
 *   player.current: { clip, kind: 'audio'|'speech', time: number } | null
 *   player.level(): number           (linear RMS of the output, audio clips)
 *   player.spectrum(Float32Array): boolean   (dB data; false when unavailable)
 *   player.sampleRate: number
 *   events: 'start' (clip), 'speechstart' (clip), 'boundary' ({ word, charIndex?, clip }), 'end' (clip, { stopped })
 */
export class LipSync {
  /**
   * @param {{ player: any, now?: () => number, acoustics?: AcousticsClient|null }} deps
   *   now: seconds clock, the same one passed to update(); acoustics: runs the clips' acoustic
   *   analysis (a worker; null: timeline and loudness only)
   */
  constructor(deps) {
    this.player = deps.player;
    this.acoustics = deps.acoustics === undefined ? new AcousticsClient() : deps.acoustics;
    /** @type {WeakMap<any, import('./acoustics-client.js').AcousticJob>} the acoustic analysis of each clip */
    this._jobs = new WeakMap();
    /** the speaker's formant ranges (learned per voice, like the pitch) */
    this._formants = new SpeakerFormants();
    /** the user's lip-sync offset (s, + = the mouth later) */
    this.offset = 0;
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    this._freq = new Float32Array(1024);
    this._sm = { jaw: 0, wide: 0, round: 0, press: 0, tuck: 0, teeth: 0, tongue: 0, level: 0 };
    /** velocities of the audio-analysis smoothing springs */
    this._smV = { jaw: 0, wide: 0, round: 0, press: 0, tuck: 0, teeth: 0, tongue: 0, level: 0 };
    /** the playback clock the timeline is sampled at (smooths the audio callback blocks) */
    this.clock = new PlaybackClock();
    /** @type {SpeechTrack|null} */
    this.track = null;
    this._trackClip = null;
    /** learned speaking speed of the system voice per utterance rate (plan s per s / rate) */
    this._speed = new Map();
    /** audio clip prosody: { clip, cues, i } */
    this._audioCues = null;
    this._prevClip = null;
    this._prevT = NaN;
    /** per audio clip: its analysis, trimmed timeline, segments and prosody (null: no samples) */
    this._clips = new WeakMap();
    /** the speaker's usual pitch (Hz): the median voiced pitch of the clips heard (0 = none yet) */
    this.f0Ref = 0;
    this._f0Pool = new Float32Array(3000);
    this._poolI = 0;
    /** @type {string|undefined} the voice the pitch pool belongs to (clip.voice) */
    this._speaker = undefined;
    this._pitch = 0;
    this._voicedAt = -Infinity;
    /** @type {Array<() => void>} */
    this._offs = [];
    // compile the analysis while the app is idle, not on the first clip's frames (browser only)
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(() => { warmUpAnalysis(); warmUpFusion(visemeTarget); this.acoustics?.warmUp?.(); }, { timeout: 5000 });
    }
    const p = this.player;
    if (p && typeof p.on === 'function') {
      this._offs.push(
        p.on('start', (clip) => { if (clip?.kind === 'speech') this._startSpeech(clip); }),
        p.on('speechstart', (clip) => { if (clip === this._trackClip) this.track?.begin(this._now()); }),
        p.on('boundary', (ev) => {
          if (this.track && (!ev?.clip || ev.clip === this._trackClip)) this.track.boundary(this._now(), ev || {});
        }),
        p.on('end', (clip, info) => { if (clip === this._trackClip) this._endSpeech(!!info?.stopped); }),
      );
    }
  }

  /**
   * Start analysing a clip's sound (its formants, loudness and voicing; in a worker) before it
   * plays: the speech queue calls this as soon as a clip is synthesized, while the one before it
   * plays. Optional: a clip that starts unprepared is analysed then (its first moments follow the
   * timeline alone). Resolves when the analysis is complete (null without one).
   * @param {any} clip @param {{ samples: Float32Array, sampleRate: number }} [src] its decoded samples
   * @returns {Promise<any>}
   */
  prepare(clip, src) {
    if (!clip || clip.kind !== 'audio' || !this.acoustics) return Promise.resolve(null);
    if (!Array.isArray(clip.visemes) || !clip.visemes.length) return Promise.resolve(null);
    let job = this._jobs.get(clip);
    if (!job) {
      job = this.acoustics.analyse(src || (clip.samples?.length ? { samples: clip.samples, sampleRate: clip.sampleRate } : clip.wav ? { wav: clip.wav } : { audioB64: clip.audioB64 }));
      this._jobs.set(clip, job);
    }
    return job.promise;
  }

  /**
   * How far a clip's acoustic analysis has got (diagnostics, tests): null when none was started.
   * @param {any} clip @returns {{ final: boolean, failed: boolean, frames: number, of: number }|null}
   */
  analysis(clip) {
    const j = this._jobs.get(clip);
    return j ? { final: j.final, failed: j.failed, frames: j.track?.done ?? 0, of: j.track?.n ?? 0 } : null;
  }

  /**
   * The user's lip-sync offset (settings voice.lipSyncOffsetMs): + moves the mouth (and the head
   * and face that go with the voice) later, - earlier, on top of the built-in timing.
   * @param {number} sec clamped to +-OFFSET_MAX
   */
  setOffset(sec) {
    const v = Number(sec);
    this.offset = Number.isFinite(v) ? clamp(v, -OFFSET_MAX, OFFSET_MAX) : 0;
  }

  /** Learned speed factor for an utterance rate (1 = the plan's nominal tempo). @param {number} rate */
  speedFactor(rate = 1) {
    return this._speed.get(roundRate(rate)) ?? 1;
  }

  /** @param {any} clip */
  _startSpeech(clip) {
    const rate = Number(clip.rate) > 0 ? Number(clip.rate) : 1;
    this.track = new SpeechTrack(planSpeech(clip.text || ''), { speed: rate * this.speedFactor(rate), now: this._now() });
    this.track.rate = rate;
    this._trackClip = clip;
  }

  /** @param {boolean} stopped */
  _endSpeech(stopped) {
    const tr = this.track;
    if (tr && !stopped) {
      // a voice without boundary events: learn its tempo from the utterance length
      const wall = this._now() - tr.began;
      const planLen = tr.plan.duration - LEAD_IN;
      // (not from a guessed start: that wall time says nothing about the voice)
      if (!tr.boundaries && !tr.guessed && Number.isFinite(wall) && wall > 0.4 && planLen > 0.3) this._learn(tr.rate, [planLen / wall], 0.5);
    }
    this.track = null;
    this._trackClip = null;
  }

  /** @param {number} rate @param {number[]} samples plan s per wall s @param {number} [alpha] */
  _learn(rate, samples, alpha = 0.3) {
    const key = roundRate(rate);
    let f = this._speed.get(key) ?? 1;
    for (const s of samples) f += alpha * (clamp(s / rate, 0.5, 2) - f);
    this._speed.set(key, f);
    return f;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    this.track = null;
  }

  /**
   * Add a fully analysed clip's voiced frames to the speaker's pitch pool (the last ~30 s of
   * voice) and update the reference: their median.
   * @param {VoiceAnalysis} a
   */
  _learnPitch(a) {
    const pool = this._f0Pool;
    for (let i = 0; i < a.n; i++) {
      if (!(a.f0[i] > 0)) continue;
      pool[this._poolI++ % pool.length] = a.f0[i];
    }
    const n = Math.min(this._poolI, pool.length);
    if (n < 20) return;
    const v = Array.from(pool.subarray(0, n)).sort((x, y) => x - y);
    this.f0Ref = v[n >> 1];
  }

  /**
   * Analysis state of a server-voiced clip, prepared over the clip's first frames so that no
   * frame pays for all of it: the WAV's base64, the WAV itself (both skipped when the player
   * offers its decoded buffer), then the loudness envelope, the trimmed timeline, its segments
   * and the cue plan; the pitch follows a bounded number of frames per update. While it is being
   * prepared (the clip's leading silence: a few tens of ms) `preparing` is true and the
   * timeline-only mouth plays; null for a clip without usable samples.
   * @param {{ clip: any, buffer?: any }} cur
   * @returns {{ st: any, preparing: boolean }}
   */
  _clipState(cur) {
    const clip = cur.clip;
    let p = this._clips.get(clip);
    if (!p) {
      p = { stage: 'none', st: null };
      const b = cur.buffer;
      if (b && typeof b.getChannelData === 'function' && b.sampleRate > 0) p = { stage: 'samples', src: clipSamples(cur) };
      else if (clip.samples?.length && clip.sampleRate > 0) p = { stage: 'samples', src: { samples: clip.samples, sampleRate: clip.sampleRate } };
      else if (clip.wav) p = { stage: 'bytes', bytes: new Uint8Array(clip.wav) };
      else if (clip.audioB64) p = { stage: 'base64' };
      this._clips.set(clip, p);
    } else if (p.stage === 'base64') {
      try { p = { stage: 'bytes', bytes: base64ToBytes(clip.audioB64) }; } catch { p = { stage: 'none', st: null }; }
      this._clips.set(clip, p);
    } else if (p.stage === 'bytes') {
      let src = null;
      try { const d = decodeWav(p.bytes); src = { samples: d.samples, sampleRate: d.sampleRate }; } catch { /* not a WAV */ }
      p = src ? { stage: 'samples', src } : { stage: 'none', st: null };
      this._clips.set(clip, p);
    } else if (p.stage === 'samples') {
      const ok = p.src && p.src.samples.length >= p.src.sampleRate * 0.05;
      p = ok ? { stage: 'ready', st: this._buildClip(clip, p.src) } : { stage: 'none', st: null };
      this._clips.set(clip, p);
    } else {
      return { st: p.st, preparing: false };
    }
    return { st: null, preparing: p.stage !== 'none' };
  }

  /**
   * The analysis state of a clip from its samples (pitch not analysed yet).
   * @param {any} clip @param {{ samples: Float32Array, sampleRate: number }} src
   */
  _buildClip(clip, src) {
    // another voice (Settings > Voice): its usual pitch is not the last one's, so start over (the
    // first clip of the new voice then uses its own median until the pool has learned it)
    const spk = String(clip.voice ?? '');
    if (spk !== this._speaker) {
      if (this._speaker !== undefined) {
        this._poolI = 0;
        this.f0Ref = 0;
        this._formants = new SpeakerFormants();
      }
      this._speaker = spk;
    }
    const a = new VoiceAnalysis(src.samples, src.sampleRate, { refHz: this.f0Ref });
    // the speaker's usual pitch: the median of the clips heard so far; before the first clip
    // is analysed, the median of what has been (refreshed every 10 frames)
    const own = { done: -1, hz: 0 };
    const ref = () => {
      if (this.f0Ref > 0) return this.f0Ref;
      if (a.done - own.done >= 10 || (a.complete && own.done !== a.done)) { own.done = a.done; own.hz = a.medianPitch(); }
      return own.hz || 160;
    };
    const tl = trimPhraseEnds(clip.visemes, a);
    const norms = vowelNorms(a, tl);
    const vary = hashText(clip.text || String(tl.length));
    const segs = segmentsFromVisemes(tl, {
      jawScale: (s) => stressJawScale(peakEnergy(a, s.start, s.end) - norms.energy, (s.end - s.start) / norms.dur),
      vary,
    });
    const prosody = new ClipProsody(a, tl, { ref, ends: textEnds(clip.text || '') });
    // the clip's acoustics (started by prepare(), or now): they retime the timeline and set the
    // amounts as soon as (and as far as) they are analysed
    this.prepare(clip, src);
    const st = { a, tl, segs, prosody, learned: false, ref, vary, job: this._jobs.get(clip) || null, acDone: -1, fused: null, formantsLearned: false };
    this._refuse(st);
    return st;
  }

  /**
   * Rebuild a clip's segments from its acoustics when more of them have arrived (the worker posts
   * the clip's start first, then the whole). Cheap (a few hundred frames are looked at).
   * @param {any} st the clip state
   */
  _refuse(st) {
    const tr = st.job?.track;
    if (!tr || tr.done === st.acDone) return;
    st.acDone = tr.done;
    // (a rebuild while the clip plays — its analysis arriving late, or the rest of it after the
    // first 0.8 s — crossfades from the old segments, XFADE: no jump in the mouth)
    if (st.playing) st.xf = { segs: st.segs, segsLips: st.segsLips, fused: !!st.fused, t0: NaN };
    const f = fuseTimeline(st.tl, tr, this._formants, st.ref(), visemeTarget);
    st.fused = f;
    const o = { amounts: (_s, i) => f.amounts[i], vary: st.vary, lipEdge: FUSED_LIP_EDGE };
    st.segs = segmentsFromVisemes(f.tl, o);
    st.segsLips = segmentsFromVisemes(lipTimeline(f.tl, st.tl), o);
    if (st.job.final && !st.formantsLearned) {
      st.formantsLearned = true;
      this._formants.add(f.vowels);
    }
  }

  /**
   * @param {number} dt seconds since the previous update
   * @param {number} now seconds (for the system-voice driver)
   * @returns {MouthShape & { level: number, source: 'visemes'|'audio'|'speech'|'none', cues: Cue[]|null,
   *   intonation: { pitch: number, voiced: boolean } }}
   *   intonation: the voice's pitch in semitones above / below the speaker's usual one (held over
   *   short unvoiced sounds, 0 in pauses), for the head and brows
   */
  update(dt, now) {
    const cur = this.player && this.player.current;
    /** @type {MouthShape & { level: number }} */
    let target;
    let source = /** @type {'visemes'|'audio'|'speech'|'none'} */ ('none');
    /** @type {Cue[]|null} */
    let cues = null;
    /** @type {{ pitch: number, voiced: boolean }|null} */
    let into = null;
    if (cur && cur.kind === 'audio') {
      const tl = cur.clip.visemes;
      // (the user's offset moves everything the voice drives: + = later)
      const time = this.clock.sample(cur.clip, cur.time, dt) - this.offset;
      const prevT = cur.clip === this._prevClip ? this._prevT : NaN;
      const cs = tl && tl.length ? this._clipState(cur) : null;
      const st = cs?.st;
      if (st) {
        this._refuse(st);
        // the clip's own analysis: the loudness envelope drives the jaw, the pitch the prosody
        const tt = time + VISEME_LEAD;
        st.a.advanceTo(Math.max(time + LOOKAHEAD, st.prosody.needBy(tt)), FRAMES_PER_UPDATE);
        if (st.a.complete && !st.learned) {
          st.learned = true;
          this._learnPitch(st.a);
        }
        // (the envelope a moment ahead too: the jaw opens with a syllable's onset, not after it;
        // a smooth max, so the jaw target has no corner where the two taps cross)
        const e = smoothMax(st.a.energyAt(tt - 0.005), st.a.energyAt(tt + 0.015));
        const shape = (o) => {
          const mm = o.fused
            ? mouthFromVisemes(st.tl, time, { prevT, segs: o.segs, segsLips: o.segsLips, lead: FUSED_LEAD.jaw, leadLips: FUSED_LEAD.lips })
            : mouthFromVisemes(st.tl, time, { prevT, segs: o.segs });
          mm.jaw = clamp01(mm.jaw * (o.fused ? energyJawFused(e) : energyJaw(e)));
          return mm;
        };
        let m = shape({ segs: st.segs, segsLips: st.segsLips, fused: !!st.fused });
        if (st.xf) {
          if (!Number.isFinite(st.xf.t0)) st.xf.t0 = time;
          const x = (time - st.xf.t0) / XFADE;
          if (x >= 1 || x < 0) st.xf = null;
          else m = mixShapes(shape(st.xf), m, x * x * (3 - 2 * x));
        }
        st.playing = true;
        target = { ...m, level: clamp01((st.a.energyAt(tt) + 38) / 30) };
        source = 'visemes';
        cues = st.prosody.take(tt);
        into = st.prosody.intonation(tt);
      } else if (tl && tl.length) {
        const level = dbToUnit(toDb(this.player.level()), -50, -14);
        const m = mouthFromVisemes(tl, time, { prevT });
        // louder syllables open the jaw a little more, a dip in the audio a little less
        m.jaw = clamp01(m.jaw * (0.78 + 0.4 * level));
        target = { ...m, level };
        source = 'visemes';
        // (a clip whose analysis is being prepared gets its cues from it in a moment)
        if (!cs?.preparing) cues = this._clipCues(cur.clip, tl, time + VISEME_LEAD);
      } else {
        const lvl = this.player.level();
        const level = dbToUnit(toDb(lvl), -50, -14);
        const bins = this.player.analyser?.frequencyBinCount;
        if (bins && this._freq.length !== bins) this._freq = new Float32Array(bins);
        const ok = this.player.spectrum(this._freq);
        const bands = ok ? bandEnergies(this._freq, this.player.sampleRate || 48000, AUDIO_BANDS) : [];
        target = { ...mouthFromAudio(lvl, bands), level };
        source = 'audio';
      }
      this._prevClip = cur.clip;
      this._prevT = time;
    } else if (cur && cur.kind === 'speech' && this.track && cur.clip === this._trackClip) {
      const tr = this.track;
      tr.speed = (tr.rate || 1) * this.speedFactor(tr.rate);
      tr.update(dt, now);
      if (tr.speedSamples.length) {
        this._learn(tr.rate, tr.speedSamples);
        tr.speedSamples = [];
      }
      const v = toShape(tr.sample(this.offset * tr.speed));
      const voiced = tr.mode !== 'waiting' && tr.p > LEAD_IN && tr.p < tr.plan.duration;
      target = { ...v, level: voiced ? clamp01(0.12 + 0.8 * v.jaw + 0.2 * (v.wide + v.round)) : 0.04 };
      source = 'speech';
      cues = tr.takeCues();
    } else {
      target = { ...SIL, level: 0 };
    }
    // Timeline sources are already smooth (dominance blending) and the director springs every
    // channel: they pass through as they are. Audio analysis is noisy: a spring that opens fast
    // and closes a little slower (velocity-continuous, unlike a one-pole lag).
    const sm = this._sm, sv = this._smV;
    const h = Math.max(0, dt);
    const spring = (key, omega) => {
      const st = { x: sm[key], v: sv[key] };
      springStep(st, target[key], omega, h);
      sm[key] = st.x;
      sv[key] = st.v;
    };
    const audio = source === 'audio';
    for (const k of CHANNELS) {
      if (audio || source === 'none') spring(k, target[k] > sm[k] ? 60 : 40);
      else { sm[k] = target[k]; sv[k] = 0; }
    }
    spring('level', 25);
    sm.level = clamp01(sm.level);
    // intonation: follows the voiced pitch, holds over a short unvoiced sound, relaxes in a pause
    const k = (tau) => 1 - Math.exp(-Math.max(0, dt) / tau);
    if (into?.voiced) {
      this._pitch += (into.pitch - this._pitch) * k(0.05);
      this._voicedAt = now;
    } else if (!(now - this._voicedAt < 0.15)) {
      this._pitch += (0 - this._pitch) * k(0.3);
    }
    return {
      jaw: sm.jaw, wide: sm.wide, round: sm.round, press: sm.press, tuck: sm.tuck, teeth: sm.teeth, tongue: sm.tongue,
      level: sm.level, source, cues, intonation: { pitch: this._pitch, voiced: !!into?.voiced },
    };
  }

  /** Prosody cues of a server-voiced clip passed since the last frame. */
  _clipCues(clip, tl, t) {
    let ac = this._audioCues;
    if (!ac || ac.clip !== clip) {
      ac = this._audioCues = { clip, cues: cuesFromVisemes(tl, clip.text || ''), i: 0 };
    }
    let out = null;
    while (ac.i < ac.cues.length && ac.cues[ac.i].t <= t) {
      const c = ac.cues[ac.i++];
      if (t - c.t < 0.4) (out ||= []).push(c);
    }
    return out;
  }
}

/** @param {number} r */
function roundRate(r) {
  return Math.round((Number(r) > 0 ? Number(r) : 1) * 20) / 20;
}
