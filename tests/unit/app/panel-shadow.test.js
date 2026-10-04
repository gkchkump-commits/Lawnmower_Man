// The desktop window is transparent: a CSS shadow that reaches past the window edge is cut off
// there and shows as a grey, hard-edged band on a light desktop. The chat panel sits 8 px from
// the left, right and bottom window edges (full and minimal mode), so its outer shadows must fit
// in those 8 px.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/styles/app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const MARGIN = 8;

/** @returns {Array<{ selector: string, body: string }>} top-level rules (no @media nesting in app.css for .panel) */
function rules() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

/** Split a box-shadow value on top-level commas. @param {string} v */
function splitShadows(v) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** @param {string} shadow @returns {{ inset: boolean, x: number, y: number, blur: number, spread: number }} */
function parseShadow(shadow) {
  const noColor = shadow.replace(/rgba?\([^)]*\)|hsla?\([^)]*\)|var\([^)]*\)|#[0-9a-f]{3,8}\b/gi, ' ');
  const lengths = [...noColor.matchAll(/(-?\d*\.?\d+)(px)?\b/g)].map((x) => Number(x[1]));
  const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
  return { inset: /\binset\b/.test(shadow), x, y, blur, spread };
}

const panelRules = rules().filter((r) => r.selector.split(',').some((s) => /(^|\s)\.panel$/.test(s.trim())));

describe('chat panel shadows stay inside the transparent window', () => {
  it('the panel keeps its 8 px margin to the window edges', () => {
    const base = panelRules.find((r) => r.selector === '.panel');
    expect(base?.body).toMatch(/margin:\s*0 8px 8px\s*;/);
    const minimal = panelRules.find((r) => r.selector.includes('[data-chat="minimal"]'));
    for (const side of ['left', 'right', 'bottom']) expect(minimal?.body).toMatch(new RegExp(`${side}:\\s*${MARGIN}px\\s*;`));
  });

  it('no outer shadow of the panel reaches past the left, right or bottom window edge', () => {
    const shadows = panelRules.flatMap((r) => [...r.body.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => ({ selector: r.selector, value: m[1] })));
    expect(shadows.length).toBeGreaterThanOrEqual(3); // base + listening + speaking
    for (const { selector, value } of shadows) {
      for (const s of splitShadows(value)) {
        const p = parseShadow(s);
        if (p.inset) continue;
        const reach = { left: p.blur + p.spread - p.x, right: p.blur + p.spread + p.x, bottom: p.blur + p.spread + p.y };
        for (const [side, px] of Object.entries(reach)) {
          expect(px, `${selector} → "${s}" reaches ${px}px past the ${side} edge`).toBeLessThanOrEqual(MARGIN);
        }
      }
    }
  });

  it('parses shadows the way CSS does', () => {
    expect(parseShadow('0 10px 34px rgba(0, 0, 0, 0.5)')).toEqual({ inset: false, x: 0, y: 10, blur: 34, spread: 0 });
    expect(parseShadow('inset 0 1px 0 rgba(255, 255, 255, 0.04)').inset).toBe(true);
    expect(parseShadow('0 0 0 1px rgba(0, 0, 0, 0.35)')).toMatchObject({ blur: 0, spread: 1 });
    expect(splitShadows('0 1px 2px rgba(0, 0, 0, 0.5), 0 0 8px var(--cyan)')).toHaveLength(2);
  });
});
