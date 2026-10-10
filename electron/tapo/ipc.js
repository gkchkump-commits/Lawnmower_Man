// The home camera's IPC channels (contract §6.1). Every handler checks the sender (the avatar
// window and/or the camera window, decided by main.js's isTrustedSender), validates its payload
// (validate.js) and returns plain JSON; errors are thrown as short, user-presentable messages.

import {
  validateArmPayload, validateCalibratePayload, validateCredentialsPayload, validateEventIdPayload, validateEventsQuery,
  validatePresetSave, validatePresetsQuery, validatePtzCommand, validateTestOverride, validateTokenPayload, validateViewPayload,
  validateWindowPayload,
} from './validate.js';

/** @typedef {'avatar'|'camera'} SenderKind */

const BOTH = /** @type {SenderKind[]} */ (['avatar', 'camera']);
const CAMERA = /** @type {SenderKind[]} */ (['camera']);
const AVATAR = /** @type {SenderKind[]} */ (['avatar']);

/** Channel → who may call it (documentation and tests). */
export const TAPO_CHANNELS = Object.freeze({
  'lm:tapo:status': BOTH,
  'lm:tapo:set-credentials': CAMERA,
  'lm:tapo:clear-credentials': CAMERA,
  'lm:tapo:test': CAMERA,
  'lm:tapo:discover': CAMERA,
  'lm:tapo:ptz': BOTH,
  'lm:tapo:presets': BOTH,
  'lm:tapo:preset-save': CAMERA,
  'lm:tapo:preset-remove': CAMERA,
  'lm:tapo:arm': BOTH,
  'lm:tapo:calibrate': CAMERA,
  'lm:tapo:events-list': BOTH,
  'lm:tapo:event-remove': CAMERA,
  'lm:tapo:event-ack': CAMERA,
  'lm:tapo:open-clips': BOTH,
  'lm:tapo:window': AVATAR,
  'lm:tapo:request-port': CAMERA,
  'lm:tapo:view': CAMERA, // ipcRenderer.send
});

/** @param {unknown[]} args */
function noArgs(args) {
  if (args.length > 0 && !(args.length === 1 && args[0] === undefined)) throw new Error('This call takes no arguments');
}

/**
 * @param {{ ipcMain: any, isTrustedSender: (event: any, kinds: SenderKind[]) => void, service: import('./tapo-service.js').TapoService,
 *   onWindow: (req: { show: boolean, eventId?: string }) => void, log?: (level: string, msg: string) => void }} o
 * @returns {() => void} unregister
 */
export function registerTapoIpc(o) {
  const { ipcMain, isTrustedSender, service } = o;
  const log = o.log || (() => {});
  /** @type {string[]} */
  const handled = [];
  /** @param {string} channel @param {(event: any, ...args: any[]) => any} fn */
  const handle = (channel, fn) => {
    const kinds = /** @type {any} */ (TAPO_CHANNELS)[channel];
    ipcMain.handle(channel, async (/** @type {any} */ event, /** @type {any[]} */ ...args) => {
      isTrustedSender(event, kinds);
      return fn(event, ...args);
    });
    handled.push(channel);
  };

  handle('lm:tapo:status', (_e, ...a) => {
    noArgs(a);
    return service.status();
  });
  handle('lm:tapo:set-credentials', (_e, p) => service.setCredentials(validateCredentialsPayload(p)));
  handle('lm:tapo:clear-credentials', (_e, ...a) => {
    noArgs(a);
    return service.clearCredentials();
  });
  handle('lm:tapo:test', (_e, p) => service.test(validateTestOverride(p)));
  handle('lm:tapo:discover', (_e, ...a) => {
    noArgs(a);
    return service.discover();
  });
  handle('lm:tapo:ptz', (_e, p) => service.ptz(validatePtzCommand(p)));
  handle('lm:tapo:presets', (_e, p) => service.presets(validatePresetsQuery(p)));
  handle('lm:tapo:preset-save', (_e, p) => service.savePreset(validatePresetSave(p)));
  handle('lm:tapo:preset-remove', (_e, p) => service.removePreset(validateTokenPayload(p)));
  handle('lm:tapo:arm', (_e, p) => service.arm(validateArmPayload(p)));
  handle('lm:tapo:calibrate', (_e, p) => service.calibrate(validateCalibratePayload(p)));
  handle('lm:tapo:events-list', (_e, p) => service.listEvents(validateEventsQuery(p)));
  handle('lm:tapo:event-remove', (_e, p) => service.removeEvent(validateEventIdPayload(p).id));
  handle('lm:tapo:event-ack', (_e, p) => service.ackEvent(validateEventIdPayload(p).id));
  handle('lm:tapo:open-clips', (_e, ...a) => {
    noArgs(a);
    return service.openClips();
  });
  handle('lm:tapo:window', (_e, p) => {
    o.onWindow(validateWindowPayload(p));
    return { ok: true };
  });
  handle('lm:tapo:request-port', (e, ...a) => {
    noArgs(a);
    return { ok: service.attachWorker(e.sender) };
  });

  /** @param {any} event @param {any} payload */
  const onView = (event, payload) => {
    try {
      isTrustedSender(event, CAMERA);
      service.setViewVisible(validateViewPayload(payload).visible);
    } catch (err) {
      log('warn', `[ipc] lm:tapo:view: ${/** @type {Error} */ (err).message}`);
    }
  };
  ipcMain.on('lm:tapo:view', onView);

  return () => {
    for (const ch of handled) ipcMain.removeHandler(ch);
    ipcMain.removeListener('lm:tapo:view', onView);
  };
}
