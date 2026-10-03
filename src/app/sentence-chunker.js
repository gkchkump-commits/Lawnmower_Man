// Incremental streaming text → speakable chunks (one TTS request each).
//
// Claude's reply arrives as small text deltas of Markdown. Speaking it with low latency means
// cutting it into sentences as soon as a sentence is certainly complete, without being fooled
// by "Dr.", "e.g.", "3.14", "v2.1", URLs, e-mail addresses or ellipses, and without ever
// speaking code. Two stages:
//
//   1. a line filter that removes fenced code blocks and table rows (replacing each kind with
//      a short spoken placeholder, once per reply) and passes ordinary text through as soon as
//      a line is known not to be special, and
//   2. a sentence splitter that finds boundaries (sentence punctuation followed by whitespace,
//      paragraph breaks, list items, headings), allows the FIRST chunk to be cut early at a
//      clause boundary (fast time-to-first-audio), splits over-long text at clause/word
//      boundaries and merges very short fragments (list items) into the next chunk.
//
// Output chunks are still Markdown-ish (inline emphasis, links); run them through
// speech-text.js before synthesis. Line-level markers (list bullets, "#", ">") are removed here.

/**
 * @typedef {object} ChunkerOptions
 * @property {number} [firstMinChars]  earliest position for an early clause cut of the first chunk (default 40)
 * @property {number} [firstMaxChars]  the first chunk is cut at a clause or word boundary once this long (default 110)
 * @property {number} [maxChars]       hard upper bound for any chunk (default 220)
 * @property {number} [minChars]       non-first chunks shorter than this are merged into the next one (default 14)
 * @property {string} [codePlaceholder]
 * @property {string} [tablePlaceholder]
 */

export const DEFAULT_CHUNKER_OPTIONS = Object.freeze({
  firstMinChars: 40,
  firstMaxChars: 110,
  maxChars: 220,
  minChars: 14,
  codePlaceholder: "I've put the code in the chat.",
  tablePlaceholder: "I've put a table in the chat.",
});

const TERMINATORS = '.!?…。！？';
const CLOSERS = '"\'”’»)]}*_`';
const OPENERS = '("\'“‘[{«*_`';
/** Words that are never sentence ends when followed by a period. */
const NEVER_END = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'v', 'e.g', 'i.e', 'cf',
  'approx', 'dept', 'est', 'gen', 'col', 'lt', 'sgt', 'capt', 'rev', 'hon', 'gov', 'sen', 'rep',
  'pres', 'mme', 'messrs', 'viz', 'resp', 'incl', 'excl', 'ca', 'c', 'al',
]);
/** Abbreviations that are not sentence ends when followed by a number ("No. 5", "Fig. 2"). */
const BEFORE_NUMBER = new Set(['no', 'nos', 'fig', 'figs', 'vol', 'vols', 'p', 'pp', 'ch', 'sec', 'art', 'eq', 'ver', 'op', 'nr']);
/** Abbreviations that end a sentence only when an upper-case word follows ("etc. Next"). */
const MAYBE_END = new Set(['etc', 'inc', 'ltd', 'co', 'corp', 'llc', 'bros', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'a.m', 'p.m']);

const BLOCK_MARKER = /^[ \t]*(?:[-*+•][ \t]|\d{1,3}[.)][ \t]|#{1,6}[ \t]|>)/;
const LINE_MARKERS = /^\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+|#{1,6}\s+|>\s*)+/;
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const TABLE_ROW = /^[ \t]{0,3}\|/;
const HAS_WORD = /[\p{L}\p{N}]/u;

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === ' ';
const isUpperStart = (c) => !!c && c.toUpperCase() === c && c.toLowerCase() !== c;
const isDigit = (c) => c >= '0' && c <= '9';

export class SentenceChunker {
  /** @param {ChunkerOptions} [options] */
  constructor(options = {}) {
    this.opts = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
    this.reset();
  }

