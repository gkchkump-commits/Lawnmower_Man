// Integration: the camera's own motion / person events through the app's PullPoint monitor
// (electron/tapo/events.js, contract §8.9) against the simulator's Tapo behaviour: the event
// flood with single false blips comes out as one rising and one falling edge, pulls dropped
// with bytes after "Connection: close" keep the subscription, a subscription is renewed (never
// re-created on top), the 4th subscription is never created, a reboot is recovered from with
// exactly one new subscription, and stop() unsubscribes. Skips while lane A is not present.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startSim } from '../../../tools/tapo-sim/index.mjs';
import { laneModules, sleep, until } from './helpers.js';

const lane = await laneModules(['electron/tapo/onvif-client.js', 'electron/tapo/events.js']);
const { OnvifClient } = lane.mods['electron/tapo/onvif-client.js'] || {};
const { PullPointMonitor } = lane.mods['electron/tapo/events.js'] || {};

describe.skipIf(!lane.ok)(`PullPointMonitor × simulated Tapo events${lane.reason}`, () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {any} */
  let client;
  /** @type {any} */
  let monitor;
  /** @type {Array<{ kind: string, active: boolean, at: number }>} */
  let edges;
  /** Shifts the monitor's clock (renewals are due by time). */
  let jump = 0;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(() => sim?.close());
  beforeEach(async () => {
    sim.reset();
    jump = 0;
    client = new OnvifClient({ host: '127.0.0.1', port: sim.onvifPort, username: 'camacct', getPassword: async () => 'se&cret', log: () => {} });
    await client.connect();
    edges = [];
    monitor = new PullPointMonitor({ client, log: () => {}, now: () => Date.now() + jump });
    monitor.on('event', (/** @type {any} */ e) => edges.push(e));
  });
  afterEach(async () => {
    await monitor.stop();
    client.close?.();
  });

  it('subscribes once (without InitialTerminationTime after the refusal) and learns the topics', async () => {
    await monitor.start();
    await until(() => monitor.state === 'subscribed', { what: 'subscribed' });
    expect(monitor.topics).toEqual(expect.arrayContaining(['tns1:RuleEngine/PeopleDetector/People', 'tns1:RuleEngine/CellMotionDetector/Motion']));
    expect(sim.state.subscriptions.list).toHaveLength(1);
    await monitor.stop();
    expect(sim.state.subscriptions.list).toHaveLength(0); // Unsubscribe on stop
    expect(sim.callsOf('Unsubscribe')).toHaveLength(1);
  });

  it('turns the flood (18/s with a false blip every 60) into one rising and one falling edge', async () => {
    await monitor.start();
    await until(() => monitor.state === 'subscribed');
    await sleep(300); // past the Initialized baseline
    sim.set({ person: true });
    await sleep(4200); // ≥ 72 messages: includes one blip
    sim.set({ person: false });
    await until(() => edges.some((e) => e.kind === 'person' && !e.active), { timeout: 6000, what: 'the falling edge' });
    const person = edges.filter((e) => e.kind === 'person');
    expect(person.map((e) => e.active)).toEqual([true, false]);
    const held = person[1].at - person[0].at;
    expect(held).toBeGreaterThan(4000); // the blip did not end it
    expect(sim.state.subscriptions.created).toBe(1);
  }, 20000);

  it('a pull dropped with bytes after "Connection: close" is an empty pull: same subscription', async () => {
    sim.set({ quirks: { pullDropAfterMs: 250 } });
    await monitor.start();
    await until(() => sim.callsOf('PullMessages').filter((c) => c.status === 'dropped').length >= 4, { timeout: 8000, what: 'dropped pulls' });
    expect(sim.state.subscriptions.created).toBe(1);
    expect(sim.state.subscriptions.list).toHaveLength(1);
    expect(monitor.state).toBe('subscribed');
    // events still arrive on that subscription
    sim.set({ motion: true });
    await until(() => edges.some((e) => e.kind === 'motion' && e.active), { timeout: 3000, what: 'the motion edge' });
  }, 15000);

  it('renews the subscription when due (480 s) instead of creating another', async () => {
    sim.set({ quirks: { pullDropAfterMs: 200 } });
    await monitor.start();
    await until(() => monitor.state === 'subscribed');
    jump = 481_000;
    await until(() => sim.callsOf('Renew').length > 0, { timeout: 5000, what: 'a Renew' });
    expect(sim.callsOf('Renew')[0].status).toBe(200);
    expect(sim.state.subscriptions.created).toBe(1);
  });

  it('never creates a 4th subscription; after a reboot it subscribes exactly once again', async () => {
    sim.set({ quirks: { pullDropAfterMs: 200, rebootMs: 400 } });
    await monitor.start();
    await until(() => monitor.state === 'subscribed');
    sim.set({ reboot: true });
    await until(() => sim.state.subscriptions.list.length === 1 && sim.state.bootCount === 2, { timeout: 12000, what: 'a new subscription after the reboot' });
    await sleep(1000);
    expect(sim.state.subscriptions.created).toBe(2);
    expect(sim.state.subscriptions.refused).toBe(0);
    expect(sim.state.subscriptions.list).toHaveLength(1);
  }, 20000);

  it('starting and stopping repeatedly leaves no subscription behind', async () => {
    for (let k = 0; k < 4; k++) {
      await monitor.start();
      await until(() => monitor.state === 'subscribed');
      await monitor.stop();
    }
    expect(sim.state.subscriptions.list).toHaveLength(0);
    expect(sim.state.subscriptions.refused).toBe(0);
  });
});
