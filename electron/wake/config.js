// "Hey Jade" wake-word engine: keywords, thresholds, recipe constants and the pinned engine files
// (contract-wake §5.4, §7.7). Pure: no Electron, no file access. Shared by the main process
// (paths.js checks the sizes), the utility process (buildConfig) and scripts/fetch-wake.mjs (the
// SHA-256 pins), so the numbers live in one place.
//
// Two tiny sherpa-onnx keyword-spotting models run on the same audio and are OR-ed:
//   zhen (model A): sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, CMU phones. Most precise; no
//                   stated licence, so it is never shipped: the voice downloader fetches it on the
//                   user's PC (voice/lawnmower_voice/download.py --kws).
//   giga (model B): sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01, BPE-500. More robust in
//                   noise; Apache-2.0 per its model card; shipped in resources/wake/.
// Both: int8 encoder + joiner, fp32 decoder, chunk-16, beam 16, one thread (eval.md §0.1).

export const SHERPA_VERSION = '1.13.8';
export const ONNXRUNTIME_VERSION = '1.28.2';
export const SAMPLE_RATE = 16000;

/**
 * Keyword lines (tokens, then `@label`). Lines with the same label are pronunciation variants.
 * `HEY_JUDE` is a non-overlapping label that soaks up the song title; decoys that share the start
 * or end of "hey jade" (HEY_JAY, OKAY_JADE, …) steal recall and are deliberately absent (eval.md §3).
 * The name keywords (JADE) run in a separate stream, only with wake.phrase = 'jade'.
 */
export const KEYWORDS = Object.freeze({
  zhen: 'HH EY1 JH EY1 D @HEY_JADE\nEY1 JH EY1 D @HEY_JADE\nHH EY1 JH EY1 T @HEY_JADE\nHH EY2 JH EY1 D @HEY_JADE\nHH EY1 JH UW1 D @HEY_JUDE\n',
  giga: '▁HE Y ▁JA DE @HEY_JADE\n▁HE Y ▁JU DE @HEY_JUDE\n',
  nameZhen: 'JH EY1 D @JADE\n',
  nameGiga: '▁JA DE @JADE\n',
});

/** The labels a hit can carry. */
export const LABELS = Object.freeze(['HEY_JADE', 'HEY_JUDE', 'JADE']);

/**
 * Thresholds per model (`keywords_threshold`, the mean token probability a keyword needs) and the
 * stage-2 veto mode the renderer applies (§8.6). `gigaOnly` is model B's threshold when model A is
 * missing. normal = the eval's winner (A-var t0.10 + B t0.05); high = +3 points of noisy recall
 * (zh-en t0.05) with the Jude-only veto; low = fewer false wakes (strict / media-burst mode).
 */
export const SENSITIVITY = Object.freeze({
  low: Object.freeze({ zhen: 0.15, giga: 0.10, gigaOnly: 0.25, veto: 'full' }),
  normal: Object.freeze({ zhen: 0.10, giga: 0.05, gigaOnly: 0.05, veto: 'full' }),
  high: Object.freeze({ zhen: 0.05, giga: 0.05, gigaOnly: 0.05, veto: 'jude' }),
});

/** The name-only keyword ("Jade, …" at the very start of an utterance): eval.md §6.2 used t0.25. */
export const NAME_THRESHOLD = 0.25;

/** Fixed spotter settings (both models). */
export const SPOTTER_DEFAULTS = Object.freeze({ maxActivePaths: 16, numTrailingBlanks: 1, keywordsScore: 1.0, numThreads: 1 });

/** sherpa-onnx's Silero VAD v4 (verified in contract-probe/stream/stream.cjs). */
export const VAD_DEFAULTS = Object.freeze({ threshold: 0.5, minSpeechDuration: 0.06, minSilenceDuration: 0.1, windowSize: 512, maxSpeechDuration: 30, bufferSec: 30 });

/**
 * The onset recipe (§7.5): a fresh stream at each VAD onset after ≥ quietMs without speech, fed
 * prerollMs of the audio before it; nothing fed hangoverMs after the last speech; a JADE hit counts
 * only when its first token lies within namePrefixMs of the stream start.
 * maxStreamMs / overlapMs: in continuous speech (TV, radio, people talking) a new set of streams
 * starts every maxStreamMs and the old set runs on for overlapMs, so a call across the renewal is
 * still heard whole (a plain renewal at 8 s lost recall on long prose, 243 → 237 of 252, which is
 * why it was off; an endless stream loses wakes and its timestamps drift by seconds under a TV).
 * stampLateMs / reanchorMs: a hit whose last token lies more than stampLateMs before the decision
 * is re-anchored to emitAt - reanchorMs (correct stamps are ≤ 0.56 s before it, drifted ones
 * ≥ 1.88 s; measured over clean, noisy and TV-bed runs), its length kept (≤ maxKeywordMs).
 * agcLookaheadMs: at an utterance onset the spotters' feed waits until this much speech has set the
 * utterance's own level (no added latency: "Jade" ends later); measured on the eval's noisy mix,
 * 198 → 202 of 252 against the previous utterance's gain (docs: the lane report).
 */
