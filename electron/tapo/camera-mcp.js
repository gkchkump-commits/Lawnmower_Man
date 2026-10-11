// The "lawnmower-camera" MCP server Claude uses (contract §8.12): JSON-RPC 2.0 by hand, hosted
// in main over the CLI's control channel (sdkMcpServers / mcp_message), or over loopback HTTP
// (mcp-http.js). Pure: the camera service is injected.
//
// Claude can check the camera, turn it, look through it and arm the alarm — never disarm it.
// Pictures and moves follow the user's settings (claudeSee / claudeMove): "never" is refused
// here too, even though the CLI is not offered those tools then. Results never contain the
// camera's address, credentials or file paths; image data is never logged.

export const SERVER_NAME = 'lawnmower-camera';
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const DEFAULT_PROTOCOL = '2025-06-18';
export const TOOL_NAMES = Object.freeze(['camera_status', 'camera_look', 'camera_snapshot', 'camera_events', 'security_arm']);
const DIRS = ['left', 'right', 'up', 'down'];
const AMOUNTS = ['small', 'medium', 'large'];

/** @param {string} tool */
export const qualifiedToolName = (tool) => `mcp__${SERVER_NAME}__${tool}`;

/** What Claude hears about the connection: fixed sentences, never the status detail (it names the address). */
export const CONNECTION_TEXT = Object.freeze({
  online: 'online',
  off: 'turned off in the app',
  connecting: 'connecting',
  'not-configured': 'not set up yet',
  unreachable: 'not reachable (it may be switched off or off the network)',
  'auth-failed': 'not connected: the camera refused the sign-in (the Camera Account in the setup)',
  error: 'not connected (the camera window says why)',
});

/** A camera-supplied name for Claude: one short line. @param {unknown} v */
export const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 40);

/**
 * No addresses in anything Claude reads (contract §8.12): the configured host, IP literals and
 * host:port. @param {string} text @param {string} [host]
 */
export function scrubAddresses(text, host = '') {
  let t = String(text);
  const h = String(host || '').trim();
  if (h) t = t.split(h).join('the camera');
  return t
    .replace(/\[[0-9a-f:.]+\](?::\d+)?/gi, 'the camera')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, 'the camera')
    // IPv6 literals: compressed (with "::"; times like 14:03:12 never have it) or all 8 groups
    .replace(/(?:\b[0-9a-f]{1,4})?(?::[0-9a-f]{0,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?:%\w+)?/gi, (m) => (/[0-9a-f]/i.test(m) && m.length > 3 ? 'the camera' : m))
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}\b/gi, 'the camera');
}

const META = Object.freeze({ 'anthropic/alwaysLoad': true });

/** The tool list (flat input schemas, no extra properties). */
export function toolDefinitions() {
  const ann = (/** @type {boolean} */ readOnly, /** @type {string} */ title) => ({ title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
  return [
    {
      name: 'camera_status',
      description: "The user's home security camera right now: online or not, armed or not, privacy mode, its pan/tilt position, the saved positions and the last few detections. Use it before answering questions about the camera.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: ann(true, 'Camera status'),
      _meta: META,
    },
    {
      name: 'camera_look',
      description: 'Turn the pan/tilt camera: a direction (left, right, up, down; amount small, medium or large), a saved position by name (for example "door"), or home. Give exactly one of direction, preset or home. Answers once the camera has stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: DIRS, description: 'Which way to turn.' },
          amount: { type: 'string', enum: AMOUNTS, default: 'medium', description: 'How far to turn (with direction).' },
          preset: { type: 'string', maxLength: 64, description: 'A saved position, by name.' },
          home: { type: 'boolean', description: 'Go back to the home position.' },
        },
        additionalProperties: false,
      },
      annotations: ann(false, 'Turn the camera'),
      _meta: META,
    },
    {
      name: 'camera_snapshot',
      description: 'A picture from the home camera right now (JPEG, at most 640 px). Only use it when the user asks you to look or check; describe what you see briefly and never guess who a person is. To look somewhere else, turn the camera with camera_look first (the user may have to approve that).',
      inputSchema: {
        type: 'object',
        properties: { preset: { type: 'string', maxLength: 64, description: 'A saved position to look at first (only when the user lets Claude move the camera without asking, and it is not armed).' } },
        additionalProperties: false,
      },
      annotations: ann(true, 'Look through the camera'),
      _meta: META,
    },
    {
      name: 'camera_events',
      description: 'Recent detections of the home camera (people, movement, tamper), newest first, with their time and length. Text only.',
      inputSchema: {
        type: 'object',
        properties: {
          since_minutes: { type: 'integer', minimum: 1, maximum: 10080, default: 60, description: 'How far back, in minutes.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'At most this many events.' },
        },
        additionalProperties: false,
      },
      annotations: ann(true, 'Camera events'),
      _meta: META,
    },
    {
      name: 'security_arm',
      description: 'Arm the home security (detections then alert the user). It arms after the exit delay set by the user. You cannot disarm it; the user does that.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: ann(false, 'Arm home security'),
      _meta: META,
    },
  ];
}

/**
 * Check `args` against a flat schema (types, enums, ranges, no unknown keys).
 * @param {any} schema @param {unknown} args @returns {string|null} what is wrong
 */
export function checkArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (args))) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}"`;
    if (p.type === 'string') {
      if (typeof v !== 'string') return `"${k}" must be text`;
      if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
      if (p.maxLength && v.length > p.maxLength) return `"${k}" is too long`;
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${k}" must be true or false`;
    } else if (p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) return `"${k}" must be a whole number`;
      if (v < p.minimum || v > p.maximum) return `"${k}" must be between ${p.minimum} and ${p.maximum}`;
    }
  }
  return null;
}

