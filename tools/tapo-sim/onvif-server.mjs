// The simulated camera's ONVIF service (contract §11.2): SOAP 1.2 over plain HTTP, the subset
// the app uses (device, media, PTZ, events + PullPoint subscriptions), WS-Security
// PasswordDigest checked against the camera's own clock, and the Tapo quirk switches.
//
// Paths ('tapo'): /onvif/device_service, /onvif/service (every other service), /event-<n>_<port>
// (subscriptions). 'split' (the `ideal` preset): one path per service, /onvif/subscription/<n>.
// Every response closes the connection, like the camera.

import http from 'node:http';
import { DEVICE, MAX_PRESETS } from './camera.mjs';
import { TOPICS } from './events-model.mjs';
import { at, child, findAll, parse, textAt } from './xml-lite.mjs';
import {
  SoapFault, checkWsse, envelope, esc, invalidArg, notAuthorized, notSupported, parseDuration, parseNumber,
} from './soap.mjs';

const MAX_BODY = 256 * 1024;
const SPACE = {
  pos: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace',
  trans: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace',
  vel: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace',
  speed: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/GenericSpeedSpace',
};
const ACTION = {
  pullResponse: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesResponse',
  createResponse: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionResponse',
  renewResponse: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewResponse',
  unsubscribeResponse: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeResponse',
};

/** Which service each operation belongs to. */
const OPS = {
  device: ['GetSystemDateAndTime', 'GetDeviceInformation', 'GetCapabilities', 'GetServices', 'GetScopes', 'GetHostname'],
  media: ['GetProfiles', 'GetProfile', 'GetStreamUri', 'GetSnapshotUri', 'GetVideoSources'],
  ptz: ['GetNodes', 'GetNode', 'GetConfigurations', 'GetConfiguration', 'GetConfigurationOptions', 'GetStatus', 'RelativeMove',
    'ContinuousMove', 'AbsoluteMove', 'Stop', 'GetPresets', 'GotoPreset', 'SetPreset', 'RemovePreset', 'GotoHomePosition', 'SetHomePosition'],
  events: ['GetEventProperties', 'CreatePullPointSubscription', 'GetServiceCapabilities'],
  subscription: ['PullMessages', 'Renew', 'Unsubscribe', 'SetSynchronizationPoint'],
};
/** @type {Record<string, string>} */
const SERVICE_OF = {};
for (const [svc, ops] of Object.entries(OPS)) for (const op of ops) SERVICE_OF[op] ??= svc;

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** @param {number} n */
const num = (n) => String(Math.round(n * 1e6) / 1e6);

/** @param {string} tag @param {{ min: number, max: number }} [r] */
const range = (tag, r = { min: -1, max: 1 }) => `<tt:${tag}><tt:Min>${r.min}</tt:Min><tt:Max>${r.max}</tt:Max></tt:${tag}>`;
const SPACES_XML = [
  `<tt:AbsolutePanTiltPositionSpace><tt:URI>${SPACE.pos}</tt:URI>${range('XRange')}${range('YRange')}</tt:AbsolutePanTiltPositionSpace>`,
  `<tt:RelativePanTiltTranslationSpace><tt:URI>${SPACE.trans}</tt:URI>${range('XRange')}${range('YRange')}</tt:RelativePanTiltTranslationSpace>`,
  `<tt:ContinuousPanTiltVelocitySpace><tt:URI>${SPACE.vel}</tt:URI>${range('XRange')}${range('YRange')}</tt:ContinuousPanTiltVelocitySpace>`,
  `<tt:PanTiltSpeedSpace><tt:URI>${SPACE.speed}</tt:URI>${range('XRange', { min: 0, max: 1 })}</tt:PanTiltSpeedSpace>`,
].join('');

