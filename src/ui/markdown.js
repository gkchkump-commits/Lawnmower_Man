// Minimal, SAFE Markdown for chat bubbles.
//
// parseMarkdown() turns text into a small AST (pure; unit-tested); renderMarkdown() builds DOM
// nodes from it with createElement/createTextNode only — never innerHTML — so neither the
// model nor the user can inject markup. Links are only created for http(s) and mailto URLs
// (they open in the system browser via Electron's window-open handler); images are shown as
// links (the CSP blocks remote images anyway). Built for streaming: an unterminated code fence
// renders as an open code block.
//
// Blocks: paragraphs (soft line breaks kept), ATX headings, fenced code (``` / ~~~, language),
// block quotes, ordered/unordered/task lists with nesting, GFM tables, horizontal rules.
// Inline: `code`, **strong**, *em* / _em_, ~~del~~, [links](url), <autolinks>, bare URLs,
// ![images](url), backslash escapes, hard/soft breaks.

/**
 * @typedef {{ type: 'text', value: string } | { type: 'code', value: string } | { type: 'br' }
 *   | { type: 'strong'|'em'|'del', children: Inline[] } | { type: 'link', href: string, children: Inline[] }
 *   | { type: 'image', alt: string, href: string }} Inline
 * @typedef {{ type: 'paragraph', children: Inline[] } | { type: 'heading', level: number, children: Inline[] }
 *   | { type: 'code', lang: string, text: string, open: boolean } | { type: 'hr' }
 *   | { type: 'blockquote', children: Block[] }
 *   | { type: 'list', ordered: boolean, start: number, items: Array<{ task: boolean|null, children: Block[] }> }
 *   | { type: 'table', align: Array<'left'|'right'|'center'|null>, header: Inline[][], rows: Inline[][][] }} Block
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^ {0,3}\|?(?:[ \t]*:?-{1,}:?[ \t]*\|)+(?:[ \t]*:?-{1,}:?[ \t]*)?\|?[ \t]*$/;

/** Allowed link targets. @param {string} url */
export function safeHref(url) {
  const u = String(url || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(u) && !/[\s<>"]/.test(u)) return u;
  if (/^www\.[^\s<>"]+$/i.test(u)) return `https://${u}`;
  return '';
}

/**
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return parseBlocks(lines, 0);
}

/** @param {string[]} lines @param {number} depth @returns {Block[]} */
function parseBlocks(lines, depth) {
  /** @type {Block[]} */
  const out = [];
  let i = 0;
  /** @type {string[]} */
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push({ type: 'paragraph', children: parseInline(para.join('\n').trim()) });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      flushPara();
      const marker = m[1];
      const lang = (m[2] || '').slice(0, 30);
      const indent = (/^ */.exec(line) || [''])[0].length;
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (c && c[1][0] === marker[0] && c[1].length >= marker.length) {
          closed = true;
          i++;
          break;
        }
        body.push(indent ? l.replace(new RegExp(`^ {0,${indent}}`), '') : l);
        i++;
      }
      out.push({ type: 'code', lang, text: body.join('\n'), open: !closed });
      continue;
    }
    if ((m = HEADING.exec(line))) {
      flushPara();
      out.push({ type: 'heading', level: m[1].length, children: parseInline(m[2] || '') });
      i++;
      continue;
    }
    if (HR.test(line) && !(para.length && /^ {0,3}-+[ \t]*$/.test(line))) {
      flushPara();
      out.push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < 8) {
      flushPara();
      const inner = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
        inner.push(m[1]);
        i++;
      }
      out.push({ type: 'blockquote', children: parseBlocks(inner, depth + 1) });
      continue;
    }
    if ((m = LIST_ITEM.exec(line)) && depth < 8 && (!para.length || !/^\d/.test(m[2]) || m[2].startsWith('1'))) {
      flushPara();
      const r = parseList(lines, i, depth);
      out.push(r.block);
      i = r.next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      const r = parseTable(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

/** @param {string} l */
const indentOf = (l) => (/^ */.exec(l) || [''])[0].length;

/** @param {string[]} lines @param {number} start @param {number} depth */
function parseList(lines, start, depth) {
  const first = /** @type {RegExpExecArray} */ (LIST_ITEM.exec(lines[start]));
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  /** @type {Array<{ task: boolean|null, children: Block[] }>} */
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    // a different indentation or list type ends this list
    if (!m || m[1].length !== baseIndent || /^\d/.test(m[2]) !== ordered) break;
    const content = [m[3]];
    const contentIndent = baseIndent + m[2].length + 1;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // a blank line continues the item only if indented content follows
        const next = lines[i + 1];
        if (next !== undefined && next.trim() && indentOf(next) > baseIndent) {
          content.push('');
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > baseIndent) {
        content.push(l.slice(Math.min(ind, contentIndent))); // nested content
        i++;
        continue;
      }
      if (ind < baseIndent || LIST_ITEM.test(l)) break; // next item, or the parent's next item
      if (HEADING.test(l) || FENCE.test(l) || QUOTE.test(l) || HR.test(l)) break;
      content.push(l.trim()); // lazy continuation line
      i++;
    }
    let task = null;
    const tm = /^\[([ xX])\][ \t]+/.exec(content[0]);
    if (tm) {
      task = tm[1] !== ' ';
      content[0] = content[0].slice(tm[0].length);
    }
    items.push({ task, children: parseBlocks(content, depth + 1) });
  }
  return { block: /** @type {Block} */ ({ type: 'list', ordered, start: startNum, items }), next: i };
}

/** @param {string} row */
function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (c === '`') inCode = !inCode;
    if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** @param {string[]} lines @param {number} start */
function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitRow(lines[i]);
    rows.push(header.map((_, k) => parseInline(cells[k] ?? '')));
    i++;
  }
  return {
    block: /** @type {Block} */ ({ type: 'table', align: header.map((_, k) => /** @type {any} */ (align[k] ?? null)), header: header.map((c) => parseInline(c)), rows }),
    next: i,
  };
}

