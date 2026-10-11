import { describe, it, expect, afterEach, vi } from 'vitest';
import { FALL_HOLD_MS, PullPointMonitor, STALE_MS } from '../../../electron/tapo/events.js';
import { OnvifClient } from '../../../electron/tapo/onvif-client.js';
import { OnvifError } from '../../../electron/tapo/onvif-soap.js';
import { sleep, startFakeOnvif } from './helpers/fake-onvif.js';

const MOTION = 'tns1:RuleEngine/CellMotionDetector/Motion';
const PEOPLE = 'tns1:RuleEngine/PeopleDetector/People';

/** An in-memory client: each pull waits until the test delivers messages (or fails it). */
function memClient() {
  const c = {
    authFailed: false,
    pullPointSupport: true,
    serviceUrl: () => 'http://127.0.0.1:2020/onvif/service',
    calls: /** @type {string[]} */ ([]),
    /** @type {{ resolve: (m: any[]) => void, reject: (e: any) => void }|null} */
    pull: null,
    getEventProperties: async () => [MOTION, PEOPLE],
    createPullPoint: async () => { c.calls.push('create'); return { address: 'http://127.0.0.1:2020/event-0_2020', terminationTime: '' }; },
    pullMessages: () => new Promise((resolve, reject) => { c.calls.push('pull'); c.pull = { resolve, reject }; }),
    renew: async () => { c.calls.push('renew'); return { terminationTime: '' }; },
    call: async () => { c.calls.push('unsubscribe'); },
    deliver: (msgs) => { const p = c.pull; c.pull = null; p?.resolve(msgs); },
    fail: (err) => { const p = c.pull; c.pull = null; p?.reject(err); },
  };
  return c;
}
const msg = (topic, name, value, operation = 'Changed') => ({ topic, utcTime: '', operation, data: { [name]: String(value) } });

let mon;
afterEach(async () => {
  vi.useRealTimers();
  await mon?.stop();
  mon = null;
});

