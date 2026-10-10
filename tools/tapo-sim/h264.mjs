// H.264 Annex B helpers for the simulator: NAL unit splitting, frames by access unit delimiter,
// parameter sets for the SDP, and RTP payloads (RFC 6184: single NAL unit packets, FU-A above the
// MTU). Pure functions; the fixtures are plain Annex B byte streams.

export const NAL = Object.freeze({ SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, FU_A: 28 });

/** @param {Buffer} nal */
export function nalType(nal) {
  return nal[0] & 0x1f;
}

/**
 * Split an Annex B stream into NAL units (start codes removed; 3- and 4-byte start codes).
 * @param {Buffer} data @returns {Buffer[]}
 */
export function splitAnnexB(data) {
  /** @type {number[]} */
  const starts = []; // index of the first byte after each start code
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length;
    // a 4-byte start code (00 00 00 01) leaves one zero byte before the next 3-byte code
    while (end > starts[k] && data[end - 1] === 0) end--;
    if (end > starts[k]) out.push(data.subarray(starts[k], end));
  }
  return out;
}

/**
 * Group NAL units into frames: a new access unit starts at every AUD (type 9). The AUD stays the
 * first NAL of its frame. NAL units before the first AUD form a frame of their own.
 * @param {Buffer[]} nals @returns {Buffer[][]}
 */
export function accessUnits(nals) {
  /** @type {Buffer[][]} */
  const out = [];
  /** @type {Buffer[]} */
  let cur = [];
  for (const n of nals) {
    if (nalType(n) === NAL.AUD && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** @param {Buffer[]} au */
export function isKeyFrame(au) {
  return au.some((n) => nalType(n) === NAL.IDR);
}

/**
 * The SPS and PPS of an access unit (the first IDR of a fixture carries both).
 * @param {Buffer[]} au @returns {{ sps: Buffer, pps: Buffer }}
 */
export function parameterSets(au) {
  const sps = au.find((n) => nalType(n) === NAL.SPS);
  const pps = au.find((n) => nalType(n) === NAL.PPS);
  if (!sps || !pps) throw new Error('access unit without SPS/PPS');
  return { sps, pps };
}

/** SDP `profile-level-id` (profile_idc, constraint flags, level_idc as hex). @param {Buffer} sps */
export function profileLevelId(sps) {
  return sps.subarray(1, 4).toString('hex').toUpperCase();
}

/** SDP `sprop-parameter-sets`. @param {{ sps: Buffer, pps: Buffer }} ps */
export function spropParameterSets(ps) {
  return `${ps.sps.toString('base64')},${ps.pps.toString('base64')}`;
}

/**
 * RTP payloads for one NAL unit: the NAL itself when it fits, else FU-A fragments (RFC 6184 §5.8).
 * @param {Buffer} nal @param {number} [mtu] largest payload
 * @returns {Buffer[]}
 */
export function rtpPayloads(nal, mtu = 1400) {
  if (nal.length <= mtu) return [nal];
  const header = nal[0];
  const indicator = (header & 0xe0) | NAL.FU_A; // F + NRI of the original, type 28
  const type = header & 0x1f;
  const out = [];
  const body = nal.subarray(1);
  const chunk = mtu - 2;
  for (let off = 0; off < body.length; off += chunk) {
    const start = off === 0;
    const end = off + chunk >= body.length;
    const fu = (start ? 0x80 : 0) | (end ? 0x40 : 0) | type;
    out.push(Buffer.concat([Buffer.from([indicator, fu]), body.subarray(off, off + chunk)]));
  }
  return out;
}

/**
 * One RTP packet (RFC 3550 fixed header, no CSRC, no extension).
 * @param {{ payloadType: number, seq: number, timestamp: number, ssrc: number, marker: boolean, payload: Buffer }} p
 */
export function rtpPacket(p) {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
  h.writeUInt16BE(p.seq & 0xffff, 2);
  h.writeUInt32BE(p.timestamp >>> 0, 4);
  h.writeUInt32BE(p.ssrc >>> 0, 8);
  return Buffer.concat([h, p.payload]);
}

/**
 * Reassemble NAL units from RTP payloads (single NAL + FU-A): the inverse of rtpPayloads, used
 * by the self-tests to check what goes over the wire.
 * @param {Buffer[]} payloads @returns {Buffer[]}
 */
export function depacketize(payloads) {
  const out = [];
  /** @type {Buffer[]|null} */
  let fu = null;
  for (const p of payloads) {
    const type = p[0] & 0x1f;
    if (type !== NAL.FU_A) {
      out.push(p);
      continue;
    }
    const s = p[1] & 0x80;
    const e = p[1] & 0x40;
    if (s) fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)])];
    if (fu) fu.push(p.subarray(2));
    if (e && fu) {
      out.push(Buffer.concat(fu));
      fu = null;
    }
  }
  return out;
}
