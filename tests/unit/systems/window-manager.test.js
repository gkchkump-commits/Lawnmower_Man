import { describe, it, expect } from 'vitest';
import {
  CHAT_PANEL_HEIGHT,
  EDGE_MARGIN,
  MIN_CHAT_PANEL_HEIGHT,
  SIZE_PRESETS,
  clampToWorkArea,
  defaultBounds,
  pickDisplay,
  placeWindow,
  reclamp,
  resizeAnchored,
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
  it('clampToWorkArea keeps the top-left visible for oversize windows', () => {
    expect(clampToWorkArea({ x: 100, y: 100, width: 3000, height: 3000 }, primary.workArea)).toEqual({ x: 0, y: 0, width: 3000, height: 3000 });
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
