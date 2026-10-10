import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OnvifClient, SerialQueue, parseNotifications, parseTopicSet, rewriteXaddr } from '../../../electron/tapo/onvif-client.js';
import { OnvifError } from '../../../electron/tapo/onvif-soap.js';
import { parseXml, path } from '../../../electron/tapo/xml.js';
import { sleep, startFakeOnvif } from './helpers/fake-onvif.js';

/** @type {Awaited<ReturnType<typeof startFakeOnvif>>} */
let cam;
const logs = [];
const log = (level, msg) => logs.push(`${level} ${msg}`);

function client(over = {}) {
  return new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'camacct', getPassword: async () => 'se&cret', log, ...over });
}

beforeEach(async () => {
  logs.length = 0;
  cam = await startFakeOnvif();
});
afterEach(async () => {
  await cam.close();
});

describe('OnvifClient.connect', () => {
  it('reads the device, rewrites XAddrs to the configured host and picks the PTZ section', async () => {
    const c = client();
    const dev = await c.connect();
    expect(dev).toEqual({ manufacturer: 'tp-link', model: 'Tapo C211', firmware: '1.5.4 Build 260702 Rel.43n', serialNumber: '2c3f0b1a99887766', hardwareId: '2.0' });
    // the camera reported tapo-cam.invalid:80 and listed Analytics (/onvif/analytics) first
    expect(c.xaddr.ptz).toBe(`http://127.0.0.1:${cam.port}/onvif/service`);
    expect(c.xaddr.media).toBe(`http://127.0.0.1:${cam.port}/onvif/service`);
    expect(c.xaddr.events).toBe(`http://127.0.0.1:${cam.port}/onvif/service`);
    expect(c.pullPointSupport).toBe(true);
    expect(c.profile).toMatchObject({ token: 'profile_1', ptzConfigToken: 'PTZConfiguration_1', encoding: 'H264', width: 2304, height: 1296, fps: 15 });
    expect(c.profile?.ranges).toEqual({ x: { min: -1, max: 1 }, y: { min: -1, max: 1 } });
    expect(c.profiles.map((p) => p.token)).toEqual(['profile_1', 'profile_2']);
    expect(cam.ops()).toEqual(['GetSystemDateAndTime', 'GetDeviceInformation', 'GetCapabilities', 'GetProfiles']);
    expect(cam.calls[0].authed).toBe(false); // the clock is read without a security header
    expect(cam.calls.slice(1).every((x) => x.authed)).toBe(true);
    expect(await c.getStreamUri('profile_2')).toBe('rtsp://192.168.1.50:554/stream2');
  });

  it('falls back to GetServices when GetCapabilities fails', async () => {
    cam.quirks.capabilitiesFail = true;
    const c = client();
    await c.connect();
    expect(cam.ops()).toContain('GetServices');
    expect(c.xaddr.ptz).toBe(`http://127.0.0.1:${cam.port}/onvif/service`);
  });

  it('compensates a camera clock that is 30 s off', async () => {
    cam.state.clockSkewSec = 30;
    const c = client();
    await c.connect();
    expect(Math.abs(/** @type {any} */ (c.clock).offsetMs - 30000)).toBeLessThan(1500);
    expect(c.clock?.warn).toBe(true);
    expect(c.clock?.ntp).toBe(true);
    expect((await c.getPresets()).map((p) => p.name)).toEqual(['Door', 'Window']);
  });

  it('retries GetSystemDateAndTime with a security header when the camera wants one', async () => {
    cam.quirks.timeNeedsAuth = true;
    const c = client();
    await c.connect();
    const times = cam.calls.filter((x) => x.op === 'GetSystemDateAndTime');
    expect(times.map((x) => x.authed)).toEqual([false, true]);
  });

  it('a wrong password fails once (after one clock resync) and is never retried on its own', async () => {
    const c = client({ getPassword: async () => 'wrong' });
    let failed = 0;
    c.on('auth-failed', () => failed++);
    const err = await c.connect().catch((e) => e);
    expect(err).toBeInstanceOf(OnvifError);
    expect(err.kind).toBe('auth');
    expect(c.authFailed).toBe(true);
    expect(failed).toBe(1);
    expect(cam.count('GetDeviceInformation')).toBe(2);
    expect(cam.count('GetSystemDateAndTime')).toBe(2);
    const before = cam.calls.length;
    for (let i = 0; i < 5; i++) expect((await c.getPresets().catch((e) => e)).kind).toBe('auth');
    expect(cam.calls.length).toBe(before); // nothing reached the camera
    c.resetAuth();
    expect((await c.getDeviceInformation().catch((e) => e)).kind).toBe('auth'); // still wrong
    expect(cam.calls.length).toBeGreaterThan(before);
  });

  it('re-reads the clock after a sign-in fault and retries the call once', async () => {
    const c = client();
    await c.connect();
    cam.state.clockSkewSec = 90; // the camera lost its time (no NTP)
    const presets = await c.getPresets();
    expect(presets).toHaveLength(2);
    expect(cam.count('GetSystemDateAndTime')).toBe(2);
    expect(c.authFailed).toBe(false);
  });

  it('an operation the account may not use is not taken for a wrong password', async () => {
    const c = client();
    await c.connect();
    // the fake refuses an unknown body as NotAuthorized only when unsigned; simulate with a bad digest for one call
    const orig = c._send.bind(c);
    let n = 0;
    c._send = async (url, body, o, auth) => {
      if (/SetPreset/.test(body) && n++ < 2) throw new OnvifError('auth', 'refused', { codes: ['ter:NotAuthorized'] });
      return orig(url, body, o, auth);
    };
    const err = await c.setPreset('Door').catch((e) => e);
    expect(err.kind).toBe('fault');
    expect(c.authFailed).toBe(false);
  });
});

