import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { SERVER_NAME, checkArgs, createCameraMcp, eventLine, qualifiedToolName, toolDefinitions } from '../../../electron/tapo/camera-mcp.js';
import { createMcpHttpServer, mcpHttpConfig } from '../../../electron/tapo/mcp-http.js';
import { alertLine, buildAvatarAlert, buildNotificationOptions, cameraLabel, AlertManager } from '../../../electron/tapo/alerts.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const NOW = new Date(2026, 9, 10, 14, 5, 0).getTime();

function fakeService(over = {}) {
  const calls = [];
  const svc = {
    calls,
    st: { enabled: true, configured: true, connection: 'online', detail: '', ptz: { available: true, privacySuspected: false, position: { x: 0.12, y: -0.3 } }, security: { armed: false, arming: false } },
    status: () => svc.st,
    presets: async () => [{ token: '1', name: 'Door' }, { token: '2', name: 'Window' }],
    ptz: async (cmd) => { calls.push(['ptz', cmd]); return cmd.op === 'preset-name' && cmd.name === 'garage' ? { ok: false, code: 'no-preset', error: 'There is no saved position called "garage".' } : { ok: true, moved: true, preset: cmd.op === 'preset-name' ? 'Door' : undefined }; },
    waitPtzIdle: async (ms) => { calls.push(['wait', ms]); return true; },
    snapshot: async (o) => { calls.push(['snapshot', o]); return { mediaType: 'image/jpeg', data: JPEG, width: 640, height: 360, at: new Date(2026, 9, 10, 14, 3, 12).getTime() }; },
    listEvents: async (q) => { calls.push(['events', q]); return { events: [{ id: 'a', kind: 'person', startedAt: new Date(2026, 9, 10, 14, 3).getTime(), endedAt: 1, durationSec: 23.4, clipUrl: 'app://lawnmower/__clips/x.mp4' }], total: 1 }; },
    arm: (o) => { calls.push(['arm', o]); return { armed: true, arming: true, armingEndsAt: NOW + 30_000 }; },
    ...over,
  };
  return svc;
}

