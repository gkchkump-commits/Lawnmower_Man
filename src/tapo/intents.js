// Simple Home camera commands, understood locally (no Claude turn): "camera left", "turn the
// camera a bit to the right", "look at the door", "camera home", "arm the camera", "show me the
// camera". Pure: the avatar link (src/tapo/avatar-link.js) asks parseCameraIntent() before a
// typed or spoken message goes to Claude, and runs the command itself when it matches.
//
// Deliberately narrow: English, the WHOLE utterance must be the command (at most 8 words after
// "hey" / "please" / "can you"), and anything ambiguous goes to Claude. "Look at this code",
// "check the weather" or "turn off the lights" are not camera commands.
//
// Preset names are matched like main does (electron/tapo/ptz.js, contract §8.4): normalized
// (lowercase, no articles or punctuation), exact first, then a prefix, then a Levenshtein
// distance ≤ 2 for names of 4+ characters; two equally good candidates → no match.

/** @typedef {'left'|'right'|'up'|'down'} Dir */
/** @typedef {'small'|'medium'|'large'} Amount */
/**
 * @typedef {{ kind: 'ptz', cmd: object, say: string }
 *   | { kind: 'arm', armed: boolean, say: string }
 *   | { kind: 'open', say: string }} CameraIntent
 */

export const MAX_COMMAND_WORDS = 8;

const ARTICLES = new Set(['the', 'a', 'an', 'my', 'our']);
const LEADING = /^(?:(?:hey|ok|okay)\s+)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/;
const TRAILING = /(?:\s+(?:please|for me|now))+$/;
const SMALL = '(?:a\\s+(?:little\\s+)?bit|a\\s+little|slightly|just\\s+a\\s+bit|a\\s+touch)';
const LARGE = '(?:all\\s+the\\s+way|a\\s+lot|far|way)';

/** Lowercase, apostrophes dropped, punctuation → spaces, one space between words. @param {string} s */
export function normalizeUtterance(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A preset name for matching: normalized, articles removed. @param {string} s */
export function normalizePresetName(s) {
  return normalizeUtterance(s).split(' ').filter((w) => w && !ARTICLES.has(w)).join(' ');
}

/** @param {string} a @param {string} b */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Find the preset a spoken name means.
 * @param {string} query @param {string[]} names
 * @returns {{ name: string } | { ambiguous: string[] } | null}
 */
export function matchPreset(query, names) {
  const q = normalizePresetName(query);
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim());
  if (!q || !list.length) return null;
  const norm = list.map((n) => ({ name: n, key: normalizePresetName(n) })).filter((x) => x.key);
  /** @param {Array<{ name: string }>} hits */
  const decide = (hits) => {
    const unique = [...new Set(hits.map((x) => x.name))];
    if (unique.length === 1) return { name: unique[0] };
    return unique.length > 1 ? { ambiguous: unique } : null;
  };
  const exact = decide(norm.filter((x) => x.key === q));
  if (exact) return exact;
  const prefix = decide(norm.filter((x) => q.length >= 2 && x.key.startsWith(q)));
  if (prefix) return prefix;
  if (q.length < 4) return null;
  let best = 3;
  /** @type {Array<{ name: string }>} */
  let hits = [];
  for (const x of norm) {
    if (x.key.length < 4) continue;
    const d = levenshtein(q, x.key);
    if (d > 2) continue;
    if (d < best) {
      best = d;
      hits = [x];
    } else if (d === best) {
      hits.push(x);
    }
  }
  return decide(hits);
}

/** 0..99 in words, for the spoken confirmations ("thirty seconds"). @param {number} n */
export function numberWords(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0 || v > 99) return String(v);
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  if (v < 20) return ones[v];
  return tens[Math.floor(v / 10)] + (v % 10 ? `-${ones[v % 10]}` : '');
}

/** What the avatar says after arming. @param {number} delaySec the exit delay */
export function armedLine(delaySec) {
  const s = Math.max(0, Math.round(Number(delaySec) || 0));
  if (s <= 0) return 'Armed.';
  if (s < 60 || s % 60) return `Armed. You have ${numberWords(s)} second${s === 1 ? '' : 's'}.`;
  const m = s / 60;
  return `Armed. You have ${numberWords(m)} minute${m === 1 ? '' : 's'}.`;
}

