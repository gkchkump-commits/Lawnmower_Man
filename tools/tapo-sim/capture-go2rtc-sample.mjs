#!/usr/bin/env node
// Capture tests/fixtures/tapo/go2rtc-sample.mp4: 3 s of /api/stream.mp4 from the real go2rtc
// (1.9.14, `npm run fetch:go2rtc`) fed by the simulator — the exact fMP4 layout the app's parser
// and recorder get from a camera. The camera pans during the capture, so the sample also holds a
// scene-cut keyframe. Uses the hardened config of contract §8.5 (loopback API, random Basic
// credentials, local_auth, allow_paths, RTSP server off); the camera password reaches go2rtc
// only through its environment, percent-encoded.
//
//   node tools/tapo-sim/capture-go2rtc-sample.mjs [--out file.mp4] [--seconds 3]
//   LAWNMOWER_GO2RTC=/path/to/go2rtc node tools/tapo-sim/capture-go2rtc-sample.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSim } from './index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(root, 'tests/fixtures/tapo/go2rtc-sample.mp4');
const secIdx = argv.indexOf('--seconds');
const seconds = secIdx >= 0 ? Number(argv[secIdx + 1]) : 3;

/** The go2rtc binary: $LAWNMOWER_GO2RTC, else vendor/go2rtc/<platform>-<arch>/go2rtc(.exe). */
export function findGo2rtc(env = process.env) {
  if (env.LAWNMOWER_GO2RTC) return env.LAWNMOWER_GO2RTC;
  const exe = process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
  return path.join(root, 'vendor/go2rtc', `${process.platform}-${process.arch}`, exe);
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

const binary = findGo2rtc();
if (!fs.existsSync(binary)) {
  console.error(`go2rtc not found at ${binary}: run \`npm run fetch:go2rtc\` or set LAWNMOWER_GO2RTC`);
  process.exit(2);
}

const sim = await startSim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapo-sim-g2r-'));
const apiPort = await freePort();
const apiUser = crypto.randomBytes(6).toString('hex');
const apiPass = crypto.randomBytes(12).toString('hex');
const config = {
  app: { modules: ['api', 'mp4', 'rtsp'] },
  api: { listen: '127.0.0.1:${LM_G2R_PORT}', username: '${LM_G2R_USER}', password: '${LM_G2R_PASS}', local_auth: true, allow_paths: ['/api/streams', '/api/stream.mp4'] },
  rtsp: { listen: '' },
  log: { format: 'text', level: 'info', output: 'stdout' },
  streams: { lm_main: `rtsp://\${LM_CAM_USER}:\${LM_CAM_PASS}@127.0.0.1:${sim.rtspPort}/stream1` },
};
const cfgFile = path.join(dir, 'go2rtc.yaml');
fs.writeFileSync(cfgFile, JSON.stringify(config, null, 1));
const child = spawn(binary, ['-config', cfgFile], {
  env: { PATH: process.env.PATH || '', LM_G2R_PORT: String(apiPort), LM_G2R_USER: apiUser, LM_G2R_PASS: apiPass, LM_CAM_USER: encodeURIComponent(sim.username), LM_CAM_PASS: encodeURIComponent(sim.password) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
/** @type {string[]} */
const logs = [];
child.stdout.on('data', (c) => logs.push(String(c)));
child.stderr.on('data', (c) => logs.push(String(c)));
const auth = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
try {
  // ready: /api/streams answers 200 with Basic auth
  const t0 = Date.now();
  for (;;) {
    const st = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/api/streams', headers: { Authorization: auth }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
    });
    if (st === 200) break;
    if (Date.now() - t0 > 10000) throw new Error(`go2rtc did not become ready:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  /** @type {Buffer[]} */
  const chunks = [];
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: '/api/stream.mp4?src=lm_main', headers: { Authorization: auth }, agent: false }, (res) => {
      res.on('data', (c) => chunks.push(c));
      setTimeout(() => sim.camera.ptz.relative(-0.2, 0), (seconds * 1000) / 2); // a pan: scene-cut keyframe
      setTimeout(() => {
        req.destroy();
        resolve(res.statusCode);
      }, seconds * 1000);
    });
    req.on('error', reject);
  });
  const body = Buffer.concat(chunks);
  const sessions = sim.state.rtspSessions;
  if (status !== 200 || body.length < 1000) throw new Error(`stream.mp4 answered ${status} with ${body.length} bytes:\n${logs.join('')}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  console.log(JSON.stringify({ wrote: out, bytes: body.length, segments: [...sessions.live, ...sessions.ended].map((s) => s.segments.map((x) => x.id)) }));
} finally {
  child.kill();
  await sim.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