function server(settings = {}, svc = fakeService()) {
  const s = { tapo: { name: 'front door camera' }, security: { claudeSee: 'ask', claudeMove: 'ask', ...settings } };
  return { mcp: createCameraMcp({ service: svc, getSettings: () => s, appVersion: '0.5.0', now: () => NOW }), svc };
}
const call = (mcp, name, args = {}, id = 7) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('camera MCP server', () => {
  it('initialize negotiates the protocol version', async () => {
    const { mcp } = server();
    expect(mcp.name).toBe(SERVER_NAME);
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.296' } } });
    expect(r).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lawnmower-camera', version: '0.5.0' }, instructions: expect.stringMatching(/camera_snapshot only when the user asks/) } });
    expect((await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).result.protocolVersion).toBe('2025-06-18');
  });

  it('notifications get no answer; ping; unknown methods −32601; junk −32600', async () => {
    const { mcp } = server();
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code).toBe(-32601);
    expect((await mcp.handle({ id: 5 })).error.code).toBe(-32600);
    expect((await mcp.handle('nope')).error.code).toBe(-32600);
  });

  it('tools/list: five flat tools, always loaded, no disarm', async () => {
    const { mcp } = server();
    const { result } = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(result.tools.map((t) => t.name)).toEqual(['camera_status', 'camera_look', 'camera_snapshot', 'camera_events', 'security_arm']);
    for (const t of result.tools) {
      expect(t._meta).toEqual({ 'anthropic/alwaysLoad': true });
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
      expect(t.description.length).toBeLessThan(2048);
      for (const k of Object.keys(t.inputSchema.properties)) expect(k).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
    expect(result.tools.map((t) => t.name).join()).not.toMatch(/disarm/);
    expect(qualifiedToolName('camera_status')).toBe('mcp__lawnmower-camera__camera_status');
    expect(toolDefinitions().find((t) => t.name === 'camera_snapshot').annotations.readOnlyHint).toBe(true);
  });

  it('camera_status in plain words, without the address', async () => {
    const { mcp } = server();
    const r = await call(mcp, 'camera_status');
    const text = r.result.content[0].text;
    expect(text).toMatch(/^Front door camera: online\. Disarmed\. Pan\/tilt works \(position pan 0\.12, tilt -0\.30\)\. Saved positions: Door, Window\. Last events: 14:03 person \(23 s, clip saved\)\./);
    expect(text).not.toMatch(/192\.168|rtsp:|password|__clips/);
  });

  it('camera_look turns, goes to presets and home, waits for the move to settle', async () => {
    const { mcp, svc } = server();
    expect((await call(mcp, 'camera_look', { direction: 'left' })).result.content[0].text).toBe('Turned left.');
    expect(svc.calls[0]).toEqual(['ptz', { op: 'nudge', dir: 'left', amount: 'medium' }]);
    expect(svc.calls[1]).toEqual(['wait', 10000]);
    expect((await call(mcp, 'camera_look', { direction: 'up', amount: 'small' })).result.content[0].text).toBe('Tilted up.');
    expect((await call(mcp, 'camera_look', { preset: 'door' })).result.content[0].text).toBe('Moved to Door.');
    expect((await call(mcp, 'camera_look', { home: true })).result.content[0].text).toBe('Back at the home position.');
    const garage = (await call(mcp, 'camera_look', { preset: 'garage' })).result;
    expect(garage.isError).toBe(true);
    expect(garage.content[0].text).toMatch(/no saved position/);
    expect((await call(mcp, 'camera_look', { direction: 'left', home: true })).result.isError).toBe(true);
    expect((await call(mcp, 'camera_look', {})).result.isError).toBe(true);
    expect((await call(mcp, 'camera_look', { direction: 'sideways' })).result.content[0].text).toMatch(/must be one of/);
    expect((await call(mcp, 'camera_look', { direction: 'left', zoom: 2 })).result.content[0].text).toMatch(/unknown argument/);
  });

  it('camera_snapshot returns a JPEG image block and a caption', async () => {
    const { mcp, svc } = server();
    const r = (await call(mcp, 'camera_snapshot')).result;
    expect(r.content).toEqual([{ type: 'image', data: JPEG, mimeType: 'image/jpeg' }, { type: 'text', text: 'Front door camera, 14:03:12' }]);
    expect(svc.calls).toEqual([['snapshot', { maxSide: 640 }]]);
    await call(mcp, 'camera_snapshot', { preset: 'door' });
    expect(svc.calls.slice(1, 3)).toEqual([['ptz', { op: 'preset-name', name: 'door' }], ['wait', 10000]]);
    const failing = server({}, fakeService({ snapshot: async () => { throw new Error('No picture from the camera right now.'); } }));
    expect((await call(failing.mcp, 'camera_snapshot')).result).toEqual({ content: [{ type: 'text', text: 'No picture from the camera right now.' }], isError: true });
  });

  it('"never" settings are refused inside the handler too', async () => {
    const { mcp, svc } = server({ claudeSee: 'never', claudeMove: 'never' });
    expect((await call(mcp, 'camera_snapshot')).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not allowed Claude to see/) }] });
    expect((await call(mcp, 'camera_look', { direction: 'left' })).result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not allowed Claude to move/) }] });
    const moveOff = server({ claudeMove: 'never' });
    expect((await call(moveOff.mcp, 'camera_snapshot', { preset: 'door' })).result.isError).toBe(true);
    expect(svc.calls).toEqual([]);
  });

  it('camera_events and security_arm', async () => {
    const { mcp, svc } = server();
    expect((await call(mcp, 'camera_events', { since_minutes: 120, limit: 5 })).result.content[0].text).toBe('14:03 person (23 s, clip saved)');
    expect(svc.calls[0]).toEqual(['events', { sinceMs: NOW - 120 * 60000, limit: 5 }]);
    expect((await call(mcp, 'camera_events', { since_minutes: 0 })).result.isError).toBe(true);
    expect((await call(mcp, 'camera_events', { limit: 2.5 })).result.isError).toBe(true);
    expect((await call(mcp, 'security_arm')).result.content[0].text).toBe('Armed in 30 seconds.');
    expect(svc.calls.at(-1)).toEqual(['arm', { armed: true, immediate: false }]);
    svc.st.security = { armed: true, arming: false };
    expect((await call(mcp, 'security_arm')).result.content[0].text).toBe('Already armed.');
    expect((await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'security_disarm' } })).error.code).toBe(-32602);
  });

  it('eventLine and checkArgs', () => {
    expect(eventLine({ kind: 'motion', startedAt: new Date(2026, 9, 10, 9, 7).getTime() })).toBe('09:07 motion (still going on)');
    expect(eventLine({ kind: 'person', startedAt: new Date(2026, 9, 10, 9, 7).getTime(), endedAt: 1, durationSec: 4, unconfirmed: true })).toBe('09:07 person (4 s, unconfirmed)');
    expect(checkArgs({ properties: {} }, null)).toBeNull();
    expect(checkArgs({ properties: {} }, [])).toMatch(/object/);
  });
});

