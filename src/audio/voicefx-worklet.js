// AudioWorklet processor: the voice character effect (voicefx.js) on the audio rendering
// thread, so it costs the main thread nothing and adds no latency (one 128-sample block).
//
// One node lives for the whole session; the player routes each local-voice clip through it (or
// around it, for 'natural'), so effect tails ring out naturally across clips. Messages:
//   { type: 'set', character, amount }          change the character (ramped, no clicks)
//   { type: 'clip', samples, rate, startTime }  the dry clip about to play at context time
//                                               `startTime`: its pitch is analysed ahead
//   { type: 'stats', id }                       → { type: 'stats', id, character, amount,
//                                                  blocks, inSq, outSq, diffSq, pitchSource }
// A bug in the DSP must never silence the voice: the processor then passes the input through
// and reports { type: 'error', message } once.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

import { VoiceFx } from './voicefx.js';

class LawnmowerVoiceFxProcessor extends AudioWorkletProcessor {
  /** @param {{ processorOptions?: { character?: any, amount?: number } }} [options] */
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.fx = new VoiceFx(sampleRate, { character: o.character, amount: o.amount });
    /** @type {null | { samples: Float32Array, rate: number, startTime: number }} */
    this.pendingClip = null;
    this.failed = false;
    // what the effect did to the voice (tests and diagnostics): blocks with input, and the
    // energy of the input, the output and their difference over those blocks
    this.stats = { blocks: 0, inSq: 0, outSq: 0, diffSq: 0 };
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
      this.fx.process(input, out);
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
        s.inSq += a;
        s.outSq += b;
        s.diffSq += d;
      }
    }
    return true;
  }
}

registerProcessor('lawnmower-voicefx', LawnmowerVoiceFxProcessor);
