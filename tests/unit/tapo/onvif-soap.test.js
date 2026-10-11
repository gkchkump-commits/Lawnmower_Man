import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import {
  ACTIONS, BODIES, NS, OnvifError, PASSWORD_DIGEST, envelope, escapeXml, formatNumber, isBenignPullError,
  parseFault, parseSoapResponse, passwordDigest, postSoap, transportError, wsseHeader,
} from '../../../electron/tapo/onvif-soap.js';
import { parseXml } from '../../../electron/tapo/xml.js';

const NONCE = Buffer.from([...Array(16).keys()]);
const CREATED = '2026-10-10T12:00:00.000Z';

describe('WS-Security', () => {
  it('computes the contract test vector', () => {
    expect(NONCE.toString('base64')).toBe('AAECAwQFBgcICQoLDA0ODw==');
    expect(passwordDigest(NONCE, CREATED, 'se&cret')).toBe('dHOmgGxSGDXchosYzIsHN03/CiI=');
  });

  it('builds the exact UsernameToken header and escapes the user name', () => {
    const h = wsseHeader({ username: 'a&b', password: 'se&cret', createdIso: CREATED, nonce: NONCE });
    expect(h).toBe(`<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"><wsse:UsernameToken>`
      + '<wsse:Username>a&amp;b</wsse:Username>'
      + `<wsse:Password Type="${PASSWORD_DIGEST}">dHOmgGxSGDXchosYzIsHN03/CiI=</wsse:Password>`
      + '<wsse:Nonce>AAECAwQFBgcICQoLDA0ODw==</wsse:Nonce>'
      + `<wsu:Created>${CREATED}</wsu:Created></wsse:UsernameToken></wsse:Security>`);
    expect(h).not.toContain('se&cret');
  });
});

describe('formatting', () => {
  it('formatNumber never writes an exponent or -0', () => {
    expect(formatNumber(1e-7)).toBe('0');
    expect(formatNumber(-1e-7)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(0.25)).toBe('0.25');
    expect(formatNumber(-0.123456789)).toBe('-0.123457');
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(-1)).toBe('-1');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(600)).toBe('600');
    expect(() => formatNumber(NaN)).toThrow();
    expect(() => formatNumber(Infinity)).toThrow();
    for (const v of [1e-9, 3.14159265, -2.5e-5, 123.0000001]) expect(formatNumber(v)).not.toMatch(/e/i);
  });

  it('escapeXml escapes all five characters', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });
});

