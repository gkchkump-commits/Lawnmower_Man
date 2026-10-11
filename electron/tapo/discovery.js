// "Find cameras": one WS-Discovery Probe for ONVIF NetworkVideoTransmitters (contract §8.10).
// Pure Node (dgram).
//
// A multicast Probe to 239.255.255.250:3702 from a udp4 socket; replies come back unicast
// (Windows Firewall accepts those for 3 s after an outgoing multicast). Only LAN hosts are
// returned, deduplicated. Typing the IP stays the primary way: multicast does not cross guest
// Wi-Fi, VLANs or AP isolation.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

import { isLanIp } from './host.js';
import { findAll, parseXml, textOf } from './xml.js';

export const WS_DISCOVERY = Object.freeze({ address: '239.255.255.250', port: 3702 });

/** @param {string} [uuid] */
export function probeMessage(uuid = crypto.randomUUID()) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
    + ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
    + `<e:Header><w:MessageID>uuid:${uuid}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>`
    + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
    + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
}

/**
 * The ProbeMatches of one reply: XAddrs and the name/hardware scopes.
 * @param {string} text
 * @returns {Array<{ xaddrs: string[], name?: string, hardware?: string }>}
 */
export function parseProbeMatches(text) {
  let doc;
  try {
    doc = parseXml(text, { maxBytes: 65536 });
  } catch {
    return [];
  }
  return findAll(doc, 'ProbeMatch').map((m) => {
    const xaddrs = (textOf(m, 'XAddrs') || '').split(/\s+/).filter(Boolean);
    const scopes = (textOf(m, 'Scopes') || '').split(/\s+/).filter(Boolean);
    const scope = (/** @type {string} */ k) => {
      const s = scopes.find((x) => x.toLowerCase().startsWith(`onvif://www.onvif.org/${k}/`));
      if (!s) return undefined;
      try {
        return decodeURIComponent(s.slice(`onvif://www.onvif.org/${k}/`.length)).slice(0, 64);
      } catch {
        return undefined;
      }
    };
    /** @type {{ xaddrs: string[], name?: string, hardware?: string }} */
    const out = { xaddrs };
    const name = scope('name');
    const hardware = scope('hardware');
    if (name) out.name = name;
    if (hardware) out.hardware = hardware;
    return out;
  }).filter((m) => m.xaddrs.length > 0);
}

/** At most this many cameras are listed. */
export const MAX_FOUND = 16;

/**
 * @param {{ timeoutMs?: number, createSocket?: typeof dgram.createSocket, target?: { address: string, port: number }, allowLoopback?: boolean,
 *   log?: (level: string, msg: string) => void }} [o]
 * @returns {Promise<Array<{ host: string, xaddr: string, name?: string, model?: string, hardware?: string }>>}
 */
export function discover(o = {}) {
  const timeoutMs = Math.min(3500, o.timeoutMs ?? 3000);
  const target = o.target || WS_DISCOVERY;
  const log = o.log || (() => {});
  return new Promise((resolve) => {
    /** @type {Map<string, { host: string, xaddr: string, name?: string, model?: string, hardware?: string }>} */
    const found = new Map();
    let sock;
    try {
      sock = (o.createSocket || dgram.createSocket)({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      log('info', `[tapo] discovery unavailable: ${/** @type {Error} */ (err).message}`);
      resolve([]);
      return;
    }
    const finish = () => {
      try { sock.close(); } catch { /* closed */ }
      resolve([...found.values()]);
    };
    sock.on('error', (err) => {
      log('info', `[tapo] discovery: ${err.message}`);
      clearTimeout(timer);
      finish();
    });
    sock.on('message', (msg, rinfo) => {
      for (const m of parseProbeMatches(msg.toString('utf8'))) {
        for (const x of m.xaddrs) {
          let u;
          try {
            u = new URL(x);
          } catch {
            continue;
          }
          const host = u.hostname.replace(/^\[|\]$/g, '');
          // Only the device that answered: a reply naming another address (any LAN host can
          // send one, or spoof it) would point the sign-in at a device that is not the camera.
          // A name in the XAddr (not an IP) stands for the sender.
          const ip = net.isIP(host) ? host : rinfo.address;
          if (ip !== rinfo.address || !isLanIp(ip, { allowLoopback: o.allowLoopback }) || found.has(ip) || found.size >= MAX_FOUND) continue;
          found.set(ip, { host: ip, xaddr: x.slice(0, 200), ...(m.name ? { name: m.name } : {}), ...(m.hardware ? { hardware: m.hardware, model: m.hardware } : {}) });
        }
      }
    });
    const timer = setTimeout(finish, timeoutMs);
    sock.bind(0, () => {
      const payload = Buffer.from(probeMessage());
      sock.send(payload, target.port, target.address, (err) => {
        if (err) log('info', `[tapo] discovery send failed: ${err.message}`);
      });
    });
  });
}
