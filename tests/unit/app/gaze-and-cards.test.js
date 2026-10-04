import { describe, expect, it } from 'vitest';
import { FAR_GAZE, gazeFromPoint } from '../../../src/app/gaze.js';
import { ARM_MS, createDecisionGate } from '../../../src/ui/permission-cards.js';
import { parseMarkdown } from '../../../src/ui/markdown.js';

describe('gazeFromPoint (global cursor follow)', () => {
  const stage = { left: 0, top: 0, width: 400, height: 600 };

  it('inside the stage it matches the old pointer mapping exactly', () => {
    expect(gazeFromPoint(200, 300, stage)).toEqual([0, 0]);
    expect(gazeFromPoint(400, 0, stage)).toEqual([1, 1]);
    expect(gazeFromPoint(100, 450, stage)).toEqual([-0.5, -0.5]);
  });

  it('outside it keeps the direction and eases off with distance (continuous at the edge)', () => {
    const edge = gazeFromPoint(400, 300, stage); // right edge
    const near = gazeFromPoint(420, 300, stage);
    expect(edge).toEqual([1, 0]);
    expect(near[0]).toBeGreaterThan(0.98);
    const mid = gazeFromPoint(1400, 300, stage); // 5 stage half-widths away
    const far = gazeFromPoint(200 + 200 * 1000, 300, stage);
    expect(mid[0]).toBeLessThan(near[0]);
    expect(mid[0]).toBeGreaterThan(far[0]);
    expect(far[0]).toBeGreaterThan(FAR_GAZE - 0.01);
    expect(Math.abs(mid[1])).toBeLessThan(1e-9);
    // above-left of the window: looks up-left, gently
    const ul = gazeFromPoint(-800, -1200, stage);
    expect(ul[0]).toBeLessThan(0);
    expect(ul[1]).toBeGreaterThan(0);
    expect(Math.max(Math.abs(ul[0]), Math.abs(ul[1]))).toBeLessThan(1);
  });

  it('rejects unusable input', () => {
    expect(gazeFromPoint(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    expect(gazeFromPoint(Number.NaN, 1, stage)).toBeNull();
  });
});

describe('permission card decision gate (SEC-10, SEC-2)', () => {
  const clock = () => {
    let t = 1000;
    return { now: () => t, advance: (ms) => { t += ms; } };
  };

  it('a click right after the card appears does nothing; after arming it decides', () => {
    const c = clock();
    const g = createDecisionGate({ now: c.now });
    g.pointerDown('allow');
    expect(g.accept('allow', 1)).toBe(false); // the click meant for the window underneath
    c.advance(ARM_MS);
    expect(g.accept('allow', 1)).toBe(false); // its pointerdown was before arming
    g.pointerDown('allow');
    expect(g.accept('allow', 1)).toBe(true);
  });

  it('the pointerdown must be on the same button; keyboard activation only needs arming', () => {
    const c = clock();
    const g = createDecisionGate({ now: c.now });
    c.advance(ARM_MS + 1);
    g.pointerDown('deny');
    expect(g.accept('allow', 1)).toBe(false);
    expect(g.accept('deny', 0)).toBe(true); // Enter/Space on a deliberately focused button
  });

  it('a truncated request keeps Allow disabled until "Show all" (Deny always works once armed)', () => {
    const c = clock();
    const g = createDecisionGate({ now: c.now, needsReview: true });
    c.advance(ARM_MS + 1);
    expect(g.enabled('allow')).toBe(false);
    expect(g.enabled('deny')).toBe(true);
    g.pointerDown('allow');
    expect(g.accept('allow', 1)).toBe(false);
    g.review();
    expect(g.enabled('allow')).toBe(true);
    g.pointerDown('allow');
    expect(g.accept('allow', 1)).toBe(true);
  });
});

describe('markdown parser stays fast on hostile text (SEC-11)', () => {
  const time = (s) => {
    const t0 = performance.now();
    parseMarkdown(s);
    return performance.now() - t0;
  };

  it('thousands of unmatched emphasis markers and brackets parse in roughly linear time', () => {
    // was ~11 s for 36 KB of "*a " (cubic)
    for (const unit of ['*a ', '_a ', '**a ', '~~a ', '[a ', '![a ', '[a](b ']) {
      const ms = time(unit.repeat(Math.ceil(30000 / unit.length)));
      expect(ms, JSON.stringify(unit)).toBeLessThan(600);
    }
  });

  it('still parses real emphasis and links', () => {
    const blocks = parseMarkdown('Use *a* and **b** and ~~c~~ with [docs](https://example.com) and *x * y*.');
    const kinds = JSON.stringify(blocks);
    expect(kinds).toContain('"type":"em"');
    expect(kinds).toContain('"type":"strong"');
    expect(kinds).toContain('"type":"del"');
    expect(kinds).toContain('"type":"link"');
    // emphasis never crosses a paragraph break
    expect(JSON.stringify(parseMarkdown('*a\n\nb*'))).not.toContain('"type":"em"');
  });
});
