// Acoustic analysis of voice clips off the main thread (src/audio/acoustics.js). One message per
// clip: { type: 'analyse', id, audioB64 } (the WAV is decoded here) or { id, samples, sampleRate }.
// The first ~0.8 s is posted as soon as it is analysed (a clip that is already playing), then the
// whole track: { id, track, final }. { type: 'warm' } compiles the analysis on a synthetic voice.
/* global self */
import { AC_HOP, AcousticAnalysis } from './acoustics.js';
import { base64ToBytes, decodeWav } from './wav.js';

const FIRST = Math.round(0.8 / AC_HOP);

function warm() {
  const sr = 24000;
  const x = new Float32Array(Math.round(0.5 * sr));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] = 0.1 * Math.sin(2 * Math.PI * 140 * t) * (1 + Math.sin(2 * Math.PI * 700 * t)) + 0.05 * Math.sin(2 * Math.PI * 1500 * t);
  }
  new AcousticAnalysis(x, sr).advance();
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'warm') {
    try { warm(); } catch { /* not worth reporting */ }
    return;
  }
  if (m.type !== 'analyse') return;
  try {
    let samples = m.samples, rate = m.sampleRate;
    if (!samples) {
      const d = decodeWav(base64ToBytes(m.audioB64));
      samples = d.samples;
      rate = d.sampleRate;
    }
    const a = new AcousticAnalysis(samples, rate);
    a.advance(FIRST);
    if (!a.complete) self.postMessage({ id: m.id, track: a.toTrack(true), final: false });
    a.advance();
    const track = a.toTrack();
    self.postMessage({ id: m.id, track, final: true }, [track.e.buffer, track.lo.buffer, track.hi.buffer, track.f1.buffer, track.f2.buffer, track.f3.buffer, track.voiced.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err), final: true });
  }
};
