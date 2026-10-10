// A thin wrapper over the raw sherpa-onnx N-API addon (sherpa-onnx.node 1.13.8), replacing the
// sherpa-onnx-node JavaScript package (contract-wake §7.4): the addon is vendored like go2rtc and
// loaded by path, so there is no node_modules dependency. Runs in the utility process, in the
// engine test and in scripts/wake-smoke.mjs (plain Node: the addon is N-API).
//
// Facts this relies on (verified with 1.13.8, contract-probe/ and this lane's probes):
//  * keywords can be passed from memory (keywordsBuf/keywordsBufSize), so no keyword files ship;
//  * a stream's keyword list is the spotter's: createKeywordStream ignores a second argument, so
//    other thresholds need another spotter (createSpotter again);
//  * a result is JSON {"start_time":0,"keyword":"HEY_JADE","timestamps":[…],"tokens":[…]} with
//    times relative to the stream start, and no score;
//  * streams are N-API externals freed by a finalizer after a GC: the native state (~0.3 MB each)
//    is invisible to V8, so the caller collects garbage now and then (utility/engine.js);
//  * one thread per decoder (numThreads 1): a spotter's work stays on the calling thread.

import { createRequire } from 'node:module';

import { SAMPLE_RATE, SPOTTER_DEFAULTS, VAD_DEFAULTS } from '../config.js';

const REQUIRED = [
  'createKeywordSpotter', 'createKeywordStream', 'acceptWaveformOnline', 'isKeywordStreamReady', 'decodeKeywordStream',
  'getKeywordResultAsJson', 'resetKeywordStream', 'createVoiceActivityDetector', 'voiceActivityDetectorAcceptWaveform',
  'voiceActivityDetectorIsDetected', 'voiceActivityDetectorIsEmpty', 'voiceActivityDetectorPop', 'voiceActivityDetectorReset',
];

/**
 * Load the raw addon (Windows: its DLLs sit next to it; Linux: RUNPATH $ORIGIN).
 * @param {string} file absolute path of sherpa-onnx.node
 */
export function loadAddon(file) {
  const req = createRequire(import.meta.url);
  const addon = req(file);
  const missing = REQUIRED.filter((fn) => typeof addon?.[fn] !== 'function');
  if (missing.length) throw new Error(`the sherpa-onnx addon at ${file} lacks ${missing.join(', ')}`);
  return addon;
}

/**
 * @typedef {{ encoder: string, decoder: string, joiner: string, tokens: string }} ModelPaths
 * @typedef {{ keyword: string, timestamps: number[], tokens: string[], startTime: number }} SpotterHit
 */

/**
 * A keyword spotter (one loaded model with one keyword list). Creating one takes about a second.
 * @param {any} addon
 * @param {{ model: ModelPaths, keywords: string, threshold: number, maxActivePaths?: number, numTrailingBlanks?: number, keywordsScore?: number }} o
 */
export function createSpotter(addon, o) {
  const keywords = String(o.keywords);
  const handle = addon.createKeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: o.model.encoder, decoder: o.model.decoder, joiner: o.model.joiner },
      tokens: o.model.tokens,
      numThreads: SPOTTER_DEFAULTS.numThreads,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: o.maxActivePaths ?? SPOTTER_DEFAULTS.maxActivePaths,
    numTrailingBlanks: o.numTrailingBlanks ?? SPOTTER_DEFAULTS.numTrailingBlanks,
    keywordsScore: o.keywordsScore ?? SPOTTER_DEFAULTS.keywordsScore,
    keywordsThreshold: o.threshold,
    keywordsBuf: keywords,
    keywordsBufSize: Buffer.byteLength(keywords),
  });
  return {
    handle,
    newStream: () => addon.createKeywordStream(handle),
    /** @param {any} s @param {Float32Array} samples */
    accept: (s, samples) => addon.acceptWaveformOnline(s, { sampleRate: SAMPLE_RATE, samples }),
    /** Decode what is ready; every keyword found resets the stream (the recipe renews it anyway). @param {any} s @returns {SpotterHit[]} */
    drain: (s) => {
      /** @type {SpotterHit[]} */
      const out = [];
      while (addon.isKeywordStreamReady(handle, s)) {
        addon.decodeKeywordStream(handle, s);
        const r = JSON.parse(addon.getKeywordResultAsJson(handle, s));
        if (r && r.keyword) {
          out.push({ keyword: String(r.keyword), timestamps: Array.isArray(r.timestamps) ? r.timestamps.map(Number) : [], tokens: Array.isArray(r.tokens) ? r.tokens.map(String) : [], startTime: Number(r.start_time) || 0 });
          addon.resetKeywordStream(handle, s);
        }
      }
      return out;
    },
    /** @param {any} s */
    reset: (s) => addon.resetKeywordStream(handle, s),
  };
}

/** Uninterrupted "speech" (music, a TV with no pauses) after which the VAD is reset (its buffer holds the segment). */
export const VAD_MAX_CONTINUOUS_SEC = 25;

/**
 * sherpa-onnx's Silero VAD. accept() returns isDetected() after the block and drops the speech
 * segments the detector collects (we only need the state). The detector keeps the samples of the
 * segment in progress; after VAD_MAX_CONTINUOUS_SEC without a pause it is reset, which bounds that
 * buffer (measured: 20 minutes of gapless real speech never got there, one long music segment did).
 * @param {any} addon
 * @param {{ model: string, threshold?: number, minSpeechDuration?: number, minSilenceDuration?: number, windowSize?: number, maxSpeechDuration?: number, bufferSec?: number, maxContinuousSec?: number }} o
 */
export function createVad(addon, o) {
  const maxRun = Math.round((o.maxContinuousSec ?? VAD_MAX_CONTINUOUS_SEC) * SAMPLE_RATE);
  let run = 0;
  const h = addon.createVoiceActivityDetector({
    sileroVad: {
      model: o.model,
      threshold: o.threshold ?? VAD_DEFAULTS.threshold,
      minSilenceDuration: o.minSilenceDuration ?? VAD_DEFAULTS.minSilenceDuration,
      minSpeechDuration: o.minSpeechDuration ?? VAD_DEFAULTS.minSpeechDuration,
      windowSize: o.windowSize ?? VAD_DEFAULTS.windowSize,
      maxSpeechDuration: o.maxSpeechDuration ?? VAD_DEFAULTS.maxSpeechDuration,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, o.bufferSec ?? VAD_DEFAULTS.bufferSec);
  return {
    /** @param {Float32Array} x */
    accept(x) {
      addon.voiceActivityDetectorAcceptWaveform(h, x);
      const d = !!addon.voiceActivityDetectorIsDetected(h);
      while (!addon.voiceActivityDetectorIsEmpty(h)) addon.voiceActivityDetectorPop(h);
      run = d ? run + x.length : 0;
      if (run >= maxRun) {
        addon.voiceActivityDetectorReset(h);
        run = 0;
      }
      return d;
    },
    reset() {
      run = 0;
      addon.voiceActivityDetectorReset(h);
    },
  };
}
