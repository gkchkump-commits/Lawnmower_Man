// In-page fake of the voice server's HTTP API (contract §6), used by the mock bridge with
// ?voice=fake so the whole voice pipeline (TTS → WAV → Web Audio → visemes → lip-sync, and
// mic → WAV → STT) runs in a plain browser and in Playwright without Python or models.
//
// /tts synthesises a buzzy formant "voice" with an exact viseme timeline, /stt returns a canned
// transcript for any non-silent audio, /health and /voices describe a fake GPU server.
/* global Response, DOMException */

import { decodeWav, encodeWav, bytesToBase64 } from '../audio/wav.js';

const SR = 24000;
const VOWEL_FORMANTS = { aa: [750, 1250], E: [550, 1800], I: [320, 2300], O: [500, 900], U: [330, 800], RR: [450, 1300] };
const LETTER_VISEME = {
  a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I',
  b: 'PP', m: 'PP', p: 'PP', f: 'FF', v: 'FF', t: 'DD', d: 'DD', n: 'DD', l: 'DD',
  k: 'kk', g: 'kk', c: 'kk', q: 'kk', x: 'kk', j: 'CH', s: 'SS', z: 'SS', r: 'RR', h: 'kk', w: 'U',
};

export const FAKE_TRANSCRIPT = 'Hello Claude, can you hear me?';

export const FAKE_HEALTH = Object.freeze({
  ok: true,
  version: 'mock',
  fake: true,
  device: { cuda: true, name: 'NVIDIA GeForce RTX 5070 Laptop GPU (fake)', capability: '12.0', vramTotalMB: 8151, vramFreeMB: 6900, warnings: [] },
  stt: { backend: 'fake', model: 'large-v3-turbo', device: 'cuda', loaded: true },
  tts: { backend: 'fake', device: 'cuda', loaded: true, voices: ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george'], defaultVoice: 'af_heart' },
});

const FAKE_VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'en-us', gender: 'f' },
  { id: 'af_bella', name: 'Bella', lang: 'en-us', gender: 'f' },
  { id: 'am_michael', name: 'Michael', lang: 'en-us', gender: 'm' },
  { id: 'bf_emma', name: 'Emma', lang: 'en-gb', gender: 'f' },
  { id: 'bm_george', name: 'George', lang: 'en-gb', gender: 'm' },
];

/**
 * Synthesize text into a fake voice with a viseme timeline.
 * @param {string} text @param {number} [speed]
 */
export function fakeSynthesize(text, speed = 1) {
  const s = Math.min(2, Math.max(0.5, Number(speed) || 1));
  /** @type {Array<{ viseme: string, dur: number }>} */
  const segs = [{ viseme: 'sil', dur: 0.06 }];
  for (const word of String(text).toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const ch of word.replace(/[^a-z0-9]/g, '')) {
      const v = /** @type {any} */ (LETTER_VISEME)[ch] || 'aa';
      const vowel = v in VOWEL_FORMANTS;
      segs.push({ viseme: v, dur: (vowel ? 0.085 : 0.05) / s });
    }
    segs.push({ viseme: 'sil', dur: 0.07 / s });
  }
  // merge repeats (the real server never repeats a viseme twice in a row)
  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && last.viseme === g.viseme) last.dur += g.dur;
    else merged.push({ ...g });
  }
  const total = merged.reduce((a, g) => a + g.dur, 0);
  const n = Math.max(1, Math.round(total * SR));
  const out = new Float32Array(n);
  const visemes = [];
  let t = 0;
  let phase = 0;
  let seed = 12345;
  for (const g of merged) {
    const a = Math.round(t * SR);
    const b = Math.min(n, Math.round((t + g.dur) * SR));
    const f = /** @type {any} */ (VOWEL_FORMANTS)[g.viseme];
    for (let i = a; i < b; i++) {
      const u = (i - a) / Math.max(1, b - a);
      const env = Math.sin(Math.PI * u) ** 0.6;
      let x = 0;
      if (f) {
        phase += (2 * Math.PI * 130) / SR; // glottal pitch
        const tt = i / SR;
        x = 0.5 * Math.sin(phase) * (0.6 * Math.sin(2 * Math.PI * f[0] * tt) + 0.4 * Math.sin(2 * Math.PI * f[1] * tt));
      } else if (g.viseme !== 'sil' && g.viseme !== 'PP') {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        x = ((seed / 4294967296) * 2 - 1) * (g.viseme === 'SS' ? 0.18 : 0.08);
      }
      out[i] = x * env * 0.6;
    }
    visemes.push({ start: round3(t), end: round3(t + g.dur), viseme: g.viseme });
    t += g.dur;
  }
  if (visemes.length) visemes[visemes.length - 1].end = round3(n / SR);
  return { sampleRate: SR, samples: out, visemes, durationSec: n / SR };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * A fetch() implementation answering the voice-server endpoints.
 * @param {{ transcript?: string, latencyMs?: number, token?: string }} [o]
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
 */
export function createFakeVoiceFetch(o = {}) {
  const latency = o.latencyMs ?? 60;
  const token = o.token || 'mock-token';
  return async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    const method = (init.method || 'GET').toUpperCase();
    await wait(latency, init.signal);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/health') return json(200, FAKE_HEALTH);
    const auth = /** @type {any} */ (init.headers || {}).Authorization || /** @type {any} */ (init.headers || {}).authorization;
    if (auth !== `Bearer ${token}`) return json(401, { error: 'Missing or invalid token', code: 'unauthorized' });
    if (u.pathname === '/voices' && method === 'GET') return json(200, FAKE_VOICES);
    if (u.pathname === '/warmup' && method === 'POST') return json(200, { ok: true, stt: true, tts: true });
    if (u.pathname === '/tts' && method === 'POST') {
      let body;
      try {
        body = JSON.parse(String(init.body || '{}'));
      } catch {
        return json(400, { error: 'Invalid JSON', code: 'bad_request' });
      }
      const text = String(body.text || '').trim();
      if (!text) return json(400, { error: 'text is required', code: 'bad_request' });
      const t0 = Date.now();
      const r = fakeSynthesize(text, body.speed);
      return json(200, {
        sampleRate: r.sampleRate,
        audioB64: bytesToBase64(new Uint8Array(encodeWav(r.samples, r.sampleRate))),
        durationSec: r.durationSec,
        processingMs: Date.now() - t0,
        visemes: r.visemes,
        voice: body.voice || 'af_heart',
      });
    }
    if (u.pathname === '/stt' && method === 'POST') {
      let level = 0;
      try {
        const buf = init.body instanceof Blob ? await init.body.arrayBuffer() : /** @type {ArrayBuffer} */ (init.body);
        const d = decodeWav(buf);
        let acc = 0;
        for (let i = 0; i < d.samples.length; i++) acc += d.samples[i] * d.samples[i];
        level = d.samples.length ? Math.sqrt(acc / d.samples.length) : 0;
        return json(200, { text: level > 1e-4 ? o.transcript || FAKE_TRANSCRIPT : '', language: 'en', durationSec: d.durationSec, processingMs: latency });
      } catch (err) {
        return json(400, { error: `Bad audio: ${err?.message || err}`, code: 'bad_audio' });
      }
    }
    return json(404, { error: 'not found', code: 'not_found' });
  };
}

/** @param {number} ms @param {AbortSignal|null|undefined} signal */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}
