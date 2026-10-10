// Checks for the camera setup form (pure). Main validates everything again (electron/tapo/
// validate.js, electron/settings.js) and has the final word, e.g. on whether an address is on
// the home network after resolving it; these only catch typing mistakes early, in words.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const NAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.(?!-)[A-Za-z0-9-]{1,63})*\.?$/;

/** @param {number[]} p */
function privateIpv4(p) {
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 127;
}

/**
 * The camera's address: an IP address or a name on the home network, never a web link.
 * @param {string} v
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function checkHost(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: false, error: 'Enter the camera’s address, for example 192.168.1.50.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /[/\\?#@]/.test(s)) return { ok: false, error: 'Enter only the address, like 192.168.1.50 — not a web link.' };
  if (/\s/.test(s)) return { ok: false, error: 'The address cannot contain spaces.' };
  if (/:\d+$/.test(s) && !s.includes('::')) return { ok: false, error: 'Leave the port out here; ports are under Advanced.' };
  const m = IPV4.exec(s);
  if (m) {
    const parts = m.slice(1).map(Number);
    if (parts.some((x) => x > 255)) return { ok: false, error: 'That is not a valid IP address.' };
    if (!privateIpv4(parts)) return { ok: false, error: 'That address is on the internet, not on your home network. The camera’s address usually starts with 192.168.' };
    return { ok: true, value: s };
  }
  if (/^[\da-f:]+$/i.test(s) && s.includes(':')) {
    if (!/^f[cd]/i.test(s)) return { ok: false, error: 'Only home-network (fd…) IPv6 addresses work. An IPv4 address like 192.168.1.50 is easier.' };
    return { ok: true, value: s };
  }
  if (!NAME.test(s) || /^\d+(\.\d+)*$/.test(s)) return { ok: false, error: 'That is not a valid address.' };
  const lower = s.toLowerCase().replace(/\.$/, '');
  const lan = !lower.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(lower) || lower === 'localhost';
  if (!lan) return { ok: false, error: 'Use the camera’s IP address (or a name ending in .local or .lan). Internet names are not allowed.' };
  return { ok: true, value: s };
}

/** @param {string} v */
export function checkUsername(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: false, error: 'Enter the Camera Account user name from the Tapo app.' };
  if (/\s/.test(s)) return { ok: false, error: 'The user name cannot contain spaces.' };
  if (s.length > 64) return { ok: false, error: 'That user name is too long.' };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: 'The user name contains characters that are not allowed.' };
  return { ok: true, value: s };
}

/**
 * The Camera Account password (6–32 characters in the Tapo app; anything 1..128 is passed on).
 * @param {string} v
 * @returns {{ ok: true, value: string, warning?: string } | { ok: false, error: string }}
 */
export function checkPassword(v) {
  const s = String(v ?? '');
  if (!s) return { ok: false, error: 'Enter the Camera Account password.' };
  if (s.length > 128) return { ok: false, error: 'That password is too long.' };
  if (/[\0\r\n]/.test(s)) return { ok: false, error: 'The password cannot contain line breaks.' };
  if (s.length < 6 || s.length > 32) return { ok: true, value: s, warning: 'Tapo Camera Account passwords are 6 to 32 characters. Check that this is the right one.' };
  return { ok: true, value: s };
}

/** @param {unknown} v */
export function checkPort(v) {
  const n = Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: 'A port is a whole number from 1 to 65535.' };
  return { ok: true, value: n };
}

/** 'HH:MM-HH:MM' or '' @param {string} v */
export function checkQuietHours(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, value: '' };
  const m = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return { ok: false, error: 'Write it like 23:00-07:00, or leave it empty.' };
  return { ok: true, value: `${m[1]}:${m[2]}-${m[3]}:${m[4]}` };
}
