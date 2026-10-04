// AudioWorklet processor for microphone capture: batches the 128-sample render quanta into
// ~2048-sample Float32 blocks (mono: channel average) and posts them to the main thread.
// Loaded by src/audio/mic.js as a same-origin module (allowed by the app's CSP); keep this file
// free of imports. The same code is embedded in mic.js as a Blob-URL fallback — keep in sync.
/* global AudioWorkletProcessor, registerProcessor */

class LawnmowerCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._size = 2048;
    this._buf = new Float32Array(this._size);
    this._n = 0;
    this._alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._alive = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch0 = input[0];
      const chans = input.length;
      for (let i = 0; i < ch0.length; i++) {
        let v = ch0[i];
        for (let c = 1; c < chans; c++) v += input[c][i];
        this._buf[this._n++] = chans > 1 ? v / chans : v;
        if (this._n === this._size) {
          const out = this._buf;
          this.port.postMessage(out, [out.buffer]);
          this._buf = new Float32Array(this._size);
          this._n = 0;
        }
      }
    }
    return this._alive;
  }
}

registerProcessor('lawnmower-capture', LawnmowerCaptureProcessor);