describe('envelopes (golden strings)', () => {
  const head = '<?xml version="1.0" encoding="UTF-8"?>'
    + `<s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tptz="${NS.tptz}" xmlns:tev="${NS.tev}" xmlns:tt="${NS.tt}" xmlns:wsnt="${NS.wsnt}" xmlns:wsa="${NS.wsa}">`;

  it('wraps a body with and without a header', () => {
    expect(envelope('<tds:GetSystemDateAndTime/>')).toBe(`${head}<s:Body><tds:GetSystemDateAndTime/></s:Body></s:Envelope>`);
    const sec = wsseHeader({ username: 'u', password: 'p', createdIso: CREATED, nonce: NONCE });
    expect(envelope('<wsnt:Renew/>', { security: sec, action: ACTIONS.renew, to: 'http://192.168.1.50:2020/event-0_2020' }))
      .toBe(`${head}<s:Header>${sec}<wsa:Action>${ACTIONS.renew}</wsa:Action><wsa:To>http://192.168.1.50:2020/event-0_2020</wsa:To></s:Header><s:Body><wsnt:Renew/></s:Body></s:Envelope>`);
    // well-formed for our own parser too
    expect(parseXml(envelope(BODIES.relativeMove('p&1', 0.25, -0.1), { security: sec })).name).toBe('Envelope');
  });

  it('every body of §8.3', () => {
    const T = 'profile_1';
    expect(BODIES.getSystemDateAndTime()).toBe('<tds:GetSystemDateAndTime/>');
    expect(BODIES.getDeviceInformation()).toBe('<tds:GetDeviceInformation/>');
    expect(BODIES.getCapabilities()).toBe('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    expect(BODIES.getServices()).toBe('<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>');
    expect(BODIES.getProfiles()).toBe('<trt:GetProfiles/>');
    expect(BODIES.getStreamUri(T)).toBe('<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>profile_1</trt:ProfileToken></trt:GetStreamUri>');
    expect(BODIES.getNodes()).toBe('<tptz:GetNodes/>');
    expect(BODIES.getConfigurationOptions('PTZConfiguration_1')).toBe('<tptz:GetConfigurationOptions><tptz:ConfigurationToken>PTZConfiguration_1</tptz:ConfigurationToken></tptz:GetConfigurationOptions>');
    expect(BODIES.getStatus(T)).toBe('<tptz:GetStatus><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetStatus>');
    expect(BODIES.relativeMove(T, 0.25, 0)).toBe('<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:Translation><tt:PanTilt x="0.25" y="0"/></tptz:Translation><tptz:Speed><tt:PanTilt x="1" y="1"/></tptz:Speed></tptz:RelativeMove>');
    expect(BODIES.continuousMove(T, 0.5, 0, 1)).toBe('<tptz:ContinuousMove><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="0.5" y="0"/></tptz:Velocity><tptz:Timeout>PT1S</tptz:Timeout></tptz:ContinuousMove>');
    expect(BODIES.stop(T)).toBe('<tptz:Stop><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop>');
    expect(BODIES.stopMinimal(T)).toBe('<tptz:Stop><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:Stop>');
    expect(BODIES.absoluteMove(T, 0, 0)).toBe('<tptz:AbsoluteMove><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:Position><tt:PanTilt x="0" y="0"/></tptz:Position><tptz:Speed><tt:PanTilt x="1" y="1"/></tptz:Speed></tptz:AbsoluteMove>');
    expect(BODIES.getPresets(T)).toBe('<tptz:GetPresets><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetPresets>');
    expect(BODIES.gotoPreset(T, '1')).toBe('<tptz:GotoPreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetToken>1</tptz:PresetToken></tptz:GotoPreset>');
    expect(BODIES.setPreset(T, 'Door')).toBe('<tptz:SetPreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetName>Door</tptz:PresetName></tptz:SetPreset>');
    expect(BODIES.setPreset(T, 'Front <door>', '3')).toBe('<tptz:SetPreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetName>Front &lt;door&gt;</tptz:PresetName><tptz:PresetToken>3</tptz:PresetToken></tptz:SetPreset>');
    expect(BODIES.removePreset(T, '1')).toBe('<tptz:RemovePreset><tptz:ProfileToken>profile_1</tptz:ProfileToken><tptz:PresetToken>1</tptz:PresetToken></tptz:RemovePreset>');
    expect(BODIES.getEventProperties()).toBe('<tev:GetEventProperties/>');
    expect(BODIES.createPullPointSubscription()).toBe('<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime></tev:CreatePullPointSubscription>');
    expect(BODIES.createPullPointSubscription(false)).toBe('<tev:CreatePullPointSubscription/>');
    expect(BODIES.pullMessages(5, 32)).toBe('<tev:PullMessages><tev:Timeout>PT5S</tev:Timeout><tev:MessageLimit>32</tev:MessageLimit></tev:PullMessages>');
    expect(BODIES.renew()).toBe('<wsnt:Renew><wsnt:TerminationTime>PT10M</wsnt:TerminationTime></wsnt:Renew>');
    expect(BODIES.unsubscribe()).toBe('<wsnt:Unsubscribe/>');
    expect(BODIES.relativeMove('x"><evil/>', 1e-7, -0)).toBe('<tptz:RelativeMove><tptz:ProfileToken>x&quot;&gt;&lt;evil/&gt;</tptz:ProfileToken><tptz:Translation><tt:PanTilt x="0" y="0"/></tptz:Translation><tptz:Speed><tt:PanTilt x="1" y="1"/></tptz:Speed></tptz:RelativeMove>');
  });
});

const fault12 = (sub, text, inner = '') => `<?xml version="1.0"?><env:Envelope xmlns:env="${NS.s}" xmlns:ter="http://www.onvif.org/ver10/error"><env:Body><env:Fault>`
  + `<env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>${sub}</env:Value>${inner}</env:Subcode></env:Code>`
  + `<env:Reason><env:Text xml:lang="en">${text}</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`;

describe('faults', () => {
  it('parses nested subcodes and classifies sign-in failures', () => {
    const err = /** @type {OnvifError} */ (catchErr(() => parseSoapResponse({ status: 400, body: fault12('ter:NotAuthorized', 'Sender not Authorized') })));
    expect(err).toBeInstanceOf(OnvifError);
    expect(err.kind).toBe('auth');
    expect(err.codes).toEqual(['env:Sender', 'ter:NotAuthorized']);
    expect(err.text).toBe('Sender not Authorized');
    const nested = /** @type {OnvifError} */ (catchErr(() => parseSoapResponse({ status: 500, body: fault12('ter:InvalidArgVal', 'bad', '<env:Subcode><env:Value>ter:NoProfile</env:Value></env:Subcode>') })));
    expect(nested.kind).toBe('fault');
    expect(nested.codes).toEqual(['env:Sender', 'ter:InvalidArgVal', 'ter:NoProfile']);
    expect(catchErr(() => parseSoapResponse({ status: 500, body: fault12('ter:Action', 'Authority failure') })).kind).toBe('auth');
    expect(catchErr(() => parseSoapResponse({ status: 401, body: '' })).kind).toBe('auth');
    expect(catchErr(() => parseSoapResponse({ status: 401, body: '<html>nope' })).kind).toBe('auth');
    expect(catchErr(() => parseSoapResponse({ status: 500, body: 'Internal error' })).kind).toBe('http');
    expect(catchErr(() => parseSoapResponse({ status: 200, body: '<html><body>hi</body></html>' })).kind).toBe('malformed');
    expect(catchErr(() => parseSoapResponse({ status: 200, body: '' })).kind).toBe('malformed');
  });

  it('parses SOAP 1.1 faults too', () => {
    const doc = parseXml('<Fault><faultcode>s:Client</faultcode><faultstring>FailedAuthentication</faultstring></Fault>');
    expect(parseFault(doc)).toEqual({ codes: ['s:Client'], text: 'FailedAuthentication' });
  });

  it('returns the first Body element of a good answer', () => {
    const r = parseSoapResponse({ status: 200, body: `<e:Envelope xmlns:e="${NS.s}"><e:Body><tds:GetDeviceInformationResponse xmlns:tds="${NS.tds}"><tds:Model>Tapo C211</tds:Model></tds:GetDeviceInformationResponse></e:Body></e:Envelope>` });
    expect(r.name).toBe('GetDeviceInformationResponse');
  });

  it('classifies transport errors and benign pull endings', () => {
    expect(transportError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind).toBe('refused');
    expect(transportError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })).kind).toBe('reset');
    expect(transportError(new Error('socket hang up')).kind).toBe('reset');
    expect(transportError(Object.assign(new Error('Parse Error: Data after `Connection: close`'), { code: 'HPE_CLOSED_CONNECTION' })).kind).toBe('malformed');
    expect(transportError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })).kind).toBe('unreachable');
    expect(isBenignPullError(new OnvifError('reset', 'x'))).toBe(true);
    expect(isBenignPullError(new OnvifError('timeout', 'x'))).toBe(true);
    expect(isBenignPullError(transportError(Object.assign(new Error('Parse Error: Data after `Connection: close`'), { code: 'HPE_CLOSED_CONNECTION' })))).toBe(true);
    expect(isBenignPullError(catchErr(() => parseSoapResponse({ status: 200, body: '' })))).toBe(true);
    expect(isBenignPullError(new OnvifError('auth', 'x'))).toBe(false);
    expect(isBenignPullError(new OnvifError('fault', 'x'))).toBe(false);
  });
});

