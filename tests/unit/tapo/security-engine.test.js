import { describe, it, expect } from 'vitest';
import { SecurityEngine, inQuietHours } from '../../../electron/tapo/security-engine.js';

const BASE = {
  armDelaySec: 30, people: true, motion: true, notify: 'person', record: 'person', preRollSec: 5, postRollSec: 10, maxClipSec: 120,
  sensitivity: 'medium', cameraEvents: true, confirmLocally: true, cooldownSec: 60, quietHours: '', announce: true, describe: false,
};
const T0 = new Date(2026, 9, 10, 14, 0, 0).getTime();
const PERSON = [{ score: 0.8, box: [0.4, 0.3, 0.1, 0.3] }];

/** A rig: an engine at T0, armed (immediate) with a live stream past its start-up suppression. */
function rig(over = {}, { arm = true } = {}) {
  let n = 0;
  const e = new SecurityEngine({ settings: { ...BASE, ...over }, now: () => T0, newId: () => `ev${++n}` });
  const log = [];
  const run = (acts) => {
    log.push(...acts);
    return acts;
  };
  let t = T0;
  e.onStream('live', t);
  t += 10_500;
  if (arm) run(e.arm(true, { immediate: true, at: t }));
  return {
    e,
    log,
    types: () => log.map((a) => a.type),
    at: () => t,
    /** advance, feeding local detector samples at `hz` with `fn(i)` → sample */
    local(seconds, fn, hz = 1, detector = 'on') {
      const steps = Math.round(seconds * hz);
      for (let i = 0; i < steps; i++) {
        t += 1000 / hz;
        run(e.onLocal({ at: t, detector, ...fn(i) }));
        run(e.tick(t));
      }
    },
    camera(kind, active) { run(e.onCamera({ kind, active, at: t })); },
    wait(seconds, step = 0.5) {
      for (let s = 0; s < seconds; s += step) {
        t += step * 1000;
        run(e.tick(t));
      }
    },
    ptz(moving, settleMs = 1500) { run(e.onPtz({ moving, settleUntil: moving ? 0 : t + settleMs, at: t })); },
    run,
  };
}
const person = () => ({ motion: { active: true, score: 0.05, global: false }, persons: PERSON });
const nobody = () => ({ motion: { active: false, score: 0, global: false }, persons: [] });
const motionOnly = () => ({ motion: { active: true, score: 0.05, global: false }, persons: [] });

