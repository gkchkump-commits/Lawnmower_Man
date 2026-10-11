// WakeEngine: stage 1 of "Hey Jade" as it runs in the utility process (contract-wake §7.3):
// Silero VAD onsets → OnsetRecipe → level normaliser → the zh-en (A) and GigaSpeech (B) spotters,
// OR-ed, plus the name-only stream when wake.phrase = 'jade'. No Electron here: the same class runs
// in utility/main.js, scripts/wake-smoke.mjs, tools/wake/eval-folder.mjs and the engine test, so
// the measured numbers are the runtime's.
//
// Threshold or phrase changes (sensitivity, the renderer's media-burst `strict`) need new spotter
// handles (the addon has no per-stream keywords; creating one blocks ≈ 1 s). They are built while
// no stream is active (or after 10 s of continuous speech at the latest), and the recipe swaps at
// its next fresh stream: an utterance in progress finishes with the old thresholds, and the audio
// that arrives during the build waits in the port's queue, so nothing is lost. The strict ('low')
// set of the current phrase is built ahead, at the first quiet moment after loading (a build in the
// middle of a media burst delayed the next hit by 2.6 s, so a call right then was lost), and only
// the current set and its strict twin stay cached (each set holds ≈ 25 MB of ONNX sessions).

import v8 from 'node:v8';
import vm from 'node:vm';

import { LevelNormalizer } from '../agc.js';
import { OnsetRecipe } from '../recipe.js';
import { RECIPE_DEFAULTS, SAMPLE_RATE, VAD_DEFAULTS, buildConfig } from '../config.js';
import { createSpotter, createVad } from './sherpa.js';

/** Collect garbage after this many new streams (each holds ≈ 0.3 MB V8 cannot see). */
const GC_EVERY_STREAMS = 16;
/** the strict twin is built after this much quiet (no stream fed) once loaded or reconfigured */
const PREBUILD_QUIET_SAMPLES = SAMPLE_RATE * 1.5;
const REBUILD_LATEST_MS = 10000;
const RECENT_HITS = 20;

/** @param {{ model: string, threshold: number, keywords: string }} spec */
function spotterKey(spec) {
  return `${spec.model}\n${spec.threshold}\n${spec.keywords}`;
}