describe('MCP over loopback HTTP (G2)', () => {
  const post = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });

  it('serves the same handler behind a bearer token, refusing Origin and foreign Host', async () => {
    const { mcp } = server();
    const g2 = createMcpHttpServer({ handle: mcp.handle });
    const { url, token } = await g2.start();
    try {
      expect(await g2.start()).toEqual({ url, token }); // idempotent
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const auth = { Authorization: `Bearer ${token}` };
      const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
      expect(r.status).toBe(200);
      expect(r.body.result.tools).toHaveLength(5);
      expect((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status).toBe(202);
      expect((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
      expect((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer nope' })).status).toBe(401);
      expect((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, Origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, Host: 'evil.example:80' })).status).toBe(403);
      expect((await post(url, '{not json', auth)).body.error.code).toBe(-32700);
      expect((await post(url.replace('/mcp', '/other'), { jsonrpc: '2.0', id: 1, method: 'ping' }, auth)).status).toBe(404);
      expect(mcpHttpConfig(url)).toEqual({ mcpServers: { 'lawnmower-camera': { type: 'http', url, headers: { Authorization: 'Bearer ${LM_MCP_TOKEN}' } } } });
    } finally {
      await g2.stop();
    }
    expect(g2.url).toBeNull();
  });
});

describe('alerts', () => {
  const ev = (kind) => ({ id: '20261010-140312-a1b2', kind, startedAt: new Date(2026, 9, 10, 14, 3, 12).getTime() });
  it('notification texts', () => {
    expect(buildNotificationOptions({ event: ev('person'), cameraName: 'front door camera', snapshotPath: '/c/x.jpg' })).toEqual({ title: 'Person at the front door camera', body: '14:03 · Click to see the clip', icon: '/c/x.jpg', silent: false, urgency: 'critical', timeoutType: 'default' });
    expect(buildNotificationOptions({ event: ev('motion'), cameraName: 'The garden cam', silent: true })).toMatchObject({ title: 'Movement at the garden cam', silent: true });
    expect(buildNotificationOptions({ event: ev('tamper'), cameraName: 'camera' }).title).toBe('Camera tamper alert');
    expect('icon' in buildNotificationOptions({ event: ev('person'), cameraName: 'camera' })).toBe(false);
  });

  it('spoken lines and the avatar alert', () => {
    expect(alertLine('person', 'camera')).toBe('Someone is at the camera.');
    expect(alertLine('motion', 'front door camera')).toBe('I noticed movement on the front door camera.');
    expect(alertLine('tamper', 'camera')).toBe('The camera may have been covered or moved.');
    expect(cameraLabel('  ')).toBe('camera');
    const a = buildAvatarAlert({ event: ev('person'), cameraName: 'camera', quiet: false, describe: true, snapshot: { mediaType: 'image/jpeg', data: JPEG } });
    expect(a).toEqual({ id: '20261010-140312-a1b2', kind: 'person', at: ev('person').startedAt, cameraName: 'camera', line: 'Someone is at the camera.', quiet: false, describe: true, snapshot: { mediaType: 'image/jpeg', data: JPEG } });
    expect(buildAvatarAlert({ event: ev('person'), cameraName: 'camera', quiet: true, describe: true, snapshot: null })).toMatchObject({ describe: false, quiet: true });
  });

  it('AlertManager shows a Notification, keeps it referenced and records it for the e2e hook', () => {
    const shown = [];
    class FakeNotification {
      static isSupported() { return true; }
      constructor(o) { this.o = o; this.handlers = {}; shown.push(this); }
      on(e, f) { this.handlers[e] = f; }
      show() { this.shownAt = 1; }
    }
    const clicks = [];
    const m = new AlertManager({ Notification: FakeNotification, nativeImage: { createFromPath: () => ({ isEmpty: () => false, tag: 'img' }) }, onClick: (id) => clicks.push(id), record: true });
    expect(m.notify({ event: ev('person'), cameraName: 'camera', snapshotPath: '/x.jpg' })).toBe(true);
    expect(shown[0].o).toMatchObject({ title: 'Person at the camera', icon: { tag: 'img' } });
    shown[0].handlers.click();
    expect(clicks).toEqual(['20261010-140312-a1b2']);
    expect(m.shown).toEqual([{ title: 'Person at the camera', body: '14:03 · Click to see the clip', at: expect.any(Number), eventId: '20261010-140312-a1b2', silent: false, icon: true }]);
    const none = new AlertManager({ Notification: { isSupported: () => false } });
    expect(none.notify({ event: ev('person'), cameraName: 'camera' })).toBe(false);
  });
});
