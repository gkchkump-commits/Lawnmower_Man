// Tapo C211 camera simulator (contract §11): an ONVIF SOAP server with PTZ, PullPoint events
// and the Tapo quirk switches, an RTSP server streaming pre-encoded H.264 that follows the
// virtual pan/tilt position, and a loopback control API. Test-only; binds loopback by default.
//
//   import { startSim } from './tools/tapo-sim/index.mjs';
//   const sim = await startSim();            // random ports
//   sim.set({ person: true });               // scenario
//   sim.set({ quirks: { stopIgnoredOnPan: true } });
//   sim.state.ptz; sim.calls; await sim.close();
//
// CLI: node tools/tapo-sim [--onvif-port N] [--rtsp-port N] [--control-port N] [--user U] [--pass P] [--quirks tapo|ideal]
// See tools/tapo-sim/README.md.

import { SimCamera, QUIRK_PRESETS, DEFAULT_SCENARIO, DEVICE } from './camera.mjs';
import { startOnvifServer } from './onvif-server.mjs';
import { startRtspServer } from './rtsp-server.mjs';
import { startControlServer } from './control.mjs';
import { DEFAULT_FIXTURES, loadFixtures } from './fixtures.mjs';
import { SIM_TRUTH } from './geometry.mjs';

export { QUIRK_PRESETS, DEFAULT_SCENARIO, DEVICE, SIM_TRUTH };

/**
 * @typedef {object} SimOptions
 * @property {string} [username]   Camera Account user (default 'camacct')
 * @property {string} [password]   its password (default 'se&cret': exercises escaping and percent-encoding)
 * @property {string} [host]       bind address (default 127.0.0.1)
 * @property {number} [onvifPort]  0 = random
 * @property {number} [rtspPort]   0 = random
 * @property {number|null} [controlPort]  null = no control server, 0 = random
 * @property {'tapo'|'ideal'|Record<string, any>} [quirks]  preset name, or overrides of the tapo preset
 * @property {string} [fixtures]   directory with manifest.json (default tests/fixtures/tapo/sim)
 * @property {(level: string, msg: string) => void} [log]
 */

/**
 * Start the simulator.
 * @param {SimOptions} [opts]
 */
export async function startSim(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const fixtures = loadFixtures(opts.fixtures || DEFAULT_FIXTURES);
  const camera = new SimCamera({
    username: opts.username ?? 'camacct',
    password: opts.password ?? 'se&cret',
    quirks: opts.quirks ?? 'tapo',
    log: opts.log,
  });
  /** @type {Awaited<ReturnType<typeof startRtspServer>>|null} */
  let rtsp = null;
  /** @type {Awaited<ReturnType<typeof startOnvifServer>>|null} */
  let onvif = null;
  /** @type {Awaited<ReturnType<typeof startControlServer>>|null} */
  let control = null;
  try {
    rtsp = await startRtspServer({ camera, host, port: opts.rtspPort ?? 0, fixtures });
    const rtspPort = rtsp.port;
    onvif = await startOnvifServer({ camera, host, port: opts.onvifPort ?? 0, getRtspPort: () => rtspPort });

    const state = () => ({
      device: { ...DEVICE },
      ptz: camera.ptz.snapshot(),
      presets: camera.presets.map((p) => ({ ...p })),
      scenario: { ...camera.scenario },
      quirks: { ...camera.quirks },
      subscriptions: camera.events.snapshot(),
      rtspSessions: /** @type {NonNullable<typeof rtsp>} */ (rtsp).snapshot(),
      authFailures: { ...camera.authFailures },
      bootCount: camera.bootCount,
      calls: camera.calls.slice(-1000),
    });
    /** @param {Record<string, any>} patch */
    const set = (patch) => {
      const { quirks, ptz, ...scenario } = patch || {};
      if (quirks) camera.setQuirks(quirks);
      if (ptz) camera.ptz.place(Number(ptz.x) || 0, Number(ptz.y) || 0);
      if (Object.keys(scenario).length) camera.setScenario(scenario);
    };
    if (opts.controlPort !== null && opts.controlPort !== undefined) {
      control = await startControlServer({
        host, port: opts.controlPort, getState: state, set, reset: () => camera.reset(), place: (x, y) => camera.ptz.place(x, y),
      });
    }
    const servers = { rtsp, onvif, control };
    return {
      onvifPort: onvif.port,
      rtspPort,
      controlPort: control ? control.port : null,
      host,
      username: camera.username,
      password: camera.password,
      camera,
      /** Snapshot of everything (same as GET /state). */
      get state() {
        return state();
      },
      set,
      reset: () => camera.reset(),
      /** The live quirk switches (assign through set({ quirks }) so side effects run). */
      get quirks() {
        return camera.quirks;
      },
      /** The live request log: { t, service, op, args, status, why? }. */
      get calls() {
        return camera.calls;
      },
      /** Requests of one operation (e.g. 'RelativeMove'), optionally after a time. @param {string} op @param {number} [since] */
      callsOf: (op, since = 0) => camera.calls.filter((c) => c.op === op && c.t >= since),
      close: async () => {
        camera.stop();
        await Promise.allSettled([servers.control?.close(), servers.onvif.close(), servers.rtsp.close()]);
      },
    };
  } catch (err) {
    camera.stop();
    await Promise.allSettled([control?.close(), onvif?.close(), rtsp?.close()]);
    throw err;
  }
}
