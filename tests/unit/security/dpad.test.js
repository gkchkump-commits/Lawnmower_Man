// Press-and-hold of the D-pad and the arrow keys (src/tapo/ui/dpad.js PressHold) with fake
// timers: a tap is a nudge, a press past 300 ms is a hold with 250 ms heartbeats, and anything
// that interrupts it (pointer leaving, blur, hidden window) releases a hold and never nudges.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS, HOLD_MS, PressHold } from '../../../src/tapo/ui/dpad.js';
import { arrowDir, keyCommand } from '../../../src/tapo/ui/keyboard.js';

function make() {
  const log = [];
  const ph = new PressHold({
    onNudge: (dir, amount) => log.push(['nudge', dir, amount]),
    onHold: (dir) => log.push(['hold', dir]),
    onHeartbeat: () => log.push(['heartbeat']),
    onRelease: () => log.push(['release']),
  });
  return { ph, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PressHold', () => {
  it('a short press is one nudge', () => {
    const { ph, log } = make();
    ph.press('left', 'large');
    vi.advanceTimersByTime(HOLD_MS - 10);
    ph.release();
    vi.advanceTimersByTime(2000);
    expect(log).toEqual([['nudge', 'left', 'large']]);
  });

  it('a long press holds, beats every 250 ms, and stops on release (no nudge)', () => {
    const { ph, log } = make();
    ph.press('up');
    vi.advanceTimersByTime(HOLD_MS);
    expect(log).toEqual([['hold', 'up']]);
    expect(ph.holding).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(log.filter((l) => l[0] === 'heartbeat')).toHaveLength(4);
    ph.release();
    vi.advanceTimersByTime(2000);
    expect(log.at(-1)).toEqual(['release']);
    expect(log.filter((l) => l[0] === 'heartbeat')).toHaveLength(4); // no beats after the release
    expect(log.some((l) => l[0] === 'nudge')).toBe(false);
  });

  it('cancel (pointer left, blur, hidden) stops a hold but never nudges', () => {
    const { ph, log } = make();
    ph.press('right');
    ph.cancel();
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([]);
    ph.press('right');
    vi.advanceTimersByTime(HOLD_MS + HEARTBEAT_MS);
    ph.cancel();
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([['hold', 'right'], ['heartbeat'], ['release']]);
  });

  it('key repeat of the same arrow is ignored; another arrow ends the first press', () => {
    const { ph, log } = make();
    ph.press('left');
    ph.press('left');
    ph.press('left');
    ph.release();
    expect(log).toEqual([['nudge', 'left', 'medium']]);
    log.length = 0;
    ph.press('left');
    vi.advanceTimersByTime(HOLD_MS);
    ph.press('down');
    expect(log).toEqual([['hold', 'left'], ['release']]);
    ph.release();
    expect(log.at(-1)).toEqual(['nudge', 'down', 'medium']);
  });

  it('release without a press does nothing', () => {
    const { ph, log } = make();
    ph.release();
    ph.cancel();
    expect(log).toEqual([]);
  });
});

describe('keyCommand', () => {
  const k = (key, o = {}) => keyCommand({ key, ...o });
  it('arrows with Shift (large) and Alt (small)', () => {
    expect(k('ArrowLeft')).toEqual({ type: 'arrow', dir: 'left', amount: 'medium' });
    expect(k('ArrowUp', { shiftKey: true })).toEqual({ type: 'arrow', dir: 'up', amount: 'large' });
    expect(k('ArrowDown', { altKey: true })).toEqual({ type: 'arrow', dir: 'down', amount: 'small' });
    expect(arrowDir('ArrowRight')).toBe('right');
    expect(arrowDir('a')).toBeUndefined();
  });

  it('the other shortcuts', () => {
    expect(k('Home')).toEqual({ type: 'home' });
    expect(k('h')).toEqual({ type: 'home' });
    expect(k('1')).toEqual({ type: 'preset', index: 0 });
    expect(k('8')).toEqual({ type: 'preset', index: 7 });
    expect(k('9')).toBeNull();
    expect(k(' ', { code: 'Space' })).toEqual({ type: 'snapshot' });
    expect(k('a')).toEqual({ type: 'arm' });
    expect(k('E')).toEqual({ type: 'events' });
    expect(k('f')).toEqual({ type: 'fullscreen' });
    expect(k('?')).toEqual({ type: 'help' });
    expect(k('Escape')).toEqual({ type: 'escape' });
  });

  it('nothing while typing or with Ctrl/Meta (browser shortcuts)', () => {
    const input = { tagName: 'INPUT', type: 'text' };
    expect(k('a', { target: input })).toBeNull();
    expect(k('ArrowLeft', { target: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(k('Escape', { target: input })).toEqual({ type: 'escape' });
    expect(k('c', { ctrlKey: true })).toBeNull();
    expect(k('ArrowLeft', { metaKey: true })).toBeNull();
    expect(k('a', { altKey: true })).toBeNull();
  });
});
