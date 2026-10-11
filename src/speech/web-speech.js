// Browser speech synthesis (Web Speech API) — the voice used when the local voice server is
// turned off, not installed or failing. Picks the most natural English voice available
// (Edge/Windows "Natural"/"Online" voices, Google voices, macOS Samantha, SAPI voices…) and
// papers over Chromium quirks: voices load asynchronously, utterances can be garbage-collected
// mid-speech (losing their events), and 'end' sometimes never fires — so every utterance has a
// safety timeout derived from its length.

/**
 * Score a SpeechSynthesisVoice for natural English output (higher is better).
 * @param {{ name?: string, lang?: string, localService?: boolean, default?: boolean }} v
 * @param {string} [lang] preferred language prefix (default 'en')
 */
export function scoreVoice(v, lang = 'en') {
  const name = String(v?.name || '');
  const vl = String(v?.lang || '').toLowerCase().replace('_', '-');
  const want = lang.toLowerCase();
  let s = 0;
  if (vl === want || vl.startsWith(`${want}-`)) s += 100;
  else if (vl.split('-')[0] === want.split('-')[0]) s += 60;
  else return -1000; // wrong language
  if (want === 'en') {
    if (vl === 'en-us') s += 12;
    else if (vl === 'en-gb') s += 8;
  }
  if (/natural|neural/i.test(name)) s += 50;
  if (/online/i.test(name)) s += 15;
  if (/google us english/i.test(name)) s += 40;
  else if (/google/i.test(name)) s += 25;
  if (/microsoft (aria|jenny|guy|ava|andrew|emma|brian|sonia|ryan|libby|michelle|christopher|eric|steffan)/i.test(name)) s += 30;
  if (/samantha|alex|daniel|karen|moira|tessa|serena|ava \(premium\)|zoe/i.test(name)) s += 25;
  if (/zira|david|mark|hazel|george|susan/i.test(name)) s += 8;
  if (/espeak|festival|pico/i.test(name)) s -= 40; // robotic
  if (/whisper|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|wobble|zarvox|albert|fred|junior|ralph/i.test(name)) s -= 80; // novelty voices
  if (v?.localService) s += 3;
  if (v?.default) s += 2;
  return s;
}

/**
 * @template {{ name?: string, lang?: string, voiceURI?: string }} V
 * @param {V[]} voices @param {{ lang?: string, preferred?: string }} [o]
 * @returns {V|null}
 */
export function pickVoice(voices, o = {}) {
  if (!Array.isArray(voices) || !voices.length) return null;
  if (o.preferred) {
    const p = voices.find((v) => v.voiceURI === o.preferred || v.name === o.preferred);
    if (p) return p;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const sc = scoreVoice(v, o.lang || 'en');
    if (sc > bestScore) {
      best = v;
      bestScore = sc;
    }
  }
  return bestScore > -1000 ? best : null;
}

/** Rough speaking time of `text` at `rate` (seconds). @param {string} text @param {number} rate */
export function estimateSpeechSeconds(text, rate = 1) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words / (2.6 * Math.max(0.3, rate || 1));
}

export class WebSpeechTTS {
  /**
   * @param {object} [deps]
   * @param {SpeechSynthesis} [deps.synth]
   * @param {typeof SpeechSynthesisUtterance} [deps.Utterance]
   * @param {string} [deps.lang]
   */
  constructor(deps = {}) {
    this.synth = deps.synth !== undefined ? deps.synth : globalThis.speechSynthesis || null;
    this.Utterance = deps.Utterance || globalThis.SpeechSynthesisUtterance || null;
    this.lang = deps.lang || 'en';
    /** @type {SpeechSynthesisVoice|null} */
    this.voice = null;
    this.preferred = '';
    /** @type {SpeechSynthesisUtterance|null} */
    this._current = null; // keep a reference: Chromium may GC a playing utterance
    this._initPromise = null;
    /** @type {Set<() => void>} */
    this._listeners = new Set();
  }

  get supported() {
    return !!(this.synth && this.Utterance);
  }

  /** Usable right now (supported and an English voice was found). */
  get available() {
    return this.supported && !!this.voice;
  }

