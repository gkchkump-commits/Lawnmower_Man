// Newline-delimited JSON (NDJSON / "stream-json") parsing for child-process stdout.
//
// Robust against everything a pipe can do to us:
//  * chunks that split a line (or a multi-byte UTF-8 character) anywhere,
//  * CRLF line endings (Windows) and a UTF-8 BOM at the start of the stream or of a line,
//  * very large lines (tool results can be megabytes) — accumulated as a list of pieces so
//    concatenation stays linear; lines above `maxLineLength` are dropped with an error,
//  * invalid JSON / non-object values / exceptions thrown by the consumer → `onError`, never a
//    crash, and parsing continues with the next line.

import { StringDecoder } from 'node:string_decoder';

/**
 * @typedef {object} JsonLineParserOptions
 * @property {(msg: Record<string, any>) => void} onMessage   called once per JSON object line
 * @property {(err: Error, line: string) => void} [onError]  invalid line / handler error
 * @property {number} [maxLineLength]  max characters per line (default 64 Mi)
 */

export class JsonLineParser {
  /** @param {JsonLineParserOptions} opts */
  constructor(opts) {
    if (!opts || typeof opts.onMessage !== 'function') throw new TypeError('onMessage is required');
    this._onMessage = opts.onMessage;
    this._onError = typeof opts.onError === 'function' ? opts.onError : () => {};
    this._max = opts.maxLineLength ?? 64 * 1024 * 1024;
    this._decoder = new StringDecoder('utf8');
    /** @type {string[]} */
    this._parts = [];
    this._partsLen = 0;
    this._overflow = false;
    this._ended = false;
  }

  /** Feed a chunk (Buffer or string). @param {Buffer|string} chunk */
  push(chunk) {
    if (this._ended) return;
    const str = typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    let start = 0;
    while (start <= str.length) {
      const nl = str.indexOf('\n', start);
      if (nl === -1) {
        this._append(str.slice(start));
        break;
      }
      this._append(str.slice(start, nl));
      this._flushLine();
      start = nl + 1;
    }
  }

  /** Flush any final unterminated line. Further pushes are ignored. */
  end() {
    if (this._ended) return;
    const rest = this._decoder.end();
    if (rest) this._append(rest);
    if (this._partsLen > 0 || this._overflow) this._flushLine();
    this._ended = true;
  }

  /** @param {string} s */
  _append(s) {
    if (!s || this._overflow) return;
    this._partsLen += s.length;
    if (this._partsLen > this._max) {
      // Drop the line now instead of buffering unbounded data; report it when it ends.
      this._overflow = true;
      this._parts = [];
      return;
    }
    this._parts.push(s);
  }

  _flushLine() {
    if (this._overflow) {
      const size = this._partsLen;
      this._overflow = false;
      this._parts = [];
      this._partsLen = 0;
      this._safeError(new Error(`stream-json line too long (${size} chars > ${this._max}); dropped`), '');
      return;
    }
    let line = this._parts.length === 1 ? this._parts[0] : this._parts.join('');
    this._parts = [];
    this._partsLen = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line.trim()) return;

    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      this._safeError(new Error(`invalid JSON line: ${/** @type {Error} */ (err).message}`), preview(line));
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this._safeError(new Error('JSON line is not an object'), preview(line));
      return;
    }
    try {
      this._onMessage(value);
    } catch (err) {
      this._safeError(/** @type {Error} */ (err), preview(line));
    }
  }

  /** @param {Error} err @param {string} line */
  _safeError(err, line) {
    try {
      this._onError(err, line);
    } catch {
      /* never let an error handler break parsing */
    }
  }
}

/** @param {string} line */
function preview(line) {
  return line.length > 500 ? `${line.slice(0, 500)}… (${line.length} chars)` : line;
}

/**
 * Serialize one message as an NDJSON line. JSON.stringify escapes \n and \r inside strings,
 * so the output is always exactly one line.
 * @param {unknown} msg
 */
export function encodeJsonLine(msg) {
  return `${JSON.stringify(msg)}\n`;
}