/** @param {number} at */
const hhmm = (at) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** @param {number} at */
const hhmmss = (at) => `${hhmm(at)}:${String(new Date(at).getSeconds()).padStart(2, '0')}`;
/** @param {string} s */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** One event as a line: "14:03 person (23 s, clip saved)". @param {any} e */
export function eventLine(e) {
  const bits = [];
  if (typeof e.durationSec === 'number') bits.push(`${Math.round(e.durationSec)} s`);
  else if (!e.endedAt) bits.push('still going on');
  if (e.clipUrl) bits.push('clip saved');
  if (e.unconfirmed) bits.push('unconfirmed');
  return `${hhmm(e.startedAt)} ${e.kind}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/**
 * @typedef {object} CameraServiceForMcp
 * @property {() => any} status
 * @property {(o: { refresh?: boolean }) => Promise<Array<{ token: string, name: string }>>} presets
 * @property {(cmd: any) => Promise<any>} ptz
 * @property {(timeoutMs: number) => Promise<boolean>} waitPtzIdle
 * @property {(o: { maxSide: number }) => Promise<{ mediaType: string, data: string, width: number, height: number, at: number }>} snapshot
 * @property {(q: { sinceMs?: number, limit?: number }) => Promise<{ events: any[], total: number }>} listEvents
 * @property {(o: { armed: boolean, immediate?: boolean }) => any} arm
 */

/**
 * @param {{ service: CameraServiceForMcp, getSettings: () => { tapo: any, security: any }, appVersion?: string,
 *   log?: (level: string, msg: string) => void, now?: () => number }} o
 */
export function createCameraMcp(o) {
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const tools = toolDefinitions();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const name = () => cap(o.getSettings().tapo?.name || 'camera');

  const host = () => String(o.getSettings().tapo?.host || '');
  /** @param {string} t */
  const text = (t) => ({ content: [{ type: 'text', text: scrubAddresses(t, host()) }] });
  /** @param {string} message */
  const fail = (message) => ({ content: [{ type: 'text', text: scrubAddresses(String(message).slice(0, 300), host()) }], isError: true });

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const impl = {
    async camera_status() {
      const st = o.service.status();
      const parts = [];
      const online = st.connection === 'online';
      parts.push(`${name()}: ${/** @type {Record<string, string>} */ (CONNECTION_TEXT)[st.connection] || 'not connected'}.`);
      if (online && st.stream?.state && !['live', 'off', 'starting'].includes(st.stream.state)) parts.push('Its video is not coming through right now.');
      const sec = st.security || {};
      parts.push(sec.armed ? (sec.arming ? `Arming (armed in ${Math.max(0, Math.round(((sec.armingEndsAt || now()) - now()) / 1000))} s).` : 'Armed.') : 'Disarmed.');
      if (st.ptz?.privacySuspected) parts.push('The camera seems to be in privacy mode.');
      if (st.ptz?.available) {
        const p = st.ptz.position;
        parts.push(`Pan/tilt works${p ? ` (position pan ${p.x.toFixed(2)}, tilt ${p.y.toFixed(2)})` : ''}.`);
        const presets = await o.service.presets({ refresh: false }).catch(() => []);
        parts.push(presets.length ? `Saved positions: ${presets.slice(0, 16).map((x) => cleanName(x.name)).join(', ')}.` : 'No saved positions.');
      } else {
        parts.push('Pan/tilt is not available.');
      }
      const { events } = await o.service.listEvents({ limit: 3 }).catch(() => ({ events: [] }));
      parts.push(events.length ? `Last events: ${events.map(eventLine).join('; ')}.` : 'No events recorded.');
      if (sec.active) parts.push(`Happening now: ${sec.active.kind}.`);
      return text(parts.join(' '));
    },

    async camera_look(args) {
      if (o.getSettings().security?.claudeMove === 'never') return fail('The user has not allowed Claude to move the camera (Settings › Home camera).');
      const given = ['direction', 'preset', 'home'].filter((k) => args[k] !== undefined && args[k] !== false);
      if (given.length !== 1) return fail('Give exactly one of direction, preset or home.');
      let cmd;
      let done;
      if (args.direction) {
        cmd = { op: 'nudge', dir: args.direction, amount: args.amount || 'medium' };
        done = `${args.direction === 'up' || args.direction === 'down' ? 'Tilted' : 'Turned'} ${args.direction}.`;
      } else if (args.preset) {
        cmd = { op: 'preset-name', name: args.preset };
      } else {
        cmd = { op: 'home' };
        done = 'Back at the home position.';
      }
      const r = await o.service.ptz(cmd);
      if (!r.ok) return fail(r.error || 'The camera could not move.');
      await o.service.waitPtzIdle(10_000);
      if (args.preset) done = `Moved to ${cleanName(r.preset || args.preset)}.`;
      return text(r.moved === false && args.direction ? 'The camera is already turning; try again in a moment.' : /** @type {string} */ (done));
    },

    async camera_snapshot(args) {
      const s = o.getSettings();
      if (s.security?.claudeSee === 'never') return fail('The user has not allowed Claude to see the camera (Settings › Home camera).');
      if (args.preset) {
        if (s.security?.claudeMove === 'never') return fail('The user has not allowed Claude to move the camera. Ask for a picture without a position.');
        // A pre-approved snapshot must not turn the camera on its own: turning needs the user's
        // approval (camera_look shows the card) unless they let Claude move it without asking —
        // and never without a card while the camera is armed (it must keep watching its view).
        const armed = !!o.service.status()?.security?.armed;
        if (s.security?.claudeMove !== 'always' || armed) {
          return fail('Turning the camera needs the user\'s approval: turn it with camera_look first (preset), then ask for the picture without a position.');
        }
        const r = await o.service.ptz({ op: 'preset-name', name: args.preset });
        if (!r.ok) return fail(r.error || 'The camera could not move there.');
        await o.service.waitPtzIdle(10_000);
      }
      let snap;
      try {
        snap = await o.service.snapshot({ maxSide: 640 });
      } catch (err) {
        return fail(/** @type {Error} */ (err).message || 'No picture from the camera right now.');
      }
      return {
        content: [
          { type: 'image', data: snap.data, mimeType: 'image/jpeg' },
          { type: 'text', text: `${name()}, ${hhmmss(snap.at)}` },
        ],
      };
    },

    async camera_events(args) {
      const minutes = args.since_minutes ?? 60;
      const limit = args.limit ?? 10;
      const { events, total } = await o.service.listEvents({ sinceMs: now() - minutes * 60_000, limit });
      if (!events.length) return text(`No events in the last ${minutes} minutes.`);
      const more = total > events.length ? ` (${total - events.length} more)` : '';
      return text(`${events.map(eventLine).join('\n')}${more}`);
    },

    async security_arm() {
      const st = o.service.status();
      if (!st.enabled || !st.configured) return fail('The home camera is not set up.');
      if (st.security?.armed && !st.security?.arming) return text('Already armed.');
      const r = await o.service.arm({ armed: true, immediate: false });
      if (r.arming && r.armingEndsAt) return text(`Armed in ${Math.max(1, Math.round((r.armingEndsAt - now()) / 1000))} seconds.`);
      return text('Armed.');
    },
  };

  /**
   * One JSON-RPC message in, the response out (null for notifications).
   * @param {any} message
   * @returns {Promise<object|null>}
   */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      const id = message && typeof message === 'object' && 'id' in message ? message.id : null;
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (method.startsWith('notifications/')) return null;
    /** @param {any} result */
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    /** @param {number} code @param {string} msg */
    const err = (code, msg) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } });
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: o.appVersion || '0.0.0' },
          instructions: "Tools for the user's Tapo home security camera. Use camera_snapshot only when the user asks to look or check.",
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return err(-32602, `Unknown tool: ${String(params?.name).slice(0, 80)}`);
        const args = params?.arguments ?? {};
        const bad = checkArgs(tool.inputSchema, args);
        log('info', `[tapo] Claude called ${tool.name}${bad ? ' (bad arguments)' : ''} ${JSON.stringify(args).slice(0, 200)}`);
        if (bad) return ok(fail(`Invalid arguments: ${bad}.`));
        try {
          const result = await impl[tool.name](args);
          log('info', `[tapo] ${tool.name} → ${result.isError ? 'error' : 'ok'}: ${result.content.filter((/** @type {any} */ c) => c.type === 'text').map((/** @type {any} */ c) => c.text).join(' ').slice(0, 200)}`);
          return ok(result);
        } catch (e) {
          log('warn', `[tapo] ${tool.name} failed: ${/** @type {Error} */ (e).message}`);
          return ok(fail('The camera could not do that right now.'));
        }
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  }

  return { name: SERVER_NAME, handle };
}
