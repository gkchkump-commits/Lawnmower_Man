# Lawnmower Man: the home camera (Tapo C211)

Lawnmower Man can use a **TP-Link Tapo C211** pan/tilt camera (and most Tapo cameras that turn)
as a simple home security camera:

* **Watch it live** in its own window, and turn it with the mouse, the keyboard, on-screen
  arrows or by telling the avatar ("camera left", "look at the door").
* **Arm it** when you leave. When someone walks in, Windows shows a notification, the avatar
  wakes up, looks toward the camera window and says *"Someone is at the camera."*, and a short
  video clip is saved on your PC.
* **Ask Claude** to check the camera ("is anyone at the front door?"). Claude sees a picture only
  when you allow it.

Everything runs on your PC and your home network. The video never goes to the internet through
Lawnmower Man. The only exception: a picture you allow Claude to see is sent to Anthropic as part
of the conversation (see [Privacy and security](#8-privacy-and-security)).

Contents:
[1. What you need](#1-what-you-need) ·
[2. In the Tapo app](#2-set-up-the-camera-in-the-tapo-app) ·
[3. On your router](#3-on-your-router) ·
[4. In Lawnmower Man](#4-set-up-lawnmower-man) ·
[5. Live view and controls](#5-live-view-and-controls) ·
[6. Home security](#6-home-security) ·
[7. Troubleshooting](#7-troubleshooting) ·
[8. Privacy and security](#8-privacy-and-security) ·
[9. Diagnostics](#9-diagnostics) ·
[10. How it works (technical)](#10-how-it-works-technical)

---

## 1. What you need

* The camera, already set up and working in the **Tapo app** on your phone.
* The PC with Lawnmower Man and the camera **on the same home network** (the same Wi-Fi or the
  same router; not a guest network).
* About 10 minutes. You do **not** need your TP-Link password, a Tapo Care subscription or any
  router port forwarding.

---

## 2. Set up the camera in the Tapo app

Do this once, on your phone. The camera window in Lawnmower Man shows the same list as a checklist
with ticks you can set.

1. **Check that the camera works in the Tapo app**, and install updates if the app offers them
   (for the app and for the camera's firmware).
2. **Note the versions** (only needed if you ever ask for help): tap the camera › the gear
   (**Settings**) › **Device Info**. Write down the *hardware version* (for example 2.0 or 3.0)
   and the *firmware version* (for example `1.5.4 Build 260702`).
3. **Create a Camera Account.** Tap the camera › the gear › **Advanced Settings** › **Camera
   Account** › **Understand and Agree to Use**. Choose a user name and a password (6 to 32
   characters). Use a **new** password here, **not** your TP-Link password. This Camera Account
   is what Lawnmower Man signs in with; your TP-Link login is never needed.
4. **Set the video quality to the best.** In the camera's live view, tap the quality button and
   choose **2K** (or **Best**). Lawnmower Man gets the same quality.
5. **Turn on detection**: camera › Settings › **Detection** › turn on **Motion detection** and
   **Person detection**. This is optional (Lawnmower Man also looks for people itself), but alerts
   come faster and more reliably with it.
6. **Turn privacy mode off.** Privacy mode stops the video and the motors.
7. **Don't use Tapo Care cloud recording and a microSD card at the same time.** With both on, the
   camera switches off the access Lawnmower Man uses. One of them is fine.
8. **Not needed:** "Third-Party Compatibility", your TP-Link password, port forwarding. Leave
   them as they are.

If the camera patrols or follows people by itself (*Patrol*, *Auto-tracking* or *Motion
tracking* in the Tapo app), turn that off: it fights with Lawnmower Man over where the camera
points, and every turn pauses the alarm for a moment.

---

## 3. On your router

Also once:

9. Give the camera a **fixed address**. In your router's settings this is usually called a
   **DHCP reservation** (or "static lease" / "address reservation"). Then the camera's address
   never changes and Lawnmower Man always finds it. The camera's current address is in the Tapo
   app under camera › Settings › **Device Info** (the *IP address*, for example `192.168.1.50`).
10. Keep the PC and the camera **on the same network**: not on a guest Wi-Fi, and with no "AP
    isolation" or "client isolation" for the camera's Wi-Fi.
11. **Never forward ports 554 or 2020** (or the camera) to the internet. Lawnmower Man does not
    need it, and it would let strangers try to watch your camera.

---

## 4. Set up Lawnmower Man

12. Open the camera window: in the **tray menu** choose **Home camera › Set up the home camera…**
    (later it says *Show camera window*), or in the settings drawer (gear icon) open **Home
    camera**, turn on **Home camera**, then press **Open camera window…** (the button appears
    once the switch is on).
13. In **2. Connect**:
    * **Camera address**: the camera's IP address from step 9. Or press **Find cameras** to look
      for it on your network (Windows may ask whether Lawnmower Man may use the network: allow it
      for *private* networks).
    * **Camera Account user name** and **password**: from step 3.
    * **What do you call it?**: for example *front door camera*. The avatar then says *"Someone is
      at the front door camera."*
    * Press **Test connection**. The camera does not move during the test. Each step gets a ✓, or a
      ✗ with a hint. When it says *Everything works*, press **Save**. The live picture appears.
14. Press **Calibrate…** (in the banner at the top of the window, or in the gear's **3. Pan and
    tilt**) and then **Start**. The
    camera turns a little to the side, up and down, and back; it takes about 30 seconds. This
    teaches Lawnmower Man which way the camera turns and how far, so the arrows and
    click-to-center go the right way. If the room is too dark to measure, it turns the camera and
    asks you **which way the camera turned** (not the picture: the picture moves the other way),
    with only the answers for the direction it just tried.
15. When you leave home, press **Arm** (top of the camera window). You have 30 seconds to leave
    the room. The first time, Windows may ask whether Lawnmower Man may show notifications: allow
    it. **The PC must stay on and Lawnmower Man must keep running** for the alarm to work (see
    [Arming](#arming)).

The password is stored encrypted for your Windows user (see [Privacy and
security](#8-privacy-and-security)). It is never shown again; the form only says that one is
saved. **Forget the saved password** removes it.

The camera window can stay closed: closing it only hides it. While the alarm is armed, the app
keeps watching in the background.

---

## 5. Live view and controls

### Mouse and on-screen arrows

* **Click the picture**: the camera turns so that the spot you clicked moves to the middle.
* **Double-click**: full screen.
* **Arrows** (bottom right of the picture): click for a step, **press and hold** to keep
  turning; it stops when you let go. **⌂** goes back to the home position.
* **Positions** (sidebar): the camera's saved positions (presets), including the ones you made
  in the Tapo app (**Refresh** loads them again). **Save current position…** stores a new one;
  **Make this the home position** picks the one ⌂ goes to.

### Keyboard (camera window focused)

| Key | What it does |
|---|---|
| ← → ↑ ↓ | Turn the camera (hold to keep turning) |
| Shift + arrow | A big turn |
| Alt + arrow | A small turn |
| H or Home | Back to the home position |
| 1 – 8 | Go to a saved position (in the list's order) |
| Space | Copy a picture to the clipboard |
| A | Arm or disarm |
| E | Show or hide the events |
| F | Full screen |
| Esc | Stop the camera / close a window |
| ? | This list in the window |

### Telling the avatar (quick commands)

Typed or spoken to the avatar, these run at once, without asking Claude:

| You say | What happens |
|---|---|
| "camera left", "camera up", "turn the camera right", "tilt down" | One step that way |
| "camera left a bit", "turn the camera slightly to the right" | A small step |
| "camera all the way left", "pan right a lot" | A big step |
| "look at the door", "show me the window", "go to desk" | Goes to the saved position with that name |
| "camera home", "center the camera" | Back to the home position |
| "arm the camera", "turn on the alarm" | Arms (with the time to leave) |
| "disarm the camera", "turn off the alarm" | Disarms |
| "show me the camera" | Opens the camera window |

The whole sentence must be the command (at most 8 words, "please" and "can you" are fine).
Anything else goes to Claude as usual. You can turn this off: camera window › gear › **5. Claude
and the avatar** › **Quick commands**.

### Asking Claude

Claude has these camera tools:

| Tool | What Claude can do | Asks you first? |
|---|---|---|
| `camera_status` | Is the camera online, armed, where does it point | no |
| `camera_events` | The recent detections | no |
| `camera_snapshot` | See one picture | **yes**, every time (setting *Claude may look through the camera*) |
| `camera_look` | Turn the camera or go to a saved position | **yes**, every time (setting *Claude may turn the camera*) |
| `security_arm` | Arm the alarm | **always yes**; Claude can **never disarm** |

Examples: *"Is anyone at the front door?"*, *"Turn the camera to the window and tell me if it is
open."*, *"Did the camera see anything this afternoon?"*. When Claude wants to look, an approval
card shows up: **Allow** sends one picture, **Deny** sends nothing. Claude is told to describe
pictures briefly and factually and never to guess who someone is. In the camera window's gear ›
**5. Claude and the avatar** you can set looking and turning to *Always* (no card) or *Never*
(Claude does not even get the tool).

---

## 6. Home security

### Arming

* **Arm** in the camera window (or **A**), **Armed** in the tray menu's *Home camera* submenu,
  **Security: Armed** in the settings drawer, or say "arm the camera".
* After arming you have **30 seconds** to leave (the button counts down; click it to cancel).
  Change this under gear › **4. Alerts and recording** › *Time to leave after arming*.
* An armed alarm stays armed when you restart the PC or the app.
* While disarmed nothing is checked or recorded.
* **The PC watches, not the camera.** The alarm only works while the PC is on and Lawnmower Man
  is running. While armed, the app keeps Windows from going to sleep (the screen may still turn
  off). Turn on gear › **4. Alerts and recording** › **Start Lawnmower Man with Windows**, so an
  armed alarm comes back after a restart or a Windows update (it starts in the tray; the camera
  window offers this the first time you arm). Quitting while armed asks first.
* **When an armed camera is not watching**, it never just says *Armed*: the tray, the arm button
  and the avatar's pill say **Armed · camera offline** (the camera does not answer) or **Armed ·
  not watching** (no video for 30 seconds). After a minute you also get a notification, and the
  avatar says *"I lost the camera."* The app reconnects by itself (and at once after the PC wakes
  up); **Retry** in the camera window tries right away.

### What makes an alert

* **People.** By default an alert needs **this PC's person detector to agree** (*Double-check
  people on this PC*). The camera's own person detection (step 5) makes it faster. If the PC's
  detector is not running, the camera's own detection alone counts after 6 seconds, and the event
  is marked *unconfirmed*.
* **Movement alone** is only listed in the events (*List movement too*), not announced, unless you
  choose *Windows notification for: People and movement*.
* **Not an alert:** the camera turning (and 1–2 seconds after it), the first 10 seconds after the
  video (re)starts, and the whole picture changing at once (the night vision switching on at
  dusk, the lights being turned on).
* **Sensitivity** (*Low / Medium / High*) sets how sure the detectors must be.
* *At most one alert every* 60 seconds (default) for the same kind of event. A person who
  arrives within that minute is told once the minute is up, if they are still there.
* **Quiet hours** (for example `23:00-07:00`): no spoken alerts and silent notifications in
  that time; everything is still recorded.

### What happens on an alert

1. A **Windows notification** "Person at the camera" with the time and a small picture. Click it
   to see the clip.
2. The **avatar** comes back if it was hidden (*Bring the avatar back on an alert*), looks toward
   the camera window and says *"Someone is at the camera."* (*The avatar says it*).
3. A **clip** is recorded: from 5 seconds before the event started (for movement that turned out
   to be a person: 5 seconds before the movement) until 10 seconds after the last sign of the
   person (at most 2 minutes per file; a longer event continues in a new file).
4. Optional, **off by default**: **Claude describes alerts**. The alert picture is sent to Claude,
   which says one sentence about it ("A person in a grey jacket is standing at the door."). The
   first time you turn it on, a card explains that pictures of your home go to Anthropic. It never
   interrupts a conversation you are having and stays quiet during quiet hours.

### Clips

* Saved in `Videos\Lawnmower Man\Security\<date>\` as `<time>-person-<id>.mp4`, with a picture
  (`.jpg`) and a small description (`.json`) next to it. A clip that started as movement and
  turned out to be a person keeps `-motion-` in its file name.
* The **Events** list (sidebar, **E**) shows today's events first; click one to play it, delete it
  or open its folder. **Open clips folder** is also in the tray menu and the settings drawer.
* Clips older than **7 days** are deleted, and the oldest go first when they use more than
  **5 GB**. Change both under gear › **4. Alerts and recording** (*Keep clips for*, *Use at
  most*, *Clips folder*).

---

## 7. Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| **Sign-in failed** | The TP-Link login was used instead of the Camera Account, or a typo | Enter the Camera Account (step 3) again and press **Test connection**. Lawnmower Man does not try again by itself: repeated wrong passwords can lock the PC out of the camera for a while |
| *"The camera's clock is … s off"*, or sign-in fails after some hours | The camera's clock is wrong (it cannot reach the internet to set it) | Let the camera reach the internet, or restart it (unplug it for 10 seconds). Lawnmower Man adjusts for the difference, but a clock that keeps drifting can still break the sign-in |
| **Offline** / unreachable | Wrong address, the address changed, guest Wi-Fi, AP isolation, the camera unplugged | Give the camera a fixed address (step 9), put both on the same network (step 10), or press **Find cameras**. The app tries again by itself (2 s, 5 s, 10 s, 30 s, then every minute); **Retry** tries at once |
| The tray says **Armed · camera offline** or **Armed · not watching** | The camera stopped answering, or its video stopped, while armed | See *Offline* above, and *The live view is busy*. Nothing is watched until it reads plain **Armed** again |
| The live view is **busy** or drops when the phone app watches | The camera allows only **two** live streams at a time, the Tapo app included | Close other viewers (the phone app's live view, a recorder, Home Assistant) |
| No video and no connection at all, although the address is right | Tapo Care cloud recording **and** a microSD card are both on | Turn one of them off (step 7) |
| **Pan and tilt does nothing** | Privacy mode is on, or this firmware has no ONVIF pan/tilt | Turn privacy mode off in the Tapo app; the arrows work again within a few seconds. If the window says pan and tilt are not available, press **Copy diagnostic report** (§9) and send it |
| The camera turns **the wrong way** | Mirrored axes (common on Tapo cameras) | **Calibrate…** again, or use *Swap left and right* / *Swap up and down* (gear › **3. Pan and tilt**) |
| Clicking the picture turns **too far or not far enough** | Not calibrated, or calibrated in the dark | **Calibrate…** with the lights on |
| **No camera events** (only "this PC" detections) | Detection is off in the Tapo app, or the firmware does not send events | Turn on motion and person detection (step 5). The PC's own detection still works |
| *"This PC cannot decode this stream"* | The camera sends H.265 and this PC has no decoder for it | gear › **2. Connect** › *Ports and stream* › **stream2**, or a lower video quality in the Tapo app |
| **No notifications** | Windows notifications are off for the app, or *Do not disturb* / Focus is on | Windows **Settings › System › Notifications › Lawnmower Man**: on. The avatar's announcement and the events list still work |
| The video stops and comes back every ~15 seconds | The camera ends the video connection when it gets no "still watching" message in time | Should not happen (the app sends one every 10 seconds). If it does, press **Copy diagnostic report** (§9) and send it |
| *The video component is missing* | An antivirus program removed the bundled `go2rtc.exe` | Restore it from the antivirus quarantine, or reinstall Lawnmower Man. Pan, tilt and the camera's own events still work without it |
| False alarms at dusk or when the camera patrols | Night vision switching, Tapo patrol/auto-tracking | Turn off patrol/auto-tracking in the Tapo app; lower the *Sensitivity* |

---

## 8. Privacy and security

* **What stays on your PC:** the live video, the detections, the clips and the event list. The
  person detector runs on this PC. Nothing is uploaded by Lawnmower Man, **except** the pictures
  you let Claude see (an approval card each time by default) and, only if you turn it on, the
  alert pictures for *Claude describes alerts*. Those are sent to Anthropic as part of the
  Claude conversation.
* **The camera password** is encrypted with your Windows login (Windows DPAPI, through
  Electron's `safeStorage`) in `%APPDATA%\Lawnmower Man\tapo\credentials.json`. It is never in
  `settings.json`, in a log file or on a command line, and it is never sent to the app's
  windows. If Windows cannot encrypt it, the app keeps it in memory only and asks again after a
  restart. DPAPI protects it from other Windows users, not from other programs running as you.
* **On your network the camera's video is not encrypted** (that is how RTSP works on these
  cameras). Use a home network you trust; keep the camera off guest and public networks.
* The video component (**go2rtc**) listens **only on this PC** (`127.0.0.1`), behind a random
  password that changes every start; it offers nothing to the network. **go2rtc never gets the
  Camera Account**: it pulls the video through a small proxy in the app (also `127.0.0.1` only,
  behind a random token), which signs in to the camera with Digest. If something at the camera's
  address asks for an unencrypted (*Basic*) sign-in, the password is not sent, and the window
  says so.
* **Claude never hears the camera's address** (or the user name): the camera tools' answers are
  fixed sentences, and anything the camera sends (names, error texts) is shortened and cleaned
  first. *Always* for turning the camera is not used while the alarm is armed: then Claude asks
  each time.
* The camera password must have at least 4 characters (Tapo asks for 6 to 32).
* The app talks only to the address you entered, and only if it is a home-network address
  (`192.168.x.x`, `10.x.x.x` and similar). The app's windows cannot reach your network or the
  internet themselves; all camera traffic goes through the app's main process.
* **Never forward ports 554 or 2020** to the internet (step 11).
* **The camera's own cloud** connection (Tapo app, Tapo Care) is separate from Lawnmower Man and
  works as before.
* Anyone who can talk to the avatar (for example with hands-free listening on) can also say
  "disarm the camera". If that matters to you, turn off **Quick commands**; Claude itself can never
  disarm.
* The app never changes the camera's settings, password or clock.

---

## 9. Diagnostics

* **Test connection** (camera window › gear › **2. Connect**) shows each step: the address, the
  ONVIF port, the clock, one sign-in, the services, the profiles, pan/tilt, the camera's events
  and the video. A ✗ comes with a hint.
* **The log**: tray menu › **Open logs folder** › `main.log`. Lines about the camera start with
  `[tapo]`. Passwords never appear in it.
* **Copy diagnostic report** (camera window › gear › **2. Connect**, under the test): runs the
  connection test plus the camera's streams, services and serial number, adds what the app sees
  right now (connection, video, pan/tilt, events, detector, armed), and copies it as JSON for you
  to paste into a message. It leaves out the password, the user name and the address (shown as
  `<camera>`), cuts the serial number to 4 characters, and does not move the camera. It sends
  nothing anywhere.
* **For developers**, the same from the source code (and optionally one small test move):

  ```
  npm run probe:tapo -- --host 192.168.1.50 --user <Camera Account user name> --move
  ```

  It asks for the password (hidden; or set `TAPO_PASSWORD`); `--move` turns the camera a small
  step right and back; `--json` prints JSON.

---

## 10. How it works (technical)

### 10.1 Architecture

```
Tapo C211 ──ONVIF SOAP :2020──► Electron main: electron/tapo/
          ──RTSP :554 (1 session)──► rtsp-auth-proxy (main, Digest) ──► go2rtc (127.0.0.1 only) ──fMP4──► stream-relay
                                                                         ├─► recorder (GOP ring, clips)
                                                                         └─► MessagePort ─► camera window worker
                                                                                             (WebCodecs decode, motion,
                                                                                              person detector, shift estimate)
main: onvif-client · ptz (+ calibration, watchdogs) · events (PullPoint) · security-engine (pure)
      alerts (Notification) · credentials (safeStorage) · camera-mcp ─► electron/claude-session.js ─► claude -p
```

* **Control:** ONVIF Profile S over plain HTTP on port 2020, hand-written SOAP in main
  (`electron/tapo/onvif-soap.js`, `onvif-client.js`), WS-Security UsernameToken
  PasswordDigest with the Camera Account, the camera clock's offset applied to `Created`.
  Requests to one camera are serialized; event pulls (PullMessages, Renew, Unsubscribe) have
  their own connection, while GetEventProperties and CreatePullPointSubscription go through the
  control queue. Renew follows the camera's own TerminationTime.
* **Health:** every 2 s main checks whether the video has stalled for 10 s or the events keep
  failing; then it asks the camera for its time (no sign-in, so no lockout risk), and a camera
  that does not answer is shown as offline and retried with backoff. An armed camera that is not
  watching is shown as such (`status.security.watching`: `offline` / `no-video`), with one
  notification after 60 s. Armed, a `powerSaveBlocker` keeps the PC from suspending;
  `powerMonitor` *resume* reconnects at once.
* **Pan/tilt** (`ptz.js`): RelativeMove steps as fractions of the view (converted with the
  calibrated `viewUnitsX/Y`), press-and-hold as ContinuousMove with heartbeats, a watchdog `Stop`
  after every move and a Stop fallback chain (so a motor can never grind at its end stop),
  presets, home. `calibration.js` turns the camera +0.2 units per axis and measures the picture
  shift in the worker (`src/tapo/worker/shift.js`, block matching on 128×72 luma) for the axis
  signs and the units per view. When the camera reports that it moved (GetStatus position), the
  worker waits for the picture to move too (up to 6 s), so a video that lags the motor by a second
  or two is still measured; without GetStatus, msPerUnit keeps its previous value. Each
  measurement is logged (`[tapo] calibration x +0.2: shift …`).
* **Video:** the bundled **go2rtc 1.9.14** (`scripts/fetch-go2rtc.mjs`, SHA-256 pinned) pulls one
  RTSP session only while the stream is needed (window visible, armed, calibrating, recording or
  a snapshot) and serves fragmented MP4 on loopback behind random Basic credentials; modules
  limited to api/mp4/rtsp, its RTSP server off. Its source is
  `rtsp://127.0.0.1:<proxy port>/<random token>/stream1`: **`rtsp-auth-proxy.js`** in main forwards
  RTSP to the camera, answers its Digest challenge (MD5 or SHA-256, with or without qop), never
  answers a Basic one (it reports `insecure` and closes), tries a refused sign-in once, rewrites
  the camera's URLs in both directions and ends the camera's session with TEARDOWN when the
  video stops. go2rtc's config and environment hold no camera credentials. Main parses the fMP4 (`fmp4.js`) and relays
  frames over a `MessagePortMain` to a worker in the hidden camera window, which decodes with
  WebCodecs `VideoDecoder` (hardware first). The renderer never opens a socket; the CSP and the
  loopback-only request filter are unchanged.
* **Detection:** the camera's PullPoint events (`events.js`: renew, not recreate; de-noised) and
  the worker's local motion and person detection (MediaPipe ObjectDetector, EfficientDet-Lite0
  int8) are fused in `security-engine.js`, a pure state machine (exit delay, suppression while
  moving and after global changes, motion → person upgrade, cooldown, quiet hours). Camera
  events already active when watching starts (exit delay over, re-armed, resubscribed) count only
  after they fall and rise again.
* **Clips:** the recorder keeps a GOP ring (pre-roll; held from an event's start while it is not
  recorded yet, ≤ 32 MB) and writes stream-copied fMP4 clips + `.jpg` + `.json`; retention by age
  and size; served to the windows as `app://lawnmower/__clips/<date>/<file>` with single-range
  support (the file's real path must stay inside the clips folder; a record names only its own
  files, so deleting an event never touches anything else).

Settings are the `tapo` and `security` groups of `settings.json`; the password is not a setting
(`<userData>/tapo/credentials.json`).

### 10.2 Claude: the camera tools (MCP)

`electron/tapo/camera-mcp.js` is an MCP server named **`lawnmower-camera`**. The app offers it to
the Claude CLI in two ways (`electron/claude-session.js`):

* **G1, in-process (default).** The CLI's `initialize` control request carries
  `sdkMcpServers: ['lawnmower-camera']`; the CLI then sends the server's JSON-RPC messages as
  `control_request {subtype: 'mcp_message', server_name, message}` over the stream-json channel
  the app already uses, and the app answers `control_response {subtype: 'success', request_id,
  response: {mcp_response}}` (a notification gets `{jsonrpc: '2.0', result: {}, id: 0}`).
  Requests are handled concurrently; answers for a CLI process that has gone are dropped.
* **G2, loopback HTTP (automatic fallback, chat and assistant modes only).** In agent mode the
  in-process server is kept, because Claude's Bash tool could read the token from the CLI's
  environment and call the tools without a card. If the CLI's `system/init` lists none of the
  server's `mcp__lawnmower-camera__*` tools (and the server is not still `pending`), the session
  switches to HTTP for the rest of the app session and restarts the CLI after the running turn
  (resuming the conversation): it calls the server's `startHttp()`, writes
  `<userData>/mcp/lawnmower-camera.json` =
  `{"mcpServers":{"lawnmower-camera":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer ${LM_MCP_TOKEN}"}}}}`,
  passes `--mcp-config <file>` (with `--strict-mcp-config` kept), and puts the token only in the
  CLI's environment (`LM_MCP_TOKEN`, plus `127.0.0.1,localhost` in `NO_PROXY`). The endpoint
  (`electron/tapo/mcp-http.js`) wants the bearer token and refuses any request with an `Origin`
  header or another `Host`. The server object's interface:

  ```js
  /** @typedef {{ name: string,
   *   handle: (message: object) => Promise<object|null>,           // one JSON-RPC message; null for a notification
   *   startHttp?: () => Promise<{ url: string, token: string }>,     // 'http://127.0.0.1:<port>/mcp'; idempotent while running
   *   stopHttp?: () => Promise<void> }} SdkMcpServer */
  ```

  If the server is listed as connected but its tools are missing, or it has no `startHttp`, the
  session only logs a warning (HTTP would not help).

**Permissions** (`TapoService.toolPermissions()` → `--allowedTools` / `--disallowedTools`):
`camera_status` and `camera_events` always allowed; `camera_snapshot` and `camera_look` allowed
with *Always* (`camera_look` not while armed), disallowed with *Never*, otherwise the existing
approval card; `camera_snapshot` with a `preset` refuses unless turning is *Always* and the alarm
is disarmed (use `camera_look` first); `security_arm` always asks. A change restarts the CLI after the running turn (the spawn key includes the server
names, the permissions, the persona context and the transport).

**Persona** (`electron/persona.js`): when the camera is set up, every mode gets a paragraph naming
the camera ("Home camera: the user has a Tapo pan/tilt security camera called …") and the tools it
may use; tools the user set to *Never* are left out with "The user has not allowed you to …". In
chat mode the "no tools" line becomes "your only tools are the home camera tools below".

**Live check** (2026-10-10, Claude Code **2.1.296**, chat mode, one short turn): G1 works; the
model called `mcp__lawnmower-camera__camera_status` in its first turn. Re-run it with
`LIVE_CLAUDE=1 LIVE_CLAUDE_CLI=<path to claude> npx vitest run tests/unit/systems/claude-live.test.js -t "camera tools"`
(`LIVE_CLAUDE_REPORT=<file>` writes the findings as JSON). It uses a stand-in camera server, not a
real camera.

### 10.3 The camera simulator

`tools/tapo-sim/` (`npm run sim:tapo`, details in [its README](../tools/tapo-sim/README.md)) is
a Tapo C211 on loopback for tests and development:

* **ONVIF** device/media/PTZ/events/imaging services with WS-Security PasswordDigest, the clock
  check and nonce replay detection, and the Tapo quirks as switches: mirrored pan, inverted
  tilt, minimum step, Stop ignored on pan, RelativeMove acting continuous, privacy mode
  (malformed answer, then HTTP 500), the PullPoint drop after ~10 s, a subscription cap,
  the 18 events/s flood with false blips, slow answers.
* **RTSP** with Digest auth (realm `TP-Link IP-Camera`), TCP interleaved only, the 15 s session
  timeout (advertised in the `Session` header, which is what makes go2rtc send its keepalive
  in time), two sessions at most. It streams pre-encoded H.264 GOPs
  (`tests/fixtures/tapo/sim/`, made by `tools/tapo-sim/make-fixtures.sh` with FFmpeg) chosen
  by the virtual pan/tilt position, so a real calibration measures real shifts (truth:
  `viewUnitsX` 0.8, `viewUnitsY` 1.2); a green walking figure for the person scenario.
* A **control API** (`/state`, `/scenario`, `/quirks`, `/ptz`, `/reset`) and the same from code
  (`startSim()` in `tools/tapo-sim/index.mjs`).

### 10.4 Tests

| What | Where | Runs |
|---|---|---|
| Simulator self-tests | `tests/unit/tapo-sim/sim-self.test.js` | `npx vitest run tests/unit/tapo-sim` |
| The app's camera modules against the simulator (ONVIF, PTZ, events, go2rtc relay, recorder) | `tests/unit/tapo-sim/*-against-sim.test.js` | same; the relay/recorder ones skip with a reason without the go2rtc binary |
| MCP hosting, permissions, G2 fallback | `tests/unit/systems/claude-session-mcp.test.js` (fake CLI `tests/fixtures/fake-claude.mjs`, `FAKE_CLAUDE_IGNORE_SDK_MCP=1` emulates a CLI without G1) | `npx vitest run` |
| The real camera MCP server of a running `TapoService` in a real `ClaudeSession`, wired like `electron/main.js` (G1, and G2 through the service's own HTTP endpoint) | `tests/unit/tapo/claude-camera-tools.test.js` | `npx vitest run` |
| Live gate | `tests/unit/systems/claude-live.test.js` | `LIVE_CLAUDE=1` only |
| The whole feature in the real Electron app | `scripts/tapo-e2e.mjs` | `npx vite build && xvfb-run -a node scripts/tapo-e2e.mjs [--shots <dir>] [--report <file>]` |

`scripts/tapo-e2e.mjs` starts the simulator, then the real app with a throwaway user-data folder,
the real go2rtc and the fake Claude CLI, and checks: setup through the form → online, live video
at ≥ 8 fps and not black; nothing leaves loopback, go2rtc listens on 127.0.0.1 only, the password
is in no file and on no command line; calibration (mirrored pan and inverted tilt found, view
units within ±40 % of the truth), D-pad, hold, click-to-center, a preset, home, never an end
stop; arm → a person → event confirmed locally, notification, the avatar's line, a clip that
parses with its `.jpg`/`.json`, the player over `app://…/__clips` with Range; the describe turn
with one picture; the MCP approval card, *Always* and *Never*; privacy mode; the camera going
offline and coming back; a clean quit (Unsubscribe, TEARDOWN, go2rtc gone); no wrong password
ever sent. Exit 0 = all passed, 1 = a check failed, 2 = cannot run here (no `dist/tapo`, go2rtc
or `electron/tapo`). The CI job **`tapo-e2e-linux`** (`.github/workflows/ci.yml`) runs it on
Ubuntu under xvfb and uploads the report and screenshots when it fails.
