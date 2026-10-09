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
  CHANNELS, LEAD_IN, REST, TAIL, VISEME_SHAPES, closureCentreIn, planSpeech, sampleSegments, segmentsFromVisemes,
  toShape,
} from './articulation.js';
import { bandEnergies, dbToUnit, toDb } from './dsp.js';
import { ClipProsody, VoiceAnalysis, peakEnergy, trimPhraseEnds, vowelNorms } from './prosody.js';
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

/** Default visual lead: the mouth shapes a sound slightly before it is heard. */
export const VISEME_LEAD = 0.05;

/** Seconds of a clip's pitch analysed at once when it starts (its first cues are due at once). */
export const PRE_ANALYSE = 0.8;
/** Pitch frames analysed per update at most (~25 µs each), and how far ahead of playback. */
export const FRAMES_PER_UPDATE = 40;
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
 * @param {{ lead?: number, prevT?: number, segs?: import('./articulation.js').Segment[] }} [opts]
 *   lead: the mouth leads the sound (default VISEME_LEAD); prevT: the previous sample time — a
 *   closure whose centre lies in between is sampled at its centre (never skipped); segs: the
 *   timeline's segments when the caller built them itself (measured prominence, variation)
 * @returns {MouthShape}
 */
export function mouthFromVisemes(tl, t, opts = {}) {
  if (!Array.isArray(tl) || !tl.length || !Number.isFinite(t)) return { ...SIL };
  const lead = opts.lead ?? VISEME_LEAD;
  const segs = opts.segs || segmentsFor(tl);
  let tt = t + lead;
  if (Number.isFinite(opts.prevT)) {
    const c = closureCentreIn(segs, /** @type {number} */ (opts.prevT) + lead, tt);
    if (Number.isFinite(c)) tt = c;
  }
  return toShape(sampleSegments(segs, tt));
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

/** Plan seconds the mouth runs ahead of a word boundary (visual lead). */
const BOUNDARY_LEAD = 0.035;
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

  /** Mouth channels at the current plan position (a closure passed since the last frame is shown). */
  sample() {
    const segs = this.plan.segs;
    let t = this.p;
    const c = closureCentreIn(segs, this.pPrev, this.p);
    if (Number.isFinite(c)) t = c;
    return sampleSegments(segs, t);
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
   * @param {{ player: any, now?: () => number }} deps
   *   now: seconds clock, the same one passed to update()
   */
  constructor(deps) {
    this.player = deps.player;
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    this._freq = new Float32Array(1024);
    this._sm = { jaw: 0, wide: 0, round: 0, press: 0, tuck: 0, teeth: 0, tongue: 0, level: 0 };
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
    this._pitch = 0;
    this._voicedAt = -Infinity;
    /** @type {Array<() => void>} */
    this._offs = [];
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
   * Analysis state of a server-voiced clip (built on its first frame, then cached).
   * @param {{ clip: any, buffer?: any }} cur
   */
  _clipState(cur) {
    const clip = cur.clip;
    if (this._clips.has(clip)) return this._clips.get(clip);
    let st = null;
    const src = clipSamples(cur);
    if (src && src.samples.length >= src.sampleRate * 0.05) {
      const a = new VoiceAnalysis(src.samples, src.sampleRate, { refHz: this.f0Ref });
      a.advanceTo(PRE_ANALYSE);
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
      const segs = segmentsFromVisemes(tl, {
        jawScale: (s) => stressJawScale(peakEnergy(a, s.start, s.end) - norms.energy, (s.end - s.start) / norms.dur),
        vary: hashText(clip.text || String(tl.length)),
      });
      const prosody = new ClipProsody(a, tl, { ref, ends: textEnds(clip.text || '') });
      st = { a, tl, segs, prosody, learned: false };
    }
    this._clips.set(clip, st);
    return st;
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
      const prevT = cur.clip === this._prevClip ? this._prevT : NaN;
      const st = tl && tl.length ? this._clipState(cur) : null;
      if (st) {
        // the clip's own analysis: the loudness envelope drives the jaw, the pitch the prosody
        const tt = cur.time + VISEME_LEAD;
        st.a.advanceTo(Math.max(cur.time + LOOKAHEAD, st.prosody.needBy(tt)), FRAMES_PER_UPDATE);
        if (st.a.complete && !st.learned) {
          st.learned = true;
          this._learnPitch(st.a);
        }
        const m = mouthFromVisemes(st.tl, cur.time, { prevT, segs: st.segs });
        // (the envelope a moment ahead too: the jaw opens with a syllable's onset, not after it)
        const e = Math.max(st.a.energyAt(tt - 0.005), st.a.energyAt(tt + 0.015));
        m.jaw = clamp01(m.jaw * energyJaw(e));
        target = { ...m, level: clamp01((st.a.energyAt(tt) + 38) / 30) };
        source = 'visemes';
        cues = st.prosody.take(tt);
        into = st.prosody.intonation(tt);
      } else if (tl && tl.length) {
        const level = dbToUnit(toDb(this.player.level()), -50, -14);
        const m = mouthFromVisemes(tl, cur.time, { prevT });
        // louder syllables open the jaw a little more, a dip in the audio a little less
        m.jaw = clamp01(m.jaw * (0.78 + 0.4 * level));
        target = { ...m, level };
        source = 'visemes';
        cues = this._clipCues(cur.clip, tl, cur.time + VISEME_LEAD);
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
      this._prevT = cur.time;
    } else if (cur && cur.kind === 'speech' && this.track && cur.clip === this._trackClip) {
      const tr = this.track;
      tr.speed = (tr.rate || 1) * this.speedFactor(tr.rate);
      tr.update(dt, now);
      if (tr.speedSamples.length) {
        this._learn(tr.rate, tr.speedSamples);
        tr.speedSamples = [];
      }
      const v = toShape(tr.sample());
      const voiced = tr.mode !== 'waiting' && tr.p > LEAD_IN && tr.p < tr.plan.duration;
      target = { ...v, level: voiced ? clamp01(0.12 + 0.8 * v.jaw + 0.2 * (v.wide + v.round)) : 0.04 };
      source = 'speech';
      cues = tr.takeCues();
    } else {
      target = { ...SIL, level: 0 };
    }
    // Timeline sources are already smooth (dominance blending): only take the frame steps off.
    // Audio analysis is noisy: open fast, close a little slower.
    const sm = this._sm;
    const step = (key, tauUp, tauDown) => {
      const tau = target[key] > sm[key] ? tauUp : tauDown;
      sm[key] += (target[key] - sm[key]) * (1 - Math.exp(-Math.max(0, dt) / tau));
    };
    const audio = source === 'audio';
    for (const k of CHANNELS) {
      if (audio || source === 'none') step(k, 0.03, 0.06);
      else step(k, 0.008, 0.008);
    }
    sm.level += (target.level - sm.level) * (1 - Math.exp(-Math.max(0, dt) / 0.08));
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
