// A fake Tapo camera's ONVIF side for the unit tests: a loopback HTTP server that checks the
// WS-Security PasswordDigest (independently of the code under test) and answers the subset of
// device/media/PTZ/events calls the app makes, with switchable Tapo quirks. Every request is
// recorded in `calls`. (The full simulator with RTSP lives in tools/tapo-sim/, lane C.)

import crypto from 'node:crypto';
import http from 'node:http';

const ENV = 'http://www.w3.org/2003/05/soap-envelope';

/** @param {string} body */
const soap = (body) => `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${ENV}" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" xmlns:ter="http://www.onvif.org/ver10/error"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

/** @param {string} sub @param {string} text */
export const faultXml = (sub, text) => soap(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>${sub}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${text}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`);

/**
 * @typedef {object} FakeCall
 * @property {string} op       the Body element's local name (GetProfiles, RelativeMove, …)
 * @property {string} path
 * @property {boolean} authed  a valid digest was presented
 * @property {string} body     the raw request
 * @property {number} at       Date.now()
 * @property {string} [action] wsa:Action
 * @property {Record<string, string>} args  a few extracted values (x, y, token, …)
 */

/**
 * @param {{ username?: string, password?: string, clockSkewSec?: number, quirks?: Record<string, any>, log?: boolean }} [o]
 */
