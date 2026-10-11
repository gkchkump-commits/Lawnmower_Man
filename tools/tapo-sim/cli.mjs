#!/usr/bin/env node
// node tools/tapo-sim [--onvif-port N] [--rtsp-port N] [--control-port N] [--user U] [--pass P]
//                     [--quirks tapo|ideal] [--host 127.0.0.1] [--verbose]
// Prints {"event":"ready","onvif":N,"rtsp":N,"control":N} on stdout once listening; Ctrl+C stops.
// `npm run sim:tapo` uses the fixed ports 12020 / 10554 / 12021 (see README.md).
import { startSim } from './index.mjs';

const argv = process.argv.slice(2);
/** @param {string} name @param {string} [def] */
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
/** @param {string} name @param {number|null} def */
const port = (name, def) => {
  const v = opt(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`${name}: not a port: ${v}`);
    process.exit(2);
  }
  return n;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('node tools/tapo-sim [--onvif-port N] [--rtsp-port N] [--control-port N] [--user U] [--pass P] [--quirks tapo|ideal] [--host H] [--verbose]');
  process.exit(0);
}
const verbose = argv.includes('--verbose');
const quirks = opt('--quirks', 'tapo');
if (quirks !== 'tapo' && quirks !== 'ideal') {
  console.error('--quirks must be tapo or ideal');
  process.exit(2);
}

const sim = await startSim({
  host: opt('--host', '127.0.0.1'),
  onvifPort: /** @type {number} */ (port('--onvif-port', 0)),
  rtspPort: /** @type {number} */ (port('--rtsp-port', 0)),
  controlPort: port('--control-port', 0),
  username: opt('--user', 'camacct'),
  password: opt('--pass', 'se&cret'),
  quirks,
  log: (level, msg) => {
    if (verbose || level === 'warn' || level === 'error') console.error(`${level} ${msg}`);
  },
});
process.stdout.write(`${JSON.stringify({ event: 'ready', onvif: sim.onvifPort, rtsp: sim.rtspPort, control: sim.controlPort })}\n`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await sim.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