export const RECIPE_DEFAULTS = Object.freeze({
  quietMs: 600, prerollMs: 400, hangoverMs: 700, maxStreamMs: 8000, overlapMs: 2000, namePrefixMs: 720, blockSamples: 320, agcLookaheadMs: 300,
  stampLateMs: 900, reanchorMs: 450, maxKeywordMs: 1200,
});

/**
 * The level normaliser in front of the spotters (§7.6). `limit`: a block whose peak would pass it
 * gets less gain instead of clipping.
 */
export const AGC_DEFAULTS = Object.freeze({ targetDb: -20, minGainDb: -6, maxGainDb: 24, tauMs: 300, limit: 0.99 });

/**
 * One installed file: its name inside its folder, exact size and SHA-256.
 * @typedef {{ name: string, size: number, sha256: string, role?: 'encoder'|'decoder'|'joiner'|'tokens' }} PinnedFile
 */

/** The native addon per platform (npm sherpa-onnx-<win|linux>-x64 1.13.8, `package/` members). */
export const ADDON_FILES = Object.freeze({
  'win32-x64': Object.freeze([
    { name: 'sherpa-onnx.node', size: 681984, sha256: 'f5fd562bdc4bea167eee8ac981c6acd88c05cc8d2792b67d8951566818e293ca' },
    { name: 'sherpa-onnx-c-api.dll', size: 4605952, sha256: 'b0801cd8eeead83213c60b92cc004de6f3ac4cd4a9ac7c388c16b97c590f1e99' },
    { name: 'sherpa-onnx-cxx-api.dll', size: 259584, sha256: 'e709c46a63e4b84f3862aa0c843a804040b42ea054a398b420142f6c8e58ec77' },
    { name: 'onnxruntime.dll', size: 17799168, sha256: '7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25' },
    { name: 'onnxruntime_providers_shared.dll', size: 104960, sha256: '551d0e1fe4c227d8542314ba718d52f4379e0c7bfe729a37c59833a884e27b4d' },
  ]),
  'linux-x64': Object.freeze([
    { name: 'sherpa-onnx.node', size: 974496, sha256: 'd8f1181559e7aecaa99493e8c441c16a4d51a18a1f3fcdf48fd7884e510f3767' },
    { name: 'libsherpa-onnx-c-api.so', size: 5116576, sha256: 'b1019f8c9583e3e576c2ba6032b580677fcf6e2230c241a8b423c65aceded021' },
    { name: 'libsherpa-onnx-cxx-api.so', size: 261840, sha256: '795b88737a57f63404c8d17ddd08b5f0c28b5679ee9517cd6766ae95ee6fdb0d' },
    { name: 'libonnxruntime.so', size: 27026609, sha256: '4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e' },
  ]),
});