/** "Door" → "the door", "TV" → "the TV", "Mum's room" → "Mum's room". @param {string} name */
export function spokenPresetName(name) {
  const n = String(name || '').trim();
  if (!n) return 'that position';
  const first = n.split(/\s+/)[0].toLowerCase();
  if (ARTICLES.has(first) || /'s\b/i.test(n.split(/\s+/)[0])) return n;
  const lower = n.length > 1 && n[0] === n[0].toUpperCase() && n[1] === n[1].toLowerCase() ? n[0].toLowerCase() + n.slice(1) : n;
  return `the ${lower}`;
}

const DIR_LINE = { left: 'Turning left', right: 'Turning right', up: 'Tilting up', down: 'Tilting down' };

/** @param {Dir} dir @param {Amount} amount */
function moveIntent(dir, amount) {
  const tail = amount === 'small' ? ' a little.' : amount === 'large' ? ' all the way.' : '.';
  return { kind: /** @type {const} */ ('ptz'), cmd: { op: 'nudge', dir, amount }, say: `${DIR_LINE[dir]}${tail}` };
}

/** @param {string|undefined} pre @param {string|undefined} post @returns {Amount} */
function amountOf(pre, post) {
  const m = `${pre || ''} ${post || ''}`;
  if (new RegExp(SMALL).test(m)) return 'small';
  if (new RegExp(LARGE).test(m)) return 'large';
  return 'medium';
}

/** "camera" or the camera's own name ("front door camera") as a regex alternative. @param {string} name */
function cameraWords(name) {
  const n = normalizeUtterance(name);
  const alts = ['camera', 'cam'];
  if (n && n !== 'camera' && n !== 'cam') alts.unshift(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?:${alts.join('|')})`;
}

/**
 * @param {string} text  what the user typed or said
 * @param {{ presets?: string[], name?: string }} [o]  preset names (list order) and the camera's name
 * @returns {CameraIntent|null}  null: not a camera command (Claude handles it)
 */
export function parseCameraIntent(text, o = {}) {
  let t = normalizeUtterance(text);
  if (!t) return null;
  t = t.replace(LEADING, '').replace(TRAILING, '').trim();
  if (!t) return null;
  const words = t.split(' ');
  if (words.length > MAX_COMMAND_WORDS) return null;
  const cam = cameraWords(o.name || 'camera');
  const S = `(?:\\s+(${SMALL}|${LARGE}))?`;
  const DIR = '(?:to\\s+the\\s+)?(left|right|up|down)';
  /** @type {CameraIntent[]} */
  const found = [];
  /** @param {RegExp} re @param {(m: RegExpExecArray) => CameraIntent|null} make */
  const rule = (re, make) => {
    const m = re.exec(t);
    if (!m) return;
    const r = make(m);
    if (r) found.push(r);
  };

  // "camera left", "cam up a bit", "camera all the way right"
  rule(new RegExp(`^(?:the\\s+)?${cam}${S}\\s+${DIR}${S}$`), (m) => moveIntent(/** @type {Dir} */ (m[2]), amountOf(m[1], m[3])));
  // "turn the camera left", "pan right a little", "look left", "move the camera slightly to the right"
  rule(new RegExp(`^(?:turn|pan|look|move|rotate)(?:\\s+the)?(?:\\s+${cam})?${S}\\s+(?:to\\s+the\\s+)?(left|right)${S}$`), (m) => moveIntent(/** @type {Dir} */ (m[2]), amountOf(m[1], m[3])));
  // "tilt up", "tilt the camera down a bit"
  rule(new RegExp(`^tilt(?:\\s+the)?(?:\\s+${cam})?${S}\\s+(up|down)${S}$`), (m) => moveIntent(/** @type {Dir} */ (m[2]), amountOf(m[1], m[3])));
  // "move the camera up", "point the camera down" (the word camera is required here: "look up"
  // means something else)
  rule(new RegExp(`^(?:move|turn|point)\\s+(?:the\\s+)?${cam}${S}\\s+(up|down)${S}$`), (m) => moveIntent(/** @type {Dir} */ (m[2]), amountOf(m[1], m[3])));

  // "camera home", "look home", "center the camera", "camera back home"
  rule(new RegExp(`^(?:(?:the\\s+)?${cam}|look)\\s+(?:back\\s+)?home$`), () => ({ kind: 'ptz', cmd: { op: 'home' }, say: 'Going back to the home position.' }));
  rule(new RegExp(`^(?:re)?cent(?:er|re)\\s+(?:the\\s+)?${cam}$`), () => ({ kind: 'ptz', cmd: { op: 'home' }, say: 'Going back to the home position.' }));

  // "look at the door", "show me the window", "go to desk", "check the front door"
  rule(/^(?:look\s+at|show\s+me|go\s+to|turn\s+to|check(?:\s+on)?)\s+(.+)$/, (m) => {
    const p = matchPreset(m[1], o.presets || []);
    if (!p || !('name' in p)) return null;
    return { kind: 'ptz', cmd: { op: 'preset-name', name: p.name }, say: `Looking at ${spokenPresetName(p.name)}.` };
  });

  // "arm the camera", "disarm security", "turn on the alarm", "turn the camera off"
  const target = `(?:the\\s+)?(?:${cam}|security|alarm|security\\s+camera|home\\s+security)`;
  rule(new RegExp(`^(arm|disarm|turn\\s+on|turn\\s+off|switch\\s+on|switch\\s+off)\\s+${target}$`), (m) => {
    const on = m[1] === 'arm' || /\bon$/.test(m[1]);
    return on ? { kind: 'arm', armed: true, say: 'Arming the camera.' } : { kind: 'arm', armed: false, say: 'Disarmed.' };
  });
  rule(new RegExp(`^(?:turn|switch)\\s+${target}\\s+(on|off)$`), (m) => (m[1] === 'on'
    ? { kind: 'arm', armed: true, say: 'Arming the camera.' }
    : { kind: 'arm', armed: false, say: 'Disarmed.' }));

  // "show me the camera", "open the camera", "show the camera window"
  rule(new RegExp(`^(?:show|open)(?:\\s+me)?\\s+(?:the\\s+)?${cam}(?:\\s+(?:window|view|feed))?$`), () => ({ kind: 'open', say: 'Here is the camera.' }));

  if (found.length !== 1) {
    // several rules can describe the same command ("turn the camera left"); only a real conflict is null
    const keys = new Set(found.map((f) => JSON.stringify(f)));
    return keys.size === 1 ? found[0] : null;
  }
  return found[0];
}
