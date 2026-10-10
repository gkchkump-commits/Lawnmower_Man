// The camera simulator's own tests (contract §12.1 `sim-self`): fixtures, geometry, the ONVIF
// server (WS-Security, clock, faults, PTZ motor, quirks, PullPoint), the RTSP server (Digest,
// SDP, interleaved RTP split on AUD, session timeout, 2-session cap) and the control API —
// with a small client of the tests' own, never the app's.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startSim, SIM_TRUTH } from '../../../tools/tapo-sim/index.mjs';
import { DEFAULT_FIXTURES, loadFixtures, selectSegment } from '../../../tools/tapo-sim/fixtures.mjs';
import { gridCell, gridCellMoving, roundHalfAway, segmentId, cropOrigin, PANO, VIEW } from '../../../tools/tapo-sim/geometry.mjs';
import { accessUnits, depacketize, nalType, rtpPayloads, splitAnnexB } from '../../../tools/tapo-sim/h264.mjs';
import { checkWsse, parseDuration } from '../../../tools/tapo-sim/soap.mjs';
import { digestResponse } from '../../../tools/tapo-sim/rtsp-server.mjs';
import { parse } from '../../../tools/tapo-sim/xml-lite.mjs';
import { PtzModel } from '../../../tools/tapo-sim/ptz-model.mjs';
import { RtspClient, faultCodes, sleep, soap, until } from './helpers.js';

const AUTH = { username: 'camacct', password: 'se&cret' };

describe('fixtures (tests/fixtures/tapo, make-fixtures.sh)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_FIXTURES, 'manifest.json'), 'utf8'));

  it('every segment is one 15-frame GOP: AUD per frame, one slice, IDR first, identical SPS/PPS', () => {
    for (const [stream, info] of Object.entries(manifest.streams)) {
      /** @type {string|null} */
      let params = null;
      for (const [id, seg] of Object.entries(/** @type {any} */ (info).segments)) {
        const data = fs.readFileSync(path.join(DEFAULT_FIXTURES, stream, `${id}.h264`));
        expect(crypto.createHash('sha256').update(data).digest('hex'), `${stream}/${id}`).toBe(/** @type {any} */ (seg).sha256);
        const frames = accessUnits(splitAnnexB(data));
        expect(frames, `${stream}/${id}`).toHaveLength(15);
        frames.forEach((au, k) => {
          const types = au.map(nalType);
          expect(types[0], `${id} frame ${k} starts with an AUD`).toBe(9);
          expect(types.filter((t) => t === 1 || t === 5), `${id} frame ${k}: one slice`).toHaveLength(1);
          expect(types.includes(5), `${id} frame ${k}: IDR only first`).toBe(k === 0);
        });
        const key = frames[0].filter((n) => nalType(n) === 7 || nalType(n) === 8).map((n) => n.toString('hex')).join('/');
        params ??= key;
        expect(key, `${stream}/${id} SPS/PPS`).toBe(params);
      }
    }
  });

  it('stays small (committed: at most 3 MB in total)', () => {
    const files = [];
    const walk = (/** @type {string} */ d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else files.push(path.join(d, e.name));
      }
    };
    walk(path.dirname(DEFAULT_FIXTURES));
    const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    expect(total).toBeLessThan(3 * 1024 * 1024);
  });

  it('the grid covers the panorama; the truth the calibration is checked against', () => {
    expect(cropOrigin(-4, 2)).toEqual({ x: 0, y: 0 });
    expect(cropOrigin(4, -2)).toEqual({ x: PANO.width - VIEW.width, y: PANO.height - VIEW.height });
    expect(SIM_TRUTH.viewUnitsX).toBeCloseTo(0.8, 9);
    expect(SIM_TRUTH.viewUnitsY).toBeCloseTo(1.2, 9);
    expect(manifest.truth.viewUnitsX).toBeCloseTo(SIM_TRUTH.viewUnitsX, 9);
  });
});