/** `gc()` without --expose-gc (the flag is accepted at run time; the function lives in a new context). */
export function exposeGc() {
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    return typeof gc === 'function' ? () => gc() : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {import('./sherpa.js').ModelPaths} ModelPaths
 * @typedef {{ zhen?: ModelPaths|null, giga: ModelPaths, vad: string }} EngineModels
 * @typedef {{ sensitivity?: string, phrase?: string }} EngineParams
 * @typedef {import('../recipe.js').Hit & { id: number }} EngineHit
 */

export class WakeEngine {
  /**
   * @param {{ addon: any, models: EngineModels, params?: EngineParams, recipe?: Partial<typeof RECIPE_DEFAULTS>, agc?: boolean,
   *   agcOptions?: { targetDb?: number, minGainDb?: number, maxGainDb?: number, tauMs?: number },
   *   gc?: (() => void)|null, cpuUsage?: () => { user: number, system: number }, now?: () => number, log?: (level: string, msg: string) => void }} o
   */
  constructor(o) {
    this.addon = o.addon;
    this.modelPaths = o.models;
    this.params = { sensitivity: o.params?.sensitivity || 'normal', phrase: o.params?.phrase || 'hey-jade' };
    this.strict = false;
    this._recipeOpts = { ...RECIPE_DEFAULTS, ...(o.recipe || {}) };
    this._useAgc = o.agc !== false;
    this._agcOpts = o.agcOptions || {};
    this._gc = o.gc === undefined ? exposeGc() : o.gc;
    this._cpu = o.cpuUsage || (() => process.cpuUsage());
    this._now = o.now || (() => Date.now());
    this._log = o.log || (() => {});
    /** @type {Map<string, ReturnType<typeof createSpotter>>} */
    this._cache = new Map();
    /** @type {import('../recipe.js').OnsetRecipe|null} */
    this.recipe = null;
    this.agc = null;
    this.config = buildConfig({ ...this.params, strict: false, hasZhen: !!this.modelPaths.zhen });
    this._dirtySince = 0;
    /** the strict twin of the current configuration is cached */
    this._twinReady = false;
    this._quietSamples = 0;
    this._nextId = 1;
    this._streamsSinceGc = 0;
    /** @type {EngineHit[]} */
    this.recent = [];
    this.loadMs = 0;
    this._acct = { activeSec: 0, idleSec: 0, cpuActiveUs: 0, cpuIdleUs: 0, dropped: 0, buildMs: 0, builds: 0, prebuildMs: 0 };
  }

  /** Load the VAD and the spotters for the current settings (blocks ≈ 1 s per model). */
  load() {
    const t0 = this._now();
    const vad = createVad(this.addon, { model: this.modelPaths.vad, ...VAD_DEFAULTS });
    this.agc = this._useAgc ? new LevelNormalizer({ ...this.config.agc, ...this._agcOpts }) : null;
    this.recipe = new OnsetRecipe({
      spotters: this._spottersFor(this.config),
      vad,
      agc: this.agc,
      ...this._recipeOpts,
      onStreams: (n) => this._afterStreams(n),
    });
    this.loadMs = this._now() - t0;
    return { loadMs: this.loadMs, models: this.models };
  }

  /** Which streams run: 'zhen' | 'giga' | 'name'. */
  get models() {
    return this.config.spotters.map((s) => s.name);
  }

  /** @param {boolean} on the renderer's media-burst rule: the 'low' thresholds while on */
  setStrict(on) {
    if (this.strict === !!on) return;
    this.strict = !!on;
    this._reconfigure();
  }

  /** @param {EngineParams} p sensitivity / phrase from the settings */
  setParams(p) {
    const next = { sensitivity: p.sensitivity || this.params.sensitivity, phrase: p.phrase || this.params.phrase };
    if (next.sensitivity === this.params.sensitivity && next.phrase === this.params.phrase) return;
    this.params = next;
    this._reconfigure();
  }

  _reconfigure() {
    this.config = buildConfig({ ...this.params, strict: this.strict, hasZhen: !!this.modelPaths.zhen });
    if (!this._dirtySince) this._dirtySince = this._now() || 1;
    this._twinReady = this._has(this._twin());
  }

  /** The configuration strict mode would switch to (or back from). */
  _twin() {
    return buildConfig({ ...this.params, strict: !this.strict, hasZhen: !!this.modelPaths.zhen });
  }

  /** @param {import('../config.js').WakeEngineConfig} cfg */
  _has(cfg) {
    return cfg.spotters.every((spec) => this._cache.has(spotterKey(spec)));
  }

  /** Drop the streams now (the renderer consumed a hit, or muted). */
  reset() {
    this.recipe?.reset();
  }

  /**
   * Feed one frame of 16 kHz audio. @param {Float32Array} pcm @param {number} at index of pcm[0]
   * @returns {EngineHit[]}
   */
  push(pcm, at) {
    const recipe = /** @type {OnsetRecipe} */ (this.recipe);
    if (!recipe) throw new Error('the engine is not loaded');
    if (this._dirtySince && (!recipe.active || this._now() - this._dirtySince >= REBUILD_LATEST_MS)) this._rebuild();
    const fed0 = recipe.stats.fedSamples;
    const c0 = this._cpu();
    const hits = recipe.push(pcm, at);
    const c1 = this._cpu();
    const us = (c1.user - c0.user) + (c1.system - c0.system);
    const sec = pcm.length / SAMPLE_RATE;
    if (recipe.stats.fedSamples > fed0) {
      this._acct.activeSec += sec;
      this._acct.cpuActiveUs += us;
    } else {
      this._acct.idleSec += sec;
      this._acct.cpuIdleUs += us;
    }
    /** @type {EngineHit[]} */
    const out = hits.map((h) => ({ id: this._nextId++, ...h }));
    for (const h of out) {
      this.recent.push(h);
      if (this.recent.length > RECENT_HITS) this.recent.shift();
    }
    // build the strict twin ahead, while nobody speaks (the audio meanwhile waits in the port)
    if (!this._twinReady) {
      this._quietSamples = recipe.active ? 0 : this._quietSamples + pcm.length;
      if (this._quietSamples >= PREBUILD_QUIET_SAMPLES) this.prebuild();
    }
    return out;
  }

  /** Build (cache) the strict twin of the current configuration now. Returns the ms it took. */
  prebuild() {
    const t0 = this._now();
    this._twinReady = true;
    const twin = this._twin();
    if (!this._has(twin)) {
      this._spottersFor(twin, false);
      const ms = this._now() - t0;
      this._acct.prebuildMs += ms;
      this._log('info', `[wake] built the ${this.strict ? 'normal' : 'strict'} thresholds ahead (${twin.spotters.map((sp) => `${sp.name} ${sp.threshold}`).join(', ')}); ${ms} ms`);
    }
    this._prune();
    return this._now() - t0;
  }

  /** Keep only the current set and its strict twin (and nothing the running recipe uses). */
  _prune() {
    const keep = new Set([...this.config.spotters, ...this._twin().spotters].map(spotterKey));
    for (const key of [...this._cache.keys()]) {
      if (keep.has(key) || this._inUse(key)) continue;
      this._cache.delete(key); // the handles go with the next gc()
    }
  }

  /** @param {string} key */
  _inUse(key) {
    const sp = this._cache.get(key);
    return !!sp && !!this.recipe && this.recipe.usesSpotter(sp);
  }

  /** A frame the protocol refused (counted in the stats). */
  noteDropped() {
    this._acct.dropped++;
  }

  /** The `stats` message body (§6.3), plus a few diagnostics. */
  stats() {
    const r = this.recipe?.stats;
    const a = this._acct;
    const fedSec = r ? r.samples / SAMPLE_RATE : 0;
    const speechSec = r ? r.speechSamples / SAMPLE_RATE : 0;
    const round1 = (/** @type {number} */ v) => Math.round(v * 10) / 10;
    const totalMs = (a.cpuActiveUs + a.cpuIdleUs) / 1000;
    return {
      fedSec: round1(fedSec),
      speechSec: round1(speechSec),
      activeSec: round1(a.activeSec),
      // CPU per second of audio while a stream is being fed (speech + 0.7 s hangover) and in between
      cpuMsPerSecSpeech: a.activeSec > 0 ? round1(a.cpuActiveUs / 1000 / a.activeSec) : 0,
      cpuMsPerSecSilence: a.idleSec > 0 ? round1(a.cpuIdleUs / 1000 / a.idleSec) : 0,
      cpuMsPerSecAll: fedSec > 0 ? round1(totalMs / fedSec) : 0,
      streams: r ? r.streams : 0,
      onsets: r ? r.onsets : 0,
      dropped: a.dropped,
      gainDb: this.agc ? round1(this.agc.gainDb) : 0,
      models: this.models,
      strict: this.strict,
      builds: a.builds,
      buildMs: Math.round(a.buildMs),
      prebuildMs: Math.round(a.prebuildMs),
      cachedSets: this._cache.size,
    };
  }

  _rebuild() {
    const t0 = this._now();
    this._dirtySince = 0;
    const list = this._spottersFor(this.config);
    /** @type {OnsetRecipe} */ (this.recipe).setSpotters(list);
    const ms = this._now() - t0;
    this._acct.buildMs += ms;
    this._acct.builds++;
    this._log('info', `[wake] thresholds now ${this.config.spotters.map((s) => `${s.name} ${s.threshold}`).join(', ')}${this.strict ? ' (strict)' : ''}; ${ms} ms`);
    this._twinReady = this._has(this._twin());
    this._quietSamples = 0;
    if (this._twinReady) this._prune();
  }

  /**
   * The spotters for a configuration, from the cache when possible.
   * @param {import('../config.js').WakeEngineConfig} cfg @param {boolean} [prune] drop what no longer belongs
   */
  _spottersFor(cfg, prune = true) {
    const list = cfg.spotters.map((spec) => {
      const key = spotterKey(spec);
      let sp = this._cache.get(key);
      if (!sp) {
        const model = spec.model === 'zhen' ? this.modelPaths.zhen : this.modelPaths.giga;
        if (!model) throw new Error(`model ${spec.model} is not available`);
        sp = createSpotter(this.addon, { model, keywords: spec.keywords, threshold: spec.threshold });
        this._cache.set(key, sp);
      }
      return { name: spec.name, spotter: sp };
    });
    if (prune && this.recipe) this._prune();
    return list;
  }

  /** @param {number} n streams just created */
  _afterStreams(n) {
    this._streamsSinceGc += n;
    if (this._gc && this._streamsSinceGc >= GC_EVERY_STREAMS) {
      this._streamsSinceGc = 0;
      this._gc();
    }
  }
}
