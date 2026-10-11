// A stand-in for the app's camera MCP server (electron/tapo/camera-mcp.js + mcp-http.js) for the
// ClaudeSession tests and the gated live check: the same JSON-RPC over handle(), and with
// `http` the same handle() over loopback Streamable HTTP (bearer token; requests with an Origin
// header, another Host or another method than POST are refused).
import crypto from 'node:crypto';
import http from 'node:http';

export const SERVER = 'lawnmower-camera';

/** A JPEG header the size of a real snapshot (640x360): SOI, APP0, SOF0, EOI. */
export function fakeJpeg() {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, crypto.randomBytes(2000), Buffer.from([0xff, 0xd9])]);
}

export const TOOLS = ['camera_status', 'camera_look', 'camera_snapshot', 'camera_events', 'security_arm'].map((name) => ({
  name, description: `${name} (test)`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, _meta: { 'anthropic/alwaysLoad': true },
}));

/**
 * A stand-in for the camera MCP server (electron/tapo/camera-mcp.js): JSON-RPC over handle(),
 * and — with `http` — the same handle() over loopback HTTP with a bearer token, refusing
 * requests with an Origin header or another Host (like electron/tapo/mcp-http.js).
 * @param {{ http?: boolean, extraTools?: string[], statusText?: string }} [o]
 */
export function cameraServer(o = {}) {
  /** @type {any[]} */
  const calls = [];
  const jpeg = fakeJpeg();
  /** @param {any} msg */
  const handle = async (msg) => {
    calls.push(msg);
    if (msg.id === undefined || msg.id === null) return null; // notification
    const ok = (/** @type {any} */ result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER, version: 'test' } });
      case 'tools/list':
        return ok({ tools: [...TOOLS, ...(o.extraTools || []).map((name) => ({ name, inputSchema: { type: 'object' } }))] });
      case 'tools/call': {
        const name = msg.params?.name;
        if (name === 'camera_status') return ok({ content: [{ type: 'text', text: o.statusText || 'Front door camera: online, disarmed.' }] });
        if (name === 'camera_look') return ok({ content: [{ type: 'text', text: `Turned ${msg.params.arguments?.direction}.` }] });
        if (name === 'camera_snapshot') return ok({ content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: 'Front door camera, 14:03:12' }] });
        if (name === 'camera_boom') throw new Error('camera exploded');
        return ok({ content: [{ type: 'text', text: 'Unknown tool' }], isError: true });
      }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
  /** @type {import('../../../electron/claude-session.js').SdkMcpServer & Record<string, any>} */
  const server = { name: SERVER, handle };
  const state = { starts: 0, stops: 0, refused: 0, /** @type {http.Server|null} */ srv: null, url: '', token: '' };
  if (o.http) {
    server.startHttp = async () => {
      state.starts++;
      if (state.srv) return { url: state.url, token: state.token };
      state.token = crypto.randomBytes(16).toString('hex');
      const srv = http.createServer((req, res) => {
        const port = /** @type {any} */ (srv.address()).port;
        if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}` || req.headers.authorization !== `Bearer ${state.token}`) {
          state.refused++;
          res.writeHead(403).end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' }).end(); // no SSE stream offered (allowed by the spec)
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          const out = await handle(JSON.parse(body));
          if (out === null) return res.writeHead(202).end();
          const data = JSON.stringify(out);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }).end(data);
          return undefined;
        });
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
      state.srv = srv;
      state.url = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/mcp`;
      return { url: state.url, token: state.token };
    };
    server.stopHttp = async () => {
      state.stops++;
      const srv = state.srv;
      state.srv = null;
      if (srv) await new Promise((r) => srv.close(() => r(undefined)));
    };
  }
  return { server, calls, state };
}
