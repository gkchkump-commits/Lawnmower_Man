// Can desktop apps use the microphone? (contract-wake §6.1, §8.3 T17). On Windows a privacy block
// most likely surfaces in Chromium as NotReadableError, which reads like "in use"; the renderer
// asks here to tell the two apart and offers "Open Windows microphone settings".

export const MIC_ACCESS = Object.freeze(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);

/**
 * @param {{ getMediaAccessStatus?: (type: string) => string }|null|undefined} systemPreferences
 * @param {string} [platform]
 * @returns {'granted'|'denied'|'restricted'|'not-determined'|'unknown'}
 */
export function micAccessStatus(systemPreferences, platform = process.platform) {
  if (platform !== 'win32' && platform !== 'darwin') return 'unknown';
  try {
    const s = systemPreferences?.getMediaAccessStatus?.('microphone');
    return /** @type {any} */ (MIC_ACCESS.includes(String(s)) ? s : 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * "Open Windows microphone settings" (Settings › Privacy & security › Microphone).
 * @param {{ openExternal: (url: string) => Promise<void> }} shell @param {string} [platform]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function openMicSettings(shell, platform = process.platform) {
  if (platform !== 'win32') return { ok: false };
  try {
    await shell.openExternal('ms-settings:privacy-microphone');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