// ---------------------------------------------------------------------------------------------
// Inline

const PUNCT_ESCAPE = /[\\`*_{}[\]()#+\-.!|~<>"']/;
const URL_START = /(?:https?:\/\/|www\.)/iy;

/**
 * @param {string} src
 * @param {number} [depth]
 * @returns {Inline[]}
 */
export function parseInline(src, depth = 0) {
  /** @type {Inline[]} */
  const out = [];
  let text = '';
  const pushText = () => {
    if (text) {
      out.push({ type: 'text', value: text });
      text = '';
    }
  };
  const s = String(src ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // escapes
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') {
        pushText();
        out.push({ type: 'br' });
        i += 2;
        continue;
      }
      if (PUNCT_ESCAPE.test(s[i + 1])) {
        text += s[i + 1];
        i += 2;
        continue;
      }
    }
    // line breaks (chat: every newline is a break)
    if (c === '\n') {
      text = text.replace(/ +$/, '');
      pushText();
      out.push({ type: 'br' });
      i++;
      continue;
    }
    // code span
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))[0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) {
        pushText();
        let v = s.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .+ $/.test(v)) v = v.slice(1, -1);
        out.push({ type: 'code', value: v });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    // images and links
    if ((c === '!' && s[i + 1] === '[') || c === '[') {
      const isImg = c === '!';
      const r = parseLinkAt(s, isImg ? i + 1 : i);
      if (r) {
        pushText();
        const href = safeHref(r.url);
        if (isImg) out.push({ type: 'image', alt: r.label, href });
        else if (href && depth < 4) out.push({ type: 'link', href, children: parseInline(r.label, depth + 1) });
        else out.push(...parseInline(r.label, depth + 1));
        i = r.end;
        continue;
      }
    }
    // autolinks <https://…>
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        pushText();
        const href = safeHref(m[1]);
        out.push(href ? { type: 'link', href, children: [{ type: 'text', value: m[1].replace(/^mailto:/i, '') }] } : { type: 'text', value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // bare URLs
    if ((c === 'h' || c === 'H' || c === 'w' || c === 'W') && (i === 0 || /[\s(["'*_~]/.test(s[i - 1]))) {
      URL_START.lastIndex = i;
      if (URL_START.test(s)) {
        let j = i;
        while (j < s.length && !/[\s<>"`]/.test(s[j])) j++;
        let url = s.slice(i, j);
        // trailing punctuation is not part of the URL (balanced parens are)
        for (;;) {
          const last = url[url.length - 1];
          if (/[.,;:!?'*_~]/.test(last)) url = url.slice(0, -1);
          else if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
          else break;
        }
        const href = safeHref(url);
        if (href && url.length > 4) {
          pushText();
          out.push({ type: 'link', href, children: [{ type: 'text', value: url }] });
          i += url.length;
          continue;
        }
      }
    }
    // emphasis
    if ((c === '*' || c === '_' || c === '~') && depth < 6) {
      const r = parseEmphasis(s, i, depth);
      if (r) {
        pushText();
        out.push(r.node);
        i = r.end;
        continue;
      }
    }
    text += c;
    i++;
  }
  pushText();
  return out;
}