describe('geometry and segment choice', () => {
  it('rounds half away from zero despite float noise', () => {
    expect(roundHalfAway(0.05 / 0.1)).toBe(1);
    expect(roundHalfAway(-0.05 / 0.1)).toBe(-1);
    expect(roundHalfAway(0.02 / 0.1)).toBe(0);
    expect(gridCell(0.3 + 0.1, 0)).toEqual({ i: 4, j: 0 });
    expect(gridCell(9, -9)).toEqual({ i: 4, j: -2 }); // clamped at the edge segment
    expect(segmentId(-1, 0, true)).toBe('p-1_t0_person');
  });

  it('mirrored pan / inverted tilt sit between the ONVIF position and the view', () => {
    const fx = loadFixtures().stream1;
    const tapo = { mirrorPan: true, invertTilt: true };
    // ONVIF +x on a mirrored camera turns the lens LEFT; +y on an inverted one tilts it DOWN
    expect(selectSegment(fx, { x: 0.2, y: 0 }, tapo, {}).id).toBe('p-2_t0');
    expect(selectSegment(fx, { x: 0, y: 0.2 }, tapo, {}).id).toBe('p0_t-1');
    expect(selectSegment(fx, { x: 0.2, y: 0.2 }, {}, {}).id).toBe('p2_t1');
    expect(selectSegment(fx, { x: 0.1, y: 0 }, {}, { person: true }).id).toBe('p1_t0_person');
    expect(selectSegment(fx, { x: 0.3, y: 0 }, {}, { person: true }).id).toBe('p3_t0'); // the person is not in view there
    expect(selectSegment(fx, { x: 0, y: 0 }, {}, { privacy: true, person: true }).id).toBe('privacy');
  });

  it('while an axis turns, odd and even frames show the cells on either side of the position', () => {
    // pan turning between cells 1 and 2 (0.13 units), tilt at rest at 0.1 (nearest: cell 1)
    expect(gridCellMoving(0.13, 0.1, { x: true, y: false }, 0)).toEqual({ i: 1, j: 1 });
    expect(gridCellMoving(0.13, 0.1, { x: true, y: false }, 1)).toEqual({ i: 2, j: 1 });
    expect(gridCellMoving(-0.13, 0, { x: true, y: false }, 0)).toEqual({ i: -2, j: 0 });
    expect(gridCellMoving(-0.13, 0, { x: true, y: false }, 1)).toEqual({ i: -1, j: 0 });
    // tilt turning between −1 and 0
    expect(gridCellMoving(0, -0.05, { x: false, y: true }, 0)).toEqual({ i: 0, j: -1 });
    expect(gridCellMoving(0, -0.05, { x: false, y: true }, 1)).toEqual({ i: 0, j: 0 });
    // exactly on a cell (float noise included), or past the end of the grid: the picture holds
    expect(gridCellMoving(0.1 + 0.2, 0, { x: true, y: false }, 0)).toEqual({ i: 3, j: 0 });
    expect(gridCellMoving(0.1 + 0.2, 0, { x: true, y: false }, 1)).toEqual({ i: 3, j: 0 });
    expect(gridCellMoving(0.9, 0, { x: true, y: false }, 1)).toEqual({ i: 4, j: 0 });
    expect(gridCellMoving(0.9, 0, { x: true, y: false }, 0)).toEqual({ i: 4, j: 0 });
    // through selectSegment: no axis moving is the nearest cell
    const fx = loadFixtures().stream1;
    expect(selectSegment(fx, { x: 0.13, y: 0 }, {}, {}, { x: false, y: false, frameNo: 1 }).id).toBe('p1_t0');
    expect(selectSegment(fx, { x: 0.13, y: 0 }, {}, {}, { x: true, y: false, frameNo: 1 }).id).toBe('p2_t0');
    expect(selectSegment(fx, { x: 0.13, y: 0 }, { mirrorPan: true }, {}, { x: true, y: false, frameNo: 1 }).id).toBe('p-1_t0');
  });

  it('RTP payloads round-trip, FU-A above 1400 bytes', () => {
    const nal = Buffer.concat([Buffer.from([0x65]), crypto.randomBytes(5000)]);
    const parts = rtpPayloads(nal);
    expect(parts.length).toBe(4);
    expect(parts.every((p) => p.length <= 1400)).toBe(true);
    expect(parts[0][0] & 0x1f).toBe(28);
    expect(depacketize(parts)[0].equals(nal)).toBe(true);
    expect(rtpPayloads(Buffer.from([0x67, 1, 2]))).toHaveLength(1);
  });

  it('parses ISO durations and tolerant XML', () => {
    expect(parseDuration('PT5S')).toBe(5);
    expect(parseDuration('PT10M')).toBe(600);
    expect(parseDuration('PT0.5S')).toBe(0.5);
    expect(parseDuration('P1DT1H')).toBe(90000);
    expect(parseDuration('junk')).toBeNull();
    const d = parse('<?xml version="1.0"?><a:X xmlns:a="u"><a:Y v=\'1 &amp; 2\'>t&lt;<![CDATA[<raw>]]></a:Y><Z/></a:X>');
    expect(d.children[0].name).toBe('X');
    expect(d.children[0].children[0]).toMatchObject({ name: 'Y', prefix: 'a', attrs: { v: '1 & 2' }, text: 't<<raw>' });
    expect(() => parse('<!DOCTYPE x><x/>')).toThrow(/DOCTYPE/);
    expect(() => parse('<a><b></a>')).toThrow();
  });
});

