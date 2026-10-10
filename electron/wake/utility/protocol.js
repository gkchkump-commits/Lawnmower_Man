// The renderer ↔ utility port protocol (contract-wake §6.3), the utility's side. Pure: given the
// engine and a message, it returns the replies, so the unit tests need no Electron or addon.
//
//   r → u  { t:'pcm', at, pcm: Float32Array }   1-4096 finite samples in [-1.5, 1.5]; at = index of pcm[0]
//          { t:'reset' }  { t:'strict', on }  { t:'ping', n }
//   u → r  { t:'ready', models, gen }  { t:'hit', id, keyword, model, streamAt, startAt, endAt, emitAt }
//          { t:'vad', speaking, at }    { t:'stats', … }    { t:'pong', n }    { t:'error', message }
// Frames arrive as structured-clone copies: an ArrayBuffer in a transfer list reaches a
// MessagePortMain as null (verified), so the renderer never transfers.

export const MAX_FRAME = 4096;
const MAX_ABS = 1.5;

/**
 * Check a pcm message. `expected` is the index the next frame should start at (null = any).
 * A jump forward is a gap (allowed: the recipe ends the stream); a jump backward is refused.
 * @param {any} m @param {number|null} expected
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkPcm(m, expected) {
  const pcm = m?.pcm;
  if (!(pcm instanceof Float32Array)) return { ok: false, error: 'pcm must be a Float32Array' };
  if (pcm.length < 1 || pcm.length > MAX_FRAME) return { ok: false, error: `pcm must hold 1-${MAX_FRAME} samples` };
  if (!Number.isSafeInteger(m.at) || m.at < 0) return { ok: false, error: 'at must be a non-negative integer' };
  if (expected !== null && m.at < expected) return { ok: false, error: `at ${m.at} goes back (expected ≥ ${expected})` };
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!(v >= -MAX_ABS && v <= MAX_ABS)) return { ok: false, error: 'pcm holds a non-finite or out-of-range sample' };
  }
  return { ok: true };
}

/**
 * The port side of one connection (one `gen`). Owns the expected sample index and the VAD
 * transition reports; the engine is shared across reconnections.
 */
export class PortSession {
  /**
   * @param {{ engine: import('./engine.js').WakeEngine, gen: number, onHits?: (hits: any[]) => void }} o
   */
  constructor(o) {
    this.engine = o.engine;
    this.gen = o.gen;
    this._onHits = o.onHits || (() => {});
    /** @type {number|null} */
    this._expected = null;
    this._speaking = false;
    this._errors = 0;
  }

  /** The greeting once the engine is loaded. */
  ready() {
    return { t: 'ready', models: this.engine.models, gen: this.gen };
  }

  /**
   * @param {any} m a message from the renderer (anything: it is validated here)
   * @returns {any[]} replies
   */
  handle(m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return this._error('a message must be an object with a type');
    switch (m.t) {
      case 'pcm': {
        const c = checkPcm(m, this._expected);
        if (!c.ok) {
          this.engine.noteDropped();
          // a backward jump means the sender restarted its count: resynchronise at the next frame
          if (/goes back/.test(c.error)) this._expected = null;
          return this._error(c.error);
        }
        this._expected = m.at + m.pcm.length;
        const hits = this.engine.push(m.pcm, m.at);
        /** @type {any[]} */
        const out = [];
        const speaking = !!this.engine.recipe?.speaking;
        if (speaking !== this._speaking) {
          this._speaking = speaking;
          out.push({ t: 'vad', speaking, at: this._expected });
        }
        for (const h of hits) out.push({ t: 'hit', id: h.id, keyword: h.keyword, model: h.model, streamAt: h.streamAt, startAt: h.startAt, endAt: h.endAt, emitAt: h.emitAt });
        if (hits.length) this._onHits(hits);
        return out;
      }
      case 'reset':
        this.engine.reset();
        return [];
      case 'strict':
        if (typeof m.on !== 'boolean') return this._error('strict needs on: boolean');
        this.engine.setStrict(m.on);
        return [];
      case 'ping':
        return [{ t: 'pong', n: Number.isFinite(m.n) ? m.n : 0 }];
      default:
        return this._error(`unknown message type ${String(m.t).slice(0, 40)}`);
    }
  }

  /** @param {string} message */
  _error(message) {
    // a misbehaving page must not flood the port: report the first errors, then every 100th
    this._errors++;
    return this._errors <= 5 || this._errors % 100 === 0 ? [{ t: 'error', message }] : [];
  }
}
