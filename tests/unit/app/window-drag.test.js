import { describe, it, expect, vi } from 'vitest';
import { WindowDrag, nextSizePreset } from '../../../src/app/window-drag.js';
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

describe('nextSizePreset (Ctrl + wheel)', () => {
  it('wheel up grows, wheel down shrinks, and stops at either end', () => {
    expect(nextSizePreset('medium', -100)).toBe('large');
    expect(nextSizePreset('medium', 100)).toBe('small');
    expect(nextSizePreset('large', -100)).toBe(null);
    expect(nextSizePreset('small', 100)).toBe(null);
    expect(nextSizePreset('medium', 0)).toBe(null);
    expect(nextSizePreset('bogus', -1)).toBe('medium');
  });
});