describe('request lanes', () => {
  it('serializes control calls and lets a Stop jump the queue', async () => {
    const c = client();
    await c.connect();
    cam.calls.length = 0;
    cam.state.maxConcurrent = 0;
    cam.quirks.delayMs.RelativeMove = 120;
    const order = [];
    const p = [
      c.relativeMove(0.1, 0).then(() => order.push('move1')),
      c.relativeMove(0.2, 0).then(() => order.push('move2')),
      c.relativeMove(0.3, 0).then(() => order.push('move3')),
    ];
    await sleep(20);
    p.push(c.stop().then(() => order.push('stop')));
    await Promise.all(p);
    expect(order).toEqual(['move1', 'stop', 'move2', 'move3']);
    expect(cam.state.maxConcurrent).toBe(1);
  });

  it('runs the pull lane beside the control lane (at most two requests open)', async () => {
    const c = client();
    await c.connect();
    cam.quirks.pullHoldMs = 400;
    const sub = await c.createPullPoint();
    cam.state.maxConcurrent = 0;
    const t0 = Date.now();
    const pull = c.pullMessages(sub.address, 5, 32);
    await sleep(30);
    await c.getStatus();
    const statusAt = Date.now() - t0;
    await pull;
    expect(statusAt).toBeLessThan(300);
    expect(cam.state.maxConcurrent).toBe(2);
  });

  it('SerialQueue.clear rejects what has not started', async () => {
    const q = new SerialQueue();
    let release;
    const first = q.run(() => new Promise((r) => { release = r; }));
    const second = q.run(async () => 'never');
    second.catch(() => {});
    await sleep(0);
    q.clear(new Error('closed'));
    release('done');
    expect(await first).toBe('done');
    await expect(second).rejects.toThrow('closed');
  });
});

describe('events', () => {
  it('subscribes, pulls (state from Data, not Source), renews and unsubscribes', async () => {
    const c = client();
    await c.connect();
    expect(await c.getEventProperties()).toEqual(['tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/PeopleDetector/People', 'tns1:RuleEngine/TamperDetector/Tamper']);
    const sub = await c.createPullPoint();
    expect(sub.address).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${cam.port}/event-0_\\d+$`));
    cam.notify('tns1:RuleEngine/PeopleDetector/People', 'IsPeople', true);
    const msgs = await c.pullMessages(sub.address);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ topic: 'tns1:RuleEngine/PeopleDetector/People', operation: 'Changed', data: { IsPeople: 'true' } });
    const pullCall = cam.calls.find((x) => x.op === 'PullMessages');
    expect(pullCall?.action).toBe('http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest');
    expect(pullCall?.args.timeout).toBe('PT5S');
    await c.renew(sub.address);
    await c.unsubscribe(sub.address);
    expect(cam.state.subscriptions.size).toBe(0);
  });

  it('retries CreatePullPointSubscription without InitialTerminationTime once refused', async () => {
    cam.quirks.rejectInitialTerminationTime = true;
    const c = client();
    await c.connect();
    await c.createPullPoint();
    await c.createPullPoint();
    const creates = cam.calls.filter((x) => x.op === 'CreatePullPointSubscription');
    expect(creates.map((x) => /InitialTerminationTime/.test(x.body))).toEqual([true, false, false]);
  });

  it('switches the PullMessages action after a fault that mentions it', async () => {
    cam.quirks.actionFault = true;
    const c = client();
    await c.connect();
    const sub = await c.createPullPoint();
    await c.pullMessages(sub.address);
    await c.pullMessages(sub.address);
    const actions = cam.calls.filter((x) => x.op === 'PullMessages').map((x) => x.action);
    expect(actions).toEqual([
      'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
      'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessages',
      'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessages',
    ]);
  });
});

describe('parsers', () => {
  it('rewriteXaddr keeps path and query', () => {
    expect(rewriteXaddr('http://tapo.invalid:80/onvif/service?x=1', '192.168.1.50', 2020)).toBe('http://192.168.1.50:2020/onvif/service?x=1');
    expect(rewriteXaddr('http://10.0.0.9/onvif/service http://[fe80::1]/onvif/service', 'fd00::5', 2020)).toBe('http://[fd00::5]:2020/onvif/service');
    expect(rewriteXaddr('not a url', '192.168.1.50', 2020)).toBeNull();
    expect(rewriteXaddr('', '192.168.1.50', 2020)).toBeNull();
  });

  it('parseNotifications reads Data even when Source comes first with a boolean-looking item', () => {
    const doc = parseXml(`<PullMessagesResponse><NotificationMessage><Topic>tns1:RuleEngine/CellMotionDetector/Motion</Topic><Message><Message UtcTime="2026-10-10T12:00:00Z" PropertyOperation="Initialized"><Source><SimpleItem Name="IsMotion" Value="true"/></Source><Data><SimpleItem Name="IsMotion" Value="false"/></Data></Message></Message></NotificationMessage></PullMessagesResponse>`);
    expect(parseNotifications(doc)).toEqual([{ topic: 'tns1:RuleEngine/CellMotionDetector/Motion', utcTime: '2026-10-10T12:00:00Z', operation: 'Initialized', data: { IsMotion: 'false' } }]);
  });

  it('parseTopicSet walks nested topics', () => {
    const doc = parseXml('<R><TopicSet><tns1:RuleEngine><A><B topic="true"><MessageDescription><X topic="true"/></MessageDescription></B></A></tns1:RuleEngine><tns1:Device><Trigger topic="true"/></tns1:Device></TopicSet></R>');
    expect(parseTopicSet(doc)).toEqual(['tns1:RuleEngine/A/B', 'tns1:Device/Trigger']);
    expect(path(doc, 'TopicSet')).not.toBeNull();
  });
});
