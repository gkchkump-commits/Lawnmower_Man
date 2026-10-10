# Tapo C211 camera simulator (test-only)

A stand-in for the Tapo C211 that the Home camera feature talks to in tests, in CI and for manual
testing without a camera: the ONVIF service the app uses for pan/tilt and events, an RTSP server
whose picture follows the virtual pan/tilt position, the Tapo misbehaviours the research found,
and a control API to script what happens in front of the camera. Pure Node, loopback only, no
dependencies. It is never shipped with the app.

```bash
npm run sim:tapo                    # ONVIF 12020, RTSP 10554, control 12021 (fixed ports)
node tools/tapo-sim --quirks ideal  # random ports; prints {"event":"ready","onvif":…,"rtsp":…,"control":…}
```

To point the app at it: start the app with `LAWNMOWER_TAPO_ALLOW_LOOPBACK=1`, open the Home camera
window, enter host `127.0.0.1`, user `camacct`, password `se&cret`, and under *Advanced* the ONVIF
port 12020 and the RTSP port 10554. Then script the scene:

```bash
curl -s localhost:12021/state | jq .ptz
curl -s -XPOST localhost:12021/scenario -d '{"person":true}'
curl -s -XPOST localhost:12021/quirks   -d '{"stopIgnoredOnPan":true}'
```

In tests: `const sim = await startSim()` from `tools/tapo-sim/index.mjs` (random ports), then
`sim.set({ person: true })`, `sim.set({ quirks: { … } })`, `sim.state`, `sim.callsOf('RelativeMove')`,
`await sim.close()`.

## What it emulates

| Part | Behaviour |
|---|---|
| ONVIF (`onvif-server.mjs`) | SOAP 1.2 on plain HTTP; `/onvif/device_service`, every other service at `/onvif/service`, subscriptions at `/event-<n>_<port>`; Tapo identity (`tp-link`, `Tapo C211`); profiles `profile_1` (H264 2304×1296) and `profile_2` (640×360) with `PTZConfiguration_1`; GetCapabilities lists Analytics first (a client must take PTZ/Events from their own sections); `GetSnapshotUri` fails |
| WS-Security | PasswordDigest verified, `Created` within ±10 s of the camera clock (`clockSkewSec` moves that clock), reused nonces refused; `GetSystemDateAndTime` works without auth; a bad login is HTTP 400 `ter:NotAuthorized` |
| PTZ motor (`ptz-model.mjs`) | x, y in [-1, 1]; pan 0.35 units/s, tilt 0.25; RelativeMove (speed ignored), ContinuousMove (until Timeout/Stop), AbsoluteMove, Stop, GetStatus with MoveStatus; 8 preset slots with `1` Door and `2` Window; time pushed against an end stop is counted (`state.ptz.endStopMs`) |
| Events (`events-model.mjs`) | CreatePullPointSubscription, PullMessages, Renew, Unsubscribe; topics CellMotionDetector/Motion (`IsMotion`), PeopleDetector/People (`IsPeople`), TamperDetector/Tamper (`IsTamper`); Initialized messages after subscribing, Changed on every edge of `scenario.motion/person/tamper`; Source items before Data |
| RTSP (`rtsp-server.mjs`) | `/stream1` 640×360 and `/stream2` 320×180 H.264 High at 15 fps, PCMA/8000 silence when its track is set up, `/stream8` is 404; Digest realm `TP-Link IP-Camera`; TCP interleaved only (UDP → 461); 2 sessions, the Tapo app's viewers included (`scenario.viewers`), then 453; a session with no RTSP request for 15 s is dropped (RTCP does not count) |
| Picture | The segment nearest to where the lens points: a 9 × 5 grid of 1-second GOPs cut from one panorama; when the view changes the next frame starts the new segment at its IDR, so the picture moves within a frame of the motor. `scenario.person` swaps in a green walking figure (around the centre), `scenario.privacy` a "Privacy Mode is on" picture |

### Quirk switches (`--quirks tapo`, the default)