  /** Forget everything (start of a new reply). */
  reset() {
    // stage 1 (line filter)
    this._line = '';            // held start of the current line (undecided)
    this._lineMode = 'start';   // 'start' (undecided) | 'text' (passing through) | 'skip' (drop rest of line)
    /** @type {{ ch: string, len: number }|null} */
    this._fence = null;
    this._codeSaid = false;
    this._tableSaid = false;
    // stage 2 (splitter)
    this._buf = '';
    this._emitted = 0;
    /** @type {string|null} */
    this._held = null;
    /** @type {string[]} */
    this._out = [];
  }

  /** True while inside a fenced code block. */
  get inCode() { return this._fence !== null; }

  /**
   * Feed a text delta; returns the chunks that became complete.
   * @param {string} text
   * @returns {string[]}
   */
  push(text) {
    if (typeof text === 'string' && text) this._filter(text.replace(/\r\n?/g, '\n'), false);
    this._split(false);
    return this._take();
  }

  /**
   * End of the reply (or of one assistant message): emit everything that is left.
   * @returns {string[]}
   */
  flush() {
    this._filter('', true);
    this._split(true);
    if (this._held !== null) {
      this._out.push(this._held);
      this._held = null;
    }
    return this._take();
  }

  _take() {
    const out = this._out;
    this._out = [];
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Stage 1: line filter (code fences, tables)

  /** @param {string} text @param {boolean} final */
  _filter(text, final) {
    let rest = text;
    while (rest.length) {
      const nl = rest.indexOf('\n');
      const piece = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? '' : rest.slice(nl + 1);
      this._linePiece(piece, nl !== -1);
    }
    if (final) {
      // Unterminated last line: decide it now.
      if (this._lineMode === 'start' && this._line && !this._fence) this._completeLine(this._line, false);
      this._line = '';
      this._lineMode = 'start';
      this._fence = null; // an unclosed fence is simply dropped
    }
  }

  /** @param {string} piece text without newline @param {boolean} complete the line ended */
  _linePiece(piece, complete) {
    if (this._fence) {
      this._line += piece;
      if (complete) {
        if (isFenceClose(this._line, this._fence)) this._fence = null;
        this._line = '';
      }
      return;
    }
    if (this._lineMode === 'skip') {
      if (complete) this._lineMode = 'start';
      return;
    }
    if (this._lineMode === 'text') {
      this._feed(complete ? `${piece}\n` : piece);
      if (complete) this._lineMode = 'start';
      return;
    }
    // undecided line start
    this._line += piece;
    const line = this._line;
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      // The rest of the opener line (info string) is consumed by the fence branch above.
      this._enterFence(fence[1]);
      this._line = '';
      this._lineMode = 'start';
      return;
    }
    if (TABLE_ROW.test(line)) {
      this._table();
      this._line = '';
      this._lineMode = complete ? 'start' : 'skip';
      return;
    }
    if (complete) {
      this._completeLine(line, true);
      return;
    }
    // Could this still become a fence / table row? Then wait for more characters.
    if (/^[ \t]{0,3}(?:`{1,2}|~{1,2})?$/.test(line)) return;
    this._line = '';
    this._lineMode = 'text';
    this._feed(line);
  }

  /** @param {string} line @param {boolean} withNewline */
  _completeLine(line, withNewline) {
    this._line = '';
    this._lineMode = 'start';
    this._feed(withNewline ? `${line}\n` : line);
  }

  /** @param {string} marker */
  _enterFence(marker) {
    this._fence = { ch: marker[0], len: marker.length };
    this._hardBreak();
    if (!this._codeSaid) {
      this._codeSaid = true;
      this._placeholder(this.opts.codePlaceholder);
    }
  }

  _table() {
    this._hardBreak();
    if (!this._tableSaid) {
      this._tableSaid = true;
      this._placeholder(this.opts.tablePlaceholder);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Stage 2: sentence splitter

  /** @param {string} s */
  _feed(s) { this._buf += s; }

  /** Emit whatever is buffered as its own chunk (before a code block or table). */
  _hardBreak() {
    this._split(true);
  }

  /** @param {string} text */
  _placeholder(text) {
    if (!text) return;
    if (this._held !== null) {
      this._out.push(this._held);
      this._held = null;
    }
    this._out.push(text);
    this._emitted++;
  }

  /** @param {boolean} final */
  _split(final) {
    for (;;) {
      const b = findBoundary(this._buf, final);
      if (!b) break;
      this._emit(this._buf.slice(0, b.end));
      this._buf = this._buf.slice(b.end + b.skip);
    }
    // No (certain) boundary left in the buffer: apply the length rules.
    for (;;) {
      const cut = this._lengthCut();
      if (cut <= 0) break;
      this._emit(this._buf.slice(0, cut));
      this._buf = this._buf.slice(cut);
    }
    if (final) {
      if (this._buf.trim()) this._emit(this._buf);
      this._buf = '';
    }
  }

  /** @returns {number} cut position (exclusive) or 0 */
  _lengthCut() {
    const s = this._buf;
    const { firstMinChars, firstMaxChars, maxChars } = this.opts;
    if (this._emitted === 0 && this._held === null && s.length >= firstMinChars) {
      // Low latency: start speaking at the first clause boundary after ~40 characters.
      const c = findClauseCut(s, firstMinChars, firstMaxChars);
      if (c > 0) return c;
      if (s.length > firstMaxChars) return findWordCut(s, firstMaxChars) || firstMaxChars;
    }
    if (s.length > maxChars) {
      const c = findLastClauseCut(s, Math.floor(maxChars * 0.4), maxChars);
      if (c > 0) return c;
      return findWordCut(s, maxChars) || maxChars;
    }
    return 0;
  }

  /** @param {string} raw */
  _emit(raw) {
    let text = raw.replace(/[ \t]*\n[ \t]*/g, '\n');
    // strip line-level markdown markers at the start of every line, then join soft wraps
    text = text.split('\n').map((l) => l.replace(LINE_MARKERS, '')).join(' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (!HAS_WORD.test(text)) return;
    if (this._held !== null) {
      const h = this._held;
      this._held = null;
      text = /[.!?,;:…]$/.test(h) ? `${h} ${text}` : `${h}, ${text}`;
    }
    if (text.length < this.opts.minChars && this._emitted > 0) {
      this._held = text;
      return;
    }
    this._out.push(text);
    this._emitted++;
  }
}

/**
 * Is `line` a closing fence for `fence`?
 * @param {string} line @param {{ ch: string, len: number }} fence
 */
function isFenceClose(line, fence) {
  const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

/**
 * Find the first certain sentence boundary in `s`.
 * @param {string} s @param {boolean} final no more text will follow
 * @returns {{ end: number, skip: number }|null} cut s[0..end), then drop `skip` characters
 */
export function findBoundary(s, final) {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '\n') {
      const line = s.slice(s.lastIndexOf('\n', i - 1) + 1, i);
      if (!line.trim()) {
        if (!s.slice(0, i).trim()) continue; // leading blank lines
        return { end: i, skip: 1 }; // paragraph break
      }
      const rest = s.slice(i + 1);
      if (rest[0] === '\n') return { end: i, skip: 1 }; // paragraph break
      // A heading / list item ends at its newline; so does a line ending in ':' or ';'.
      if (BLOCK_MARKER.test(line) || /[:;]["'”’)\]*_`]*[ \t]*$/.test(line)) return { end: i, skip: 1 };
      if (BLOCK_MARKER.test(rest)) return { end: i, skip: 1 }; // the next line starts a list item
      if (!rest.length) {
        if (final) return { end: i, skip: 1 };
        return null; // can't tell a soft wrap from a list item yet
      }
      // Short look-ahead that might still become "- item" / "12. item" / "## heading": wait.
      if (!final && rest.length < 4 && /^[ \t]*(?:[-*+•]|\d{1,3}[.)]?|#{1,6}|>)?$/.test(rest)) return null;
      continue; // soft wrap inside a paragraph: becomes a space
    }
    if (!TERMINATORS.includes(c)) continue;
    let j = i;
    while (j < n && TERMINATORS.includes(s[j])) j++;
    let k = j;
    while (k < n && CLOSERS.includes(s[k])) k++;
    if (k >= n) {
      if (final) return { end: k, skip: 0 };
      return null; // need to see what follows
    }
    if (!isSpace(s[k])) { i = j - 1; continue; } // "3.14", "example.com", "?q=1", "..." inside a word
    // what comes after the whitespace?
    let m = k;
    while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === ' ')) m++;
    const nextCh = m < n ? s[m] : '';
    const needLookahead = () => !nextCh && !final;
    const run = s.slice(i, j);
    if (run === '.') {
      // A period followed by a lower-case word does not end a sentence ("the U.S. economy",
      // "3 p.m. today", "(quietly.) he did").
      if (needLookahead()) return null;
      if (nextCh && nextCh !== '\n' && nextCh.toLowerCase() === nextCh && nextCh.toUpperCase() !== nextCh) { i = j - 1; continue; }
      const word = wordBefore(s, i);
      const lw = word.toLowerCase();
      // "Dr." "vs." and initials ("J. R. R. Tolkien"; but "…so did I. Then" ends a sentence)
      if (NEVER_END.has(lw) || (/^[A-Z]$/.test(word) && word !== 'I')) { i = j - 1; continue; }
      if (/^(?:[a-z]\.)+[a-z]$/i.test(word) && !MAYBE_END.has(lw)) { i = j - 1; continue; } // e.g / i.e / U.S
      if (BEFORE_NUMBER.has(lw)) {
        if (needLookahead()) return null;
        if (isDigit(nextCh) || nextCh === '#') { i = j - 1; continue; }
      }
      if (MAYBE_END.has(lw)) {
        if (needLookahead()) return null;
        if (nextCh && nextCh !== '\n' && !isUpperStart(nextCh) && !isDigit(nextCh) && !OPENERS.includes(nextCh)) { i = j - 1; continue; }
      }
      if (/^\d{1,3}$/.test(word)) {
        // "1. " at the start of a line is a list marker, not a sentence.
        const ws = i - word.length;
        const before = s.slice(s.lastIndexOf('\n', ws - 1) + 1, ws);
        if (!before.trim()) { i = j - 1; continue; }
      }
    } else if (run === '...' || run === '…' || /^\.{2,}$/.test(run)) {
      if (needLookahead()) return null;
      if (nextCh && nextCh !== '\n' && !isUpperStart(nextCh)) { i = j - 1; continue; } // "well... maybe"
    }
    return { end: k, skip: 0 };
  }
  return null;
}