describe('PTZ motor model', () => {
  /** @param {Record<string, any>} [quirks] */
  const motor = (quirks = {}) => {
    let t = 0;
    const m = new PtzModel({ now: () => t, getQuirks: () => quirks });
    return { m, at: (/** @type {number} */ ms) => { t = ms; return m; } };
  };

  it('RelativeMove drives to the target at 0.35 units/s (speed ignored), tilt at 0.25', () => {
    const { m, at } = motor();
    m.relative(0.35, -0.25);
    expect(at(500).position).toEqual({ x: 0.175, y: -0.125 });
    expect(m.moving).toBe(true);
    expect(at(1000).position).toEqual({ x: 0.35, y: -0.25 });
    expect(m.moving).toBe(false);
  });

  it('acknowledges and ignores translations below minEffectiveStep', () => {
    const { m, at } = motor({ minEffectiveStep: 0.05 });
    expect(m.relative(0.03, 0.06)).toEqual({ x: false, y: true });
    expect(at(2000).position).toEqual({ x: 0, y: 0.06 });
  });

  it('ContinuousMove runs until its timeout; pushing at an end stop is counted', () => {
    const { m, at } = motor();
    m.continuous(1, 0, 4000);
    expect(at(1000).position.x).toBeCloseTo(0.35, 6);
    expect(at(5000).position.x).toBe(1); // reached the stop after ~2.86 s
    expect(m.moving).toBe(false);
    expect(m.endStopMs).toBeGreaterThan(1000);
    expect(m.endStopMs).toBeLessThan(1200);
  });

  it('stopIgnoredOnPan: Stop leaves the pan running, a zero-velocity ContinuousMove stops it', () => {
    const { m, at } = motor({ stopIgnoredOnPan: true });
    m.continuous(-0.5, 0.5);
    at(400).stop();
    const x400 = m.position.x;
    expect(at(800).position.x).toBeLessThan(x400);
    expect(m.y.mode).toBe('idle');
    at(900).continuous(0, 0);
    const x = m.position.x;
    expect(at(2000).position.x).toBe(x);
    expect(m.moving).toBe(false);
  });

  it('relativeActsContinuous: a RelativeMove keeps turning until Stop', () => {
    const { m, at } = motor({ relativeActsContinuous: true });
    m.relative(0.1, 0);
    expect(at(3000).position.x).toBeGreaterThan(0.1);
    expect(m.moving).toBe(true);
    at(3000).stop();
    expect(at(4000).moving).toBe(false);
  });
});

