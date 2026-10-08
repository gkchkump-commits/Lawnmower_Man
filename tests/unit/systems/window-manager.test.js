import { describe, it, expect } from 'vitest';
import {
  CHAT_PANEL_HEIGHT,
  DRAG_THRESHOLD,
  EDGE_MARGIN,
  MIN_CHAT_PANEL_HEIGHT,
  SIZE_PRESETS,
  clampToWorkArea,
  defaultBounds,
  dragBounds,
  pickDisplay,
  placeWindow,
  reclamp,
  resizeAnchored,
  settleDrop,
  windowLayout,
} from '../../../electron/window-manager.js';

const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const second = { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, workArea: { x: 1920, y: -200, width: 2560, height: 1400 } };

describe('windowLayout', () => {
  it('uses the contract presets', () => {
    expect(SIZE_PRESETS.small).toEqual({ width: 300, height: 450 });
    expect(SIZE_PRESETS.medium).toEqual({ width: 400, height: 600 });
    expect(SIZE_PRESETS.large).toEqual({ width: 560, height: 840 });
  });
  it('adds the chat panel below the avatar', () => {
    const l = windowLayout('medium', true);
    expect(l).toMatchObject({ width: 400, height: 600 + CHAT_PANEL_HEIGHT.medium, avatar: { width: 400, height: 600 } });
    expect(l.chat).toEqual({ position: 'bottom', width: 400, height: CHAT_PANEL_HEIGHT.medium });
    expect(windowLayout('medium', false)).toMatchObject({ width: 400, height: 600, chat: null });
  });
  it('falls back to medium for unknown presets', () => {
    expect(windowLayout('huge', false).preset).toBe('medium');
  });
  it('shrinks the chat panel to fit short work areas', () => {
    const l = windowLayout('large', true, { x: 0, y: 0, width: 1280, height: 1000 });
    expect(l.chat.height).toBe(160);
    const tiny = windowLayout('large', true, { x: 0, y: 0, width: 1280, height: 700 });
    expect(tiny.chat.height).toBe(MIN_CHAT_PANEL_HEIGHT);
    expect(tiny.height).toBeLessThanOrEqual(700);
  });
  it('shrinks the avatar area (exact 2:3) when even the minimum chat strip does not fit', () => {
    // CI runner (1024x768, taskbar) and a 1080p laptop at 150% scaling (~1280x672 work area)
    for (const h of [720, 672, 600]) {
      const l = windowLayout('medium', true, { x: 0, y: 0, width: 1280, height: h });
      expect(l.height, `work area ${h}`).toBeLessThanOrEqual(h);
      expect(l.chat.height).toBe(MIN_CHAT_PANEL_HEIGHT);
      expect(l.avatar.width * 3).toBe(l.avatar.height * 2); // the renderer derives the strip from width * 1.5
      expect(l.width).toBe(l.avatar.width);
      expect(l.height).toBe(l.avatar.height + l.chat.height);
    }
    expect(windowLayout('medium', true, { x: 0, y: 0, width: 1280, height: 672 }).avatar).toEqual({ width: 354, height: 531 });
    // without the chat strip the avatar alone must fit too (large preset on a short screen)
    expect(windowLayout('large', false, { x: 0, y: 0, width: 1280, height: 720 })).toMatchObject({ width: 480, height: 720, chat: null });
    // roomy screens are unchanged
    expect(windowLayout('medium', true, { x: 0, y: 0, width: 1920, height: 1032 })).toMatchObject({ width: 400, height: 840 });
  });
});

