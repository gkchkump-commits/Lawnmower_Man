import { describe, it, expect } from 'vitest';
import {
  CHAT_PANEL_HEIGHT,
  CORNERS,
  DRAG_THRESHOLD,
  MAX_AVATAR_WIDTH,
  MAX_CHAT_PANEL_HEIGHT,
  MIN_AVATAR_WIDTH,
  chatHeightFor,
  normalizeAvatarWidth,
  resizeBounds,
  EDGE_MARGIN,
  MIN_CHAT_PANEL_HEIGHT,
  SIZE_PRESETS,
  clampToWorkArea,
  defaultBounds,
  dragBounds,
  initialBounds,
  pickDisplay,
  placeWindow,
  reclamp,
  resizeAnchored,
  settleDrop,
  snapToEdges,
  SNAP_DISTANCE,
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
    expect(l.chat).toEqual({ position: 'bottom', width: 400, height: CHAT_PANEL_HEIGHT.medium, mode: 'full' });
    // minimal mode keeps the strip (the panel drops down into it), so toggling never resizes
    expect(windowLayout('medium', false)).toEqual({ ...l, chat: { ...l.chat, mode: 'dropdown' } });
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
    // minimal mode fits the same way (the strip is always there)
    const mini = windowLayout('large', false, { x: 0, y: 0, width: 1280, height: 720 });
    expect(mini).toEqual({ ...windowLayout('large', true, { x: 0, y: 0, width: 1280, height: 720 }), chat: { ...mini.chat, mode: 'dropdown' } });
    expect(mini.height).toBeLessThanOrEqual(720);
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
  it('sizes the window for the display it opens on (a shorter second screen gets a smaller one)', () => {
    // a 1080p laptop at 150 % next to the primary: 1280×720 DIP, 672 px of work area
    const laptop = { id: 3, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, workArea: { x: 1920, y: 0, width: 1280, height: 672 } };
    const displays = [primary, laptop];
    const there = initialBounds({ saved: { x: 2400, y: 0 }, preset: 'medium', showChat: true, displays, primary });
    expect(there.layout).toEqual(windowLayout('medium', true, laptop.workArea));
    expect(there.bounds).toEqual({ x: 2400, y: 0, width: there.layout.width, height: there.layout.height });
    expect(there.layout.avatar.height + there.layout.chat.height).toBeLessThanOrEqual(672);
    expect(there.layout.avatar.height / there.layout.avatar.width).toBe(1.5);
    // on the primary (or with nothing saved) it is the primary's layout
    const here = initialBounds({ saved: { x: 100, y: 100 }, preset: 'medium', showChat: true, displays, primary });
    expect(here.bounds).toEqual({ x: 100, y: 100, width: 400, height: 840 });
    expect(initialBounds({ saved: null, preset: 'large', showChat: false, displays, primary }).bounds)
      .toEqual(placeWindow({ saved: null, size: windowLayout('large', false, primary.workArea), displays, primary }));
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

describe('snapping to screen edges (like a normal window)', () => {
  const size = { width: 400, height: 840 };
  it('locks flush against an edge within SNAP_DISTANCE and lets go beyond it', () => {
    const d = [primary, second];
    expect(snapToEdges({ ...size, x: SNAP_DISTANCE, y: 100 }, d)).toEqual({ ...size, x: 0, y: 100 });
    expect(snapToEdges({ ...size, x: SNAP_DISTANCE + 1, y: 100 }, d)).toEqual({ ...size, x: SNAP_DISTANCE + 1, y: 100 });
    // right edge, also from slightly past it
    expect(snapToEdges({ ...size, x: 1920 - 400 + 10, y: 100 }, d).x).toBe(1520);
    // bottom edge = above the taskbar (work area), top edge
    expect(snapToEdges({ ...size, x: 600, y: 1032 - 840 - 20 }, d).y).toBe(1032 - 840);
    expect(snapToEdges({ ...size, x: 600, y: -12 }, d).y).toBe(0);
  });
  it('snaps into a corner when near two edges, on the display the window is on', () => {
    expect(snapToEdges({ ...size, x: 1920 - 400 - 7, y: 1032 - 840 + 5 }, [primary, second])).toEqual({ ...size, x: 1520, y: 192 });
    // second monitor with negative y: its own top-left corner
    expect(snapToEdges({ ...size, x: 1930, y: -190 }, [primary, second])).toEqual({ ...size, x: 1920, y: -200 });
  });
  it('a window wider than the gap between two near edges takes the nearer one; dist 0 turns it off', () => {
    const narrow = { id: 9, bounds: { x: 0, y: 0, width: 420, height: 900 }, workArea: { x: 0, y: 0, width: 420, height: 900 } };
    expect(snapToEdges({ ...size, x: 4, y: 0 }, [narrow]).x).toBe(0);
    expect(snapToEdges({ ...size, x: 16, y: 0 }, [narrow]).x).toBe(20);
    const b = { ...size, x: 5, y: 5 };
    expect(snapToEdges(b, [primary], 0)).toBe(b);
  });
});

describe('free sizes (settings.window.avatarWidth)', () => {
  const wa = { x: 0, y: 0, width: 2560, height: 1400 }; // a 1440p screen
  it('normalizes a width: null when not a number, else clamped and even', () => {
    expect(normalizeAvatarWidth(null)).toBe(null);
    expect(normalizeAvatarWidth('500')).toBe(null);
    expect(normalizeAvatarWidth(NaN)).toBe(null);
    expect(normalizeAvatarWidth(451)).toBe(452);
    expect(normalizeAvatarWidth(50)).toBe(MIN_AVATAR_WIDTH);
    expect(normalizeAvatarWidth(1e6)).toBe(MAX_AVATAR_WIDTH);
  });

  it('the chat strip follows the width through the presets, without a jump at a preset', () => {
    for (const p of /** @type {const} */ (['small', 'medium', 'large'])) {
      expect(chatHeightFor(SIZE_PRESETS[p].width)).toBe(CHAT_PANEL_HEIGHT[p]);
      expect(windowLayout(p, true, wa, SIZE_PRESETS[p].width)).toMatchObject({ width: SIZE_PRESETS[p].width, height: SIZE_PRESETS[p].height + CHAT_PANEL_HEIGHT[p] });
    }
    let prev = 0;
    for (let w = MIN_AVATAR_WIDTH; w <= MAX_AVATAR_WIDTH; w += 2) {
      const h = chatHeightFor(w);
      expect(h).toBeGreaterThanOrEqual(prev);
      expect(h - prev).toBeLessThanOrEqual(prev ? 1 : Infinity);
      expect(h).toBeGreaterThanOrEqual(MIN_CHAT_PANEL_HEIGHT);
      expect(h).toBeLessThanOrEqual(MAX_CHAT_PANEL_HEIGHT);
      prev = h;
    }
  });

  it('a free width replaces the preset, keeps 2:3, and still fits the work area', () => {
    const l = windowLayout('small', true, wa, 520);
    expect(l).toMatchObject({ avatarWidth: 520, width: 520, avatar: { width: 520, height: 780 }, chat: { height: chatHeightFor(520) } });
    expect(l.height).toBe(780 + chatHeightFor(520));
    // too tall for the screen: the strip shrinks first, then the avatar (2:3)
    const big = windowLayout('medium', true, wa, 1200);
    expect(big.height).toBeLessThanOrEqual(wa.height);
    expect(windowLayout('medium', true, { x: 0, y: 0, width: 1920, height: 1040 }, 1200).height).toBeLessThanOrEqual(1040);
    expect(big.avatar.height).toBe(big.avatar.width * 1.5);
    // wider than a narrow (portrait) work area
    const narrow = windowLayout('medium', true, { x: 0, y: 0, width: 480, height: 3000 }, 900);
    expect(narrow.width).toBe(480);
    expect(narrow.avatar.height).toBe(720);
    // null / garbage: the preset
    expect(windowLayout('medium', true, wa, null)).toMatchObject({ avatarWidth: null, width: 400, height: 840 });
    expect(windowLayout('medium', true, wa, 'x')).toMatchObject({ width: 400 });
  });
});

describe('resizing by a corner', () => {
  const wa = { x: 0, y: 0, width: 2560, height: 1400 };
  const start = { x: 800, y: 100, width: 400, height: 840 };
  const height = (w) => w * 1.5 + chatHeightFor(w);

  it('a press that barely moves stays a click', () => {
    expect(resizeBounds(start, 'br', { x: 0, y: 0 }, { x: DRAG_THRESHOLD - 1, y: 1 }, wa, false)).toBe(null);
    expect(resizeBounds(start, 'br', { x: 0, y: 0 }, { x: 1, y: 1 }, wa, true)).not.toBe(null);
  });

  it('each corner keeps the opposite corner where it was', () => {
    const right = start.x + start.width;
    const bottom = start.y + start.height;
    const r = (corner, dx, dy) => resizeBounds(start, corner, { x: 0, y: 0 }, { x: dx, y: dy }, wa, true).bounds;
    expect(r('br', 60, 0)).toEqual({ x: start.x, y: start.y, width: 460, height: height(460) });
    expect(r('bl', -60, 0)).toEqual({ x: right - 460, y: start.y, width: 460, height: height(460) });
    const tr = r('tr', 40, 0);
    expect(tr).toEqual({ x: start.x, y: bottom - height(440), width: 440, height: height(440) });
    const tl = r('tl', 40, 0); // dragged inwards: smaller
    expect(tl).toEqual({ x: right - 360, y: bottom - height(360), width: 360, height: height(360) });
    for (const c of CORNERS) {
      const b = r(c, 0, 0);
      expect(b).toEqual(start);
    }
  });

  it('the axis asking for the bigger change wins; the height follows the width', () => {
    // straight down by 150 px: the height grows by ~150 (2:3 + strip), the width with it
    const down = resizeBounds(start, 'br', { x: 0, y: 0 }, { x: 5, y: 150 }, wa, true);
    expect(down.bounds.height).toBeGreaterThan(start.height + 140);
    expect(down.bounds.height).toBeLessThanOrEqual(start.height + 150);
    expect(down.avatarWidth).toBe(down.bounds.width);
    expect(down.bounds.width % 2).toBe(0);
  });

  it('never grows past the work area on the dragged side, and never below the minimum', () => {
    const huge = resizeBounds(start, 'br', { x: 0, y: 0 }, { x: 5000, y: 5000 }, wa, true).bounds;
    expect(huge.x + huge.width).toBeLessThanOrEqual(wa.width);
    expect(huge.y + huge.height).toBeLessThanOrEqual(wa.height);
    expect(huge.x).toBe(start.x);
    const up = resizeBounds(start, 'tl', { x: 0, y: 0 }, { x: -5000, y: -5000 }, wa, true).bounds;
    expect(up.y).toBeGreaterThanOrEqual(wa.y);
    expect(up.y + up.height).toBe(start.y + start.height);
    const tiny = resizeBounds(start, 'br', { x: 0, y: 0 }, { x: -5000, y: -5000 }, wa, true);
    expect(tiny.avatarWidth).toBe(MIN_AVATAR_WIDTH);
    expect(tiny.bounds).toEqual({ x: start.x, y: start.y, width: MIN_AVATAR_WIDTH, height: height(MIN_AVATAR_WIDTH) });
    // a second monitor at negative coordinates
    const left = { x: -1920, y: 0, width: 1920, height: 1400 };
    const s2 = { x: -600, y: 100, width: 400, height: 840 };
    const b2 = resizeBounds(s2, 'bl', { x: 0, y: 0 }, { x: -100, y: 0 }, left, true).bounds;
    expect(b2).toEqual({ x: -700, y: 100, width: 500, height: height(500) });
  });

  it('the layout of the width it ends on is the same window (nothing moves after the release)', () => {
    for (const [dx, dy] of [[100, 0], [-120, 30], [0, 90], [333, 333]]) {
      const r = resizeBounds(start, 'br', { x: 0, y: 0 }, { x: dx, y: dy }, wa, true);
      const l = windowLayout('medium', true, wa, r.avatarWidth);
      expect({ width: l.width, height: l.height }).toEqual({ width: r.bounds.width, height: r.bounds.height });
    }
  });
});