describe('ONVIF server', () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {string} */
  let svc;
  beforeAll(async () => {
    sim = await startSim();
    svc = `http://127.0.0.1:${sim.onvifPort}/onvif/service`;
  });
  afterAll(() => sim.close());
  afterEach(() => sim.reset());

  it('GetSystemDateAndTime needs no auth; everything else does (400 ter:NotAuthorized)', async () => {
    const t = await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/device_service`, '<tds:GetSystemDateAndTime/>');
    expect(t.status).toBe(200);
    expect(t.text).toMatch(/<tt:DateTimeType>NTP<\/tt:DateTimeType>/);
    const noAuth = await soap(svc, '<tds:GetDeviceInformation/>');
    expect(noAuth.status).toBe(400);
    expect(faultCodes(noAuth.text)).toEqual(['SOAP-ENV:Sender', 'ter:NotAuthorized']);
    const ok = await soap(svc, '<tds:GetDeviceInformation/>', { auth: AUTH });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('<tds:Model>Tapo C211</tds:Model>');
    const bad = await soap(svc, '<tds:GetDeviceInformation/>', { auth: { ...AUTH, password: 'nope' } });
    expect(bad.status).toBe(400);
    expect(sim.state.authFailures.onvif).toBe(2);
    expect(sim.calls.at(-1)).toMatchObject({ op: 'GetDeviceInformation', status: 400, why: 'wrong digest' });
  });

  it('checks Created against the camera clock (skew) and refuses a replayed nonce', async () => {
    sim.set({ clockSkewSec: 30 });
    const offClock = await soap(svc, '<tds:GetDeviceInformation/>', { auth: AUTH });
    expect(offClock.status).toBe(400);
    expect(sim.calls.at(-1).why).toMatch(/off the camera clock/);
    const camTime = new Date(Date.now() + 30_000).toISOString();
    expect((await soap(svc, '<tds:GetDeviceInformation/>', { auth: { ...AUTH, created: camTime } })).status).toBe(200);
    const t = await soap(svc, '<tds:GetSystemDateAndTime/>');
    expect(t.text).toMatch(/<tt:DateTimeType>Manual<\/tt:DateTimeType>/);
    const nonce = crypto.randomBytes(16);
    const created = new Date(Date.now() + 30_000).toISOString();
    expect((await soap(svc, '<tds:GetDeviceInformation/>', { auth: { ...AUTH, created, nonce } })).status).toBe(200);
    expect((await soap(svc, '<tds:GetDeviceInformation/>', { auth: { ...AUTH, created, nonce } })).status).toBe(400);
    expect(sim.calls.at(-1).why).toBe('nonce replayed');
  });

  it('verifies the contract test vector digest', () => {
    const created = '2026-10-10T12:00:00.000Z';
    const xml = `<s:Envelope xmlns:s="x"><s:Header><wsse:Security xmlns:wsse="y"><wsse:UsernameToken><wsse:Username>camacct</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">dHOmgGxSGDXchosYzIsHN03/CiI=</wsse:Password><wsse:Nonce>AAECAwQFBgcICQoLDA0ODw==</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header><s:Body/></s:Envelope>`;
    expect(checkWsse(parse(xml), { username: 'camacct', password: 'se&cret', cameraNowMs: Date.parse(created), toleranceSec: 10, seenNonces: null })).toEqual({ ok: true, user: 'camacct' });
  });

  it('GetCapabilities lists Analytics first; PTZ and Events have their own sections', async () => {
    const r = await soap(svc, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', { auth: AUTH });
    const xaddrs = [...r.text.matchAll(/<tt:(\w+)><tt:XAddr>([^<]+)</g)].map((m) => m[1]);
    expect(xaddrs).toEqual(['Analytics', 'Device', 'Events', 'Imaging', 'Media', 'PTZ']);
    expect(r.text).toContain(`<tt:PTZ><tt:XAddr>http://127.0.0.1:${sim.onvifPort}/onvif/service</tt:XAddr>`);
    expect(r.text).toContain('<tt:WSPullPointSupport>true</tt:WSPullPointSupport>');
    sim.set({ quirks: { xaddrHost: 'camera.invalid:2020' } });
    const r2 = await soap(svc, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', { auth: AUTH });
    expect(r2.text).toContain('<tt:XAddr>http://camera.invalid:2020/onvif/service</tt:XAddr>');
  });

  it('profiles carry tokens and the PTZ configuration; GetSnapshotUri fails as on siblings', async () => {
    const r = await soap(svc, '<trt:GetProfiles/>', { auth: AUTH });
    expect(r.text).toMatch(/<trt:Profiles token="profile_1".*<tt:Width>2304<\/tt:Width>.*<tt:PTZConfiguration token="PTZConfiguration_1">/s);
    const uri = await soap(svc, '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>profile_2</trt:ProfileToken></trt:GetStreamUri>', { auth: AUTH });
    expect(uri.text).toContain(`rtsp://127.0.0.1:${sim.rtspPort}/stream2`);
    expect((await soap(svc, '<trt:GetSnapshotUri><trt:ProfileToken>profile_1</trt:ProfileToken></trt:GetSnapshotUri>', { auth: AUTH })).status).toBe(500);
    const wrong = await soap(svc, '<tptz:GetStatus><tptz:ProfileToken>Profile_1</tptz:ProfileToken></tptz:GetStatus>', { auth: AUTH });
    expect(faultCodes(wrong.text)).toContain('ter:NoProfile');
  });

  it('PTZ over SOAP: RelativeMove, MoveStatus, exponent numbers refused, presets', async () => {
    const move = await soap(svc, '<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:Translation><tt:PanTilt x="0.2" y="0"/></tptz:Translation><tptz:Speed><tt:PanTilt x="1" y="1"/></tptz:Speed></tptz:RelativeMove>', { auth: AUTH });
    expect(move.status).toBe(200);
    const st = await soap(svc, '<tptz:GetStatus><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetStatus>', { auth: AUTH });
    expect(st.text).toContain('<tt:PanTilt>MOVING</tt:PanTilt>');
    await until(() => !sim.state.ptz.moving, { timeout: 2000 });
    expect(sim.state.ptz).toMatchObject({ x: 0.2, y: 0 });
    expect(sim.calls.find((c) => c.op === 'RelativeMove')?.args).toMatchObject({ profile: 'profile_1', x: 0.2, y: 0 });
    const expo = await soap(svc, '<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:Translation><tt:PanTilt x="1e-7" y="0"/></tptz:Translation></tptz:RelativeMove>', { auth: AUTH });
    expect(expo.status).toBe(400);
    expect(faultCodes(expo.text)).toContain('ter:InvalidArgVal');
    const presets = await soap(svc, '<tptz:GetPresets><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetPresets>', { auth: AUTH });
    expect(presets.text).toMatch(/<tptz:Preset token="1"><tt:Name>Door<\/tt:Name>.*<tptz:Preset token="2"><tt:Name>Window/s);
    const set = await soap(svc, '<tptz:SetPreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetName>Sofa</tptz:PresetName></tptz:SetPreset>', { auth: AUTH });
    expect(set.text).toContain('<tptz:PresetToken>3</tptz:PresetToken>');
    expect((await soap(svc, '<tptz:GotoPreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetToken>9</tptz:PresetToken></tptz:GotoPreset>', { auth: AUTH })).status).toBe(400);
    expect((await soap(svc, '<tptz:GotoHomePosition><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GotoHomePosition>', { auth: AUTH })).status).toBe(500);
  });

  it('privacy mode: PTZ gets a malformed answer, then HTTP 500', async () => {
    sim.set({ privacy: true });
    const body = '<tptz:Stop><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop>';
    await expect(soap(svc, body, { auth: AUTH })).rejects.toMatchObject({ code: 'HPE_INVALID_STATUS' });
    expect((await soap(svc, body, { auth: AUTH })).status).toBe(500);
    expect((await soap(svc, '<tds:GetDeviceInformation/>', { auth: AUTH })).status).toBe(200);
  });

  it('getStatusFails answers HTTP 500; concurrent401 refuses overlapping control requests', async () => {
    sim.set({ quirks: { getStatusFails: true } });
    expect((await soap(svc, '<tptz:GetStatus><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetStatus>', { auth: AUTH })).status).toBe(500);
    sim.set({ quirks: { concurrent401: true } });
    const both = await Promise.all([1, 2, 3].map(() => soap(svc, '<tds:GetDeviceInformation/>', { auth: AUTH })));
    expect(both.map((r) => r.status).sort()).toContain(401);
  });

  describe('PullPoint events', () => {
    const create = (/** @type {boolean} */ withTime) => soap(svc, withTime ? '<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime></tev:CreatePullPointSubscription>' : '<tev:CreatePullPointSubscription/>', { auth: AUTH });
    const addr = (/** @type {string} */ text) => /** @type {RegExpExecArray} */ (/<wsa5:Address>([^<]+)<\/wsa5:Address>/.exec(text))[1];
    const pull = (/** @type {string} */ a, timeout = 'PT5S') => soap(a, `<tev:PullMessages><tev:Timeout>${timeout}</tev:Timeout><tev:MessageLimit>32</tev:MessageLimit></tev:PullMessages>`, { auth: AUTH, timeoutMs: 15000 });
    const values = (/** @type {string} */ text) => [...text.matchAll(/PropertyOperation="(\w+)">.*?<tt:Data><tt:SimpleItem Name="(\w+)" Value="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}=${m[3]}`);

    it('rejects InitialTerminationTime (C500), subscribes without it, Initialized first', async () => {
      const refused = await create(true);
      expect(faultCodes(refused.text)).toContain('ter:InvalidArgVal');
      const ok = await create(false);
      expect(ok.status).toBe(200);
      const a = addr(ok.text);
      expect(a).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${sim.onvifPort}/event-\\d+_${sim.onvifPort}$`));
      const first = await pull(a);
      expect(values(first.text)).toEqual(['Initialized:IsMotion=false', 'Initialized:IsPeople=false', 'Initialized:IsTamper=false']);
      // the Source items come before Data (a client must read Data)
      expect(first.text).toMatch(/<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"\/>/);
    });

    it('floods duplicates with single false blips while a person is there', async () => {
      sim.set({ quirks: { eventFlood: true } });
      const a = addr((await create(false)).text);
      await pull(a); // Initialized
      sim.set({ person: true });
      await sleep(3600);
      const msgs = [];
      for (let k = 0; k < 4; k++) msgs.push(...values((await pull(a)).text));
      const people = msgs.filter((m) => m.includes('IsPeople'));
      expect(people.length).toBeGreaterThan(55); // ~18 per second
      expect(people.filter((m) => m.endsWith('false')).length).toBe(1); // the 60th
      sim.set({ person: false });
      const tail = values((await pull(a)).text);
      expect(tail.at(-1)).toBe('Changed:IsPeople=false');
    });

    it('drops an empty pull after pullDropAfterMs with bytes after Connection: close', async () => {
      sim.set({ quirks: { pullDropAfterMs: 400 } });
      const a = addr((await create(false)).text);
      await pull(a);
      const t0 = Date.now();
      await expect(pull(a, 'PT5S')).rejects.toMatchObject({ code: 'HPE_CLOSED_CONNECTION' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      expect(Date.now() - t0).toBeLessThan(2000);
      // the subscription survives a dropped pull
      expect(sim.state.subscriptions.list).toHaveLength(1);
      // a message during a waiting pull answers it at once
      const p = pull(a);
      await sleep(100);
      sim.set({ motion: true });
      expect(values((await p).text)).toContain('Changed:IsMotion=true');
    });

    it('caps subscriptions at 3 (the 4th is Fault "error"), renews, unsubscribes, expires', async () => {
      const subs = [];
      for (let k = 0; k < 3; k++) subs.push(addr((await create(false)).text));
      const fourth = await create(false);
      expect(fourth.status).toBe(500);
      expect(fourth.text).toContain('>error<');
      expect(sim.state.subscriptions).toMatchObject({ created: 3, refused: 1 });
      const renew = await soap(subs[0], '<wsnt:Renew><wsnt:TerminationTime>PT10M</wsnt:TerminationTime></wsnt:Renew>', { auth: AUTH });
      expect(renew.status).toBe(200);
      expect((await soap(subs[1], '<wsnt:Unsubscribe/>', { auth: AUTH })).status).toBe(200);
      expect(sim.state.subscriptions.list).toHaveLength(2);
      sim.set({ quirks: { subscriptionLifetimeSec: 0.3 } });
      await soap(subs[2], '<wsnt:Renew><wsnt:TerminationTime>PT0.3S</wsnt:TerminationTime></wsnt:Renew>', { auth: AUTH });
      await sleep(400);
      expect((await pull(subs[2])).status).toBe(400);
    });

    it('noFallingEdge never sends the false', async () => {
      sim.set({ quirks: { eventFlood: false, noFallingEdge: true } });
      const a = addr((await create(false)).text);
      await pull(a);
      sim.set({ motion: true });
      sim.set({ motion: false });
      expect(values((await pull(a)).text)).toEqual(['Changed:IsMotion=true']);
    });
  });

  it('offline refuses connections; it comes back', async () => {
    sim.set({ offline: true });
    await expect(soap(`http://127.0.0.1:${sim.onvifPort}/onvif/device_service`, '<tds:GetSystemDateAndTime/>')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    sim.set({ offline: false });
    await until(async () => (await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/device_service`, '<tds:GetSystemDateAndTime/>').catch(() => ({ status: 0 }))).status === 200);
  });
});

describe('the ideal preset: split service paths and other tokens', () => {
  it('serves each service at its own path and lists a profile without PTZ first', async () => {
    const sim = await startSim({ quirks: 'ideal' });
    try {
      const caps = await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/device_service`, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', { auth: AUTH });
      expect(caps.text).toContain('/onvif/ptz_service</tt:XAddr>');
      const p = await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/media_service`, '<trt:GetProfiles/>', { auth: AUTH });
      expect([...p.text.matchAll(/<trt:Profiles token="(\w+)"/g)].map((m) => m[1])).toEqual(['JpegStream', 'MainStream', 'SubStream']);
      // a PTZ request sent to the Analytics address is refused
      const wrong = await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/analytics_service`, '<tptz:GetStatus><tptz:ProfileToken>MainStream</tptz:ProfileToken></tptz:GetStatus>', { auth: AUTH });
      expect(faultCodes(wrong.text)).toContain('ter:ActionNotSupported');
      const ok = await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/ptz_service`, '<tptz:GotoHomePosition><tptz:ProfileToken>MainStream</tptz:ProfileToken></tptz:GotoHomePosition>', { auth: AUTH });
      expect(ok.status).toBe(200);
    } finally {
      await sim.close();
    }
  });
});

describe('RTSP server', () => {
  /** @type {Awaited<ReturnType<typeof startSim>>} */
  let sim;
  /** @type {RtspClient[]} */
  const clients = [];
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(() => sim.close());
  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    sim.reset();
  });
  const client = async (/** @type {Record<string, any>} */ o = AUTH) => {
    const c = await new RtspClient(sim.rtspPort, o).connect();
    clients.push(c);
    return c;
  };

  it('matches the contract Digest test vector', () => {
    expect(digestResponse({ username: 'camacct', realm: 'TP-Link IP-Camera', password: 'se&cret', method: 'DESCRIBE', uri: 'rtsp://192.168.1.50:554/stream1', nonce: '0a1b2c3d4e5f6789' })).toBe('8b8bb29dc5fde00cacab3ee65e4303a9');
  });

  it('OPTIONS without auth; DESCRIBE challenges with Digest, then answers the SDP', async () => {
    const c = await client({});
    expect((await c.request('OPTIONS', `rtsp://127.0.0.1:${sim.rtspPort}/stream1`))?.headers.public).toMatch(/DESCRIBE.*GET_PARAMETER/);
    const d = await c.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream1`);
    expect(d?.status).toBe(401);
    expect(d?.headers['www-authenticate']).toMatch(/^Digest realm="TP-Link IP-Camera", nonce="[0-9a-f]{32}"$/);
    const ok = await client();
    const sdp = await ok.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream1`);
    expect(sdp?.status).toBe(200);
    expect(sdp?.body).toMatch(/a=rtpmap:96 H264\/90000/);
    expect(sdp?.body).toMatch(/packetization-mode=1; profile-level-id=64001F; sprop-parameter-sets=Z2QAH[A-Za-z0-9+/=]+,aO[A-Za-z0-9+/=]+\r\n/);
    expect(sdp?.body).toMatch(/a=rtpmap:8 PCMA\/8000/);
    expect(sdp?.headers['content-base']).toBe(`rtsp://127.0.0.1:${sim.rtspPort}/stream1/`);
    const bad = await client({ username: 'camacct', password: 'wrong' });
    expect((await bad.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream2`))?.status).toBe(401);
    expect(sim.state.authFailures.rtsp).toBe(1);
    expect((await ok.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream8`))?.status).toBe(404);
  });

  it('TCP interleaved only (UDP → 461); the Session header states the 15 s timeout', async () => {
    const c = await client();
    await c.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream1`);
    const r = await c.request('SETUP', `rtsp://127.0.0.1:${sim.rtspPort}/stream1/track1`, { Transport: 'RTP/AVP;unicast;client_port=5000-5001' });
    expect(r?.status).toBe(461);
    const ok = await c.request('SETUP', `rtsp://127.0.0.1:${sim.rtspPort}/stream1/track1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    expect(ok?.headers.session).toMatch(/^[0-9A-F]{8};timeout=15$/);
    expect(ok?.headers.transport).toMatch(/^RTP\/AVP\/TCP;unicast;interleaved=0-1;ssrc=[0-9A-F]{8}/);
    sim.set({ quirks: { rtspAdvertiseTimeout: false } });
    const c2 = await client();
    await c2.request('DESCRIBE', `rtsp://127.0.0.1:${sim.rtspPort}/stream2`);
    expect((await c2.request('SETUP', `rtsp://127.0.0.1:${sim.rtspPort}/stream2/track1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' }))?.headers.session).toMatch(/^[0-9A-F]{8}$/);
  });

  it('streams frames split on AUDs: one access unit per marker, 15 fps, IDR with SPS/PPS first', async () => {
    const c = await client();
    const r = await c.play('/stream1');
    expect(r.play?.status).toBe(200);
    expect(r.play?.headers['rtp-info']).toMatch(/url=.*track1;seq=\d+;rtptime=\d+/);
    await sleep(1150);
    const frames = c.frames(0);
    expect(frames.length).toBeGreaterThanOrEqual(14);
    expect(frames.length).toBeLessThanOrEqual(21);
    const nals = depacketize(frames[0].payloads).map(nalType);
    expect(nals).toEqual([7, 8, 5]); // AUDs are not sent; SPS + PPS + one IDR slice
    for (const f of frames.slice(1, 14)) expect(depacketize(f.payloads).map(nalType)).toEqual([1]);
    expect(frames[1].ts - frames[0].ts).toBe(6000); // 90 kHz / 15 fps
    // sequence numbers are contiguous
    const seqs = frames.flatMap((f) => f.seqs);
    for (let k = 1; k < seqs.length; k++) expect((seqs[k] - seqs[k - 1] + 65536) % 65536).toBe(1);
    // the first IDR matches the fixture byte for byte
    const want = loadFixtures().stream1.segments.get('p0_t0')?.frames[0].filter((n) => nalType(n) === 5)[0];
    expect(depacketize(frames[0].payloads)[2].equals(/** @type {Buffer} */ (want))).toBe(true);
  });

  it('the picture follows the virtual position: a new IDR at the next frame', async () => {
    const c = await client();
    await c.play('/stream1');
    await sleep(300);
    sim.camera.ptz.place(-0.1, 0); // mirrored: ONVIF −x looks right
    await sleep(300);
    const s = sim.state.rtspSessions.live[0];
    expect(s.segments.map((x) => x.id)).toEqual(['p0_t0', 'p1_t0']);
    const keys = c.frames(0).filter((f) => depacketize(f.payloads).some((n) => nalType(n) === 5));
    expect(keys.length).toBe(2);
    sim.set({ person: true });
    await sleep(200);
    expect(sim.state.rtspSessions.live[0].segment).toBe('p1_t0_person');
  });

  it('while the camera turns the picture changes on every frame; at rest it holds the final cell', async () => {
    const c = await client();
    await c.play('/stream1');
    await sleep(200);
    sim.camera.ptz.relative(-0.2, 0); // mirrored: two cells to the right, 0.2 / 0.35 ≈ 570 ms
    await until(() => !sim.camera.ptz.moving, { timeout: 3000, what: 'the motor to stop' });
    const turning = sim.state.rtspSessions.live[0].segments.map((x) => x.id);
    await sleep(400);
    const after = sim.state.rtspSessions.live[0].segments.map((x) => x.id);
    // p0 → (p0 | p1 alternating) → (p1 | p2 alternating) → p2, one change per frame (≈ 8 frames)
    expect(turning.length).toBeGreaterThanOrEqual(6);
    expect(new Set(turning)).toEqual(new Set(['p0_t0', 'p1_t0', 'p2_t0']));
    expect(after.at(-1)).toBe('p2_t0');
    expect(after.length - turning.length).toBeLessThanOrEqual(1); // still once the motor stopped
  });

  it('allows two sessions (the camera budget, Tapo app viewers included); the next gets 453', async () => {
    const a = await client();
    const b = await client();
    expect((await a.play('/stream1')).play?.status).toBe(200);
    expect((await b.play('/stream2')).play?.status).toBe(200);
    const c = await client();
    expect((await c.play('/stream1')).setup?.status).toBe(453);
    a.close();
    await until(() => sim.state.rtspSessions.live.length === 1);
    sim.set({ viewers: 1 }); // a phone watching in the Tapo app
    expect((await c.play('/stream1')).setup?.status).toBe(453);
    sim.set({ viewers: 0 });
    expect((await c.play('/stream1')).play?.status).toBe(200);
  });

  it('drops a session after sessionTimeoutSec without an RTSP request; keepalives keep it', async () => {
    sim.set({ quirks: { sessionTimeoutSec: 1 } });
    const idle = await client();
    await idle.play('/stream1');
    const kept = await client();
    await kept.play('/stream2');
    const keep = setInterval(() => kept.request('GET_PARAMETER', `rtsp://127.0.0.1:${sim.rtspPort}/stream2`), 400);
    try {
      await until(() => idle.closed, { timeout: 3000, what: 'the idle session to be dropped' });
      await sleep(800);
      expect(kept.closed).toBe(false);
      expect(sim.state.rtspSessions.live.map((s) => s.path)).toEqual(['stream2']);
      expect(sim.calls.some((c) => c.op === 'SESSION-TIMEOUT')).toBe(true);
    } finally {
      clearInterval(keep);
    }
  });

  it('TEARDOWN ends the session; PCMA silence only when the audio track is set up', async () => {
    const c = await client();
    await c.play('/stream1', { audio: true });
    await sleep(300);
    const audio = c.packets(2);
    expect(audio.length).toBeGreaterThan(5);
    expect(audio[0][1] & 0x7f).toBe(8);
    expect(audio[0].subarray(12).every((b) => b === 0xd5)).toBe(true);
    const r = await c.request('TEARDOWN', `rtsp://127.0.0.1:${sim.rtspPort}/stream1`);
    expect(r?.status).toBe(200);
    expect(sim.state.rtspSessions.ended.at(-1)).toMatchObject({ endReason: 'teardown' });
  });
});

describe('control API and CLI options', () => {
  it('GET /state, POST /scenario|/quirks|/ptz|/reset; a request with Origin is refused', async () => {
    const sim = await startSim({ controlPort: 0 });
    const call = (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body, /** @type {Record<string,string>} */ headers = {}) => new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: sim.controlPort, path: p, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end(data);
    });
    try {
      expect(await call('POST', '/scenario', { person: true, clockSkewSec: 12 })).toMatchObject({ status: 200, body: { person: true, clockSkewSec: 12 } });
      expect(await call('POST', '/quirks', { stopIgnoredOnPan: true })).toMatchObject({ status: 200, body: { stopIgnoredOnPan: true } });
      expect(await call('POST', '/quirks', { nonsense: 1 })).toMatchObject({ status: 400 });
      expect(await call('POST', '/ptz', { x: 0.5, y: -0.25 })).toMatchObject({ status: 200, body: { x: 0.5, y: -0.25 } });
      const st = /** @type {any} */ (await call('GET', '/state'));
      expect(st.body).toMatchObject({ device: { model: 'Tapo C211' }, scenario: { person: true }, quirks: { mirrorPan: true, maxSubscriptions: 3 } });
      expect(Array.isArray(st.body.calls)).toBe(true);
      expect(await call('GET', '/state', undefined, { Origin: 'http://evil.example' })).toMatchObject({ status: 403 });
      await call('POST', '/reset', {});
      expect(sim.state).toMatchObject({ scenario: { person: false }, ptz: { x: 0, y: 0 }, quirks: { stopIgnoredOnPan: false } });
    } finally {
      await sim.close();
    }
  });

  it('reboot drops subscriptions and comes back', async () => {
    const sim = await startSim({ quirks: { rebootMs: 300 } });
    try {
      await soap(`http://127.0.0.1:${sim.onvifPort}/onvif/service`, '<tev:CreatePullPointSubscription/>', { auth: AUTH });
      expect(sim.state.subscriptions.list).toHaveLength(1);
      sim.set({ reboot: true });
      expect(sim.state.scenario.offline).toBe(true);
      await until(() => !sim.state.scenario.offline && sim.state.bootCount === 2, { timeout: 2000 });
      expect(sim.state.subscriptions.list).toHaveLength(0);
    } finally {
      await sim.close();
    }
  });
});
