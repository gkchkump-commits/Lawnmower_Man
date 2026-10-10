// Integration across lanes: the real camera MCP server of a running TapoService (lane A:
// camera-mcp.js + mcp-http.js, connected to the fake ONVIF camera) handed to the real
// ClaudeSession (lane C) exactly as electron/main.js does — getSdkMcpServers: () =>
// tapo.mcpServers(), getToolPermissions, getPersonaContext — and driven by the fake Claude CLI:
//   G1  the tools reach the CLI in-process (initialize.sdkMcpServers + mcp_message);
//   G2  a CLI that ignores in-process servers: the session switches to the service's own loopback
//       HTTP endpoint (startHttp(): { url, token }; bearer token, Origin/Host checks), with the token
//       only in the CLI's environment, and stops it again (stopHttp()) when the session stops.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ClaudeSession } from '../../../electron/claude-session.js';
import { CredentialStore } from '../../../electron/tapo/credentials.js';
import { TapoService } from '../../../electron/tapo/tapo-service.js';
import { TOKEN_ENV, mcpHttpConfig } from '../../../electron/tapo/mcp-http.js';
import { startFakeOnvif } from './helpers/fake-onvif.js';
import { FakeMessageChannelMain, FakeRelay, FakeSidecar, memorySafeStorage, tempSettings, until } from './helpers/fakes.js';

const FAKE_CLI = path.resolve('tests/fixtures/fake-claude.mjs');
const T = (/** @type {string} */ tool) => `mcp__lawnmower-camera__${tool}`;

/**
 * Poll until fn returns something truthy: that value, or null after ms.
 * @template T @param {() => T} fn @param {number} [ms] @returns {Promise<T|null>}
 */
async function valueOf(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** @type {Array<() => Promise<void>|void>} */
let cleanup = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await Promise.resolve().then(f).catch(() => {});
  cleanup = [];
});

/** @param {{ env?: Record<string, string>, security?: Record<string, any> }} [o] */
async function setup(o = {}) {
  const cam = await startFakeOnvif();
  cleanup.push(() => cam.close());
  const { store, dir } = tempSettings({
    tapo: { enabled: true, host: '127.0.0.1', onvifPort: cam.port, rtspPort: 554, username: 'camacct', name: 'front door camera' },
    security: { armDelaySec: 30, ...(o.security || {}) },
  });
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = new CredentialStore({ dir: path.join(dir, 'tapo'), safeStorage: memorySafeStorage(), platform: 'linux' });
  await credentials.setPassword('se&cret', { host: '127.0.0.1' });
  const service = new TapoService({
    settings: store,
    credentials,
    paths: { configDir: path.join(dir, 'tapo'), defaultClipsDir: path.join(dir, 'clips') },
    deps: {
      MessageChannelMain: FakeMessageChannelMain,
      alerts: { notify: () => true },
      openPath: async () => '',
      detector: 'stub',
      assets: { wasmBase: 'app://lawnmower/assets/vision/wasm/', modelUrl: 'app://lawnmower/assets/security/efficientdet_lite0_int8.tflite' },
      createSidecar: () => new FakeSidecar(),
      createRelay: () => new FakeRelay(),
    },
    log: () => {},
    env: { LAWNMOWER_TAPO_ALLOW_LOOPBACK: '1' },
    appVersion: '0.5.0',
  });
  store.on('change', (n, p) => service.applySettings(n, p));
  cleanup.push(() => service.stop());
  await service.start();
  await until(() => service.status().connection === 'online');

  // what electron/main.js passes (createTapo's mcpServers(): [] unless enabled and configured)
  const mcpServers = () => (store.get().tapo.enabled && service.configured() ? [service.mcpServer()] : []);
  const logs = /** @type {string[]} */ ([]);
  const argvLog = path.join(dir, 'argv.jsonl');
  const mcpLog = path.join(dir, 'mcp.jsonl');
  const claudeSettings = { cliPath: '', model: '', effort: '', mode: 'chat', workdir: path.join(dir, 'work'), persona: '', resumeLastSession: true, lastSessionId: '' };
  const session = new ClaudeSession({
    getSettings: () => claudeSettings,
    personaDir: path.join(dir, 'persona'),
    onSessionId: (id) => { claudeSettings.lastSessionId = id; },
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_CLAUDE_LOG: argvLog, FAKE_CLAUDE_MCP_LOG: mcpLog, FAKE_CLAUDE_STATE_DIR: path.join(dir, 'state'), ...(o.env || {}) },
    restart: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
    log: (level, msg) => logs.push(`${level} ${msg}`),
    getSdkMcpServers: mcpServers,
    getToolPermissions: () => service.toolPermissions(),
    getPersonaContext: () => service.personaContext(),
    mcpDir: path.join(dir, 'mcp'),
  });
  cleanup.push(() => session.stop());
  /** @type {any[]} */
  const events = [];
  session.on('event', (ev) => events.push(ev));
  const ask = async (/** @type {string} */ text) => {
    const { turnId } = await session.send(text);
    const end = await valueOf(() => events.find((e) => e.type === 'turn_end' && e.turnId === turnId), 15000);
    if (!end) throw new Error(`no turn_end for "${text}": ${logs.join('\n')}`);
    return end;
  };
  const runs = () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const mcp = () => (fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { service, store, session, events, logs, ask, runs, mcp, dir };
}