/** Longest link label / URL considered (longer ones are shown as plain text). */
const LINK_MAX_LABEL = 1000;
const LINK_MAX_URL = 2048;

/**
 * [label](url "title") starting at s[i] === '['.
 * @param {string} s @param {number} i
 * @returns {{ label: string, url: string, end: number }|null}
 */
function parseLinkAt(s, i) {
  let depth = 0;
  let j = i;
  // bounded like emphasis: an unclosed "[" must not scan the rest of the text for every "["
  const labelEnd = Math.min(s.length, i + LINK_MAX_LABEL);
  for (; j < labelEnd; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    } else if (ch === '\n' && s[j + 1] === '\n') return null;
  }
  if (j >= labelEnd || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  const start = j + 2;
  let k = start;
  let parens = 1;
  const urlEnd = Math.min(s.length, k + LINK_MAX_URL);
  while (k < urlEnd && parens > 0) {
    const ch = s[k];
    if (ch === '(') parens++;
    else if (ch === ')') {
      parens--;
      if (parens === 0) break;
    } else if (ch === '\n') return null;
    k++;
  }
  if (parens !== 0) return null;
  const url = s.slice(start, k).trim().replace(/\s+("[^"]*"|'[^']*')$/, '').replace(/^<(.*)>$/, '$1');
  return { label, url, end: k + 1 };
}

/**
 * Bounds for the closer search of one emphasis opener. Without them, text with many unmatched
 * markers ("*a *a *a …", C pointers, `*args`) costs O(n²) per opener — O(n³) for a paragraph,
 * re-parsed on every streamed frame — and freezes the window. An opener whose closer is further
 * away than this is shown literally (real emphasis spans are short).
 */
const EMPH_MAX_SPAN = 3000;
const EMPH_MAX_CANDIDATES = 64;

/**
 * ** __ * _ ~~ emphasis starting at s[i].
 * @param {string} s @param {number} i @param {number} depth
 * @returns {{ node: Inline, end: number }|null}
 */
function parseEmphasis(s, i, depth) {
  const c = s[i];
  // emphasis never crosses a paragraph break, and the search is bounded (see EMPH_MAX_*)
  const windowEnd = Math.min(s.length, i + EMPH_MAX_SPAN);
  const para = s.slice(i + 1, windowEnd).indexOf('\n\n');
  const limit = para < 0 ? windowEnd : i + 1 + para;
  if ((c === '*' || c === '_') && s[i + 1] === c && s[i + 2] === c) {
    // ***strong emphasis***
    const k = s.indexOf(c + c + c, i + 3);
    if (k > i + 3 && k < limit && !/\s/.test(s[i + 3]) && !/\s/.test(s[k - 1])) {
      const inner = parseInline(s.slice(i + 3, k), depth + 1);
      return { node: { type: 'em', children: [{ type: 'strong', children: inner }] }, end: k + 3 };
    }
  }
  const double = s[i + 1] === c;
  if (c === '~' && !double) return null;
  const marker = double ? c + c : c;
  const after = s[i + marker.length];
  if (!after || /\s/.test(after)) return null;
  // intraword underscores are not emphasis (snake_case)
  if (c === '_' && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1])) return null;
  let j = i + marker.length;
  for (let tries = 0; j < limit && tries < EMPH_MAX_CANDIDATES; tries++) {
    const k = s.indexOf(marker, j);
    if (k < 0 || k >= limit) return null;
    const before = s[k - 1];
    const next = s[k + marker.length];
    const triple = !double && s[k + 1] === c; // "*a**" ambiguity: skip the double
    if (!/\s/.test(before) && !triple && !(c === '_' && next && /[\p{L}\p{N}]/u.test(next)) && k > i + marker.length) {
      const inner = s.slice(i + marker.length, k);
      const type = c === '~' ? 'del' : double ? 'strong' : 'em';
      return { node: /** @type {Inline} */ ({ type, children: parseInline(inner, depth + 1) }), end: k + marker.length };
    }
    j = k + (triple ? 2 : 1);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rendering (DOM, no innerHTML)

/**
 * @param {Block[]} blocks
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function renderMarkdown(blocks, doc = document) {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) frag.appendChild(renderBlock(b, doc));
  return frag;
}

/** Parse + render. @param {string} text @param {Document} [doc] */
export function markdownToFragment(text, doc = document) {
  return renderMarkdown(parseMarkdown(text), doc);
}

/** @param {Block} b @param {Document} doc @returns {Node} */
function renderBlock(b, doc) {
  const el = (tag, cls) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  switch (b.type) {
    case 'paragraph': {
      const p = el('p');
      appendInline(p, b.children, doc);
      return p;
    }
    case 'heading': {
      const hx = el(`h${Math.min(6, Math.max(1, b.level))}`);
      appendInline(hx, b.children, doc);
      return hx;
    }
    case 'hr':
      return el('hr');
    case 'code': {
      const wrap = el('div', b.open ? 'code-block open' : 'code-block');
      const head = el('div', 'code-head');
      const lang = el('span', 'code-lang');
      lang.textContent = b.lang || 'code';
      const btn = el('button', 'code-copy');
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-action', 'copy-code');
      btn.setAttribute('aria-label', 'Copy code');
      btn.textContent = 'Copy';
      head.appendChild(lang);
      head.appendChild(btn);
      const pre = el('pre');
      const code = el('code');
      if (b.lang) code.setAttribute('data-lang', b.lang);
      code.textContent = b.text;
      pre.appendChild(code);
      wrap.appendChild(head);
      wrap.appendChild(pre);
      return wrap;
    }
    case 'blockquote': {
      const q = el('blockquote');
      for (const c of b.children) q.appendChild(renderBlock(c, doc));
      return q;
    }
    case 'list': {
      const list = el(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) list.setAttribute('start', String(b.start));
      for (const item of b.items) {
        const li = el('li', item.task === null ? '' : 'task');
        if (item.task !== null) {
          const box = el('span', item.task ? 'task-box done' : 'task-box');
          box.setAttribute('aria-hidden', 'true');
          box.textContent = item.task ? '✓' : '';
          li.appendChild(box);
        }
        // a single paragraph item renders without the <p> wrapper (tight list)
        if (item.children.length === 1 && item.children[0].type === 'paragraph') appendInline(li, item.children[0].children, doc);
        else for (const c of item.children) li.appendChild(renderBlock(c, doc));
        list.appendChild(li);
      }
      return list;
    }
    case 'table': {
      const wrap = el('div', 'table-wrap');
      const table = el('table');
      const thead = el('thead');
      const tr = el('tr');
      b.header.forEach((cell, k) => {
        const th = el('th');
        if (b.align[k]) th.style.textAlign = b.align[k];
        appendInline(th, cell, doc);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const row of b.rows) {
        const r = el('tr');
        row.forEach((cell, k) => {
          const td = el('td');
          if (b.align[k]) td.style.textAlign = b.align[k];
          appendInline(td, cell, doc);
          r.appendChild(td);
        });
        tbody.appendChild(r);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }
    default:
      return doc.createTextNode('');
  }
}

/** @param {Node} parent @param {Inline[]} nodes @param {Document} doc */
function appendInline(parent, nodes, doc) {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        parent.appendChild(doc.createTextNode(n.value));
        break;
      case 'br':
        parent.appendChild(doc.createElement('br'));
        break;
      case 'code': {
        const c = doc.createElement('code');
        c.textContent = n.value;
        parent.appendChild(c);
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const e = doc.createElement(n.type);
        appendInline(e, n.children, doc);
        parent.appendChild(e);
        break;
      }
      case 'link': {
        const a = doc.createElement('a');
        a.setAttribute('href', n.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('title', n.href);
        appendInline(a, n.children, doc);
        parent.appendChild(a);
        break;
      }
      case 'image': {
        // never load remote images: show the alt text (linked when the URL is safe)
        const label = `🖼 ${n.alt || 'image'}`;
        if (n.href) {
          const a = doc.createElement('a');
          a.setAttribute('href', n.href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.className = 'md-image';
          a.textContent = label;
          parent.appendChild(a);
        } else {
          const sp = doc.createElement('span');
          sp.className = 'md-image';
          sp.textContent = label;
          parent.appendChild(sp);
        }
        break;
      }
      default:
        break;
    }
  }
}