  /**
   * Load the voice list (asynchronous in Chromium). Resolves to `available`.
   * @param {number} [timeoutMs]
   */
  init(timeoutMs = 2000) {
    if (!this.supported) return Promise.resolve(false);
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve) => {
      const done = () => {
        this._choose();
        resolve(this.available);
      };
      if (this._voices().length) {
        done();
        return;
      }
      const timer = setTimeout(() => {
        try { this.synth.removeEventListener?.('voiceschanged', onChange); } catch { /* ignore */ }
        done();
      }, timeoutMs);
      const onChange = () => {
        if (!this._voices().length) return;
        clearTimeout(timer);
        try { this.synth.removeEventListener?.('voiceschanged', onChange); } catch { /* ignore */ }
        done();
      };
      try { this.synth.addEventListener?.('voiceschanged', onChange); } catch { /* ignore */ }
    });
    // later voice list changes (e.g. online voices arriving) re-pick and refresh the picker
    try {
      this.synth.addEventListener?.('voiceschanged', () => {
        this._choose();
        this._notify();
      });
    } catch { /* ignore */ }
    this._initPromise.then(() => this._notify());
    return this._initPromise;
  }

  /**
   * Called whenever the voice list may have changed (after init, on voiceschanged).
   * @param {() => void} cb @returns {() => void} unsubscribe
   */
  onVoicesChanged(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _notify() {
    for (const cb of [...this._listeners]) {
      try {
        cb();
      } catch (err) {
        console.warn('[web-speech] voices listener threw', err);
      }
    }
  }

  /** @returns {SpeechSynthesisVoice[]} */
  _voices() {
    try {
      return this.synth?.getVoices?.() || [];
    } catch {
      return [];
    }
  }

  _choose() {
    this.voice = pickVoice(this._voices(), { lang: this.lang, preferred: this.preferred });
  }

  /** List of usable voices (for a settings picker). */
  voices() {
    return this._voices().filter((v) => scoreVoice(v, this.lang) > -1000);
  }

  /**
   * Every installed voice for the settings picker: voices for the app's language first (most
   * natural first), then the others by language and name.
   * @returns {Array<{ id: string, name: string, lang: string, local: boolean }>}
   */
  allVoices() {
    const list = this._voices().map((v) => ({ v, score: scoreVoice(v, this.lang) }));
    list.sort((a, b) => {
      const ma = a.score > -1000;
      const mb = b.score > -1000;
      if (ma !== mb) return ma ? -1 : 1;
      if (ma && a.score !== b.score) return b.score - a.score;
      return String(a.v.lang).localeCompare(String(b.v.lang)) || String(a.v.name).localeCompare(String(b.v.name));
    });
    const seen = new Set();
    const out = [];
    for (const { v } of list) {
      const id = String(v.voiceURI || v.name || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: String(v.name || id), lang: String(v.lang || ''), local: !!v.localService });
    }
    return out;
  }

  /** settings.voice.systemVoice: a voice name or voiceURI; '' = automatic (best voice). @param {string} nameOrUri */
  setPreferred(nameOrUri) {
    this.preferred = typeof nameOrUri === 'string' ? nameOrUri : '';
    this._choose();
  }

  /** The preferred voice is set but not installed (any more): the automatic choice is used. */
  get preferredMissing() {
    return !!this.preferred && !this._voices().some((v) => v.voiceURI === this.preferred || v.name === this.preferred);
  }

  /**
   * Speak one chunk. Resolves when it ended, was cancelled or timed out (never rejects for
   * cancellation; rejects on a synthesis error so the caller can report it).
   * @param {string} text
   * @param {{ rate?: number, onStart?: () => void,
   *   onBoundary?: (word: string, info: { charIndex: number, charLength: number }) => void }} [o]
   *   onBoundary: a word starts (charIndex / charLength into `text`, for the lip-sync)
   */
  speak(text, o = {}) {
    if (!this.supported) return Promise.reject(new Error('Speech synthesis is not supported'));
    const synth = this.synth;
    const u = new this.Utterance(text);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    } else {
      u.lang = 'en-US';
    }
    const rate = Math.min(2, Math.max(0.5, Number(o.rate) || 1));
    u.rate = rate;
    u.pitch = 1;
    u.volume = 1;
    this._current = u;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._current === u) this._current = null;
        if (err) reject(err);
        else resolve(undefined);
      };
      // safety net: 'end' sometimes never fires (Chromium); allow generous slack
      const limitMs = (estimateSpeechSeconds(text, rate) * 2 + 4) * 1000;
      const timer = setTimeout(() => {
        try { synth.cancel(); } catch { /* ignore */ }
        finish();
      }, limitMs);
      u.onstart = () => o.onStart?.();
      u.onend = () => finish();
      u.onerror = (e) => {
        const kind = /** @type {any} */ (e)?.error;
        if (kind === 'interrupted' || kind === 'canceled') finish();
        else finish(new Error(`speech synthesis failed${kind ? `: ${kind}` : ''}`));
      };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        const ci = Number.isFinite(e.charIndex) ? e.charIndex : 0;
        const len = e.charLength || (/^\S+/.exec(text.slice(ci))?.[0].length ?? 0);
        o.onBoundary?.(text.substr(ci, len), { charIndex: ci, charLength: len });
      };
      try {
        // Chromium can be stuck "speaking" after a previous error: reset before speaking.
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch (err) {
        finish(/** @type {Error} */ (err));
      }
    });
  }

  cancel() {
    try {
      this.synth?.cancel();
    } catch { /* ignore */ }
    this._current = null;
  }
}