describe('SecurityEngine', () => {
  it('does nothing while disarmed, and during the exit delay', () => {
    const r = rig({}, { arm: false });
    r.local(5, person);
    expect(r.log).toEqual([]);
    const acts = r.e.arm(true, { at: r.at() });
    expect(acts).toEqual([{ type: 'armed-changed', armed: true, arming: true, armingEndsAt: r.at() + 30_000 }]);
    r.local(20, person);
    expect(r.types()).not.toContain('event-start');
    r.local(11, nobody);
    expect(r.types()).toContain('armed-changed');
    expect(r.e.state).toMatchObject({ armed: true, arming: false });
    r.local(3, person);
    expect(r.types()).toContain('event-start');
  });

  it('a confirmed person: event, clip, alert snapshot, notification and announcement', () => {
    const r = rig({ motion: false }); // (with motion events on, the first frame starts a motion event that upgrades)
    r.local(1, person);
    expect(r.types()).not.toContain('event-start'); // one sample is not enough (2 of the last 3)
    r.local(1, person);
    const start = r.log.findIndex((a) => a.type === 'event-start');
    expect(r.log.slice(start).map((a) => a.type)).toEqual(['event-start', 'record-start', 'snapshot', 'notify', 'announce']);
    expect(r.log[start].event).toMatchObject({ id: 'ev1', kind: 'person', sources: ['local-motion', 'local-person'] });
    expect(r.log.find((a) => a.type === 'notify')).toMatchObject({ silent: false });
    expect(r.log.find((a) => a.type === 'announce')).toMatchObject({ quiet: false });
    expect(r.log.find((a) => a.type === 'snapshot')).toMatchObject({ eventId: 'ev1', purpose: 'alert' });
  });

  it('small boxes and low scores do not count; sensitivity sets the score', () => {
    const r = rig();
    r.local(5, () => ({ motion: { active: false }, persons: [{ score: 0.9, box: [0, 0, 0.03, 0.03] }] }));
    r.local(5, () => ({ motion: { active: false }, persons: [{ score: 0.45, box: [0, 0, 0.2, 0.3] }] }));
    expect(r.types()).not.toContain('event-start');
    const h = rig({ sensitivity: 'high' });
    h.local(3, () => ({ motion: { active: false }, persons: [{ score: 0.45, box: [0, 0, 0.2, 0.3] }] }));
    expect(h.types()).toContain('event-start');
  });

  it('the camera alone does not make a person alert while the local detector runs and disagrees', () => {
    const r = rig({ motion: false });
    r.camera('person', true);
    r.local(10, nobody);
    expect(r.types()).not.toContain('event-start');
    expect(r.types()).toContain('boost');
  });

  it('…but counts, unconfirmed, after 6 s while the local detector is down', () => {
    const r = rig();
    r.camera('person', true);
    r.local(4, nobody, 1, 'failed');
    expect(r.types()).not.toContain('event-start');
    r.local(3, nobody, 1, 'failed');
    const ev = r.log.find((a) => a.type === 'event-start');
    expect(ev.event).toMatchObject({ kind: 'person', unconfirmed: true, sources: ['camera-person'] });
    // the detector comes back and agrees: confirmed
    r.local(2, person);
    expect(r.log.filter((a) => a.type === 'event-update').at(-1).event.unconfirmed).toBeUndefined();
  });

  it('with confirmLocally off, the camera person event starts at once', () => {
    const r = rig({ confirmLocally: false });
    r.camera('person', true);
    expect(r.types()).toEqual(expect.arrayContaining(['event-start', 'notify']));
    expect(r.log.find((a) => a.type === 'event-start').event.unconfirmed).toBeUndefined();
  });

  it('suppressed while our pan/tilt moves and settles; camera motion from the move is ignored until it falls', () => {
    const r = rig();
    r.ptz(true);
    r.camera('motion', true);
    r.local(3, person);
    r.ptz(false, 1500);
    r.local(1, person);
    expect(r.types()).not.toContain('event-start');
    r.local(2, () => ({ motion: { active: false }, persons: [] }));
    expect(r.types()).not.toContain('event-start'); // the camera's own motion episode stays ignored
    r.camera('motion', false);
    r.camera('motion', true); // a new episode after the move: counts
    expect(r.log.find((a) => a.type === 'event-start')?.event.kind).toBe('motion');
  });

  it('suppressed 10 s after the stream (re)starts and 3 s after a global change', () => {
    const r = rig();
    r.run(r.e.onStream('down', r.at()));
    r.run(r.e.onStream('live', r.at()));
    r.local(9, person);
    expect(r.types()).not.toContain('event-start');
    r.local(3, person);
    expect(r.types()).toContain('event-start');
    const g = rig();
    g.local(1, () => ({ motion: { active: true, global: true }, persons: PERSON }));
    g.local(2, person);
    expect(g.types()).not.toContain('event-start');
    g.local(3, person);
    expect(g.types()).toContain('event-start');
  });

  it('a person walking in: the motion event of the first frame upgrades to person (one event)', () => {
    const r = rig();
    r.local(2, person);
    expect(r.types()).toEqual(['armed-changed', 'event-start', 'snapshot', 'event-update', 'record-start', 'snapshot', 'notify', 'announce']);
    expect(r.log.filter((a) => a.type.startsWith('event-')).map((a) => [a.event.id, a.event.kind])).toEqual([['ev1', 'motion'], ['ev1', 'person']]);
  });

  it('a motion event (listed, not notified) upgrades to person', () => {
    const r = rig();
    r.local(2, motionOnly, 5);
    expect(r.types()).toEqual(['armed-changed', 'event-start', 'snapshot']); // notify=person, record=person
    expect(r.log[1].event.kind).toBe('motion');
    r.local(2, person);
    const up = r.log.find((a) => a.type === 'event-update' && a.event.kind === 'person');
    expect(up.event.id).toBe('ev1');
    expect(r.types()).toEqual(expect.arrayContaining(['record-start', 'notify', 'announce']));
  });

  it('notify=motion notifies motion too; record=motion records it; record=off never', () => {
    const r = rig({ notify: 'motion', record: 'motion' });
    r.local(1, motionOnly, 5);
    expect(r.types()).toEqual(expect.arrayContaining(['event-start', 'record-start', 'notify', 'announce']));
    const off = rig({ record: 'off' });
    off.local(3, person);
    expect(off.types()).not.toContain('record-start');
  });

  it('ends post-roll after the last evidence; the cooldown blocks the next alert of that kind', () => {
    const r = rig({ postRollSec: 3, cooldownSec: 30 });
    r.local(3, person);
    r.local(2, nobody);
    expect(r.types()).not.toContain('event-end');
    r.local(2, nobody);
    expect(r.types().slice(-2)).toEqual(['record-stop', 'event-end']);
    const ended = r.log.find((a) => a.type === 'event-end').event;
    expect(ended.endedAt).toBeGreaterThan(ended.startedAt);
    r.local(3, person);
    expect(r.log.filter((a) => a.type === 'event-start')).toHaveLength(2);
    expect(r.log.filter((a) => a.type === 'notify')).toHaveLength(1); // in the cooldown
    r.local(4, nobody);
    r.wait(30);
    r.local(3, person);
    expect(r.log.filter((a) => a.type === 'notify')).toHaveLength(2);
  });

  it('quiet hours: a silent toast, no voice, no description', () => {
    const r = rig({ quietHours: '13:00-07:00', describe: true });
    r.local(3, person);
    expect(r.log.find((a) => a.type === 'notify').silent).toBe(true);
    expect(r.log.find((a) => a.type === 'announce').quiet).toBe(true);
    expect(r.types()).not.toContain('describe');
    const d = rig({ describe: true });
    d.local(3, person);
    expect(d.types()).toContain('describe');
    const quietOff = rig({ announce: false });
    quietOff.local(3, person);
    expect(quietOff.types()).not.toContain('announce');
  });

  it('disarming mid-event ends it at once', () => {
    const r = rig();
    r.local(3, person);
    const acts = r.e.arm(false, { at: r.at() });
    expect(acts.map((a) => a.type)).toEqual(['record-stop', 'event-end', 'armed-changed']);
    expect(r.e.state.active).toBeNull();
    r.local(3, person);
    expect(r.log.filter((a) => a.type === 'event-start')).toHaveLength(1);
  });

  it('tamper: an alert without local confirmation; a person outranks it', () => {
    const r = rig();
    r.camera('tamper', true);
    expect(r.types()).toEqual(expect.arrayContaining(['event-start', 'record-start', 'notify', 'announce']));
    expect(r.log.find((a) => a.type === 'event-start').event.kind).toBe('tamper');
    r.local(3, person);
    expect(r.log.find((a) => a.type === 'event-update' && a.event.kind === 'person')).toBeTruthy();
  });

  it('a better picture of the person asks for a "best" snapshot', () => {
    const r = rig({ motion: false });
    r.local(3, person);
    r.local(3, () => ({ motion: { active: true }, persons: [{ score: 0.95, box: [0.4, 0.3, 0.1, 0.3] }] }));
    expect(r.log.filter((a) => a.type === 'snapshot').map((a) => a.purpose)).toEqual(['alert', 'best']);
    expect(r.e.state.active.maxScore).toBe(0.95);
  });

  it('quiet hours parsing', () => {
    const at = (h, m) => new Date(2026, 9, 10, h, m).getTime();
    expect(inQuietHours('22:00-07:00', at(23, 0))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(6, 59))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(7, 0))).toBe(false);
    expect(inQuietHours('09:00-17:00', at(12, 0))).toBe(true);
    expect(inQuietHours('09:00-17:00', at(18, 0))).toBe(false);
    expect(inQuietHours('', at(12, 0))).toBe(false);
    expect(inQuietHours('10:00-10:00', at(10, 0))).toBe(false);
  });
});
