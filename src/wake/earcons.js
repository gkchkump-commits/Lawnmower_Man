// Jade's earcons, synthesized (no asset files): ported from the UX research (wake/earcons/).
//
// Rules (ux.md A11Y-7): at most 200 ms; fundamentals 500-1200 Hz (audible with age-related
// high-frequency loss, below the 2-4 kHz band where consonants live); a soft 6 ms attack and an
// 8 ms release (no click); "wake" peaks at -18 dBFS, quieter than her voice. Rising = "I'm
// listening", falling = "I stopped listening", a low glide pair for microphone off / on.
// They are played through the player's AudioContext (AudioPlayer.playCue), so Chromium's echo
// canceller has them in its reference and the microphone does not hear them as speech.

/** @typedef {{ f0: number, f1?: number, at: number, dur: number, gain: number }} Note */
/** @typedef {'wake'|'done'|'micOff'|'micOn'} EarconName */

/** @type {Readonly<Record<EarconName, { peakDb: number, notes: Note[] }>>} */
export const EARCONS = Object.freeze({
  // "I heard my name, go ahead": two quick rising notes (a fifth, 660 → 990 Hz)
  wake: { peakDb: -18, notes: [{ f0: 660, at: 0, dur: 0.07, gain: 0.8 }, { f0: 990, at: 0.055, dur: 0.11, gain: 1 }] },
  // "I stopped listening" (Sounds › Start + end): the same fifth, falling, quieter
  done: { peakDb: -24, notes: [{ f0: 880, at: 0, dur: 0.06, gain: 1 }, { f0: 587, at: 0.05, dur: 0.1, gain: 0.85 }] },
  // microphone off / on: low, with a glide, so they are not confused with wake / done
  micOff: { peakDb: -20, notes: [{ f0: 520, f1: 390, at: 0, dur: 0.16, gain: 1 }] },
  micOn: { peakDb: -20, notes: [{ f0: 390, f1: 520, at: 0, dur: 0.16, gain: 1 }] },
});

/** Length of an earcon in milliseconds. @param {EarconName} name */
export function earconDurationMs(name) {
  const spec = EARCONS[name];
  if (!spec) return 0;
  return Math.max(...spec.notes.map((n) => n.at + n.dur)) * 1000;
}

/**
 * Render an earcon as mono samples at `sampleRate`, normalized to its peak level.
 * @param {EarconName} name @param {number} [sampleRate]
 * @returns {Float32Array}
 */
export function renderEarcon(name, sampleRate = 48000) {
  const spec = EARCONS[name];
  if (!spec) throw new Error(`unknown earcon "${name}"`);
  const end = Math.max(...spec.notes.map((n) => n.at + n.dur));
  const out = new Float32Array(Math.ceil(end * sampleRate) + 1);
  for (const n of spec.notes) {
    const i0 = Math.round(n.at * sampleRate);
    const len = Math.round(n.dur * sampleRate);
    let phase = 0;
    for (let i = 0; i < len && i0 + i < out.length; i++) {
      const t = i / sampleRate;
      const f = n.f1 ? n.f0 + (n.f1 - n.f0) * (i / len) : n.f0;
      phase += (2 * Math.PI * f) / sampleRate;
      const attack = Math.min(1, t / 0.006);
      const decay = Math.exp(-t / (n.dur * 0.35));
      const release = Math.min(1, (len - i) / (0.008 * sampleRate)); // no click at the end
      // a soft "glass" timbre: the fundamental plus a little 2nd and 3rd partial
      const s = Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase);
      out[i0 + i] += n.gain * attack * decay * release * s;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const target = 10 ** (spec.peakDb / 20);
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= target / peak;
  return out;
}

/** Rendered earcons, per name and rate (each is rendered once). */
const cache = new Map();

/** @param {EarconName} name @param {number} sampleRate */
export function earconSamples(name, sampleRate) {
  const key = `${name}@${sampleRate}`;
  let x = cache.get(key);
  if (!x) cache.set(key, (x = renderEarcon(name, sampleRate)));
  return x;
}
