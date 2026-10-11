// Which addresses the app may talk to for the camera (contract §2.2). Pure Node.
//
// The camera password travels (as a digest) to whatever host the user typed, so a typo or a
// public name must never send it across the internet: only home-network addresses are allowed.
//   * IPv4: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local), 100.64/10 (CGNAT, some mesh
//     routers hand these out); IPv6: unique local fc00::/7.
//   * names ending in .local, .lan, .home.arpa or .internal, or a single label ("tapo-c211").
//   * loopback only for the simulator/e2e (LAWNMOWER_TAPO_ALLOW_LOOPBACK=1, resolveLanHost's
//     allowLoopback). The settings accept loopback syntax so that a test settings file loads.
// A name is resolved once per connection and the RESOLVED address must be on the LAN too; the
// caller then connects to that IP (pinned), which defeats DNS rebinding.

import dns from 'node:dns';
import net from 'node:net';

const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** @param {string} ip @returns {number[]|null} */
function ipv4Octets(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/**
 * Expand an IPv6 literal into its 8 groups (no zone ids). @param {string} ip
 * @returns {number[]|null}
 */
function ipv6Groups(ip) {
  if (!net.isIPv6(ip) || ip.includes('%')) return null;
  let s = ip;
  // an embedded IPv4 tail (::ffff:192.168.1.5)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** @param {string} ip */
export function isLoopbackIp(ip) {
  const o = ipv4Octets(ip);
  if (o) return o[0] === 127;
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isLoopbackIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return false;
}

/**
 * Is `ip` (a literal) an address on a home network?
 * @param {string} ip @param {{ allowLoopback?: boolean }} [o]
 */
export function isLanIp(ip, o = {}) {
  if (isLoopbackIp(ip)) return !!o.allowLoopback;
  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isLanIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, o);
  }
  return (g[0] & 0xfe00) === 0xfc00; // fc00::/7 unique local
}

/** A name that can only mean the home network. @param {string} name lowercase */
function isLanName(name) {
  if (name === 'localhost') return false;
  const labels = name.split('.');
  if (!labels.every((l) => LABEL.test(l))) return false;
  if (labels.length === 1) return !/^\d+$/.test(name) && !['local', 'lan', 'internal', 'arpa', 'home'].includes(name);
  return LAN_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
}

/**
 * Settings validator for tapo.host (syntax only, no lookup): '' or a LAN IP literal (loopback
 * literals pass here; resolveLanHost decides), or a LAN-style name. Never a URL, port or path.
 * Same result shape as the leaf validators in electron/settings.js.
 * @param {unknown} v
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function validateHostSetting(v) {
  if (typeof v !== 'string') return { ok: false, reason: 'expected a string' };
  let s = v.trim();
  if (s === '') return { ok: true, value: '' };
  if (s.length > 253) return { ok: false, reason: 'is too long for a host name' };
  if (/[\s/\\@?#]/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { ok: false, reason: 'must be an IP address or a name, not a link' };
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (net.isIP(s)) {
    if (s.includes('%')) return { ok: false, reason: 'link-local IPv6 addresses are not supported; use the IPv4 address' };
    return isLanIp(s, { allowLoopback: true }) ? { ok: true, value: s.toLowerCase() } : { ok: false, reason: 'is not an address on your home network' };
  }
  if (/^\d+(\.\d+)*$/.test(s)) return { ok: false, reason: 'is not a valid IP address' };
  if (/:\d+$/.test(s)) return { ok: false, reason: 'must not include a port (set the ports separately)' };
  const name = s.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost') return { ok: true, value: name };
  return isLanName(name) ? { ok: true, value: name } : { ok: false, reason: 'is not a name on your home network (use the camera\'s IP address)' };
}

export class HostError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'HostError';
  }
}

/**
 * Resolve the configured host to the IP to connect to. Throws HostError with a user-facing
 * sentence when it is not a home-network address.
 * @param {string} host
 * @param {{ allowLoopback?: boolean, lookup?: (name: string, o: { all: true }) => Promise<Array<{ address: string, family: number }>> }} [o]
 * @returns {Promise<{ ip: string, family: 4|6 }>}
 */
export async function resolveLanHost(host, o = {}) {
  const allowLoopback = !!o.allowLoopback;
  const v = validateHostSetting(host);
  const notLan = new HostError(`${String(host || '').trim() || 'The camera address'} is not an address on your home network.`);
  if (!v.ok || !v.value) throw v.ok ? new HostError('No camera address is set.') : notLan;
  const h = v.value;
  if (net.isIP(h)) {
    if (!isLanIp(h, { allowLoopback })) throw notLan;
    return { ip: h, family: /** @type {4|6} */ (net.isIP(h)) };
  }
  if (h === 'localhost' && !allowLoopback) throw notLan;
  const lookup = o.lookup || ((name, opts) => dns.promises.lookup(name, opts));
  let addrs;
  try {
    addrs = await lookup(h, { all: true });
  } catch (err) {
    throw new HostError(`The name ${h} could not be found on your network (${/** @type {any} */ (err).code || /** @type {Error} */ (err).message}). Use the camera's IP address.`);
  }
  const pick = (addrs || []).find((a) => isLanIp(a.address, { allowLoopback }));
  if (!pick) throw new HostError(`${h} does not point to an address on your home network.`);
  return { ip: pick.address, family: /** @type {4|6} */ (net.isIPv6(pick.address) ? 6 : 4) };
}

/** host[:port] for a URL (IPv6 in brackets). @param {string} ip @param {number} port */
export function hostPort(ip, port) {
  return `${net.isIPv6(ip) ? `[${ip}]` : ip}:${port}`;
}
