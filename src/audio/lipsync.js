// Lip-sync: turns what is being played into mouth targets for the avatar,
// { jaw, wide, round } (0..1 each, avatar.setMouth) plus a loudness level (setSpeechLevel).
//
// Three drivers, best first:
//   (a) the voice server's viseme timeline, sampled at the playback clock, with a viseme →
//       mouth-shape table and coarticulation (neighbouring shapes cross-fade at boundaries,
//       bilabial closures are kept crisp, the visual leads the audio by a few ms);
//   (b) audio analysis of the playing clip when no visemes came with it: RMS → jaw with a noise
//       gate, band-energy ratios → wide (E/I/S: bright, high energy) vs round (O/U: dark);
//   (c) Web Speech fallback (no audio samples available): word boundary events drive a syllable
//       oscillator whose vowels pick wide/round; a free-running oscillator covers voices that
//       send no boundary events.
// The mapping functions are pure and unit-tested; LipSync wires them to the player.

import { bandEnergies, dbToUnit, toDb } from './dsp.js';

/** @typedef {{ jaw: number, wide: number, round: number }} MouthShape */
/** @typedef {{ start: number, end: number, viseme: string }} VisemeSegment */

/** Mouth shape per viseme id (contract §6). */
export const VISEME_SHAPES = Object.freeze({
  sil: { jaw: 0.0, wide: 0.0, round: 0.0 },
  PP: { jaw: 0.0, wide: 0.0, round: 0.12 }, // m b p: lips pressed
  FF: { jaw: 0.1, wide: 0.3, round: 0.0 }, // f v: lower lip to teeth
  TH: { jaw: 0.18, wide: 0.22, round: 0.0 },
  DD: { jaw: 0.24, wide: 0.25, round: 0.0 }, // t d n l
  kk: { jaw: 0.3, wide: 0.15, round: 0.0 }, // k g
  CH: { jaw: 0.2, wide: 0.0, round: 0.55 }, // ch j sh: protruded
  SS: { jaw: 0.1, wide: 0.55, round: 0.0 }, // s z: teeth together, spread
  RR: { jaw: 0.22, wide: 0.0, round: 0.45 },
  aa: { jaw: 0.78, wide: 0.22, round: 0.0 },
  E: { jaw: 0.45, wide: 0.6, round: 0.0 },
  I: { jaw: 0.26, wide: 0.78, round: 0.0 },
  O: { jaw: 0.52, wide: 0.0, round: 0.75 },
  U: { jaw: 0.24, wide: 0.0, round: 0.92 },
});

const SIL = VISEME_SHAPES.sil;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** @param {string} id @returns {MouthShape} */
export function visemeShape(id) {
  return /** @type {any} */ (VISEME_SHAPES)[id] || SIL;
}

