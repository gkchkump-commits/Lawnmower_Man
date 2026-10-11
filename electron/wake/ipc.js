// The wake word's IPC channels (contract-wake §6.1). The avatar window only (main.js's
// isTrustedSender(event, ['avatar'])); the Home camera window gets none of them. Every payload is
// validated (validate.js) and every handler returns plain JSON.
//
//   lm:wake:status        invoke  ()                 → WakeEngineStatus
//   lm:wake:request-port  invoke  ()                 → { ok, gen }  (+ lm:wake:port { gen } with the port)
//   lm:wake:state         send    ({ state, reason? })  the renderer's listening state → tray
//   lm:wake:mic-access    invoke  ()                 → 'granted'|'denied'|'restricted'|'not-determined'|'unknown'
//   lm:wake:open-mic-settings invoke ()              → { ok }
//   lm:wake:save-clip     invoke  ({ wav, hits })    → { ok, path?, error? }
//   lm:wake:download      invoke  ()                 → { ok, started }
//   lm:wake:restart       invoke  ()                 → { ok }  ("Retry" after the engine kept stopping)
//   main → avatar: lm:wake:status (on change, ≤ 4/s), lm:wake:port, lm:wake:power
// lm:window:show (show the avatar without focus) belongs to main.js (the orchestrator's wiring).

import { validateNoArgs, validateUiState } from './validate.js';

export const WAKE_CHANNELS = Object.freeze({
  invoke: Object.freeze(['lm:wake:status', 'lm:wake:request-port', 'lm:wake:mic-access', 'lm:wake:open-mic-settings', 'lm:wake:save-clip', 'lm:wake:download', 'lm:wake:restart']),
  send: Object.freeze(['lm:wake:state']),
  toAvatar: Object.freeze(['lm:wake:status', 'lm:wake:port', 'lm:wake:power']),
});

const AVATAR = /** @type {Array<'avatar'|'camera'>} */ (['avatar']);

/**
 * @param {{ ipcMain: any, isTrustedSender: (event: any, kinds: Array<'avatar'|'camera'>) => void,
 *   service: { status: () => any, requestPort: (sender: any) => any, reportState: (st: { state: string, reason: string }) => void,
 *     micAccess: () => string, openMicSettings: () => Promise<{ ok: boolean }>, saveClip: (payload: unknown) => Promise<any>, download: () => any,
 *     restart?: () => any },
 *   log?: (level: string, msg: string) => void }} o
 * @returns {() => void} unregister
 */
export function registerWakeIpc(o) {
  const { ipcMain, isTrustedSender, service } = o;
  const log = o.log || (() => {});
  /** @param {string} channel @param {(event: any, ...args: any[]) => any} fn */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (/** @type {any} */ event, /** @type {any[]} */ ...args) => {
      isTrustedSender(event, AVATAR);
      return fn(event, ...args);
    });
  };
  handle('lm:wake:status', (_e, ...a) => {
    validateNoArgs(a);
    return service.status();
  });
  handle('lm:wake:request-port', (e, ...a) => {
    validateNoArgs(a);
    return service.requestPort(e.sender);
  });
  handle('lm:wake:mic-access', (_e, ...a) => {
    validateNoArgs(a);
    return service.micAccess();
  });
  handle('lm:wake:open-mic-settings', (_e, ...a) => {
    validateNoArgs(a);
    return service.openMicSettings();
  });
  handle('lm:wake:save-clip', (_e, p, ...rest) => {
    validateNoArgs(rest);
    return service.saveClip(p);
  });
  handle('lm:wake:download', (_e, ...a) => {
    validateNoArgs(a);
    return service.download();
  });
  handle('lm:wake:restart', (_e, ...a) => {
    validateNoArgs(a);
    return service.restart ? service.restart() : { ok: false };
  });
  /** @param {any} event @param {any} payload */
  const onState = (event, payload) => {
    try {
      isTrustedSender(event, AVATAR);
      service.reportState(validateUiState(payload));
    } catch (err) {
      log('warn', `[ipc] lm:wake:state: ${/** @type {Error} */ (err).message}`);
    }
  };
  ipcMain.on('lm:wake:state', onState);
  return () => {
    for (const ch of WAKE_CHANNELS.invoke) ipcMain.removeHandler(ch);
    ipcMain.removeListener('lm:wake:state', onState);
  };
}
