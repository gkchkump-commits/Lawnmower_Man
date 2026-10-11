#!/usr/bin/env node
// Capture tests/unit/tapo/fixtures/go2rtc-sample.mp4: 3 s of /api/stream.mp4 from the real
// go2rtc 1.9.14 (vendor/, `npm run fetch:go2rtc`) fed by the in-test RTSP server streaming
// clip-160x90.h264. With --wrong-password it instead prints what go2rtc logs and answers when
// the camera refuses the sign-in (used to design the auth-failure detection).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Go2rtcSidecar, go2rtcBinaryPath } from '../../../../electron/tapo/go2rtc.js';
import { startMiniRtsp } from '../helpers/mini-rtsp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const wrong = process.argv.includes('--wrong-password');
const binary = go2rtcBinaryPath({ isPackaged: false, appRoot: root });
const rtsp = await startMiniRtsp({ file: path.join(here, 'clip-160x90.h264'), path: '/stream1' });
const lines = [];
const g = new Go2rtcSidecar({ binary, configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-g2r-')), log: (l, m) => lines.push(`${l} ${m}`) });
g.on('auth-failed', () => lines.push('EVENT auth-failed'));
const ep = await g.start({ host: '127.0.0.1', rtspPort: rtsp.port, stream: 'stream1', camUser: 'camacct', camPass: wrong ? 'nope' : 'se&cret' });
const chunks = [];
const status = await new Promise((resolve) => {
  const req = http.get(`${ep.url}/api/stream.mp4?src=lm_main`, { headers: { Authorization: ep.auth }, agent: false }, (res) => {
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(res.statusCode));
    setTimeout(() => { req.destroy(); resolve(res.statusCode); }, 3000);
  });
  req.on('error', (e) => resolve(`error ${e.message}`));
});
await new Promise((r) => setTimeout(r, 300));
await g.stop();
await rtsp.close();
const body = Buffer.concat(chunks);
console.log(JSON.stringify({ status, bytes: body.length, rtsp: rtsp.log, head: body.subarray(0, 120).toString('latin1').replace(/[^\x20-\x7e]/g, '.') }, null, 1));
console.log(lines.join('\n'));
if (!wrong) {
  fs.writeFileSync(path.join(here, 'go2rtc-sample.mp4'), body);
  console.log(`wrote ${body.length} bytes`);
}