/** The models, renamed to role names when installed (fetch-wake.mjs, download.py). */
export const MODEL_FILES = Object.freeze({
  giga: Object.freeze([
    { role: 'encoder', name: 'encoder.int8.onnx', size: 4807159, sha256: '1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678' },
    { role: 'decoder', name: 'decoder.onnx', size: 1063189, sha256: 'f61ebd3eed3773a44d088d53dfae92dbb6aec4839f4dcaee2d402414741663a3' },
    { role: 'joiner', name: 'joiner.int8.onnx', size: 163380, sha256: 'eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c' },
    { role: 'tokens', name: 'tokens.txt', size: 5006, sha256: 'fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53' },
  ]),
  zhen: Object.freeze([
    { role: 'encoder', name: 'encoder.int8.onnx', size: 4599656, sha256: '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48' },
    { role: 'decoder', name: 'decoder.onnx', size: 759829, sha256: '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21' },
    { role: 'joiner', name: 'joiner.int8.onnx', size: 86629, sha256: '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1' },
    { role: 'tokens', name: 'tokens.txt', size: 1928, sha256: '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0' },
  ]),
  vad: Object.freeze({ name: 'silero_vad.onnx', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' }),
});

/** Where things sit under the wake folder (vendor/wake/ or resources/wake/). */
export const LAYOUT = Object.freeze({
  addonDir: (/** @type {string} */ platformKey) => `sherpa-onnx/${platformKey}`,
  gigaDir: 'models/gigaspeech-3.3m',
  vad: 'models/silero_vad.onnx',
  zhenDevDir: 'dev-models/zh-en-3m', // fetch:wake --with-zhen only; never packaged
  zhenUserDir: 'kws/zh-en-3m', // under the voice models folder on the user's PC
  licensesDir: 'LICENSES',
});

/**
 * @typedef {object} SpotterSpec
 * @property {'zhen'|'giga'|'name'} name   'name' = the "Jade, …" stream
 * @property {'zhen'|'giga'} model         which loaded model decodes it
 * @property {string} keywords             keyword lines with the threshold folded in (`#t`)
 * @property {number} threshold
 */

/**
 * @typedef {object} WakeEngineConfig     what the utility process runs with (§6.3 `init`/`settings`)
 * @property {SpotterSpec[]} spotters
 * @property {typeof VAD_DEFAULTS} vad
 * @property {typeof RECIPE_DEFAULTS} recipe
 * @property {typeof AGC_DEFAULTS} agc
 * @property {'low'|'normal'|'high'} sensitivity   effective (strict forces 'low')
 * @property {'full'|'jude'} veto
 * @property {boolean} strict
 * @property {'hey-jade'|'jade'} phrase
 */

/**
 * Fold a threshold into every keyword line (`tokens #t @LABEL`). sherpa-onnx reads a per-keyword
 * threshold after `#` (no space after it), so one loaded model serves streams with different
 * thresholds and keyword sets: a sensitivity or phrase change applies at the next fresh stream,
 * without rebuilding the spotter (which blocks for about a second).
 * @param {string} lines @param {number} threshold
 */
export function withThreshold(lines, threshold) {
  const t = Number(threshold);
  if (!(t > 0 && t < 1)) throw new RangeError(`threshold ${threshold} out of (0, 1)`);
  const tag = `#${+t.toFixed(3)}`;
  return lines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.lastIndexOf(' @');
      const head = (at >= 0 ? l.slice(0, at) : l).replace(/\s+#[0-9.]+/g, '').trim();
      return `${head} ${tag}${at >= 0 ? l.slice(at) : ''}`;
    })
    .join('\n') + '\n';
}

/**
 * The engine configuration for the settings (§7.7). `strict` (the media-burst rule) forces 'low'.
 * Without model A, model B runs alone with its `gigaOnly` threshold.
 * @param {{ sensitivity?: string, phrase?: string, strict?: boolean, hasZhen?: boolean }} o
 * @returns {WakeEngineConfig}
 */
export function buildConfig(o = {}) {
  const requested = /** @type {'low'|'normal'|'high'} */ (Object.hasOwn(SENSITIVITY, String(o.sensitivity)) ? o.sensitivity : 'normal');
  const strict = !!o.strict;
  const sensitivity = strict ? 'low' : requested;
  const s = SENSITIVITY[sensitivity];
  const phrase = o.phrase === 'jade' ? 'jade' : 'hey-jade';
  const hasZhen = !!o.hasZhen;
  /** @type {SpotterSpec[]} */
  const spotters = hasZhen
    ? [
        { name: 'zhen', model: 'zhen', threshold: s.zhen, keywords: withThreshold(KEYWORDS.zhen, s.zhen) },
        { name: 'giga', model: 'giga', threshold: s.giga, keywords: withThreshold(KEYWORDS.giga, s.giga) },
      ]
    : [{ name: 'giga', model: 'giga', threshold: s.gigaOnly, keywords: withThreshold(KEYWORDS.giga, s.gigaOnly) }];
  if (phrase === 'jade') {
    spotters.push(hasZhen
      ? { name: 'name', model: 'zhen', threshold: NAME_THRESHOLD, keywords: withThreshold(KEYWORDS.nameZhen, NAME_THRESHOLD) }
      : { name: 'name', model: 'giga', threshold: NAME_THRESHOLD, keywords: withThreshold(KEYWORDS.nameGiga, NAME_THRESHOLD) });
  }
  return { spotters, vad: { ...VAD_DEFAULTS }, recipe: { ...RECIPE_DEFAULTS }, agc: { ...AGC_DEFAULTS }, sensitivity, veto: s.veto, strict, phrase };
}
