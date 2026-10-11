// Where the video sits in the live view and what a click means (src/tapo/geometry.js, used by
// the live view's click-to-center and person boxes, and by the worker's drawing).
import { describe, expect, it } from 'vitest';
import { boxToView, clampBox, letterbox, uvAt } from '../../../src/tapo/geometry.js';
import { letterbox as lvLetterbox, uvAt as lvUvAt } from '../../../src/tapo/ui/live-view.js';

describe('letterbox', () => {
  it('a 16:9 video in a wider box: bars left and right', () => {
    expect(letterbox(1920, 1080, 1000, 450)).toEqual({ x: 100, y: 0, width: 800, height: 450 });
  });
  it('a 16:9 video in a taller box: bars top and bottom', () => {
    expect(letterbox(2304, 1296, 800, 600)).toEqual({ x: 0, y: 75, width: 800, height: 450 });
  });
  it('degenerate sizes do not throw', () => {
    expect(letterbox(0, 0, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(letterbox(16, 9, 0, 0).width).toBe(0);
  });
  it('the live view uses the same function', () => {
    expect(lvLetterbox).toBe(letterbox);
    expect(lvUvAt).toBe(uvAt);
  });
});

describe('uvAt (click-to-center)', () => {
  const box = { w: 800, h: 600 }; // video at y 75..525
  it('maps a click inside the video to 0..1, u right, v down', () => {
    expect(uvAt(400, 300, box.w, box.h, 16, 9)).toEqual({ u: 0.5, v: 0.5 });
    expect(uvAt(0, 75, box.w, box.h, 16, 9)).toEqual({ u: 0, v: 0 });
    expect(uvAt(800, 525, box.w, box.h, 16, 9)).toEqual({ u: 1, v: 1 });
    const r = uvAt(600, 187.5, box.w, box.h, 16, 9);
    expect(r?.u).toBeCloseTo(0.75);
    expect(r?.v).toBeCloseTo(0.25);
  });
  it('a click on a letterbox bar is not a point in the picture', () => {
    expect(uvAt(400, 40, box.w, box.h, 16, 9)).toBeNull();
    expect(uvAt(400, 560, box.w, box.h, 16, 9)).toBeNull();
    expect(uvAt(50, 225, 1000, 450, 16, 9)).toBeNull(); // the left bar of a wide box
    expect(uvAt(Number.NaN, 1, 10, 10, 16, 9)).toBeNull();
  });
});

describe('boxes', () => {
  it('a person box in video fractions → view pixels', () => {
    const v = letterbox(16, 9, 800, 600);
    expect(boxToView([0.25, 0.5, 0.1, 0.2], v)).toEqual({ x: 200, y: 75 + 225, width: 80, height: 90 });
  });
  it('clampBox keeps boxes inside the picture (what main accepts)', () => {
    expect(clampBox([-0.1, 0.2, 0.5, 0.3])).toEqual([0, 0.2, 0.5, 0.3]);
    expect(clampBox([0.8, 0.9, 0.5, 0.5])).toEqual([0.8, 0.9, expect.closeTo(0.2), expect.closeTo(0.1)]);
    expect(clampBox([Number.NaN, 0, 2, 1])).toEqual([0, 0, 1, 1]);
  });
});