/** The token right before position i (letters, digits, dots, apostrophes). @param {string} s @param {number} i */
function wordBefore(s, i) {
  let a = i;
  while (a > 0 && !isSpace(s[a - 1]) && !OPENERS.includes(s[a - 1])) a--;
  return s.slice(a, i);
}

/**
 * First clause boundary (", " "; " ": " " — " " – " " - ") at or after `from` and before `to`.
 * Returns the cut position (after the punctuation) or 0.
 * @param {string} s @param {number} from @param {number} to
 */
export function findClauseCut(s, from, to) {
  const end = Math.min(to, s.length - 1);
  for (let i = Math.max(1, from - 1); i < end; i++) {
    const r = clauseAt(s, i);
    if (r) return r;
  }
  return 0;
}

/** Last clause boundary between `from` and `to`. @param {string} s @param {number} from @param {number} to */
function findLastClauseCut(s, from, to) {
  for (let i = Math.min(to, s.length - 1) - 1; i >= from; i--) {
    const r = clauseAt(s, i);
    if (r && r <= to) return r;
  }
  return 0;
}

/** @param {string} s @param {number} i @returns {number} cut position after a clause mark at i, or 0 */
function clauseAt(s, i) {
  const c = s[i];
  if ((c === ',' || c === ';' || c === ':') && isSpace(s[i + 1] || '')) {
    if (c === ',' && isDigit(s[i - 1] || '') && isDigit(s[i + 2] || '')) return 0; // "1, 2" lists are fine, but keep "1,000"
    return i + 1;
  }
  if ((c === '—' || c === '–') && i > 0 && i + 1 < s.length) return i + 1;
  if (c === '-' && s[i - 1] === ' ' && s[i + 1] === ' ') return i + 1;
  return 0;
}

/** Last whitespace at or before `max` (cut there). @param {string} s @param {number} max */
function findWordCut(s, max) {
  const i = s.lastIndexOf(' ', max);
  return i > max * 0.5 ? i : 0;
}