describe('de-noising (fake timers)', () => {
  it('Initialized sets the baseline, duplicates and single blips are dropped, a fall is held 2 s', async () => {
    vi.useFakeTimers();
    const c = memClient();
    mon = new PullPointMonitor({ client: /** @type {any} */ (c) });
    const events = [];
    mon.on('event', (e) => events.push(`${e.kind}:${e.active}`));
    await mon.start();
    expect(mon.state).toBe('subscribed');
    await vi.advanceTimersByTimeAsync(0);
    c.deliver([msg(MOTION, 'IsMotion', false, 'Initialized'), msg(PEOPLE, 'IsPeople', false, 'Initialized')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    // a flood: 18 "true" a second, one "false" blip in the middle
    const flood = [];
    for (let i = 0; i < 18; i++) flood.push(msg(PEOPLE, 'IsPeople', true));
    flood.push(msg(PEOPLE, 'IsPeople', false));
    for (let i = 0; i < 18; i++) flood.push(msg(PEOPLE, 'IsPeople', true));
    c.deliver(flood);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['person:true']);
    c.deliver([msg(PEOPLE, 'IsPeople', false)]);
    await vi.advanceTimersByTimeAsync(FALL_HOLD_MS - 100);
    expect(events).toEqual(['person:true']);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual(['person:true', 'person:false']);
    // the camera's own source names don't matter; unknown items are ignored
    c.deliver([{ topic: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', utcTime: '', operation: 'Changed', data: { IsVehicle: 'true' } }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toHaveLength(2);
  });

  it('an active state without a refresh falls after 3 minutes (no falling edge on some firmwares)', async () => {
    vi.useFakeTimers();
    const c = memClient();
    mon = new PullPointMonitor({ client: /** @type {any} */ (c) });
    const events = [];
    mon.on('event', (e) => events.push(`${e.kind}:${e.active}`));
    await mon.start();
    await vi.advanceTimersByTimeAsync(0);
    c.deliver([msg(MOTION, 'IsMotion', true)]);
    await vi.advanceTimersByTimeAsync(STALE_MS - 1000);
    expect(events).toEqual(['motion:true']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual(['motion:true', 'motion:false']);
  });

  it('a benign drop keeps the subscription; renews on time; a real failure resubscribes once', async () => {
    vi.useFakeTimers();
    const c = memClient();
    mon = new PullPointMonitor({ client: /** @type {any} */ (c), renewMs: 480_000 });
    await mon.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      c.fail(new OnvifError('reset', 'socket hang up', { code: 'ECONNRESET' }));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(c.calls.filter((x) => x === 'create')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(480_000);
    c.deliver([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(c.calls).toContain('renew');
    c.fail(new OnvifError('fault', 'unknown subscription', { codes: ['ter:InvalidArgVal'] }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(c.calls.filter((x) => x === 'create')).toHaveLength(2);
    expect(c.calls.filter((x) => x === 'unsubscribe')).toHaveLength(1); // the old one went first
  });

  it('a sign-in failure stops the loop for good', async () => {
    vi.useFakeTimers();
    const c = memClient();
    mon = new PullPointMonitor({ client: /** @type {any} */ (c) });
    await mon.start();
    await vi.advanceTimersByTimeAsync(0);
    c.fail(new OnvifError('auth', 'refused'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mon.state).toBe('off');
    expect(mon.running).toBe(false);
    expect(c.calls.filter((x) => x === 'pull')).toHaveLength(1);
  });

  it('reports unsupported when the camera says so', async () => {
    const c = memClient();
    c.pullPointSupport = false;
    mon = new PullPointMonitor({ client: /** @type {any} */ (c) });
    await mon.start();
    expect(mon.state).toBe('unsupported');
    expect(c.calls).toEqual([]);
  });
});

describe('against the fake camera (real sockets)', () => {
  it('drops with bytes after "Connection: close" do not resubscribe; stop unsubscribes', async () => {
    const cam = await startFakeOnvif({ quirks: { pullDropAfterMs: 40, rejectInitialTerminationTime: true } });
    try {
      const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'camacct', getPassword: async () => 'se&cret' });
      await client.connect();
      mon = new PullPointMonitor({ client });
      const events = [];
      mon.on('event', (e) => events.push(`${e.kind}:${e.active}`));
      await mon.start();
      expect(mon.state).toBe('subscribed');
      await sleep(900); // each drop: 40 ms + the 250 ms pause
      expect(cam.count('PullMessages')).toBeGreaterThanOrEqual(3);
      expect(cam.count('CreatePullPointSubscription')).toBe(2); // one refused (InitialTerminationTime), one made
      expect(cam.state.subscriptions.size).toBe(1);
      cam.quirks.pullDropAfterMs = 0;
      cam.notify(PEOPLE, 'IsPeople', true);
      await sleep(300);
      expect(events).toEqual(['person:true']);
      cam.quirks.pullHoldMs = 20000; // a pull in flight while we stop
      await sleep(100);
      const t0 = Date.now();
      await mon.stop();
      expect(Date.now() - t0).toBeLessThan(3500);
      expect(cam.state.subscriptions.size).toBe(0);
      expect(mon.state).toBe('off');
    } finally {
      await cam.close();
    }
  });

  it('never keeps more than one subscription when pulls fail for real', async () => {
    const cam = await startFakeOnvif();
    try {
      const client = new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'camacct', getPassword: async () => 'se&cret' });
      await client.connect();
      mon = new PullPointMonitor({ client });
      await mon.start();
      await sleep(50);
      cam.state.subscriptions.clear(); // the camera rebooted: our subscription is gone
      await sleep(2600);
      expect(cam.count('CreatePullPointSubscription')).toBe(2);
      expect(cam.state.subscriptions.size).toBe(1);
      expect(mon.state).toBe('subscribed');
    } finally {
      await mon.stop();
      await cam.close();
    }
  });
});
