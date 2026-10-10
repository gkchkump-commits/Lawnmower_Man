// A small, tolerant XML reader for the simulator's SOAP requests. Deliberately independent of the
// app's own parser (electron/tapo/xml.js), so the simulator checks the client against a second
// implementation. Elements are matched by local name (prefixes stripped), like a camera would.

/**
 * @typedef {{ name: string, prefix: string, attrs: Record<string, string>, children: XNode[], text: string }} XNode
 */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** @param {string} s */
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (e)] ?? m;
  });
}

/** @param {string} qname */
function split(qname) {
  const i = qname.indexOf(':');
  return i < 0 ? { prefix: '', name: qname } : { prefix: qname.slice(0, i), name: qname.slice(i + 1) };
}

/**
 * Parse a document; throws on broken structure (the server answers that with a SOAP fault).
 * @param {string} text @returns {XNode}
 */
export function parse(text) {
  if (/<!DOCTYPE/i.test(text)) throw new Error('DOCTYPE not allowed');
  /** @type {XNode} */
  const root = { name: '#document', prefix: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      const { name } = split(m[2]);
      if (stack.length < 2 || top.name !== name) throw new Error(`unexpected </${m[2]}>`);
      top.text = top.text.trim();
      stack.pop();
    } else if (m[3] !== undefined) {
      const { prefix, name } = split(m[3]);
      /** @type {Record<string, string>} */
      const attrs = {};
      const are = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = are.exec(m[4] || ''))) attrs[split(a[1]).name] = decode(a[2] ?? a[3] ?? '');
      /** @type {XNode} */
      const node = { name, prefix, attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decode(m[6]);
    } else if (m[0].startsWith('<') && !m[0].startsWith('<!--') && !m[0].startsWith('<?')) {
      throw new Error('malformed markup');
    }
  }
  if (stack.length !== 1) throw new Error('unclosed element');
  if (!root.children.length) throw new Error('empty document');
  return root;
}

/** First child by local name. @param {XNode|null|undefined} n @param {string} name */
export function child(n, name) {
  return n ? n.children.find((c) => c.name === name) || null : null;
}

/** Follow a path of local names ('Body/RelativeMove/Translation'). @param {XNode|null|undefined} n @param {string} p */
export function at(n, p) {
  let cur = n || null;
  for (const part of p.split('/')) {
    if (!cur) return null;
    cur = child(cur, part);
  }
  return cur;
}

/** Text at a path ('' when absent). @param {XNode|null|undefined} n @param {string} p */
export function textAt(n, p) {
  return at(n, p)?.text ?? '';
}

/** Depth-first search by local name. @param {XNode|null|undefined} n @param {string} name @returns {XNode[]} */
export function findAll(n, name) {
  if (!n) return [];
  const out = [];
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    out.push(...findAll(c, name));
  }
  return out;
}