export async function startFakeOnvif(o = {}) {
  const username = o.username ?? 'camacct';
  let password = o.password ?? 'se&cret';
  /** @type {Record<string, any>} */
  const quirks = {
    analyticsFirst: true, // an Analytics section with its own XAddr before PTZ (gladys' trap)
    getStatusFails: false,
    rejectInitialTerminationTime: false,
    privacy: false,
    stopFaults: false,
    stopMinimalFaults: false,
    noPtz: false,
    noEvents: false,
    capabilitiesFail: false,
    timeNeedsAuth: false, // GetSystemDateAndTime refused without a security header
    setPresetFails: false,
    pullDropAfterMs: 0, // >0: never answer a pull normally; after this, write a bare 200 + garbage and close
    pullHoldMs: 30, // a normal pull answers after this long
    actionFault: false, // fault the first PullMessages that uses the WSDL action
    delayMs: /** @type {Record<string, number>} */ ({}),
    hostInXaddr: 'tapo-cam.invalid:80', // camera-reported host (the client must rewrite it)
    ...(o.quirks || {}),
  };
  const state = {
    clockSkewSec: o.clockSkewSec ?? 0,
    ptz: { x: 0, y: 0, moving: false },
    presets: [{ token: '1', name: 'Door', x: 0.3, y: -0.2 }, { token: '2', name: 'Window', x: -0.5, y: 0.1 }],
    subscriptions: /** @type {Set<string>} */ (new Set()),
    /** queued notifications, delivered by the next pull: [{ topic, name, value, op }] */
    pending: /** @type {Array<{ topic: string, name: string, value: string, op?: string }>} */ ([]),
    concurrent: 0,
    maxConcurrent: 0,
    subSeq: 0,
  };
  /** @type {FakeCall[]} */
  const calls = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let port = 0;
  let actionFaulted = false;
  let privacyNext500 = false;

  const camNow = () => new Date(Date.now() + state.clockSkewSec * 1000);

  /** @param {string} raw */
  const checkAuth = (raw) => {
    const user = /<(?:\w+:)?Username>([^<]*)</.exec(raw)?.[1];
    const pw = /<(?:\w+:)?Password[^>]*>([^<]*)</.exec(raw)?.[1];
    const nonce = /<(?:\w+:)?Nonce[^>]*>([^<]*)</.exec(raw)?.[1];
    const created = /<(?:\w+:)?Created>([^<]*)</.exec(raw)?.[1];
    if (!user || !pw || !nonce || !created) return false;
    const unescaped = user.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (unescaped !== username) return false;
    const expect = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(password)])).digest('base64');
    if (expect !== pw) return false;
    const skew = Math.abs(Date.parse(created) - camNow().getTime());
    return skew <= 10_000;
  };

  const xaddr = (p) => `http://${quirks.hostInXaddr}${p}`;

  /** @param {string} op @param {string} raw @param {string} p */
  const answer = (op, raw, p) => {
    const num = (attr) => Number(new RegExp(`<(?:\\w+:)?PanTilt[^>]*\\b${attr}="([^"]+)"`).exec(raw)?.[1] ?? 'NaN');
    switch (op) {
      case 'GetSystemDateAndTime': {
        const d = camNow();
        return soap(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }
      case 'GetDeviceInformation':
        return soap('<tds:GetDeviceInformationResponse><tds:Manufacturer>tp-link</tds:Manufacturer><tds:Model>Tapo C211</tds:Model><tds:FirmwareVersion>1.5.4 Build 260702 Rel.43n</tds:FirmwareVersion><tds:SerialNumber>2c3f0b1a99887766</tds:SerialNumber><tds:HardwareId>2.0</tds:HardwareId></tds:GetDeviceInformationResponse>');
      case 'GetCapabilities':
        if (quirks.capabilitiesFail) return { status: 500, body: faultXml('ter:ActionNotSupported', 'not supported') };
        return soap(`<tds:GetCapabilitiesResponse><tds:Capabilities>${quirks.analyticsFirst ? `<tt:Analytics><tt:XAddr>${xaddr('/onvif/analytics')}</tt:XAddr></tt:Analytics>` : ''}<tt:Device><tt:XAddr>${xaddr('/onvif/device_service')}</tt:XAddr></tt:Device>${quirks.noEvents ? '' : `<tt:Events><tt:XAddr>${xaddr('/onvif/service')}</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>`}<tt:Media><tt:XAddr>${xaddr('/onvif/service')}</tt:XAddr></tt:Media>${quirks.noPtz ? '' : `<tt:PTZ><tt:XAddr>${xaddr('/onvif/service')}</tt:XAddr></tt:PTZ>`}</tds:Capabilities></tds:GetCapabilitiesResponse>`);
      case 'GetServices':
        return soap(`<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>${xaddr('/onvif/device_service')}</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>${xaddr('/onvif/service')}</tds:XAddr></tds:Service>${quirks.noPtz ? '' : `<tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>${xaddr('/onvif/service')}</tds:XAddr></tds:Service>`}<tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>${xaddr('/onvif/service')}</tds:XAddr></tds:Service></tds:GetServicesResponse>`);
      case 'GetProfiles': {
        const ptzCfg = quirks.noPtz ? '' : '<tt:PTZConfiguration token="PTZConfiguration_1"><tt:Name>PTZ</tt:Name><tt:NodeToken>PTZNODETOKEN</tt:NodeToken><tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace><tt:DefaultRelativePanTiltTranslationSpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:DefaultRelativePanTiltTranslationSpace><tt:PanTiltLimits><tt:Range><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:Range></tt:PanTiltLimits></tt:PTZConfiguration>';
        const prof = (tok, name, w, h) => `<trt:Profiles fixed="true" token="${tok}"><tt:Name>${name}</tt:Name><tt:VideoEncoderConfiguration token="enc_${tok}"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution><tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit><tt:BitrateLimit>2048</tt:BitrateLimit></tt:RateControl></tt:VideoEncoderConfiguration>${ptzCfg}</trt:Profiles>`;
        return soap(`<trt:GetProfilesResponse>${prof('profile_1', 'mainStream', 2304, 1296)}${prof('profile_2', 'minorStream', 640, 360)}</trt:GetProfilesResponse>`);
      }
      case 'GetStreamUri': {
        const tok = /<(?:\w+:)?ProfileToken>([^<]*)</.exec(raw)?.[1];
        return soap(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.1.50:554/${tok === 'profile_2' ? 'stream2' : 'stream1'}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
      }
      case 'GetNodes':
        return soap('<tptz:GetNodesResponse><tptz:PTZNode token="PTZNODETOKEN" FixedHomePosition="false"><tt:Name>PTZ</tt:Name><tt:SupportedPTZSpaces><tt:AbsolutePanTiltPositionSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:AbsolutePanTiltPositionSpace><tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:RelativePanTiltTranslationSpace><tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace></tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>8</tt:MaximumNumberOfPresets><tt:HomeSupported>false</tt:HomeSupported></tptz:PTZNode></tptz:GetNodesResponse>');
      case 'GetConfigurationOptions':
        return soap('<tptz:GetConfigurationOptionsResponse><tptz:PTZConfigurationOptions><tt:Spaces><tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:RelativePanTiltTranslationSpace><tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace></tt:Spaces></tptz:PTZConfigurationOptions></tptz:GetConfigurationOptionsResponse>');
      case 'GetStatus':
        if (quirks.getStatusFails) return { status: 500, body: faultXml('ter:Action', 'Unknown error') };
        return soap(`<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${state.ptz.x}" y="${state.ptz.y}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/></tt:Position><tt:MoveStatus><tt:PanTilt>${state.ptz.moving ? 'MOVING' : 'IDLE'}</tt:PanTilt></tt:MoveStatus><tt:UtcTime>${camNow().toISOString()}</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>`);
      case 'RelativeMove':
        state.ptz.x = clamp(state.ptz.x + num('x'));
        state.ptz.y = clamp(state.ptz.y + num('y'));
        return soap('<tptz:RelativeMoveResponse/>');
      case 'ContinuousMove':
        state.ptz.moving = num('x') !== 0 || num('y') !== 0;
        return soap('<tptz:ContinuousMoveResponse/>');
      case 'AbsoluteMove':
        state.ptz.x = clamp(num('x'));
        state.ptz.y = clamp(num('y'));
        return soap('<tptz:AbsoluteMoveResponse/>');
      case 'Stop': {
        const minimal = !/PanTilt>true/.test(raw);
        if (!minimal && quirks.stopFaults) return { status: 500, body: faultXml('ter:InvalidArgVal', 'Stop not supported') };
        if (minimal && quirks.stopMinimalFaults) return { status: 500, body: faultXml('ter:InvalidArgVal', 'Stop not supported') };
        state.ptz.moving = false;
        return soap('<tptz:StopResponse/>');
      }
      case 'GetPresets':
        return soap(`<tptz:GetPresetsResponse>${state.presets.map((pr) => `<tptz:Preset token="${pr.token}"><tt:Name>${pr.name}</tt:Name><tt:PTZPosition><tt:PanTilt x="${pr.x}" y="${pr.y}"/></tt:PTZPosition></tptz:Preset>`).join('')}</tptz:GetPresetsResponse>`);
      case 'GotoPreset': {
        const tok = /<(?:\w+:)?PresetToken>([^<]*)</.exec(raw)?.[1];
        const pr = state.presets.find((x) => x.token === tok);
        if (!pr) return { status: 500, body: faultXml('ter:NoToken', 'no such preset') };
        state.ptz.x = pr.x;
        state.ptz.y = pr.y;
        return soap('<tptz:GotoPresetResponse/>');
      }
      case 'SetPreset': {
        if (quirks.setPresetFails) return { status: 500, body: faultXml('ter:Action', 'not supported') };
        const name = /<(?:\w+:)?PresetName>([^<]*)</.exec(raw)?.[1] || '';
        const token = String(1 + Math.max(0, ...state.presets.map((x) => Number(x.token) || 0)));
        state.presets.push({ token, name, x: state.ptz.x, y: state.ptz.y });
        return soap(`<tptz:SetPresetResponse><tptz:PresetToken>${token}</tptz:PresetToken></tptz:SetPresetResponse>`);
      }
      case 'RemovePreset': {
        const tok = /<(?:\w+:)?PresetToken>([^<]*)</.exec(raw)?.[1];
        state.presets = state.presets.filter((x) => x.token !== tok);
        return soap('<tptz:RemovePresetResponse/>');
      }
      case 'GetEventProperties':
        return soap('<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation><wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet><tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data></tt:MessageDescription></Motion></CellMotionDetector><PeopleDetector><People wstop:topic="true"/></PeopleDetector><TamperDetector><Tamper wstop:topic="true"/></TamperDetector></tns1:RuleEngine></wstop:TopicSet></tev:GetEventPropertiesResponse>');
      case 'CreatePullPointSubscription': {
        if (quirks.rejectInitialTerminationTime && /InitialTerminationTime/.test(raw)) return { status: 400, body: faultXml('ter:InvalidArgVal', 'InitialTerminationTime is not supported') };
        const id = `event-${state.subSeq++}_${port}`;
        state.subscriptions.add(id);
        const now = camNow();
        return soap(`<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>${xaddr(`/${id}`)}</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>${now.toISOString()}</wsnt:CurrentTime><wsnt:TerminationTime>${new Date(now.getTime() + 600000).toISOString()}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`);
      }
      case 'PullMessages': {
        const id = p.slice(1);
        if (!state.subscriptions.has(id)) return { status: 400, body: faultXml('ter:InvalidArgVal', 'unknown subscription') };
        const msgs = state.pending.splice(0, 32);
        const now = camNow().toISOString();
        return soap(`<tev:PullMessagesResponse><tev:CurrentTime>${now}</tev:CurrentTime><tev:TerminationTime>${new Date(Date.now() + 600000).toISOString()}</tev:TerminationTime>${msgs.map((m) => `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${m.topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${now}" PropertyOperation="${m.op || 'Changed'}"><tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/><tt:SimpleItem Name="Rule" Value="MyMotionDetectorRule"/></tt:Source><tt:Data><tt:SimpleItem Name="${m.name}" Value="${m.value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`).join('')}</tev:PullMessagesResponse>`);
      }
      case 'Renew': {
        const id = p.slice(1);
        if (!state.subscriptions.has(id)) return { status: 400, body: faultXml('ter:InvalidArgVal', 'unknown subscription') };
        return soap(`<wsnt:RenewResponse><wsnt:TerminationTime>${new Date(Date.now() + 600000).toISOString()}</wsnt:TerminationTime></wsnt:RenewResponse>`);
      }
      case 'Unsubscribe':
        state.subscriptions.delete(p.slice(1));
        return soap('<wsnt:UnsubscribeResponse/>');
      default:
        return { status: 400, body: faultXml('ter:ActionNotSupported', `${op} is not supported`) };
    }
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      state.concurrent++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      const done = () => { state.concurrent--; };
      const op = /<(?:\w+:)?Body>\s*<(?:\w+:)?(\w+)/.exec(raw)?.[1] || '?';
      const authed = checkAuth(raw);
      const action = /<(?:\w+:)?Action>([^<]*)</.exec(raw)?.[1];
      const args = {};
      for (const k of ['x', 'y']) {
        const m = new RegExp(`<(?:\\w+:)?PanTilt[^>]*\\b${k}="([^"]+)"`).exec(raw);
        if (m) args[k] = m[1];
      }
      const tok = /<(?:\w+:)?PresetToken>([^<]*)</.exec(raw)?.[1];
      if (tok) args.presetToken = tok;
      const timeout = /<(?:\w+:)?Timeout>([^<]*)</.exec(raw)?.[1];
      if (timeout) args.timeout = timeout;
      calls.push({ op, path: req.url || '', authed, body: raw, at: Date.now(), action, args });
      const delay = quirks.delayMs[op] || 0;
      if (delay) await sleep(delay);

      const ptzOps = ['GetNodes', 'GetConfigurationOptions', 'GetStatus', 'RelativeMove', 'ContinuousMove', 'Stop', 'AbsoluteMove', 'GetPresets', 'GotoPreset', 'SetPreset', 'RemovePreset'];
      if ((op !== 'GetSystemDateAndTime' || quirks.timeNeedsAuth) && !authed) {
        done();
        res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
        res.end(faultXml('ter:NotAuthorized', 'Sender not Authorized'));
        return;
      }
      if (quirks.privacy && ptzOps.includes(op)) {
        done();
        if (privacyNext500) {
          privacyNext500 = false;
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('error');
        } else {
          privacyNext500 = true;
          res.socket?.end('HTTP/1.1 2OO broken\r\n\r\n');
        }
        return;
      }
      if (op === 'PullMessages') {
        if (quirks.actionFault && !actionFaulted && action && action.endsWith('PullMessagesRequest')) {
          actionFaulted = true;
          done();
          res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
          res.end(faultXml('ter:ActionNotSupported', 'The Action is not supported'));
          return;
        }
        if (quirks.pullDropAfterMs > 0 && !state.pending.length) {
          await sleep(quirks.pullDropAfterMs);
          done();
          res.socket?.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\ntrailing garbage');
          return;
        }
        const until = Date.now() + quirks.pullHoldMs;
        while (!state.pending.length && Date.now() < until) await sleep(10);
      }
      const out = answer(op, raw, req.url || '');
      done();
      const r = typeof out === 'string' ? { status: 200, body: out } : out;
      res.writeHead(r.status, { 'Content-Type': 'application/soap+xml; charset=utf-8', Connection: 'close' });
      res.end(r.body);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

  return {
    port,
    calls,
    state,
    quirks,
    /** count of calls by op @param {string} op */
    count: (op) => calls.filter((c) => c.op === op).length,
    ops: () => calls.map((c) => c.op),
    setPassword: (pw) => { password = pw; },
    /** queue a notification for the next pull */
    notify: (topic, name, value, op) => state.pending.push({ topic, name, value: String(value), op }),
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r(undefined));
    }),
  };
}

/** @param {number} v */
function clamp(v) {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
