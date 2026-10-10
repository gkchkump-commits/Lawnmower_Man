// The camera MCP server over loopback Streamable HTTP (contract §10.4, "G2"): the fallback for a
// Claude CLI that does not offer in-process SDK MCP servers to the model. Same handle() as the
// control-channel transport. Pure Node (http).
//
//   POST http://127.0.0.1:<random>/mcp   JSON-RPC in, JSON out (202 for notifications)
//   Authorization: Bearer <token>        random per start; the CLI gets it as ${LM_MCP_TOKEN}
//                                        from its environment (the config file holds no secret)
// Refused: any request with an Origin header (a web page; MCP transport spec: servers MUST check
// Origin), a Host other than 127.0.0.1:<port> (DNS rebinding), anything but POST /mcp, bodies
// over 1 MB, non-JSON. No SSE stream is offered (GET → 405), which the spec allows.

import crypto from 'node:crypto';
import http from 'node:http';

export const MAX_BODY = 1024 * 1024;
export const TOKEN_ENV = 'LM_MCP_TOKEN';

/**
 * The --mcp-config JSON for the CLI (the token stays in the child's environment).
 * @param {string} url @param {string} [name]
 */
export function mcpHttpConfig(url, name = 'lawnmower-camera') {
  return { mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } };
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{ handle: (message: object) => Promise<object|null>, log?: (level: string, msg: string) => void }} o
 */
export function createMcpHttpServer(o) {
  const log = o.log || (() => {});
  /** @type {http.Server|null} */
  let server = null;
  let token = '';
  let port = 0;
  /** @type {Promise<{ url: string, token: string }>|null} */
  let starting = null;

  /** @param {http.ServerResponse} res @param {number} status @param {object|null} [body] */
  const reply = (res, status, body = null) => {
    const data = body ? JSON.stringify(body) : '';
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}) });
    res.end(data);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const onRequest = (req, res) => {
    if (req.headers.origin !== undefined) {
      log('warn', `[tapo] MCP HTTP: refused a request with Origin ${String(req.headers.origin).slice(0, 80)}`);
      return reply(res, 403, { error: 'forbidden' });
    }
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, { error: 'forbidden' });
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return reply(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'method not allowed' });
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reply(res, 415, { error: 'expected application/json' });
    /** @type {Buffer[]} */
    const parts = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', async () => {
      if (tooBig) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      try {
        const out = await o.handle(msg);
        if (out === null) return reply(res, 202);
        return reply(res, 200, out);
      } catch (err) {
        log('warn', `[tapo] MCP HTTP: ${/** @type {Error} */ (err).message}`);
        return reply(res, 500, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: 'Internal error' } });
      }
    });
    req.on('error', () => {});
    return undefined;
  };

  return {
    get url() {
      return server ? `http://127.0.0.1:${port}/mcp` : null;
    },
    /** Start (idempotent while running): the endpoint and its bearer token. @returns {Promise<{ url: string, token: string }>} */
    start() {
      if (server && port) return Promise.resolve({ url: `http://127.0.0.1:${port}/mcp`, token });
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        token = crypto.randomBytes(32).toString('hex');
        const srv = http.createServer(onRequest);
        srv.requestTimeout = 120_000;
        srv.on('error', (err) => {
          starting = null;
          reject(err);
        });
        srv.listen(0, '127.0.0.1', () => {
          server = srv;
          port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
          starting = null;
          log('info', `[tapo] MCP over HTTP on 127.0.0.1:${port}`);
          resolve({ url: `http://127.0.0.1:${port}/mcp`, token });
        });
      });
      return starting;
    },
    /** @returns {Promise<void>} */
    stop() {
      const srv = server;
      server = null;
      port = 0;
      token = '';
      if (!srv) return Promise.resolve();
      return new Promise((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    },
  };
}