/** POST one JSON-RPC message to the G2 endpoint. @param {string} url @param {Record<string, string>} headers @param {object} body */
function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('the home camera\'s tools in a Claude session (lane A server × lane C session)', () => {
  it('G1: the five tools reach the CLI in-process; status and events are pre-approved, the rest asks', async () => {
    const h = await setup();
    const end = await h.ask('camera camera_status {}');
    expect(end.isError).toBe(false);
    expect(end.result).toMatch(/^Tool camera_status returned text: Front door camera: online\. Disarmed\./);
    const session = h.events.find((e) => e.type === 'session');
    expect(session.tools.sort()).toEqual([T('camera_events'), T('camera_look'), T('camera_snapshot'), T('camera_status'), T('security_arm')]);
    const argv = h.runs()[0].argv;
    expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', [T('camera_events'), T('camera_status')].join(',')]));
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--disallowedTools');
    expect(h.mcp().find((x) => x.kind === 'initialize').request).toMatchObject({ subtype: 'initialize', sdkMcpServers: ['lawnmower-camera'] });
    // the persona's camera paragraph names the camera
    const persona = fs.readFileSync(argv[argv.indexOf('--system-prompt-file') + 1], 'utf8');
    expect(persona).toContain('"front door camera"');
    // a tool the user set to "never" is not offered at all (spawn key → restart after the turn)
    h.store.update({ security: { claudeSee: 'never' } });
    h.session.applySettings();
    const denied = await h.ask('camera camera_snapshot {}');
    expect(denied.result).toBe('Tool unavailable.');
    const last = h.runs().at(-1).argv;
    expect(last).toEqual(expect.arrayContaining(['--disallowedTools', T('camera_snapshot')]));
  });

  it('G2: a CLI without in-process servers gets the service\'s loopback HTTP endpoint, token only in its environment', async () => {
    const h = await setup({ env: { FAKE_CLAUDE_IGNORE_SDK_MCP: '1' } });
    const first = await h.ask('hello');
    expect(first.isError).toBe(false);
    expect(h.logs.some((l) => /did not take the in-process tools of lawnmower-camera; serving them over loopback HTTP/.test(l))).toBe(true);
    expect(await valueOf(() => h.events.some((e) => e.type === 'status' && e.status === 'restarting'))).toBe(true);

    const end = await h.ask('camera camera_status {}');
    expect(end.result).toMatch(/^Tool camera_status returned text: Front door camera: online\. Disarmed\./);
    const argv = h.runs().at(-1).argv;
    expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--resume', first.sessionId]));
    const cfgFile = argv[argv.indexOf('--mcp-config') + 1];
    expect(cfgFile).toBe(path.join(h.dir, 'mcp', 'lawnmower-camera.json'));
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const url = cfg.mcpServers['lawnmower-camera'].url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // the session's config file and lane A's own mcpHttpConfig() agree, and hold no secret
    expect(cfg).toEqual(mcpHttpConfig(url));
    expect(cfg.mcpServers['lawnmower-camera'].headers.Authorization).toBe(`Bearer \${${TOKEN_ENV}}`);
    const { token } = await h.service.mcpServer().startHttp(); // idempotent while running: the same endpoint
    expect(fs.readFileSync(cfgFile, 'utf8')).not.toContain(token);
    expect(JSON.stringify(h.runs())).not.toContain(token);
    const viaHttp = h.mcp().filter((x) => x.via === 'http');
    expect(viaHttp.map((x) => x.message.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    // the endpoint itself: bearer token, no web pages (Origin), no other Host
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const port = new URL(url).port;
    expect(await post(url, { Authorization: `Bearer ${token}` }, ping)).toBe(200);
    expect(await post(url, {}, ping)).toBe(401);
    expect(await post(url, { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }, ping)).toBe(403);
    expect(await post(url, { Authorization: `Bearer ${token}`, Host: `localhost:${port}` }, ping)).toBe(403);
    // stopping the session stops the endpoint
    await h.session.stop();
    await expect(post(url, { Authorization: `Bearer ${token}` }, ping)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('no camera tools while the camera is turned off', async () => {
    const h = await setup();
    h.store.update({ tapo: { enabled: false } });
    h.session.applySettings();
    await h.ask('hello');
    const argv = h.runs().at(-1).argv;
    expect(argv).not.toContain('--allowedTools');
    expect(h.mcp().filter((x) => x.kind === 'initialize').at(-1).request).toEqual({ subtype: 'initialize' });
    const none = h.events.filter((e) => e.type === 'session').at(-1);
    expect(none.tools).toEqual([]);
  });
});
