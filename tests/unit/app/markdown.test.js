import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, renderMarkdown, safeHref } from '../../../src/ui/markdown.js';

// --- a tiny DOM double: enough for renderMarkdown, and it has no innerHTML at all ---------
class FakeNode {
  constructor(type, name) {
    this.nodeType = type;
    this.nodeName = name;
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.className = '';
    this._text = '';
  }
  appendChild(n) {
    if (n.nodeType === 11) this.childNodes.push(...n.childNodes);
    else this.childNodes.push(n);
    return n;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  set textContent(v) { this.childNodes = [new FakeNode(3, '#text')]; this.childNodes[0]._text = String(v); }
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map((c) => c.textContent).join(''); }
}
const doc = {
  createElement: (t) => new FakeNode(1, t.toLowerCase()),
  createTextNode: (t) => { const n = new FakeNode(3, '#text'); n._text = String(t); return n; },
  createDocumentFragment: () => new FakeNode(11, '#fragment'),
};
/** Serialise to a compact HTML-ish string (text escaped) for assertions. */
function html(node) {
  if (node.nodeType === 3) return node._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inner = node.childNodes.map(html).join('');
  if (node.nodeType === 11) return inner;
  const attrs = [
    node.className ? ` class="${node.className}"` : '',
    ...Object.entries(node.attributes).filter(([k]) => k !== 'title' && k !== 'aria-label').map(([k, v]) => ` ${k}="${v}"`),
    Object.keys(node.style).length ? ` style="${Object.entries(node.style).map(([k, v]) => `${k}:${v}`).join(';')}"` : '',
  ].join('');
  return `<${node.nodeName}${attrs}>${inner}</${node.nodeName}>`;
}
const md = (text) => html(renderMarkdown(parseMarkdown(text), /** @type {any} */ (doc)));

describe('markdown: inline', () => {
  it('emphasis, code, strikethrough', () => {
    expect(md('a **b** *c* _d_ ~~e~~ `f*g*`')).toBe('<p>a <strong>b</strong> <em>c</em> <em>d</em> <del>e</del> <code>f*g*</code></p>');
    expect(md('***both***')).toBe('<p><em><strong>both</strong></em></p>');
  });

  it('does not treat snake_case or lone stars as emphasis', () => {
    expect(md('use my_var_name and 2 * 3 * 4')).toBe('<p>use my_var_name and 2 * 3 * 4</p>');
    expect(md('**unclosed bold')).toBe('<p>**unclosed bold</p>');
  });

  it('links: only http(s)/mailto; others become text', () => {
    expect(md('[docs](https://example.com/a_(b)) and [x](javascript:alert(1)) and [m](mailto:a@b.co)'))
      .toBe('<p><a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">docs</a> and x and <a href="mailto:a@b.co" target="_blank" rel="noopener noreferrer">m</a></p>');
  });

  it('bare URLs and autolinks, trailing punctuation excluded', () => {
    expect(md('See https://example.com/x. Or <https://a.org/y>, www.b.com!'))
      .toBe('<p>See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>. Or <a href="https://a.org/y" target="_blank" rel="noopener noreferrer">https://a.org/y</a>, <a href="https://www.b.com" target="_blank" rel="noopener noreferrer">www.b.com</a>!</p>');
  });

  it('images are never loaded (alt text only)', () => {
    expect(md('![a cat](https://x.org/cat.png)')).toBe('<p><a class="md-image" href="https://x.org/cat.png" target="_blank" rel="noopener noreferrer">🖼 a cat</a></p>');
  });

  it('escapes and line breaks', () => {
    expect(md('\\*not em\\* line one\nline two')).toBe('<p>*not em* line one<br></br>line two</p>');
  });

  it('HTML in the text stays text', () => {
    const out = md('<img src=x onerror=alert(1)> <script>bad()</script> **<b>x</b>**');
    expect(out).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &lt;script&gt;bad()&lt;/script&gt; <strong>&lt;b&gt;x&lt;/b&gt;</strong></p>');
  });

  it('parseInline returns an AST', () => {
    expect(parseInline('hi `x`')).toEqual([{ type: 'text', value: 'hi ' }, { type: 'code', value: 'x' }]);
  });

  it('safeHref', () => {
    expect(safeHref('https://a.b')).toBe('https://a.b');
    expect(safeHref('JAVASCRIPT:alert(1)')).toBe('');
    expect(safeHref('file:///etc/passwd')).toBe('');
    expect(safeHref('data:text/html,hi')).toBe('');
    expect(safeHref('www.x.com')).toBe('https://www.x.com');
  });
});

describe('markdown: blocks', () => {
  it('headings, rules, quotes', () => {
    expect(md('# Title\n## Sub ##\n---\n> quoted\n> more')).toBe('<h1>Title</h1><h2>Sub</h2><hr></hr><blockquote><p>quoted<br></br>more</p></blockquote>');
  });

  it('fenced code with language and copy button; text is not interpreted', () => {
    expect(md('```js\nconst a = "<b>";\n  **x**\n```')).toBe(
      '<div class="code-block"><div class="code-head"><span class="code-lang">js</span><button class="code-copy" type="button" data-action="copy-code">Copy</button></div>'
      + '<pre><code data-lang="js">const a = "&lt;b&gt;";\n  **x**</code></pre></div>',
    );
  });

  it('an unterminated fence (streaming) renders as an open block', () => {
    const blocks = parseMarkdown('Look:\n```py\nprint(1)');
    expect(blocks[1]).toEqual({ type: 'code', lang: 'py', text: 'print(1)', open: true });
  });

  it('lists: unordered, ordered with start, nested, tasks', () => {
    expect(md('- a\n- b\n  - c\n- [x] done\n- [ ] todo')).toBe(
      '<ul><li>a</li><li><p>b</p><ul><li>c</li></ul></li><li class="task"><span class="task-box done" aria-hidden="true">✓</span>done</li><li class="task"><span class="task-box" aria-hidden="true"></span>todo</li></ul>',
    );
    expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('list items can contain code blocks', () => {
    const blocks = parseMarkdown('1. Run:\n   ```sh\n   npm test\n   ```\n2. Done');
    expect(blocks).toHaveLength(1);
    const list = /** @type {any} */ (blocks[0]);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children[1]).toMatchObject({ type: 'code', lang: 'sh', text: 'npm test' });
  });

  it('GFM tables with alignment', () => {
    expect(md('| A | B |\n|:--|--:|\n| 1 | `x|y` |\n| 2 |')).toBe(
      '<div class="table-wrap"><table><thead><tr><th style="textAlign:left">A</th><th style="textAlign:right">B</th></tr></thead>'
      + '<tbody><tr><td style="textAlign:left">1</td><td style="textAlign:right"><code>x|y</code></td></tr><tr><td style="textAlign:left">2</td><td style="textAlign:right"></td></tr></tbody></table></div>',
    );
  });

  it('paragraphs separated by blank lines', () => {
    expect(md('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
    expect(md('')).toBe('');
  });
});
