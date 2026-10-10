// Test-only control API of the simulator (contract §11.4), loopback HTTP + JSON:
//   GET  /state      { ptz, calls, subscriptions, rtspSessions, scenario, quirks, … }
//   POST /scenario   { motion?, person?, tamper?, privacy?, offline?, clockSkewSec?, viewers?, reboot? }
//   POST /quirks     { <quirk>: value, … }
//   POST /ptz        { x, y }   put the camera somewhere (no motion)
//   POST /reset      back to the initial state
// Requests with an Origin header are refused (a web page must not drive it).

import http from 'node:http';

/**
 * @param {{ host: string, port: number, getState: () => any, set: (patch: any) => void, reset: () => void, place: (x: number, y: number) => void }} o
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startControlServer(o) {
  const server = http.createServer((req, res) => {
    const json = (/** @type {number} */ status, /** @type {any} */ body) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
      res.end(data);
    };
    if (req.headers.origin !== undefined) return json(403, { error: 'forbidden' });
    const url = new URL(req.url || '/', 'http://x');
    /** @type {Buffer[]} */
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      try {
        const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
        if (req.method === 'GET' && url.pathname === '/state') return json(200, o.getState());
        if (req.method === 'POST' && url.pathname === '/scenario') {
          o.set(body);
          return json(200, o.getState().scenario);
        }
        if (req.method === 'POST' && url.pathname === '/quirks') {
          o.set({ quirks: body });
          return json(200, o.getState().quirks);
        }
        if (req.method === 'POST' && url.pathname === '/ptz') {
          o.place(Number(body.x) || 0, Number(body.y) || 0);
          return json(200, o.getState().ptz);
        }
        if (req.method === 'POST' && url.pathname === '/reset') {
          o.reset();
          return json(200, { ok: true });
        }
        return json(404, { error: 'not found' });
      } catch (err) {
        return json(400, { error: /** @type {Error} */ (err).message });
      }
    });
    return undefined;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve(undefined));
  });
  return {
    port: /** @type {import('node:net').AddressInfo} */ (server.address()).port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
