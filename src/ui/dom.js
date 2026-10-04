// Tiny DOM helpers. Text always goes in through textContent / createTextNode — never
// innerHTML — so model or user text can never inject markup.
/* global Node */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element.
 *   h('button', { class: 'x', type: 'button', onclick: fn, 'aria-label': 'Send' }, 'Send')
 * Attributes: `class`, `dataset` (object), `style` (object), `on<event>` (listener), boolean
 * true → empty attribute, false/null/undefined → omitted. Children: nodes, strings (as text),
 * arrays, null/false (skipped).
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** @param {Element} el @param {Record<string, any>|null|undefined} attrs */
function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', String(v));
    else if (k === 'dataset') Object.assign(/** @type {HTMLElement} */ (el).dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(/** @type {HTMLElement} */ (el).style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/** @param {Node} el @param {any[]} children */
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Remove all children. @param {Node} el */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Icon path data (24×24 viewBox, stroke icons). */
export const ICONS = Object.freeze({
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7',
  send: 'M4 12l16-8-6 16-3-7-7-1z',
  stop: 'M7 7h10v10H7z',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
  chat: 'M4 5h16v11H9l-5 4z',
  minimize: 'M6 12h12',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M7 7l10 10M17 7L7 17',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z',
  voice: 'M3 10v4M7 7v10M11 4v16M15 8v8M19 11v2',
  info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  plus: 'M12 5v14M5 12h14',
});

/**
 * An inline SVG icon.
 * @param {keyof typeof ICONS} name @param {string} [cls]
 */
export function icon(name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.appendChild(p);
  return svg;
}

/** Is the event target a text-entry control (so Space must type, not talk)? @param {EventTarget|null} t */
export function isTypingTarget(t) {
  const el = /** @type {HTMLElement|null} */ (t);
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

/** Is the event target an activatable control (Space would press it)? @param {EventTarget|null} t */
export function isControlTarget(t) {
  const el = /** @type {HTMLElement|null} */ (t);
  if (!el || !el.tagName) return false;
  return isTypingTarget(el) || ['button', 'a', 'summary'].includes(el.tagName.toLowerCase()) || el.getAttribute?.('role') === 'button';
}