describe('placement', () => {
  const size = { width: 400, height: 840 };
  it('defaults to the bottom-right of the primary work area', () => {
    const b = placeWindow({ saved: null, size, displays: [primary], primary });
    expect(b).toEqual({ x: 1920 - 400 - EDGE_MARGIN, y: 1032 - 840 - EDGE_MARGIN, width: 400, height: 840 });
    expect(defaultBounds(size, primary.workArea)).toEqual(b);
  });
  it('restores a saved position on a secondary monitor (negative coordinates)', () => {
    const b = placeWindow({ saved: { x: 3000, y: -150 }, size, displays: [primary, second], primary });
    expect(b).toEqual({ x: 3000, y: -150, width: 400, height: 840 });
  });
  it('clamps a partially off-screen position fully onto the display', () => {
    const b = placeWindow({ saved: { x: 1800, y: 500 }, size, displays: [primary], primary });
    expect(b).toEqual({ x: 1520, y: 192, width: 400, height: 840 });
  });
  it('resets when the saved monitor is gone', () => {
    const b = placeWindow({ saved: { x: 3000, y: 100 }, size, displays: [primary], primary });
    expect(b).toEqual(defaultBounds(size, primary.workArea));
  });
  it('pickDisplay uses overlap, then nearest centre', () => {
    expect(pickDisplay({ x: 1900, y: 0, width: 400, height: 400 }, [primary, second]).id).toBe(2);
    expect(pickDisplay({ x: -5000, y: 0, width: 10, height: 10 }, [primary, second]).id).toBe(1);
    expect(pickDisplay({ x: 0, y: 0, width: 1, height: 1 }, [])).toBeNull();
  });
  it('clampToWorkArea keeps oversize windows inside the work area (never under the taskbar)', () => {
    expect(clampToWorkArea({ x: 100, y: 100, width: 3000, height: 3000 }, primary.workArea)).toEqual({ x: 0, y: 0, width: primary.workArea.width, height: primary.workArea.height });
  });
});

describe('resizeAnchored', () => {
  it('keeps the bottom-right corner for a window docked bottom-right', () => {
    const old = { x: 1496, y: 192, width: 400, height: 840 };
    const r = resizeAnchored(old, { width: 560, height: 1120 }, primary.workArea);
    // Grows up/left; then clamped to the top of the work area.
    expect(r.x + r.width).toBe(old.x + old.width);
    expect(r.y).toBe(0);
  });
  it('keeps the top-left corner for a window in the top-left quadrant', () => {
    const old = { x: 50, y: 60, width: 400, height: 600 };
    expect(resizeAnchored(old, { width: 300, height: 450 }, primary.workArea)).toEqual({ x: 50, y: 60, width: 300, height: 450 });
  });
  it('reclamp moves a window back after a monitor disappears', () => {
    const b = reclamp({ x: 3000, y: 0, width: 400, height: 600 }, [primary], primary);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
  });
});

describe('dragging', () => {
  const start = { x: 900, y: 200, width: 400, height: 840 };
  it('a press that barely moves stays a click', () => {
    const from = { x: 1000, y: 500 };
    expect(dragBounds(start, from, { x: 1000 + DRAG_THRESHOLD - 1, y: 500 - (DRAG_THRESHOLD - 1) }, false)).toBe(null);
    expect(dragBounds(start, from, { x: 1000 + DRAG_THRESHOLD, y: 500 }, false)).toEqual({ ...start, x: 900 + DRAG_THRESHOLD });
  });
  it('once moving, follows the cursor exactly (also back within the threshold), size unchanged', () => {
    const from = { x: 1000, y: 500 };
    expect(dragBounds(start, from, { x: 1001, y: 499 }, true)).toEqual({ ...start, x: 901, y: 199 });
    expect(dragBounds(start, from, { x: 400.4, y: 1300.6 }, true)).toEqual({ x: 300, y: 1001, width: 400, height: 840 });
  });
  it('crosses onto a second monitor with negative coordinates', () => {
    expect(dragBounds(start, { x: 1000, y: 500 }, { x: 2600, y: 100 }, true)).toEqual({ ...start, x: 2500, y: -200 });
  });
  it('settles a drop fully onto the display it landed on', () => {
    // half under the taskbar of the primary display
    expect(settleDrop({ ...start, y: 600 }, [primary, second], primary)).toEqual({ ...start, y: 1032 - 840 });
    // mostly on the second monitor, poking above its top edge
    expect(settleDrop({ ...start, x: 2500, y: -400 }, [primary, second], primary)).toEqual({ ...start, x: 2500, y: -200 });
    // nowhere near any display: nearest one
    expect(settleDrop({ ...start, x: -9000, y: 0 }, [primary, second], primary)).toEqual({ ...start, x: 0, y: 0 });
  });
});