/**
 * @param {{ camera: import('./camera.mjs').SimCamera, host: string, port: number, getRtspPort: () => number }} o
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startOnvifServer(o) {
  const cam = o.camera;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let inflight = 0;
  let privacyToggle = 0;
  /** @type {Map<string, number>} */
  const seenNonces = new Map();
  let port = 0;

  const paths = () => (cam.quirks.servicePaths === 'split'
    ? { device: '/onvif/device_service', media: '/onvif/media_service', ptz: '/onvif/ptz_service', events: '/onvif/event_service', analytics: '/onvif/analytics_service', imaging: '/onvif/imaging_service' }
    : { device: '/onvif/device_service', media: '/onvif/service', ptz: '/onvif/service', events: '/onvif/service', analytics: '/onvif/service', imaging: '/onvif/service' });

  /** @param {http.IncomingMessage} req */
  const advertised = (req) => cam.quirks.xaddrHost || req.headers.host || `${o.host}:${port}`;
  /** @param {http.IncomingMessage} req */
  const base = (req) => `http://${advertised(req)}`;

  /**
   * Which service a path serves ('subscription' for PullPoint addresses), or null.
   * @param {string} p @returns {string[]|null}
   */
  const servicesAt = (p) => {
    if (cam.events.get(p)) return ['subscription'];
    if (/^\/event-\d+_\d+$|^\/onvif\/subscription\/\d+$/.test(p)) return ['subscription'];
    const map = paths();
    const out = Object.entries(map).filter(([, v]) => v === p).map(([k]) => k);
    if (p === '/onvif/service' && cam.quirks.servicePaths !== 'split') out.push('device');
    return out.length ? out : null;
  };

  const server = http.createServer((req, res) => {
    // Control requests in flight (PullMessages on a subscription address is a separate lane):
    // with concurrent401, a control request that starts while another one is still being
    // answered gets HTTP 401 (Tapo-Control README: ONVIF must not be used concurrently).
    const nonPull = !/^\/event-|^\/onvif\/subscription\//.test(req.url || '');
    if (nonPull) inflight++;
    let counted = nonPull;
    const done = () => {
      if (counted) inflight--;
      counted = false;
    };
    res.on('close', done);
    const overlapped = nonPull && inflight > 1;
    /** @type {Buffer[]} */
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else parts.push(c);
    });
    req.on('end', async () => {
      const latency = nonPull ? Number(cam.quirks.latencyMs) || 0 : 0;
      if (latency > 0) await new Promise((r) => setTimeout(r, latency));
      handle(req, res, Buffer.concat(parts).toString('utf8'), overlapped).catch((err) => {
        cam.log('error', `[sim] ONVIF handler failed: ${err.stack || err}`);
        if (!res.headersSent) send(res, 500, new SoapFault('internal error', { sender: false }).xml());
      });
    });
  });
  server.on('connection', (s) => {
    if (cam.scenario.offline) {
      s.destroy();
      return;
    }
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.requestTimeout = 60_000;

  /** @param {http.ServerResponse} res @param {number} status @param {string} xml @param {Record<string,string>} [headers] */
  function send(res, status, xml, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml), Connection: 'close', ...headers });
    res.end(xml);
  }

  /**
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} text @param {boolean} overlapped
   */
  async function handle(req, res, text, overlapped) {
    const urlPath = new URL(req.url || '/', 'http://x').pathname;
    if (req.method !== 'POST') return send(res, 405, new SoapFault('POST only').xml());
    const services = servicesAt(urlPath);
    if (!services) {
      res.writeHead(404, { Connection: 'close' });
      return res.end();
    }
    /** @type {import('./xml-lite.mjs').XNode} */
    let doc;
    try {
      doc = parse(text);
    } catch (err) {
      cam.record({ service: services[0], op: '(unparseable)', args: {}, status: 400, why: /** @type {Error} */ (err).message });
      return send(res, 400, new SoapFault('Not well formed', { subcodes: ['ter:WellFormed'] }).xml());
    }
    const body = at(doc, 'Envelope/Body');
    const opNode = body && body.children[0];
    const op = opNode ? opNode.name : '';
    const service = SERVICE_OF[op] || services[0];
    if (!services.includes(service)) {
      // an operation sent to the wrong service address (e.g. PTZ to the Analytics XAddr)
      const call = cam.record({ service: services[0], op, args: {}, status: 500, why: `not a ${services.join('/')} operation` });
      return send(res, Number(call.status), notSupported(`${op} is not served at ${urlPath}`).xml());
    }
    /** @type {Record<string, any>} */
    let args;
    try {
      args = argsOf(op, opNode);
    } catch (err) {
      if (!(err instanceof SoapFault)) throw err;
      cam.record({ service, op, args: {}, status: err.status, why: err.message });
      return send(res, err.status, err.xml());
    }
    const call = cam.record({ service, op, args, status: 0 });
    const reply = (/** @type {number} */ status, /** @type {string} */ xml, /** @type {Record<string,string>} */ h = {}) => {
      call.status = status;
      send(res, status, xml, h);
    };

    if (overlapped && cam.quirks.concurrent401) {
      call.why = 'concurrent request';
      return reply(401, notAuthorized().xml(), { 'WWW-Authenticate': 'Digest realm="TP-Link IP-Camera"' });
    }
    if (op !== 'GetSystemDateAndTime') {
      const auth = checkWsse(doc, {
        username: cam.username, password: cam.password, cameraNowMs: cam.cameraNow(),
        toleranceSec: Number(cam.quirks.clockToleranceSec) || 10, seenNonces: cam.quirks.replayCheck ? seenNonces : null,
      });
      if (!auth.ok) {
        cam.authFailures.onvif++;
        call.why = auth.why;
        return reply(400, notAuthorized().xml());
      }
    }
    if (service === 'ptz' && cam.scenario.privacy) {
      // vyzio #89 (C200 fw 1.9.1, privacy on): a malformed answer, then HTTP 500
      call.why = 'privacy mode';
      if (privacyToggle++ % 2 === 0) {
        call.status = 'malformed';
        req.socket.end('HTTP/1.1 OK\r\n\r\n');
        return undefined;
      }
      return reply(500, new SoapFault('Privacy mode is on', { sender: false }).xml());
    }
    if (service === 'ptz' && cam.quirks.noPtz) {
      call.why = 'no PTZ on this firmware';
      return reply(500, notSupported().xml());
    }
    try {
      if (service === 'subscription') return await subscriptionOp(req, res, op, opNode, urlPath, call, args);
      const out = operation(req, op, opNode, args);
      return reply(200, envelope(out.body, { action: out.action }));
    } catch (err) {
      if (err instanceof SoapFault) {
        call.why = err.message;
        return reply(err.status, err.xml());
      }
      throw err;
    }
  }

  /**
   * The answer to one non-subscription operation.
   * @param {http.IncomingMessage} req @param {string} op @param {import('./xml-lite.mjs').XNode} n @param {Record<string, any>} args
   * @returns {{ body: string, action?: string }}
   */
  function operation(req, op, n, args) {
    const t = cam.tokens;
    const q = cam.quirks;
    switch (op) {
      case 'GetSystemDateAndTime': {
        const d = new Date(cam.cameraNow());
        const ntp = !cam.scenario.clockSkewSec;
        const dt = (/** @type {Date} */ x) => `<tt:Time><tt:Hour>${x.getUTCHours()}</tt:Hour><tt:Minute>${x.getUTCMinutes()}</tt:Minute><tt:Second>${x.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${x.getUTCFullYear()}</tt:Year><tt:Month>${x.getUTCMonth() + 1}</tt:Month><tt:Day>${x.getUTCDate()}</tt:Day></tt:Date>`;
        return { body: `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>${ntp ? 'NTP' : 'Manual'}</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>GMT+00:00</tt:TZ></tt:TimeZone><tt:UTCDateTime>${dt(d)}</tt:UTCDateTime><tt:LocalDateTime>${dt(d)}</tt:LocalDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>` };
      }
      case 'GetDeviceInformation':
        return { body: `<tds:GetDeviceInformationResponse><tds:Manufacturer>${esc(DEVICE.manufacturer)}</tds:Manufacturer><tds:Model>${esc(DEVICE.model)}</tds:Model><tds:FirmwareVersion>${esc(DEVICE.firmware)}</tds:FirmwareVersion><tds:SerialNumber>${esc(DEVICE.serial)}</tds:SerialNumber><tds:HardwareId>${esc(DEVICE.hardwareId)}</tds:HardwareId></tds:GetDeviceInformationResponse>` };
      case 'GetCapabilities': {
        const cat = textAt(n, 'Category') || 'All';
        const b = base(req);
        const p = paths();
        const want = (/** @type {string} */ c) => cat === 'All' || cat === c;
        const parts = [];
        // Analytics comes first in the schema: a client that takes the first XAddr of the
        // document gets this one (gladys-tapo found that on real firmware)
        if (want('Analytics')) parts.push(`<tt:Analytics><tt:XAddr>${b}${p.analytics}</tt:XAddr><tt:RuleSupport>true</tt:RuleSupport><tt:AnalyticsModuleSupport>true</tt:AnalyticsModuleSupport></tt:Analytics>`);
        if (want('Device')) parts.push(`<tt:Device><tt:XAddr>${b}${p.device}</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>false</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS></tt:Network><tt:System><tt:DiscoveryResolve>false</tt:DiscoveryResolve><tt:DiscoveryBye>true</tt:DiscoveryBye><tt:RemoteDiscovery>false</tt:RemoteDiscovery><tt:SystemBackup>false</tt:SystemBackup><tt:SystemLogging>false</tt:SystemLogging><tt:FirmwareUpgrade>false</tt:FirmwareUpgrade><tt:SupportedVersions><tt:Major>2</tt:Major><tt:Minor>40</tt:Minor></tt:SupportedVersions></tt:System><tt:Security><tt:TLS1.1>false</tt:TLS1.1><tt:TLS1.2>false</tt:TLS1.2><tt:UsernameToken>true</tt:UsernameToken></tt:Security></tt:Device>`);
        if (want('Events')) parts.push(`<tt:Events><tt:XAddr>${b}${p.events}</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>${q.noEvents ? 'false' : 'true'}</tt:WSPullPointSupport><tt:WSPausableSubscriptionManagerInterfaceSupport>false</tt:WSPausableSubscriptionManagerInterfaceSupport></tt:Events>`);
        if (want('Imaging')) parts.push(`<tt:Imaging><tt:XAddr>${b}${p.imaging}</tt:XAddr></tt:Imaging>`);
        if (want('Media')) parts.push(`<tt:Media><tt:XAddr>${b}${p.media}</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>`);
        if (want('PTZ') && !q.noPtz) parts.push(`<tt:PTZ><tt:XAddr>${b}${p.ptz}</tt:XAddr></tt:PTZ>`);
        return { body: `<tds:GetCapabilitiesResponse><tds:Capabilities>${parts.join('')}</tds:Capabilities></tds:GetCapabilitiesResponse>` };
      }
      case 'GetServices': {
        const b = base(req);
        const p = paths();
        const list = [
          ['http://www.onvif.org/ver10/device/wsdl', p.device], ['http://www.onvif.org/ver10/media/wsdl', p.media],
          ['http://www.onvif.org/ver10/events/wsdl', p.events], ...(q.noPtz ? [] : [['http://www.onvif.org/ver20/ptz/wsdl', p.ptz]]),
          ['http://www.onvif.org/ver20/imaging/wsdl', p.imaging], ['http://www.onvif.org/ver20/analytics/wsdl', p.analytics],
        ];
        return { body: `<tds:GetServicesResponse>${list.map(([ns, path]) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${b}${path}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>40</tt:Minor></tds:Version></tds:Service>`).join('')}</tds:GetServicesResponse>` };
      }
      case 'GetScopes':
        return { body: `<tds:GetScopesResponse>${['onvif://www.onvif.org/name/TP-IPC', 'onvif://www.onvif.org/hardware/C211', 'onvif://www.onvif.org/Profile/Streaming'].map((s) => `<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef><tt:ScopeItem>${s}</tt:ScopeItem></tds:Scopes>`).join('')}</tds:GetScopesResponse>` };
      case 'GetHostname':
        return { body: '<tds:GetHostnameResponse><tds:HostnameInformation><tt:FromDHCP>true</tt:FromDHCP><tt:Name>C211</tt:Name></tds:HostnameInformation></tds:GetHostnameResponse>' };
      case 'GetProfiles':
        return { body: `<trt:GetProfilesResponse>${profiles().map(profileXml).join('')}</trt:GetProfilesResponse>` };
      case 'GetProfile': {
        const p = profiles().find((x) => x.token === args.profile);
        if (!p) throw invalidArg('no such profile', 'ter:NoProfile');
        return { body: `<trt:GetProfileResponse>${profileXml(p).replace(/^<trt:Profiles/, '<trt:Profile').replace(/<\/trt:Profiles>$/, '</trt:Profile>')}</trt:GetProfileResponse>` };
      }
      case 'GetStreamUri': {
        const p = profiles().find((x) => x.token === args.profile);
        if (!p) throw invalidArg('no such profile', 'ter:NoProfile');
        const hostOnly = advertised(req).replace(/:\d+$/, '');
        return { body: `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://${esc(hostOnly)}:${o.getRtspPort()}/${p.path}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT60S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>` };
      }
      case 'GetSnapshotUri':
        throw notSupported(); // fails on Tapo siblings: snapshots come from the stream
      case 'GetVideoSources':
        return { body: `<trt:GetVideoSourcesResponse><trt:VideoSources token="${t.video}"><tt:Framerate>15</tt:Framerate><tt:Resolution><tt:Width>2304</tt:Width><tt:Height>1296</tt:Height></tt:Resolution></trt:VideoSources></trt:GetVideoSourcesResponse>` };

      // ---- PTZ ----
      case 'GetNodes':
      case 'GetNode':
        return { body: `<tptz:${op}Response><tptz:PTZNode token="${t.node}" FixedHomePosition="false" GeoMove="false"><tt:Name>PTZ</tt:Name><tt:SupportedPTZSpaces>${SPACES_XML}</tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>${MAX_PRESETS}</tt:MaximumNumberOfPresets><tt:HomeSupported>${q.homeSupported ? 'true' : 'false'}</tt:HomeSupported></tptz:PTZNode></tptz:${op}Response>` };
      case 'GetConfigurations':
        return { body: `<tptz:GetConfigurationsResponse>${ptzConfigXml('tptz:PTZConfiguration')}</tptz:GetConfigurationsResponse>` };
      case 'GetConfiguration':
        if (args.config !== t.ptzConfig) throw invalidArg('no such configuration', 'ter:NoConfig');
        return { body: `<tptz:GetConfigurationResponse>${ptzConfigXml('tptz:PTZConfiguration')}</tptz:GetConfigurationResponse>` };
      case 'GetConfigurationOptions':
        if (args.config !== t.ptzConfig) throw invalidArg('no such configuration', 'ter:NoConfig');
        return { body: `<tptz:GetConfigurationOptionsResponse><tptz:PTZConfigurationOptions><tt:Spaces>${SPACES_XML}</tt:Spaces><tt:PTZTimeout><tt:Min>PT1S</tt:Min><tt:Max>PT60S</tt:Max></tt:PTZTimeout></tptz:PTZConfigurationOptions></tptz:GetConfigurationOptionsResponse>` };
      case 'GetStatus': {
        ptzProfile(args);
        if (q.getStatusFails) throw new SoapFault('Unknown error', { sender: false }); // HTTP 500 like the C500
        const p = cam.ptz.position;
        const moving = cam.ptz.moving;
        return { body: `<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${num(p.x)}" y="${num(p.y)}" space="${SPACE.pos}"/></tt:Position><tt:MoveStatus><tt:PanTilt>${moving ? 'MOVING' : 'IDLE'}</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus><tt:UtcTime>${iso(cam.cameraNow())}</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>` };
      }
      case 'RelativeMove': {
        ptzProfile(args);
        if (args.x === null && args.y === null) throw invalidArg('Translation missing');
        if (Math.abs(args.x ?? 0) > 1 || Math.abs(args.y ?? 0) > 1) throw invalidArg('translation outside the space', 'ter:InvalidTranslation');
        const moved = cam.ptz.relative(args.x ?? 0, args.y ?? 0);
        args.moved = moved;
        return { body: '<tptz:RelativeMoveResponse/>' };
      }
      case 'ContinuousMove': {
        ptzProfile(args);
        if (args.x === null && args.y === null) throw invalidArg('Velocity missing');
        if (Math.abs(args.x ?? 0) > 1 || Math.abs(args.y ?? 0) > 1) throw invalidArg('velocity outside the space', 'ter:InvalidVelocity');
        cam.ptz.continuous(args.x ?? 0, args.y ?? 0, args.timeoutSec === null ? Infinity : args.timeoutSec * 1000);
        return { body: '<tptz:ContinuousMoveResponse/>' };
      }
      case 'AbsoluteMove': {
        ptzProfile(args);
        if (q.absoluteFails) throw notSupported();
        if (args.x === null || args.y === null) throw invalidArg('Position missing');
        if (Math.abs(args.x) > 1 || Math.abs(args.y) > 1) throw invalidArg('position outside the space', 'ter:InvalidPosition');
        cam.ptz.absolute(args.x, args.y);
        return { body: '<tptz:AbsoluteMoveResponse/>' };
      }
      case 'Stop':
        ptzProfile(args);
        cam.ptz.stop({ panTilt: args.panTilt === null ? undefined : args.panTilt });
        return { body: '<tptz:StopResponse/>' };
      case 'GetPresets':
        ptzProfile(args);
        return { body: `<tptz:GetPresetsResponse>${cam.presets.map((p) => `<tptz:Preset token="${esc(p.token)}"><tt:Name>${esc(p.name)}</tt:Name><tt:PTZPosition><tt:PanTilt x="${num(p.x)}" y="${num(p.y)}" space="${SPACE.pos}"/></tt:PTZPosition></tptz:Preset>`).join('')}</tptz:GetPresetsResponse>` };
      case 'GotoPreset': {
        ptzProfile(args);
        const p = cam.presets.find((x) => x.token === args.token);
        if (!p) throw invalidArg('no such preset', 'ter:NoToken');
        cam.ptz.absolute(p.x, p.y);
        return { body: '<tptz:GotoPresetResponse/>' };
      }
      case 'SetPreset': {
        ptzProfile(args);
        if (q.setPresetFails) throw new SoapFault('Set preset failed', { sender: false });
        const name = String(args.name || '').trim();
        if (!name) throw invalidArg('preset name missing', 'ter:InvalidPresetName');
        const pos = cam.ptz.position;
        if (args.token) {
          const p = cam.presets.find((x) => x.token === args.token);
          if (!p) throw invalidArg('no such preset', 'ter:NoToken');
          Object.assign(p, { name, x: pos.x, y: pos.y });
          return { body: `<tptz:SetPresetResponse><tptz:PresetToken>${esc(p.token)}</tptz:PresetToken></tptz:SetPresetResponse>` };
        }
        if (cam.presets.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw invalidArg('a preset with this name exists', 'ter:PresetExist');
        if (cam.presets.length >= MAX_PRESETS) throw new SoapFault('Too many presets', { subcodes: ['ter:TooManyPresets'], sender: false });
        let token = '1';
        for (let k = 1; k <= MAX_PRESETS; k++) if (!cam.presets.some((x) => x.token === String(k))) { token = String(k); break; }
        cam.presets.push({ token, name, x: pos.x, y: pos.y });
        cam.presets.sort((a, b) => Number(a.token) - Number(b.token));
        return { body: `<tptz:SetPresetResponse><tptz:PresetToken>${token}</tptz:PresetToken></tptz:SetPresetResponse>` };
      }
      case 'RemovePreset': {
        ptzProfile(args);
        const i = cam.presets.findIndex((x) => x.token === args.token);
        if (i < 0) throw invalidArg('no such preset', 'ter:NoToken');
        cam.presets.splice(i, 1);
        return { body: '<tptz:RemovePresetResponse/>' };
      }
      case 'GotoHomePosition':
        ptzProfile(args);
        if (!q.homeSupported) throw notSupported('Home position not supported');
        cam.ptz.absolute(0, 0);
        return { body: '<tptz:GotoHomePositionResponse/>' };
      case 'SetHomePosition':
        throw notSupported();

      // ---- events ----
      case 'GetEventProperties':
        if (q.noEvents) throw notSupported();
        return { body: eventPropertiesXml() };
      case 'GetServiceCapabilities':
        return { body: `<tev:GetServiceCapabilitiesResponse><tev:Capabilities WSSubscriptionPolicySupport="true" WSPullPointSupport="${q.noEvents ? 'false' : 'true'}" WSPausableSubscriptionManagerInterfaceSupport="false" MaxNotificationProducers="1" MaxPullPoints="${Number(q.maxSubscriptions) || 10}"/></tev:GetServiceCapabilitiesResponse>` };
      case 'CreatePullPointSubscription': {
        if (q.noEvents) throw notSupported();
        let sub;
        try {
          sub = cam.events.create({ initialTerminationSec: args.initialTerminationSec });
        } catch (err) {
          const e = /** @type {any} */ (err);
          throw new SoapFault(e.message, { subcodes: e.code ? [e.code] : [], sender: e.sender });
        }
        args.address = sub.path;
        return {
          action: ACTION.createResponse,
          body: `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>${base(req)}${sub.path}</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>${iso(cam.cameraNow())}</wsnt:CurrentTime><wsnt:TerminationTime>${iso(cam.cameraNow() + (sub.expiresAt - cam.now()))}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`,
        };
      }
      default:
        throw notSupported(`${op || '(no operation)'} not implemented`);
    }
  }

  /**
   * PullMessages / Renew / Unsubscribe on a subscription address.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} op
   * @param {import('./xml-lite.mjs').XNode} n @param {string} urlPath @param {any} call @param {Record<string, any>} args
   */
  async function subscriptionOp(req, res, op, n, urlPath, call, args) {
    const sub = cam.events.get(urlPath);
    if (!sub) throw invalidArg('no such subscription', 'ter:InvalidArgVal');
    const termXml = () => `<tev:CurrentTime>${iso(cam.cameraNow())}</tev:CurrentTime><tev:TerminationTime>${iso(cam.cameraNow() + (sub.expiresAt - cam.now()))}</tev:TerminationTime>`;
    if (op === 'Renew') {
      cam.events.renew(sub, args.terminationSec);
      call.status = 200;
      return send(res, 200, envelope(`<wsnt:RenewResponse><wsnt:TerminationTime>${iso(cam.cameraNow() + (sub.expiresAt - cam.now()))}</wsnt:TerminationTime><wsnt:CurrentTime>${iso(cam.cameraNow())}</wsnt:CurrentTime></wsnt:RenewResponse>`, { action: ACTION.renewResponse }));
    }
    if (op === 'Unsubscribe') {
      cam.events.unsubscribe(sub);
      call.status = 200;
      return send(res, 200, envelope('<wsnt:UnsubscribeResponse/>', { action: ACTION.unsubscribeResponse }));
    }
    if (op === 'SetSynchronizationPoint') {
      call.status = 200;
      return send(res, 200, envelope('<tev:SetSynchronizationPointResponse/>'));
    }
    if (op !== 'PullMessages') throw notSupported();
    sub.pulls++;
    const limit = Math.max(1, Math.min(1024, args.limit || 32));
    const answer = () => {
      const msgs = cam.events.take(sub, limit);
      call.status = 200;
      args.messages = msgs.length;
      send(res, 200, envelope(`<tev:PullMessagesResponse>${termXml()}${msgs.map((m) => notificationXml(req, sub, m)).join('')}</tev:PullMessagesResponse>`, { action: ACTION.pullResponse }));
    };
    if (sub.queue.length) return answer();
    // Nothing queued: wait for a message. A Tapo camera ignores the requested Timeout and
    // drops the connection after ~10 s, writing bytes after `Connection: close`.
    const drop = Number(cam.quirks.pullDropAfterMs) || 0;
    const waitMs = drop > 0 ? drop : Math.max(0, (args.timeoutSec ?? 5) * 1000);
    await new Promise((resolve) => {
      let finished = false;
      const finish = (/** @type {'message'|'timeout'|'gone'|'closed'} */ why) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        sub.emitter.off('message', onMessage);
        sub.emitter.off('gone', onGone);
        res.off('close', onClose);
        if (why === 'message') answer();
        else if (why === 'timeout' && drop > 0) {
          call.status = 'dropped';
          req.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n\r\n</SOAP-ENV:Envelope>\r\n');
        } else if (why === 'timeout' || why === 'gone') {
          if (why === 'gone') {
            call.status = 400;
            send(res, 400, invalidArg('subscription ended').xml());
          } else answer();
        } else call.status = 'client-closed';
        resolve(undefined);
      };
      const onMessage = () => finish('message');
      const onGone = () => finish('gone');
      const onClose = () => finish('closed');
      const timer = setTimeout(() => finish('timeout'), waitMs);
      sub.emitter.on('message', onMessage);
      sub.emitter.once('gone', onGone);
      res.on('close', onClose);
    });
    return undefined;
  }

  /** @param {Record<string, any>} args */
  function ptzProfile(args) {
    const p = profiles().find((x) => x.token === args.profile);
    if (!p || !p.ptz) throw invalidArg('no such profile', 'ter:NoProfile');
  }

  function profiles() {
    const t = cam.tokens;
    const main = { token: t.main, name: 'mainStream', path: 'stream1', enc: 'H264', w: 2304, h: 1296, ptz: !cam.quirks.noPtz };
    const sub = { token: t.sub, name: 'minorStream', path: 'stream2', enc: 'H264', w: 640, h: 360, ptz: !cam.quirks.noPtz };
    // The `ideal` camera lists a snapshot profile without PTZ first: the client must pick the
    // first profile that HAS a PTZ configuration
    return cam.quirks.tokens === 'ideal'
      ? [{ token: 'JpegStream', name: 'jpegStream', path: 'stream8', enc: 'JPEG', w: 640, h: 360, ptz: false }, main, sub]
      : [main, sub];
  }

  /** @param {ReturnType<typeof profiles>[number]} p */
  function profileXml(p) {
    const t = cam.tokens;
    return `<trt:Profiles token="${esc(p.token)}" fixed="true"><tt:Name>${p.name}</tt:Name>`
      + `<tt:VideoSourceConfiguration token="${t.video}"><tt:Name>VideoSourceConfig</tt:Name><tt:UseCount>3</tt:UseCount><tt:SourceToken>${t.video}</tt:SourceToken><tt:Bounds x="0" y="0" width="2304" height="1296"/></tt:VideoSourceConfiguration>`
      + `<tt:VideoEncoderConfiguration token="enc_${esc(p.path)}"><tt:Name>VideoEncoder_${esc(p.path)}</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>${p.enc}</tt:Encoding><tt:Resolution><tt:Width>${p.w}</tt:Width><tt:Height>${p.h}</tt:Height></tt:Resolution><tt:Quality>3</tt:Quality><tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>${p.w > 1000 ? 2048 : 512}</tt:BitrateLimit></tt:RateControl>${p.enc === 'H264' ? '<tt:H264><tt:GovLength>15</tt:GovLength><tt:H264Profile>High</tt:H264Profile></tt:H264>' : ''}<tt:SessionTimeout>PT60S</tt:SessionTimeout></tt:VideoEncoderConfiguration>`
      + (p.ptz ? ptzConfigXml('tt:PTZConfiguration') : '')
      + '</trt:Profiles>';
  }

  /** @param {string} tag */
  function ptzConfigXml(tag) {
    const t = cam.tokens;
    return `<${tag} token="${t.ptzConfig}"><tt:Name>PTZ</tt:Name><tt:UseCount>2</tt:UseCount><tt:NodeToken>${t.node}</tt:NodeToken>`
      + `<tt:DefaultAbsolutePantTiltPositionSpace>${SPACE.pos}</tt:DefaultAbsolutePantTiltPositionSpace>` // sic: the schema's own spelling
      + `<tt:DefaultRelativePanTiltTranslationSpace>${SPACE.trans}</tt:DefaultRelativePanTiltTranslationSpace>`
      + `<tt:DefaultContinuousPanTiltVelocitySpace>${SPACE.vel}</tt:DefaultContinuousPanTiltVelocitySpace>`
      + `<tt:DefaultPTZSpeed><tt:PanTilt x="1" y="1" space="${SPACE.speed}"/></tt:DefaultPTZSpeed><tt:DefaultPTZTimeout>PT10S</tt:DefaultPTZTimeout>`
      + `<tt:PanTiltLimits><tt:Range><tt:URI>${SPACE.pos}</tt:URI>${range('XRange')}${range('YRange')}</tt:Range></tt:PanTiltLimits></${tag}>`;
  }

  function eventPropertiesXml() {
    /** @type {Record<string, string[]>} */
    const tree = {};
    for (const { topic, item } of Object.values(TOPICS)) {
      const [, group, leaf] = topic.replace(/^tns1:/, '').split('/');
      (tree[group] ||= []).push(`<tns1:${leaf} wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/><tt:SimpleItemDescription Name="VideoAnalyticsConfigurationToken" Type="tt:ReferenceToken"/><tt:SimpleItemDescription Name="Rule" Type="xs:string"/></tt:Source><tt:Data><tt:SimpleItemDescription Name="${item}" Type="xs:boolean"/></tt:Data></tt:MessageDescription></tns1:${leaf}>`);
    }
    const groups = Object.entries(tree).map(([g, leaves]) => `<tns1:${g}>${leaves.join('')}</tns1:${g}>`).join('');
    return `<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation><wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet><tns1:RuleEngine>${groups}</tns1:RuleEngine></wstop:TopicSet><wsnt:TopicExpressionDialect>http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet</wsnt:TopicExpressionDialect><wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsnt/t-1/TopicExpression/ConcreteSet</wsnt:TopicExpressionDialect><tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect><tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation></tev:GetEventPropertiesResponse>`;
  }

  /**
   * One NotificationMessage: the Source items come FIRST (a client that reads the first
   * SimpleItem instead of the one in Data never sees a `true`, gladys-tapo).
   * @param {http.IncomingMessage} req @param {import('./events-model.mjs').Subscription} sub @param {import('./events-model.mjs').SimMessage} m
   */
  function notificationXml(req, sub, m) {
    const t = TOPICS[m.kind];
    return `<wsnt:NotificationMessage><wsnt:SubscriptionReference><wsa5:Address>${base(req)}${sub.path}</wsa5:Address></wsnt:SubscriptionReference><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${t.topic}</wsnt:Topic><wsnt:ProducerReference><wsa5:Address>http://${advertised(req).replace(/:\d+$/, '')}:5656/event</wsa5:Address></wsnt:ProducerReference><wsnt:Message><tt:Message UtcTime="${m.utc}" PropertyOperation="${m.op}"><tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="${cam.tokens.video}"/><tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VideoAnalyticsToken"/><tt:SimpleItem Name="Rule" Value="${t.rule}"/></tt:Source><tt:Data><tt:SimpleItem Name="${t.item}" Value="${m.value ? 'true' : 'false'}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
  }

  // ---- online / offline ----
  /** @type {Promise<void>} */
  let transition = Promise.resolve();
  const onOffline = (/** @type {boolean} */ off) => {
    transition = transition.then(() => new Promise((resolve) => {
      if (off) {
        for (const s of sockets) s.destroy();
        if (server.listening) server.close(() => resolve(undefined));
        else resolve(undefined);
      } else if (!server.listening) {
        server.listen(port, o.host, () => resolve(undefined));
        server.once('error', () => resolve(undefined));
      } else resolve(undefined);
    }));
  };
  cam.onOffline.add(onOffline);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  cam.eventPath = (n) => (cam.quirks.servicePaths === 'split' ? `/onvif/subscription/${n}` : `/event-${n}_${port}`);
  return {
    port,
    close: async () => {
      cam.onOffline.delete(onOffline);
      await transition;
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => (server.listening ? server.close(() => resolve(undefined)) : resolve(undefined)));
    },
  };
}

/**
 * The interesting arguments of an operation (for the call log and the handlers).
 * @param {string} op @param {import('./xml-lite.mjs').XNode|null|undefined} n
 * @returns {Record<string, any>}
 */
export function argsOf(op, n) {
  if (!n) return {};
  const pt = (/** @type {string} */ p) => {
    const e = at(n, p);
    return e ? { x: parseNumber(e.attrs.x, `${p}@x`), y: parseNumber(e.attrs.y, `${p}@y`) } : { x: null, y: null };
  };
  const profile = textAt(n, 'ProfileToken');
  switch (op) {
    case 'RelativeMove': return { profile, ...pt('Translation/PanTilt'), speed: at(n, 'Speed') ? pt('Speed/PanTilt') : null };
    case 'ContinuousMove': {
      const to = textAt(n, 'Timeout');
      return { profile, ...pt('Velocity/PanTilt'), timeoutSec: to ? parseDuration(to) : null, timeout: to || null };
    }
    case 'AbsoluteMove': return { profile, ...pt('Position/PanTilt') };
    case 'Stop': {
      const v = child(n, 'PanTilt');
      return { profile, panTilt: v ? v.text.trim() === 'true' : null, zoom: child(n, 'Zoom') ? textAt(n, 'Zoom') === 'true' : null };
    }
    case 'GotoPreset': case 'RemovePreset': return { profile, token: textAt(n, 'PresetToken') };
    case 'SetPreset': return { profile, name: textAt(n, 'PresetName'), token: textAt(n, 'PresetToken') || null };
    case 'GetConfigurationOptions': case 'GetConfiguration':
      return { config: textAt(n, 'ConfigurationToken') || textAt(n, 'PTZConfigurationToken') };
    case 'CreatePullPointSubscription': {
      const it = child(n, 'InitialTerminationTime');
      return { initialTerminationTime: it ? it.text : null, initialTerminationSec: it ? (parseDuration(it.text) ?? 600) : null };
    }
    case 'PullMessages': return { timeoutSec: parseDuration(textAt(n, 'Timeout')), limit: Number(textAt(n, 'MessageLimit')) || 0 };
    case 'Renew': {
      const tt = textAt(n, 'TerminationTime');
      const dur = parseDuration(tt);
      const abs = !dur && tt ? (Date.parse(tt) - Date.now()) / 1000 : null;
      return { terminationTime: tt || null, terminationSec: dur ?? (abs && abs > 0 ? abs : null) };
    }
    case 'GetCapabilities': return { category: findAll(n, 'Category').map((c) => c.text) };
    case 'GetStreamUri': return { profile, protocol: textAt(n, 'StreamSetup/Transport/Protocol') };
    default: return profile ? { profile } : {};
  }
}


