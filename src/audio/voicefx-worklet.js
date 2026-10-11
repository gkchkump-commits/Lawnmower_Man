// AudioWorklet processor: the voice character effect (voicefx.js) on the audio rendering
// thread, so it costs the main thread nothing and adds no latency (one 128-sample block).
//
// One node lives for the whole session; the player routes each local-voice clip through it (or
// around it, for 'natural'), so effect tails ring out naturally across clips. Messages:
//   { type: 'set', character, amount }          change the character (ramped, no clicks)
//   { type: 'clip', samples, rate, startTime }  the dry clip about to play at context time
//                                               `startTime`: its pitch is analysed ahead
//   { type: 'stats', id }                       → { type: 'stats', id, character, amount,
//                                                  blocks, clipBlocks, inSq, outSq, diffSq,
//                                                  busyMs, workBlocks, pitchSource, failed }
// A bug in the DSP must never silence the voice: the processor then passes the input through
// and reports { type: 'error', message } once.
//
// Warm-up: until the first clip arrives the effect only ever runs its silent paths, so the first
// voiced clip of a session would run the pitch analysis and the voiced DSP in V8's interpreter on
// the audio thread (blocks of 4-7 ms against a 2.7 ms budget: a crackle at the start of the first
// reply). While the node idles, a scratch VoiceFx therefore runs ONE block per process() call of
// a synthetic voice (a harmonic saw gliding 100-250 Hz with voiced and silent stretches, handed
// over with setClip like a real clip) through synth, vocoder and robot, into a buffer that is
// never output, and is dropped after ~450 blocks (~1.2 s), or as soon as a clip arrives or the
// real effect wakes. The real effect is never touched (processorOptions.warmUp: false skips it).
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

import { VoiceFx } from './voicefx.js';

/** Blocks at which the warm-up switches character, and when it ends. */
const WARM_STEPS = Object.freeze({ vocoder: 200, robot: 300, end: 450 });
const WARM_CLIP_RATE = 24000; // the local voice's clips (Kokoro) are 24 kHz

/**
 * A synthetic voice: a harmonic-rich saw gliding 100 -> 250 Hz under a syllabic envelope, with a
 * hiss (a fricative) in the gaps between some syllables and a silent end, `seconds` long at
 * `rate` (voiced, unvoiced and silent stretches: every branch the effect has for speech).
 * @param {number} rate @param {number} [seconds]
 */
function warmSignal(rate, seconds = 1) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let ph = 0;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 100 + 150 * (t / seconds);
    ph += f / rate;
    const saw = 2 * (ph - Math.floor(ph)) - 1;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const hiss = (seed / 4294967296) * 2 - 1;
    // syllables of 0.21 s: 80 % voiced, then a short hiss after every other one; the end silent
    const k = Math.floor(t / 0.21);
    const syl = (t % 0.21) / 0.21;
    const env = t > seconds - 0.15 ? 0 : syl < 0.8 ? Math.sin(Math.PI * syl / 0.8) ** 2 : 0;
    const fric = t > seconds - 0.15 || k % 2 || syl < 0.8 ? 0 : Math.sin(Math.PI * (syl - 0.8) / 0.2);
    out[i] = 0.25 * env * saw + 0.06 * fric * hiss;
  }
  return out;
}

/** The scratch effect and its synthetic voice (see the warm-up note above). */
class WarmUp {
  /** @param {number} sr */
  constructor(sr) {
    this.fx = new VoiceFx(sr, { character: 'synth', amount: 0.6 });
    this.clip = warmSignal(WARM_CLIP_RATE);
    this.input = warmSignal(sr);
    this.inBuf = new Float32Array(128);
    this.outBuf = new Float32Array(128);
    this.pos = 0;
    this.blocks = 0;
    this.fx.setClip(this.clip, WARM_CLIP_RATE, 0);
  }

  /** One block of work; false when the warm-up is over. */
  step() {
    const b = ++this.blocks;
    if (b >= WARM_STEPS.end) return false;
    if (b === WARM_STEPS.vocoder || b === WARM_STEPS.robot) {
      this.fx.configure({ character: b === WARM_STEPS.vocoder ? 'vocoder' : 'robot', amount: 0.7 });
      this.pos = 0;
      this.fx.setClip(this.clip, WARM_CLIP_RATE, 0);
    }
    const x = this.input;
    for (let i = 0; i < 128; i++) this.inBuf[i] = x[(this.pos + i) % x.length];
    this.pos = (this.pos + 128) % x.length;
    this.fx.process(this.inBuf, this.outBuf);
    return true;
  }
}