| Quirk | Tapo default | Effect |
|---|---|---|
| `mirrorPan` | true | ONVIF +x turns the lens left (robotricks C211) |
| `invertTilt` | true | +y tilts down (gladys-tapo) |
| `minEffectiveStep` | 0.05 | smaller RelativeMove translations: 200 OK, no motion |
| `relativeActsContinuous` | false | a RelativeMove keeps turning until Stop (C260) |
| `stopIgnoredOnPan` | false | Stop does not stop the pan axis; a zero-velocity ContinuousMove does (C520WS) |
| `getStatusFails` | false | GetStatus answers HTTP 500 (C500) |
| `homeSupported` | false | GotoHomePosition |
| `setPresetFails` | false | SetPreset faults |
| `absoluteFails`, `noPtz`, `noEvents` | false | AbsoluteMove refused / no ONVIF PTZ / no PullPoint |
| `scenario.privacy` | false | PTZ: a malformed status line, then HTTP 500, alternating; detection events stop; picture → placeholder (`privacyKillsStream`: no frames) |
| `pullDropAfterMs` | 10000 | an empty PullMessages is held this long whatever its Timeout, then answered with `Content-Length: 0` + bytes after `Connection: close` (Node: "Data after `Connection: close`"); 0 honours the Timeout |
| `rejectInitialTerminationTime` | true | CreatePullPointSubscription with it → `ter:InvalidArgVal` (C500) |
| `maxSubscriptions` | 3 | the next CreatePullPointSubscription → Fault "error" |
| `concurrent401` | false | a control request that starts while another is answered gets HTTP 401 |
| `latencyMs` | 40 | the camera's answer time per control request |
| `eventFlood` | true | 18 duplicate `true` messages/s while on, a single `false` every 60 |
| `noFallingEdge` | false | the falling edge is never sent |
| `subscriptionLifetimeSec` | 600 | without Renew the subscription expires |
| `sessionTimeoutSec`, `maxRtspSessions` | 15, 2 | RTSP |
| `rtspAdvertiseTimeout` | true | the SETUP answer says `Session: <id>;timeout=15`; go2rtc 1.9.14 then sends OPTIONS every 10 s. `false`: a camera that does not say it, and go2rtc's default keepalive is too slow: the session is dropped and re-established every ~15 s |
| `clockToleranceSec`, `replayCheck`, `xaddrHost`, `rebootMs` | 10, true, null, 3000 | |

`--quirks ideal` is a well-behaved ONVIF camera: standard axes, no thresholds, honest timeouts,
one path per service (`/onvif/ptz_service`, …), other tokens (`MainStream`, `PtzConfigMain`) and
a snapshot profile without PTZ listed first. It tells a client bug from a missing workaround.

### Control API (`control.mjs`, loopback; requests with an `Origin` header are refused)

`GET /state` → `{ device, ptz, presets, scenario, quirks, subscriptions, rtspSessions, authFailures, bootCount, calls }`;
`POST /scenario {motion?, person?, tamper?, privacy?, offline?, clockSkewSec?, viewers?, reboot?}`
(offline closes every socket and refuses connections; reboot = offline for `rebootMs`, subscriptions
and sessions lost); `POST /quirks {…}`; `POST /ptz {x, y}` (place the camera, no motion);
`POST /reset`. `calls` records every request: `{ t, service, op, args, status, why? }` (never a
password or digest).

## Geometry and the truth the calibration is checked against

`geometry.mjs`: one pan grid step is 0.1 ONVIF units and 80 px of the 640 px view, one tilt step
0.2 units and 60 px of 360 px. So a full view width is **0.8 units** (`viewUnitsX`) and a full
view height **1.2 units** (`viewUnitsY`); the smallest move the camera makes is 0.05
(`minEffectiveStep`). The grid spans ±0.4 units on both axes; beyond it the edge segment is shown
(GetStatus still reports the real position). With the Tapo quirks a correct calibration finds
`invertPan: true`, `invertTilt: true`.

While a motor turns, odd and even frames show the two cells on either side of the position on
that axis (`gridCellMoving`), so the picture changes on every frame as real video does while the
camera turns. Without this the picture would rest on one cell for 4–5 frames between grid steps,
and a "has the picture settled?" check (the calibration's measurement) would stop mid-move and
measure half the real shift (seen: `viewUnitsX` 1.6 instead of 0.8).

## Fixtures

`tests/fixtures/tapo/` (committed, about 2.4 MB) is made by `tools/tapo-sim/make-fixtures.sh`
(ffmpeg + libx264): `sim/stream1|stream2/p{i}_t{j}.h264` (i = -4..4, j = -2..2), `p{i}_t{j}_person.h264`
(|i|, |j| ≤ 1), `privacy.h264` and `sim/manifest.json` (geometry, SHA-256 of every file). Each segment
is one 15-frame GOP with an AUD before every frame, one slice per frame and SPS/PPS before the IDR;
all segments of a stream share byte-identical SPS/PPS (x264 `stitchable`). The panorama is ffmpeg's
own Mandelbrot source (no third-party image), desaturated so that the only pure green is the
figure the stub person detector (`LAWNMOWER_TAPO_FAKE_DETECTOR=1`) looks for. Also for the fMP4
parser: `bframes.mp4` (B-frames, one moof per frame), `bframes-gop.mp4` (one moof per GOP, multi-sample
`trun`) and `go2rtc-sample.mp4` (3 s of `/api/stream.mp4` from go2rtc 1.9.14 fed by this simulator,
with a pan in the middle: `node tools/tapo-sim/capture-go2rtc-sample.mjs`).

## Tests

`tests/unit/tapo-sim/sim-self.test.js` tests the simulator with a client of its own. The other files
in that folder drive the app's camera modules (`electron/tapo/*`) against it and skip, saying so in
their titles, while those modules are not present; the go2rtc parts also skip without the binary
(`npm run fetch:go2rtc`, or `LAWNMOWER_GO2RTC=<path>`).
