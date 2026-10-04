// Markdown → natural speech text for TTS.
//
// The chat panel shows the Markdown; the voice reads a cleaned-up version: no emphasis
// markers, link text instead of URLs, code and tables replaced by a short phrase, no emoji or
// box-drawing junk, and a few symbols spelled out ("&" → "and", "→" → "to"). Works on whole
// replies as well as on the sentence-sized chunks produced by sentence-chunker.js.

export const SPEECH_PHRASES = Object.freeze({
  code: "I've put the code in the chat.",
  table: "I've put a table in the chat.",
});

/**
 * @typedef {object} SpeechTextOptions
 * @property {string} [codePhrase]   replacement for fenced code blocks ('' = drop)
 * @property {string} [tablePhrase]  replacement for tables ('' = drop)
 */

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu;
// arrows, box drawing, block elements, geometric shapes, misc symbols & dingbats, braille
const JUNK = /[←-⇿─-◿☀-⛿✀-➿⠀-⣿⬀-⯿•·▪►‣⁃]/gu;

/**
 * Convert Markdown text into plain text suitable for speech synthesis.
 * @param {string} markdown
 * @param {SpeechTextOptions} [options]
 * @returns {string} '' when nothing is speakable
 */
export function toSpeechText(markdown, options = {}) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const codePhrase = options.codePhrase ?? SPEECH_PHRASES.code;
  const tablePhrase = options.tablePhrase ?? SPEECH_PHRASES.table;
  let s = markdown.replace(/\r\n?/g, '\n');

  // ---- block level ------------------------------------------------------------------------
  s = replaceCodeBlocks(s, codePhrase);
  s = replaceTables(s, tablePhrase);
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ''); // horizontal rules

  const lines = s.split('\n').map((line) => {
    let l = line;
    l = l.replace(/^[ \t]*(?:>[ \t]?)+/, ''); // block quotes
    const heading = /^[ \t]*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(l);
    if (heading) l = heading[1];
    l = l.replace(/^[ \t]*(?:[-*+•][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,3}[.)][ \t]+)/, ''); // list markers, task boxes
    return l.trim();
  }).filter((l) => l.length > 0);
  // Separate lines with a pause unless the line already ends in punctuation.
  s = lines.map((l, i) => (i < lines.length - 1 && !/[.!?:;,…]["'”’)\]]*$/.test(l) ? `${l}.` : l)).join(' ');

  // ---- inline -----------------------------------------------------------------------------
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, ''); // HTML tags
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt.trim()); // images → alt text
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]+|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1'); // links → text
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1'); // reference links
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1'); // autolinks
  s = s.replace(/`{1,3}([^`]+?)`{1,3}/g, (_m, code) => code.replace(/_/g, ' ')); // inline code → plain
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi, (url) => hostOf(url)); // bare URLs → host
  s = s.replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1 at $2'); // e-mail
  s = s.replace(/(\d)\s*\*\s*(?=\d)/g, '$1 times '); // 2*3 (before emphasis stripping)
  // emphasis / strikethrough
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');

  // ---- words & symbols ----------------------------------------------------------------------
  s = s.replace(EMOJI, '');
  s = s.replace(/\be\.g\.(?=\s|,|$)/gi, 'for example');
  s = s.replace(/\bi\.e\.(?=\s|,|$)/gi, 'that is');
  s = s.replace(/\betc\.(?=\s*[a-z,;:)]|$)/g, 'et cetera');
  s = s.replace(/\betc\.(?=\s+[A-Z])/g, 'et cetera.');
  s = s.replace(/\bvs\.?(?=\s)/gi, 'versus');
  s = s.replace(/\bapprox\.(?=\s)/gi, 'approximately');
  s = s.replace(/\bw\/(?=\s)/gi, 'with');
  s = s.replace(/\bC#/g, 'C sharp').replace(/\bF#/g, 'F sharp').replace(/\bC\+\+/g, 'C plus plus');
  s = s.replace(/#(\d)/g, 'number $1');
  s = s.replace(/\s*(?:->|-->|→|⟶|⇒|=>)\s*/g, ' to ');
  s = s.replace(/\s*(?:<-|←)\s*/g, ' from ');
  s = s.replace(/\s*&(?:amp;)?\s*/g, ' and ');
  s = s.replace(/≈\s*|~(?=\s?\d)/g, 'about ');
  s = s.replace(/\s*±\s*/g, ' plus or minus ');
  s = s.replace(/\b(\d+)\s*[×x]\s*(\d+)\b/g, (m, a, b) => (a === '0' ? m : `${a} by ${b}`)); // 1920x1080, not 0x1F
  s = s.replace(/\s*×\s*/g, ' times ');
  s = s.replace(/\s*÷\s*/g, ' divided by ');
  s = s.replace(/\s*≤\s*/g, ' at most ').replace(/\s*≥\s*/g, ' at least ').replace(/\s*≠\s*/g, ' is not ');
  s = s.replace(/\s+(?:==|=)\s+/g, ' equals ');
  s = s.replace(/\s+<\s+/g, ' less than ').replace(/\s+>\s+/g, ' greater than ');
  s = s.replace(/\s+\+\s+/g, ' plus ');
  s = s.replace(/°\s*C\b/g, ' degrees Celsius').replace(/°\s*F\b/g, ' degrees Fahrenheit').replace(/°/g, ' degrees');
  s = s.replace(/(\p{L})_(?=\p{L})/gu, '$1 '); // snake_case → snake case
  s = s.replace(/(\p{L})\/(?=\p{L})/gu, '$1 '); // and/or → and or
  s = s.replace(/\s+[—–-]{1,2}\s+|[—–]/g, ', '); // dashes → pause
  s = s.replace(JUNK, ' ');
  s = s.replace(/[*#`|\\^{}[\]<>~_]/g, ' '); // leftover markup
  s = s.replace(/…/g, '...');

  // ---- punctuation & whitespace ---------------------------------------------------------------
  s = s.replace(/([!?])\1+/g, '$1');
  s = s.replace(/\.{4,}/g, '...');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  s = s.replace(/^[\s,.;:!?)]+/, '');
  s = s.replace(/\(\s*\)/g, '').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  s = s.trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

/** "https://www.github.com/x/y" → "github.com" @param {string} url */
function hostOf(url) {
  const trailing = /[.,;:!?)]+$/.exec(url)?.[0] ?? '';
  const clean = url.slice(0, url.length - trailing.length);
  try {
    const u = new URL(/^https?:/i.test(clean) ? clean : `http://${clean}`);
    return u.hostname.replace(/^www\./i, '') + trailing;
  } catch {
    return `a link${trailing}`;
  }
}

/** @param {string} s @param {string} phrase */
function replaceCodeBlocks(s, phrase) {
  const out = [];
  const lines = s.split('\n');
  /** @type {{ ch: string, len: number }|null} */
  let fence = null;
  for (const line of lines) {
    if (fence) {
      const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      if (phrase && out[out.length - 1] !== phrase) out.push(phrase);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** @param {string} s @param {string} phrase */
function replaceTables(s, phrase) {
  const out = [];
  for (const line of s.split('\n')) {
    if (/^[ \t]{0,3}\|/.test(line)) {
      if (phrase && out[out.length - 1] !== phrase) out.push(phrase);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