class LawnmowerVoiceFxProcessor extends AudioWorkletProcessor {
  /** @param {{ processorOptions?: { character?: any, amount?: number } }} [options] */
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.fx = new VoiceFx(sampleRate, { character: o.character, amount: o.amount });
    /** @type {null | { samples: Float32Array, rate: number, startTime: number }} */
    this.pendingClip = null;
    this.failed = false;
    /** @type {WarmUp|null} the warm-up (see above); started once the real effect first idles */
    this._warm = o.warmUp === false ? null : new WarmUp(sampleRate);
    this._warmStarted = false;
    // what the effect did to the voice (tests and diagnostics): blocks with input, how many of
    // them had the pitch from the clip's look-ahead analysis, and the energy of the input, the
    // output and their difference over those blocks
    // `busyMs` / `workBlocks`: time spent in the effect (Date.now() is the clock a worklet has;
    // ms steps, but unbiased summed over many blocks) and the blocks it did work in
    this.stats = { blocks: 0, clipBlocks: 0, inSq: 0, outSq: 0, diffSq: 0, busyMs: 0, workBlocks: 0 };
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  /** @param {any} m */
  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'set') this.fx.configure({ character: m.character, amount: m.amount });
    else if (m.type === 'clip' && m.samples instanceof Float32Array) this.pendingClip = m;
    else if (m.type === 'stats') {
      this.port.postMessage({ type: 'stats', id: m.id, character: this.fx.character, amount: this.fx.amount, failed: this.failed, pitchSource: this.fx.pitchSource, ...this.stats });
    }
  }

  /** @param {Float32Array[][]} inputs @param {Float32Array[][]} outputs */
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    // an input with nothing connected has no channels
    const input = inputs[0] && inputs[0].length ? inputs[0][0] : null;
    if (this.failed) {
      if (input) out.set(input);
      else out.fill(0);
      return true;
    }
    try {
      const c = this.pendingClip;
      if (c) {
        this.pendingClip = null;
        this.fx.setClip(c.samples, c.rate, Math.round(c.startTime * sampleRate) - currentFrame);
      }
      const busy = !this.fx.idle;
      const t0 = busy ? Date.now() : 0;
      this.fx.process(input, out);
      if (busy) {
        this.stats.busyMs += Date.now() - t0;
        this.stats.workBlocks++;
      }
      this._warmStep(c);
    } catch (err) {
      this.failed = true;
      if (input) out.set(input);
      else out.fill(0);
      this.port.postMessage({ type: 'error', message: String(/** @type {any} */ (err)?.message || err) });
      return true;
    }
    if (input) {
      let a = 0;
      let b = 0;
      let d = 0;
      for (let i = 0; i < out.length; i++) {
        const x = input[i];
        const y = out[i];
        a += x * x;
        b += y * y;
        d += (y - x) * (y - x);
      }
      if (a > 0) {
        const s = this.stats;
        s.blocks++;
        if (this.fx.pitchSource === 'clip') s.clipBlocks++;
        s.inSq += a;
        s.outSq += b;
        s.diffSq += d;
      }
    }
    return true;
  }

  /**
   * One warm-up block while the real effect idles (never on a block that does real work).
   * @param {any} clipNow the clip handed to the real effect in this block, if any
   */
  _warmStep(clipNow) {
    const w = this._warm;
    if (!w) return;
    const idle = this.fx.idle && !this.pendingClip && !clipNow;
    // a clip arrived, or the real effect woke up after the warm-up began: stop for good
    if (clipNow || this.pendingClip || (this._warmStarted && !idle)) {
      this._warm = null;
      return;
    }
    if (!idle) return;
    this._warmStarted = true;
    try {
      if (!w.step()) this._warm = null;
    } catch {
      this._warm = null; // the warm-up is an optimisation: never let it fail the real effect
    }
  }
}

registerProcessor('lawnmower-voicefx', LawnmowerVoiceFxProcessor);
