import { describe, it, expect, vi } from 'vitest';
import { WindowDrag, nextAvatarWidth, PRESET_WIDTHS } from '../../../src/app/window-drag.js';
import { SIZE_PRESETS } from '../../../electron/window-manager.js';
import { ClickThroughGate } from '../../../src/app/click-through.js';

function setup({ locked = false, win } = {}) {
  const calls = [];
  const bridgeWin = win ?? { dragStart: vi.fn(() => calls.push('start')), dragEnd: vi.fn(() => calls.push('end')) };
  const applied = [];
  const gate = new ClickThroughGate({ apply: (ignore) => applied.push(ignore), setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} });
  gate.setEnabled(true);
  const states = [];
  const lock = { on: locked };
  const drag = new WindowDrag({ win: bridgeWin, isLocked: () => lock.on, gate, onChange: (on) => states.push(on) });
  return { drag, calls, gate, applied, states, lock };
}

const press = (over = {}) => ({ button: 0, pointerId: 1, ...over });

describe('WindowDrag', () => {
  it('a primary press on the head starts a drag and holds the window interactive until the release', () => {
    const { drag, calls, gate, states } = setup();
    expect(drag.press(press(), true)).toBe(true);
    expect(drag.active).toBe(true);
    expect(calls).toEqual(['start']);
    // the pointer leaving the page (the window moves under it) must not make it click-through
    gate.update(false);
    expect(gate.ignoring).toBe(false);
    drag.release({ pointerId: 1 });
    expect(drag.active).toBe(false);
    expect(calls).toEqual(['start', 'end']);
    expect(states).toEqual([true, false]);
    gate.update(false);
    expect(gate.ignoring).toBe(true);
  });

  it('ignores presses off the head, other buttons, and a locked position', () => {
    const { drag, calls, lock } = setup();
    expect(drag.press(press(), false)).toBe(false);
    expect(drag.press(press({ button: 2 }), true)).toBe(false);
    lock.on = true;
    expect(drag.press(press(), true)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('release is idempotent and only ends the pointer it started with', () => {
    const { drag, calls } = setup();
    drag.press(press({ pointerId: 7 }), true);
    drag.release({ pointerId: 8 }); // another finger / pen
    expect(drag.active).toBe(true);
    drag.release({ pointerId: 7 });
    drag.release({ pointerId: 7 }); // lostpointercapture after pointerup
    drag.release(); // window blur
    expect(calls).toEqual(['start', 'end']);
  });

  it('a second press without a release (lost pointer-up) ends the first drag before starting again', () => {
    const { drag, calls } = setup();
    drag.press(press({ pointerId: 1 }), true);
    drag.press(press({ pointerId: 2 }), true);
    expect(calls).toEqual(['start', 'end', 'start']);
    expect(drag.pointerId).toBe(2);
  });

  it('does nothing with a bridge that cannot move the window (older main, browser)', () => {
    const { drag, states } = setup({ win: { setIgnoreMouse() {} } });
    expect(drag.supported).toBe(false);
    expect(drag.press(press(), true)).toBe(false);
    expect(states).toEqual([]);
  });

  it('a throwing bridge call still leaves a consistent state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { drag, gate } = setup({ win: { dragStart: () => { throw new Error('gone'); }, dragEnd: () => { throw new Error('gone'); } } });
    expect(drag.press(press(), true)).toBe(true);
    drag.release();
    expect(drag.active).toBe(false);
    gate.update(false);
    expect(gate.ignoring).toBe(true);
    warn.mockRestore();
  });
});

describe('resizing by a corner grip', () => {
  const resizeSetup = (opts = {}) => {
    const calls = [];
    const win = {
      dragStart: vi.fn(() => calls.push('drag-start')),
      dragEnd: vi.fn(() => calls.push('drag-end')),
      resizeStart: vi.fn((c) => calls.push(`resize-start:${c}`)),
      resizeEnd: vi.fn(() => calls.push('resize-end')),
    };
    return { ...setup({ win, ...opts }), calls };
  };

  it('a press on a grip resizes from that corner, holding the window interactive until the release', () => {
    const { drag, calls, gate, states } = resizeSetup();
    expect(drag.resizeSupported).toBe(true);
    expect(drag.press(press(), 'br')).toBe(true);
    expect([drag.mode, drag.corner]).toEqual(['resize', 'br']);
    gate.update(false);
    expect(gate.ignoring).toBe(false);
    drag.release({ pointerId: 1 });
    expect(calls).toEqual(['resize-start:br', 'resize-end']);
    expect([drag.mode, drag.corner, drag.active]).toEqual([null, null, false]);
    expect(states).toEqual([true, false]);
  });

  it('a drag and a resize never overlap; unknown corners and a lock do nothing', () => {
    const { drag, calls, lock } = resizeSetup();
    drag.press(press({ pointerId: 1 }), true);
    drag.press(press({ pointerId: 2 }), 'tl'); // lost pointer-up
    drag.release();
    expect(calls).toEqual(['drag-start', 'drag-end', 'resize-start:tl', 'resize-end']);
    expect(drag.press(press(), 'middle')).toBe(false);
    lock.on = true;
    expect(drag.press(press(), 'br')).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it('an older main process without resizing: grips do nothing, dragging still works', () => {
    const { drag } = setup();
    expect(drag.resizeSupported).toBe(false);
    expect(drag.press(press(), 'br')).toBe(false);
    expect(drag.press(press(), true)).toBe(true);
  });
});

describe('nextAvatarWidth (Ctrl + wheel)', () => {
  it('wheel up grows, wheel down shrinks, in small even steps, and stops at either end', () => {
    expect(nextAvatarWidth(400, -100)).toBe(432);
    expect(nextAvatarWidth(400, 100)).toBe(370);
    expect(nextAvatarWidth(1200, -100)).toBe(null);
    expect(nextAvatarWidth(200, 100)).toBe(null);
    expect(nextAvatarWidth(1150, -1)).toBe(1200);
    expect(nextAvatarWidth(400, 0)).toBe(null);
    expect(nextAvatarWidth(NaN, -1)).toBe(null);
  });

  it('the renderer and main agree on the presets\' widths', () => {
    for (const p of /** @type {const} */ (['small', 'medium', 'large'])) expect(PRESET_WIDTHS[p]).toBe(SIZE_PRESETS[p].width);
  });
});
