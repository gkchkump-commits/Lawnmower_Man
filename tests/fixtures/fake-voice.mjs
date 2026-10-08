#!/usr/bin/env node
// Stand-in for `python -m lawnmower_voice` (contract §6) used by the VoiceSidecar tests.
// Accepts the real launch flags, listens on --host/--port, prints {"event":"ready","port":p},
// serves GET /health (no auth) and GET /voices (Bearer token required; token from --token or
// env LAWNMOWER_VOICE_TOKEN).
//
// Test switches:
//   --fake-no-ready            never print the ready line
//   --fake-exit <code>         exit immediately with <code> (after writing to stderr)
//   --fake-stderr <text>       what --fake-exit writes to stderr
//   --fake-crash-after <ms>    exit(9) <ms> after becoming ready
//   --fake-ready-delay <ms>    wait before listening
//   --fake-log-file <path>     append {argv, env} on start
//   --fake-loading-ms <ms>     /health reports both engines as loading for <ms> after listening
//   --fake-not-installed       like the real server in a half-installed venv: report the missing
//                              packages ({"event":"not-installed"} + stderr) and exit 2
//   --fake-not-installed-legacy  the same with only the 0.1.0 stderr message (no protocol line)
//   --fake-exit2-usage         exit 2 like an argparse usage error (not "not installed")

import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const logFile = opt('--fake-log-file');
if (logFile) {
  fs.appendFileSync(logFile, `${JSON.stringify({ argv, env: { LAWNMOWER_VOICE_TOKEN: process.env.LAWNMOWER_VOICE_TOKEN ? 'set' : null, PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? null }, cwd: process.cwd() })}\n`);
}

if (has('--fake-not-installed')) {
  process.stdout.write(`${JSON.stringify({ event: 'not-installed', missing: ['uvicorn'] })}\n`);
  process.stderr.write('2026-10-04 08:52:27,930 ERROR   lawnmower_voice: Local voice is not fully installed (missing: uvicorn). Run the setup script again ("Set up local voice again" in the app)\n');
  process.exit(2);
}
if (has('--fake-not-installed-legacy')) {
  process.stderr.write("2026-10-04 08:52:27,930 ERROR lawnmower_voice: uvicorn is not installed (No module named 'uvicorn'). Run the setup script.\n");
  process.exit(2);
}
if (has('--fake-exit2-usage')) {
  process.stderr.write('usage: python -m lawnmower_voice [-h]\npython -m lawnmower_voice: error: unrecognized arguments: --bogus\n');
  process.exit(2);
}

if (opt('--fake-exit')) {
  process.stderr.write(`${opt('--fake-stderr', 'fake-voice: simulated failure (CUDA error)')}\n`);
  process.exit(Number(opt('--fake-exit')));
}

const host = opt('--host', '127.0.0.1');
const port = Number(opt('--port', '0'));
const token = opt('--token') || process.env.LAWNMOWER_VOICE_TOKEN || '';
const device = opt('--device', 'auto');
const sttModel = opt('--stt-model', 'large-v3-turbo');
const ttsVoice = opt('--tts-voice', 'af_heart');

process.stdout.write('loading models (this line is not JSON)\n');
process.stdout.write(`${JSON.stringify({ event: 'status', detail: 'Loading speech models…' })}\n`);

const loadingMs = Number(opt('--fake-loading-ms', '0'));
let listenedAt = 0;
const engine = (extra) => {
  const loading = loadingMs > 0 && Date.now() - listenedAt < loadingMs;
  return loading ? { backend: 'fake', device, loaded: false, loading: true, ...extra } : { backend: 'fake', device, loaded: true, ...extra };
};

const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') {
    return json(200, {
      ok: true,
      version: 'fake-1',
      device: { cuda: device !== 'cpu', name: device !== 'cpu' ? 'NVIDIA GeForce RTX 5070 Laptop GPU' : 'cpu', capability: '12.0', vramTotalMB: 8151, vramFreeMB: 7000 },
      stt: engine({ model: sttModel }),
      tts: engine({ voices: [ttsVoice] }),
    });
  }
  if ((req.headers.authorization || '') !== `Bearer ${token}` || !token) return json(401, { error: 'unauthorized' });
  if (req.url === '/voices') return json(200, [{ id: ttsVoice, name: 'Heart', lang: 'en-us', gender: 'f' }]);
  return json(404, { error: 'not found' });
});

setTimeout(() => {
  server.listen(port, host, () => {
    listenedAt = Date.now();
    const actual = /** @type {any} */ (server.address()).port;
    if (!has('--fake-no-ready')) process.stdout.write(`${JSON.stringify({ event: 'ready', port: actual })}\n`);
    const crashAfter = opt('--fake-crash-after');
    if (crashAfter) {
      setTimeout(() => {
        process.stderr.write('fake-voice: simulated crash\n');
        process.exit(9);
      }, Number(crashAfter));
    }
  });
}, Number(opt('--fake-ready-delay', '0')));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