describe('postSoap', () => {
  it('posts SOAP 1.2 without keep-alive and returns status and body', async () => {
    let seen;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, type: req.headers['content-type'], len: req.headers['content-length'], body };
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end('<ok/>');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = /** @type {net.AddressInfo} */ (srv.address());
    try {
      const r = await postSoap(`http://127.0.0.1:${port}/onvif/service?x=1`, '<x>é</x>');
      expect(r).toEqual({ status: 200, body: '<ok/>' });
      expect(seen).toEqual({ method: 'POST', url: '/onvif/service?x=1', type: 'application/soap+xml; charset=utf-8', len: String(Buffer.byteLength('<x>é</x>')), body: '<x>é</x>' });
    } finally {
      srv.close();
    }
  });

  it('times out, caps the answer and reports a malformed status line', async () => {
    const srv = net.createServer((sock) => {
      sock.once('data', (d) => {
        const s = String(d);
        if (s.includes('/slow')) return; // never answer
        if (s.includes('/big')) {
          sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\n\r\n');
          sock.write('x'.repeat(5000));
          return;
        }
        sock.end('HTTX garbage\r\n\r\n'); // privacy mode: a broken status line
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = /** @type {net.AddressInfo} */ (srv.address());
    try {
      expect((await postSoap(`http://127.0.0.1:${port}/slow`, '<x/>', { timeoutMs: 150 }).catch((e) => e)).kind).toBe('timeout');
      expect((await postSoap(`http://127.0.0.1:${port}/big`, '<x/>', { maxBytes: 1000 }).catch((e) => e)).kind).toBe('malformed');
      expect((await postSoap(`http://127.0.0.1:${port}/bad`, '<x/>').catch((e) => e)).kind).toBe('malformed');
      expect((await postSoap('https://127.0.0.1/x', '<x/>').catch((e) => e)).kind).toBe('unreachable');
    } finally {
      srv.close();
    }
  });

  it('reports a refused connection', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = /** @type {net.AddressInfo} */ (srv.address());
    await new Promise((r) => srv.close(r));
    expect((await postSoap(`http://127.0.0.1:${port}/`, '<x/>').catch((e) => e)).kind).toBe('refused');
  });
});

function catchErr(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}