/** @param {MouthShape} a @param {MouthShape} b @param {number} t */
export function mixShapes(a, b, t) {
  return { jaw: a.jaw + (b.jaw - a.jaw) * t, wide: a.wide + (b.wide - a.wide) * t, round: a.round + (b.round - a.round) * t };
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

/**
 * Mouth shape at playback time t from a viseme timeline, with coarticulation.
 * @param {VisemeSegment[]} tl
 * @param {number} t seconds into the clip
 * @param {{ lead?: number, blend?: number }} [opts]
 *   lead: the mouth leads the sound (default 0.04 s); blend: cross-fade half-width (default 0.05 s)
 * @returns {MouthShape}
 */
export function mouthFromVisemes(tl, t, opts = {}) {
  const lead = opts.lead ?? 0.04;
  const blend = opts.blend ?? 0.05;
  if (!Array.isArray(tl) || !tl.length) return { ...SIL };
  const tt = t + lead;
  const i = visemeIndexAt(tl, tt);
  if (i < 0) {
    // approaching the first segment: open towards it
    const w = smoothstep(1 - (tl[0].start - tt) / blend);
    return mixShapes(SIL, visemeShape(tl[0].viseme), w * 0.5);
  }
  if (i >= tl.length) {
    const w = smoothstep(1 - (tt - tl[tl.length - 1].end) / blend);
    return mixShapes(SIL, visemeShape(tl[tl.length - 1].viseme), w * 0.5);
  }
  const seg = tl[i];
  const cur = visemeShape(seg.viseme);
  const dur = Math.max(1e-3, seg.end - seg.start);
  // closures (PP) and short segments blend less so they stay visible
  const b = Math.min(blend * (seg.viseme === 'PP' ? 0.5 : 1), dur / 2);
  const fromStart = tt - seg.start;
  const toEnd = seg.end - tt;
  if (toEnd < b && i + 1 <= tl.length) {
    const next = i + 1 < tl.length ? visemeShape(tl[i + 1].viseme) : SIL;
    return mixShapes(cur, next, 0.5 * smoothstep(1 - toEnd / b));
  }
  if (fromStart < b) {
    const prev = i > 0 ? visemeShape(tl[i - 1].viseme) : SIL;
    return mixShapes(prev, cur, 0.5 + 0.5 * smoothstep(fromStart / b));
  }
  return { ...cur };
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
  if (!(total > 0)) return { jaw, wide: 0, round: 0 };
  const lf = lo / total;
  const hf = hi / total;
  const mf = mid / total;
  // dark, low-heavy spectrum → rounded (O/U); bright → spread (E/I) or sibilant (S)
  const round = clamp01((lf - 0.6) * 3.2) * (0.4 + 0.6 * open);
  const wide = clamp01((hf + 0.5 * mf - 0.38) * 2.6);
  return { jaw, wide: wide * (1 - round), round };
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

/** Vowel letters of each syllable of a word, in order (for wide/round). @param {string} word */
function vowelGroups(word) {
  return String(word || '').toLowerCase().match(/[aeiouy]+/g) || ['a'];
}

/** @param {string} group @returns {MouthShape} */
function shapeForVowels(group) {
  const g = group[0];
  if (g === 'o') return VISEME_SHAPES.O;
  if (g === 'u' || group === 'oo' || group === 'ou') return VISEME_SHAPES.U;
  if (g === 'e' && group !== 'ea') return VISEME_SHAPES.E;
  if (g === 'i' || g === 'y' || group === 'ee' || group === 'ea') return VISEME_SHAPES.I;
  return VISEME_SHAPES.aa;
}

/**
 * Syllable oscillator for the Web Speech fallback: word boundary events start an
 * open/close cycle per syllable; without boundary events it free-runs at ~4.5 Hz.
 */
export class SyllableOscillator {
  /** @param {{ syllablesPerSec?: number }} [opts] */
  constructor(opts = {}) {
    this.rate = opts.syllablesPerSec ?? 4.6;
    this.speaking = false;
    this._t0 = 0;
    /** @type {{ start: number, dur: number, groups: string[] }|null} */
    this._word = null;
    this._lastBoundary = -Infinity;
  }

  /** @param {number} now seconds @param {number} [rateScale] the utterance rate (1 = normal) */
  start(now, rateScale = 1) {
    this.speaking = true;
    this._t0 = now;
    this._word = null;
    this._scale = rateScale > 0 ? rateScale : 1;
  }

  /** @param {number} _now */
  stop(_now) {
    this.speaking = false;
    this._word = null;
  }

  /**
   * A word boundary event (SpeechSynthesisUtterance 'boundary', name 'word').
   * @param {number} now @param {string} word
   */
  word(now, word) {
    const syl = Math.max(1, countSyllables(word));
    const groups = vowelGroups(word);
    this._word = { start: now, dur: syl / (this.rate * (this._scale || 1)), groups };
    this._lastBoundary = now;
  }

  /** @param {number} now @returns {MouthShape & { level: number }} */
  sample(now) {
    if (!this.speaking) return { ...SIL, level: 0 };
    const w = this._word;
    if (w && now - w.start < w.dur) {
      const n = Math.max(1, Math.round(w.dur * this.rate * (this._scale || 1)));
      const ph = ((now - w.start) / w.dur) * n;
      const k = Math.min(n - 1, Math.floor(ph));
      const open = Math.sin(Math.PI * (ph - k)); // one open/close per syllable
      const shape = shapeForVowels(w.groups[k % w.groups.length]);
      const s = mixShapes(SIL, shape, 0.35 + 0.65 * open);
      return { ...s, level: 0.25 + 0.5 * open };
    }
    // Boundary events recently → we are between words: rest the mouth.
    if (now - this._lastBoundary < 0.6) return { ...SIL, level: 0.1 };
    // No boundary events at all: free-running syllables with slow variation.
    const t = now - this._t0;
    const ph = t * this.rate * (this._scale || 1);
    const open = Math.max(0, Math.sin(Math.PI * (ph % 1))) * (0.65 + 0.35 * Math.sin(t * 1.7));
    const vowel = ['aa', 'E', 'O', 'I', 'aa', 'U'][Math.floor(ph) % 6];
    const s = mixShapes(SIL, visemeShape(vowel), clamp01(open));
    return { ...s, level: 0.2 + 0.5 * clamp01(open) };
  }
}

/**
 * Per-frame lip-sync driver over an AudioPlayer-like object:
 *   player.current: { clip, kind: 'audio'|'speech', time: number } | null
 *   player.level(): number           (linear RMS of the output, audio clips)
 *   player.spectrum(Float32Array): boolean   (dB data; false when unavailable)
 *   player.sampleRate: number
 */
export class LipSync {
  /**
   * @param {{ player: any, oscillator?: SyllableOscillator, now?: () => number }} deps
   *   now: seconds clock, the same one passed to update()
   */
  constructor(deps) {
    this.player = deps.player;
    this.osc = deps.oscillator || new SyllableOscillator();
    this._now = deps.now || (() => (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    this._freq = new Float32Array(1024);
    this._sm = { jaw: 0, wide: 0, round: 0, level: 0 };
    /** @type {Array<() => void>} */
    this._offs = [];
    const p = this.player;
    if (p && typeof p.on === 'function') {
      // Web Speech clips: drive the syllable oscillator from the utterance's word boundaries.
      this._offs.push(
        p.on('start', (clip) => { if (clip?.kind === 'speech') this.osc.start(this._now(), clip.rate || 1); }),
        p.on('end', (clip) => { if (clip?.kind === 'speech') this.osc.stop(this._now()); }),
        p.on('boundary', (ev) => this.osc.word(this._now(), ev?.word || '')),
      );
    }
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
  }

  /**
   * @param {number} dt seconds since the previous update
   * @param {number} now seconds (for the oscillator)
   * @returns {MouthShape & { level: number, source: 'visemes'|'audio'|'speech'|'none' }}
   */
  update(dt, now) {
    const cur = this.player && this.player.current;
    /** @type {MouthShape & { level: number }} */
    let target;
    let source = /** @type {'visemes'|'audio'|'speech'|'none'} */ ('none');
    if (cur && cur.kind === 'audio') {
      const lvl = this.player.level();
      const level = dbToUnit(toDb(lvl), -50, -14);
      const tl = cur.clip.visemes;
      if (tl && tl.length) {
        target = { ...mouthFromVisemes(tl, cur.time), level };
        source = 'visemes';
      } else {
        const bins = this.player.analyser?.frequencyBinCount;
        if (bins && this._freq.length !== bins) this._freq = new Float32Array(bins);
        const ok = this.player.spectrum(this._freq);
        const bands = ok ? bandEnergies(this._freq, this.player.sampleRate || 48000, AUDIO_BANDS) : [];
        target = { ...mouthFromAudio(lvl, bands), level };
        source = 'audio';
      }
    } else if (cur && cur.kind === 'speech') {
      target = this.osc.sample(now);
      source = 'speech';
    } else {
      target = { ...SIL, level: 0 };
    }
    // light smoothing (visemes are already blended; audio needs a little more)
    const tau = source === 'visemes' ? 0.025 : 0.05;
    const k = 1 - Math.exp(-Math.max(0, dt) / tau);
    const sm = this._sm;
    sm.jaw += (target.jaw - sm.jaw) * k;
    sm.wide += (target.wide - sm.wide) * k;
    sm.round += (target.round - sm.round) * k;
    sm.level += (target.level - sm.level) * (1 - Math.exp(-Math.max(0, dt) / 0.08));
    return { jaw: sm.jaw, wide: sm.wide, round: sm.round, level: sm.level, source };
  }
}
