// A tiny, non-validating XML reader for the camera's SOAP answers (contract §8.1). Pure.
//
// Enough for ONVIF: elements, attributes, text, CDATA, comments and processing instructions.
// Deliberately NOT supported (they only matter to attackers): DTDs (`<!DOCTYPE` is rejected, so
// no entity expansion), named entities beyond the five predefined ones. Names are matched by
// their local part (prefix stripped), so `tt:PanTilt` and `ns2:PanTilt` are the same element —
// prefixes differ between firmwares.

/**
 * @typedef {object} XmlNode
 * @property {string} name      local name (prefix stripped)
 * @property {string} prefix    '' when unprefixed
 * @property {Record<string, string>} attrs  by local name; xmlns declarations are left out
 * @property {XmlNode[]} children
 * @property {string} text      the element's own text (CDATA included), untrimmed
 */

export class XmlError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'XmlError';
    this.code = 'XML_PARSE';
  }
}

const PREDEFINED = /** @type {Record<string, string>} */ ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });

/** @param {string} s */
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  if (/&(?![^;&\s<]{1,12};)/.test(s)) throw new XmlError('stray "&"');
  return s.replace(/&([^;&\s<]{1,12});/g, (_m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw new XmlError(`bad character reference &${ent};`);
      return String.fromCodePoint(code);
    }
    const v = PREDEFINED[ent];
    if (v === undefined) throw new XmlError(`unknown entity &${ent};`);
    return v;
  });
}

/** @param {string} qname */
function splitName(qname) {
  const i = qname.indexOf(':');
  return i < 0 ? { prefix: '', name: qname } : { prefix: qname.slice(0, i), name: qname.slice(i + 1) };
}

const NAME = /^[A-Za-z_À-￿][\w.\-:·À-￿]*/;

/**
 * Parse an XML document into its root element.
 * @param {string} text
 * @param {{ maxBytes?: number, maxDepth?: number }} [o]
 * @returns {XmlNode}
 */
export function parseXml(text, o = {}) {
  const maxBytes = o.maxBytes ?? 1_048_576;
  const maxDepth = o.maxDepth ?? 128;
  if (typeof text !== 'string') throw new XmlError('expected text');
  if (text.length > maxBytes || Buffer.byteLength(text) > maxBytes) throw new XmlError(`document larger than ${maxBytes} bytes`);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  /** @type {XmlNode[]} */
  const stack = [];
  /** @type {XmlNode|null} */
  let root = null;
  const n = text.length;

  /** @param {string} s */
  const addText = (s) => {
    const top = stack[stack.length - 1];
    if (top) top.text += s;
    else if (s.trim()) throw new XmlError('text outside the root element');
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(text.slice(i, lt)));
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) throw new XmlError('unterminated processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) throw new XmlError('unterminated CDATA section');
      addText(text.slice(i + 9, end));
      i = end + 3;
    } else if (text.startsWith('<!', i)) {
      // <!DOCTYPE …> (and anything else starting with <!): no DTDs, no entity declarations.
      throw new XmlError('DOCTYPE and other declarations are not allowed');
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) throw new XmlError('unterminated end tag');
      const qname = text.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top) throw new XmlError(`unexpected </${qname}>`);
      const expected = top.prefix ? `${top.prefix}:${top.name}` : top.name;
      if (qname !== expected) throw new XmlError(`</${qname}> does not close <${expected}>`);
      i = end + 1;
    } else {
      i += 1;
      const m = NAME.exec(text.slice(i, i + 256));
      if (!m) throw new XmlError(`bad element name at ${i}`);
      const qname = m[0];
      i += qname.length;
      const { prefix, name } = splitName(qname);
      /** @type {XmlNode} */
      const node = { name, prefix, attrs: {}, children: [], text: '' };
      // attributes
      for (;;) {
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) throw new XmlError('unterminated start tag');
        if (text[i] === '>' || text.startsWith('/>', i)) break;
        const am = NAME.exec(text.slice(i, i + 256));
        if (!am) throw new XmlError(`bad attribute in <${qname}>`);
        const aq = am[0];
        i += aq.length;
        while (i < n && /\s/.test(text[i])) i++;
        if (text[i] !== '=') throw new XmlError(`attribute ${aq} has no value`);
        i++;
        while (i < n && /\s/.test(text[i])) i++;
        const quote = text[i];
        if (quote !== '"' && quote !== "'") throw new XmlError(`attribute ${aq} is not quoted`);
        const close = text.indexOf(quote, i + 1);
        if (close < 0) throw new XmlError(`unterminated attribute ${aq}`);
        const raw = text.slice(i + 1, close);
        if (raw.includes('<')) throw new XmlError(`"<" in attribute ${aq}`);
        i = close + 1;
        if (aq === 'xmlns' || aq.startsWith('xmlns:')) continue;
        const local = splitName(aq).name;
        if (!(local in node.attrs)) node.attrs[local] = decodeEntities(raw);
      }
      const selfClosing = text.startsWith('/>', i);
      i += selfClosing ? 2 : 1;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) throw new XmlError('more than one root element');
      else root = node;
      if (!selfClosing) {
        if (stack.length >= maxDepth) throw new XmlError(`nested deeper than ${maxDepth} levels`);
        stack.push(node);
      }
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].name}> is not closed`);
  if (!root) throw new XmlError('no root element');
  return root;
}

/** First direct child with this local name. @param {XmlNode|null|undefined} node @param {string} name @returns {XmlNode|null} */
export function child(node, name) {
  if (!node) return null;
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

/** All direct children with this local name. @param {XmlNode|null|undefined} node @param {string} name @returns {XmlNode[]} */
export function children(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/**
 * Follow a slash-separated path of local names from `node` (first match at each step):
 * path(envelope, 'Body/GetProfilesResponse/Profiles').
 * @param {XmlNode|null|undefined} node @param {string} p @returns {XmlNode|null}
 */
export function path(node, p) {
  let cur = node || null;
  for (const seg of p.split('/')) {
    if (!seg) continue;
    cur = child(cur, seg);
    if (!cur) return null;
  }
  return cur;
}

/** Trimmed text at a path ('' = the node itself), or null when the path does not exist. @param {XmlNode|null|undefined} node @param {string} [p] */
export function textOf(node, p = '') {
  const n = p ? path(node, p) : node || null;
  return n ? n.text.trim() : null;
}

/** Every descendant (depth first, document order) with this local name. @param {XmlNode|null|undefined} node @param {string} name @returns {XmlNode[]} */
export function findAll(node, name) {
  /** @type {XmlNode[]} */
  const out = [];
  if (!node) return out;
  const walk = (/** @type {XmlNode} */ n) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Number at a path or attribute, or null. @param {string|null|undefined} s */
export function toNumber(s) {
  if (s === null || s === undefined || String(s).trim() === '') return null;
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}
