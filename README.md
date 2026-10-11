# Lawnmower Man

A holographic desktop avatar for Claude. A glowing wireframe head floats on your desktop, listens, thinks and talks back, with lip-sync, blinks and eyes that follow your cursor.

<p align="center"><img src="docs/screenshots/hero.jpg" width="390" alt="The avatar and its chat panel on a dark desktop, speaking a reply that is still streaming in"></p>

<p align="center"><em>The real app (relief renderer) mid-reply, captured from Electron with its transparent window composited over a dark desktop.</em></p>

* **Brain:** your locally installed [Claude CLI](https://docs.claude.com/en/docs/claude-code). The app runs one persistent `claude -p` session over stream-json and uses your existing login; no API key is needed.
* **Face:** a real-time WebGL hologram on your GPU, built from the frames of the reference video (`docs/reference/`).
* **Voice:** runs locally on an NVIDIA GPU. Speech to text is [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`large-v3-turbo`); text to speech is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). Both are tuned for an **RTX 5070 Laptop GPU (8 GB, Blackwell)** and fall back to the CPU automatically.
* **Eyes (optional):** your webcam. Turned on, the avatar makes eye contact, notices when you come and go and smiles back, with face tracking that runs on your PC; Claude sees a picture only when you let it. Off by default ([docs/CAMERA.md](docs/CAMERA.md)).
* **Home camera (optional):** a TP-Link **Tapo C211** pan/tilt camera on your home network becomes a simple home security camera. Watch and turn it in its own window (or say "camera left"), arm it when you leave, and when someone walks in you get a Windows notification, the avatar turns toward the camera window and tells you, and a short clip is saved on your PC. Claude can check the camera for you; it sees a picture only when you allow it. The video stays on your PC and your network. Off by default ([docs/TAPO.md](docs/TAPO.md)).

![Reference video frame vs. the relief renderer vs. the procedural renderer](docs/screenshots/compare_rest.jpg)

*Left: a frame of the reference video. Middle: the default "relief" renderer, live and fully rigged. Right: the alternative fully 3D "procedural" renderer.*

---

## Install (testers)

For Windows 11 (10 works too). No Node, git or Python needed; no admin rights.

1. **Download** `Lawnmower-Man-Setup-<version>.exe` from the [Releases page](https://github.com/gkchkump-commits/Lawnmower_Man/releases) (test builds are marked *Pre-release*; `SHA256SUMS.txt` lists the checksums). Rather not install anything? `Lawnmower-Man-<version>-portable.exe` runs as is.
2. **SmartScreen:** the build is not code-signed, so Windows says *"Windows protected your PC"*. Click **More info → Run anyway**. (Your browser may also ask whether to keep the download.)
3. **Install:** the installer is for your user only. Pick a folder or keep the default (`%LOCALAPPDATA%\Programs\Lawnmower Man`); it adds Desktop and Start-menu shortcuts and starts the app at the end.
4. **Claude CLI (required).** Lawnmower Man is a face for *your own* [Claude Code](https://code.claude.com/docs/en/setup) CLI, which needs a Pro, Max, Team, Enterprise or Console account. If the CLI is missing or not signed in, the app shows a card with the steps and Copy buttons:
   ```powershell
   irm https://claude.ai/install.ps1 | iex     # in PowerShell: the official installer (or: winget install Anthropic.ClaudeCode)
   claude                                      # in a NEW terminal window: sign in once, then type /exit
   ```
   Then press **Retry** on the card; no restart needed. The app never runs these commands for you.
5. **Voice:** replies are spoken with a Windows voice right away (choose one under *Settings › Voice*). For voice input and the natural Kokoro voice, choose **Set up local voice…** in the tray menu (or in the settings drawer's Voice section). A PowerShell window opens and installs faster-whisper and Kokoro into `%LOCALAPPDATA%\LawnmowerMan\voice` (about 2–4 GB with models; an NVIDIA GPU is used when there is one, otherwise the smaller CPU version is installed). It needs Python 3.12 and offers to install it with `winget` if it is missing. When the window says *Done*, the app starts the local voice by itself. If the setup fails, *Settings › Voice* shows the last lines of the step that failed, with **Open setup log** and **Copy** buttons; the full log is `%LOCALAPPDATA%\LawnmowerMan\voice\setup.log` (see [docs/VOICE.md](docs/VOICE.md#51-when-the-setup-fails)).
6. **Update:** run the newer `Lawnmower-Man-Setup-<version>.exe` over the installed one (it closes a running Lawnmower Man first). Your settings and the local voice are kept, so there is normally no need to set the voice up again (if the voice reports an error after an update, choose *Set up local voice again…* in the tray menu: it reuses what is already installed).
7. **Uninstall:** Windows *Settings → Apps → Installed apps → Lawnmower Man → Uninstall*. The uninstaller asks whether to also delete your data (default: **No**): the local voice (`%LOCALAPPDATA%\LawnmowerMan\voice`, several GB) and the settings and logs (`%APPDATA%\Lawnmower Man`). A silent uninstall (`/S`) keeps both. It never touches Claude's work folder (`%USERPROFILE%\LawnmowerMan`), your Claude CLI or its login (`%USERPROFILE%\.claude`); remove the CLI separately if you want to.

Reporting a problem? The tray menu's *Open logs folder* has `main.log`; for a failed voice setup, also send `%LOCALAPPDATA%\LawnmowerMan\voice\setup.log` (*Settings › Voice*, **Open setup log**). On laptops with two GPUs, see the hybrid-graphics tip below.

## Requirements (development)

| | |
|---|---|
| OS | Windows 11 (primary target) or Linux (x64) |
| Node.js | 22.12 or newer |
| Claude CLI | installed and logged in: run `claude` once in a terminal and complete the login |
| GPU | any WebGL2 GPU for the avatar. For local voice on the GPU: an NVIDIA driver **R570+** (R580+ for GPU text to speech) |
| Python | 3.12 (only for local voice; 3.11 also works) |

## Quick start (from source)

```powershell
git clone https://github.com/gkchkump-commits/Lawnmower_Man.git
cd Lawnmower_Man
npm install          # also downloads the Electron runtime
npm start            # builds the renderer and launches the avatar
```

The avatar appears in a transparent, always-on-top window. Type in the chat panel to talk to Claude. Replies are spoken with your system's built-in voices until you install local voice:

```powershell
# Windows: GPU voice (about 1.8 GB of CUDA wheels + 2 GB of models; no admin, no CUDA Toolkit)
powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1
# or double-click scripts\setup-voice.cmd;  add -Cpu for a machine without an NVIDIA GPU
```

```bash
# Linux
scripts/setup-voice.sh          # add --cpu for CPU only
```

Then choose **Restart voice** in the tray menu, or restart the app. [docs/VOICE.md](docs/VOICE.md) covers the GPU stack, the VRAM budget and troubleshooting.

> **Laptop with hybrid graphics?** The app asks Windows for the high-performance GPU. If the avatar still runs on the integrated GPU, open *Settings → System → Display → Graphics*, add Lawnmower Man (or `electron.exe` in dev) and choose **High performance**.

## Using it

| Input | Action |
|---|---|
| Type + **Enter** | send a message (Shift+Enter: new line, ↑: recall) |
| hold **Space** (outside a text field) | push-to-talk; release to send |
| mic button | click: listen until you stop talking; hold: push-to-talk |
| camera button (toolbar) | turn the camera on/off; while it runs, a **● camera** light shows in the top-left corner |
| camera button (message box) | attach a snapshot of you to the next message (only while the camera is on) |
| **Ctrl+Shift+Space** (global; Linux/macOS: Ctrl+Alt+Space) | talk / interrupt |
| **Ctrl+Shift+F10** (global; Linux/macOS: Ctrl+Alt+X) | stop speaking |
| **Ctrl+Shift+F9** (global; Linux/macOS: Ctrl+Alt+C) | show/hide the chat panel |
| **Esc** | cancel listening, stop speaking, or stop the reply |
| drag the head (or the chat's status bar) | move the window; near a screen edge or corner it snaps flush against it like a normal window, settles fully on the screen you drop it on (sized to fit that screen) and remembers the place |
| drag a **corner** of the window (a bracket shows on hover) | resize it like a normal window; the opposite corner stays put and the face keeps its shape |
| **Ctrl + mouse wheel** over the head | bigger / smaller in small steps |
| tray icon | show/hide, always on top, click-through, lock / reset position, camera, home camera, Claude mode, new conversation, restart voice, set up local voice, logs, quit |

Hotkeys, window size (small/medium/large presets or any *Width*), click-through, renderer, voice, speed, hands-free mode, the camera, the home camera and the Claude settings are all in the **settings drawer** (gear icon). With click-through on, clicks on the transparent parts of the window go to the desktop underneath. *Settings → Window → Lock position* stops accidental moves and resizes; *Reset position* puts the avatar back in the bottom-right corner. The eyes follow the mouse anywhere on the desktop (*Settings → Avatar → Eyes follow the cursor*).

Windows avoids Ctrl+Alt global shortcuts: Windows reports AltGr as Ctrl+Alt, so they would swallow AltGr characters such as Polish ć/ź. Settings from an older version that still hold the Ctrl+Alt defaults are moved to the new ones once; shortcuts you chose yourself are kept.

### The camera

Off by default. Turn it on with the toolbar's camera button, *Settings › Camera* or the tray's **Camera** item; the first time, a card explains it before anything is opened. Then the avatar:

* makes **eye contact** (a moving cursor still wins for a moment),
* **dozes off** when you have been away for 2 minutes and **wakes up** with a smile when you are back,
* **smiles back** when you smile,
* **says hello** when it first sees you (good morning / afternoon / evening) and **welcome back** when you return after a couple of minutes away (*Greet me*: Hello, Claude for a personal hello from Claude, or Off),
* optionally **listens only while you look at the screen** in hands-free mode (*Listen only when I look*).

Face tracking (Google's MediaPipe Face Landmarker) runs inside the app, offline; no video is recorded or uploaded. **Claude sees you only** when *Settings › Camera › Let Claude see me* is on (a snapshot goes with every message) or when you press the camera button in the message box (the next message only); the chat shows the picture that was sent. The camera is released while the window is hidden or minimized. Details, privacy and troubleshooting: [docs/CAMERA.md](docs/CAMERA.md).

### The home camera (Tapo C211)

Off by default; nothing talks to a camera until you set it up. [docs/TAPO.md](docs/TAPO.md) has every step (with the Tapo app's menu paths), all controls, the troubleshooting table and the privacy details. In short:

1. **In the Tapo app** (phone, once): create a **Camera Account** (camera › gear › *Advanced Settings › Camera Account*; a new password, **not** your TP-Link password), set the video quality to the best, turn on motion and person detection, keep privacy mode off, and don't use Tapo Care recording together with a microSD card. Third-Party Compatibility, your TP-Link password and port forwarding are **not** needed.
2. **On your router** (once): give the camera a fixed address (a *DHCP reservation*). Never forward ports 554 or 2020 to the internet.
3. **In Lawnmower Man:** tray › **Home camera › Set up the home camera…** (or *Settings › Home camera*: turn on **Home camera**, then press *Open camera window…*). Enter the camera's address (or press **Find cameras**), the Camera Account user name and password, a name such as *front door camera*, then **Test connection** and **Save**. Press **Calibrate…** once (the camera turns a little each way, about 30 s), so the arrows and clicks go the right way.
4. **Arm** when you leave (top of the camera window, the tray's *Home camera › Armed*, *Settings › Home camera › Security*, or say "arm the camera"): you have 30 seconds to leave. When someone walks in, Windows shows "Person at the front door camera", the avatar wakes up, looks toward the camera window and says *"Someone is at the front door camera."*, and a clip from 5 s before to 10 s after is saved in `Videos\Lawnmower Man\Security` (kept 7 days, at most 5 GB). Closing the camera window only hides it; an armed camera keeps watching — **as long as the PC is on and Lawnmower Man runs** (while armed it keeps the PC from sleeping; turn on *Start Lawnmower Man with Windows* in the camera window's gear › *Alerts and recording*). If an armed camera stops answering or sending video, the tray and the arm button say *Armed · camera offline* / *Armed · not watching*, and after a minute a notification tells you.

| In the camera window | Action |
|---|---|
| click the picture | turn the camera so that spot moves to the middle |
| on-screen arrows (bottom right) | click: one step; press and hold: keep turning, stops when you let go; **⌂**: home position |
| **← → ↑ ↓** (Shift: a big step, Alt: a small step; hold to keep turning) | turn the camera |
| **H** or **Home** · **1**–**8** | home position · a saved position (the sidebar's *Positions*, including the ones made in the Tapo app) |
| **A** · **E** · **Space** | arm / disarm · show or hide the events (click one to play its clip) · copy a picture |
| **F** or double-click · **Esc** · **?** | full screen · stop the camera, close a dialog · all keys |

Typed or spoken to the avatar, short commands run at once without asking Claude: "camera left", "turn the camera right a bit", "look at the door" (a saved position), "camera home", "arm the camera" / "disarm the camera", "show me the camera". Anything else goes to Claude, who has camera tools too: ask *"Is anyone at the front door?"* and an approval card asks before Claude sees a picture (**Allow** sends one picture), or before it turns the camera. Claude can arm the alarm but never disarm it. In the camera window's gear › *Claude and the avatar* you can set looking and turning to *Always* or *Never*, and turn on *Claude describes alerts* (off by default: the alert picture then goes to Claude for a one-sentence description).

The camera password is encrypted for your Windows user and never written to `settings.json` or a log. The video goes from the camera to this PC only; the bundled video component (go2rtc) listens on `127.0.0.1` only. Pictures leave the PC only when you allow Claude to see them.

### Claude modes

| Mode | What Claude can do | CLI flags |
|---|---|---|
| **chat** (default) | talk only; no tools, no MCP servers | `--tools "" --system-prompt-file <voice persona>` |
| **assistant** | read files in the work folder, search and fetch the web | `--tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch`: reads outside the work folder and every web fetch show an Allow/Deny card |
| **agent** | the full Claude Code tool set | default tools; **every** permission prompt appears as an Allow/Deny card, and the avatar asks out loud |

Nothing is ever approved automatically (in assistant mode only web *searches* and reads inside the work folder run without a card). Approval cards show the exact command or content — shortened requests keep Allow disabled until you open *Show all* — and ignore clicks for a moment after they appear, so a click aimed at the window underneath cannot approve anything. Only your own Claude settings (`~/.claude/settings.json`) are loaded: a work folder's `.claude/settings.json` (hooks, permission rules) is ignored, because `claude -p` shows no trust prompt. Claude works in `~/LawnmowerMan` by default; you can change this under *Settings → Claude → Work folder*. The conversation resumes across restarts (`--resume`); **New conversation** in the tray or panel starts fresh.

## Renderers

* **relief** (default): a 2.5D relief mesh baked from your reference video. It carries the video's own pixels and is rigged from MediaPipe face landmarks: jaw and lip shapes, a lid-wipe blink, gaze, brows, and small head turns. It looks almost identical to the video.
* **procedural**: a true 3D head (derived from the Lee Perry-Smith scan, CC BY 3.0) drawn entirely by shaders in the same style. It turns much further, but it looks less like the reference.

Both share a GPU particle aura (cyan and amber motes, cyan wisps) and bloom, and both output premultiplied alpha, so black is fully transparent on the desktop.

**Voice character.** The local voice now sounds like a hologram AI: *Settings → Voice → Character* is **Synth** by default (the voice with a pitch-locked vocoder layer, a doubler, a metallic sheen and digital air, still easy to understand), **Vocoder** (fully synthetic, the pitch snapped to notes), **Robot** (monotone, ring-modulated) or **Natural** (unprocessed). *Settings → Voice → Intensity* sets how strong it is (default 60 %). It runs on the audio thread with no added delay and the mouth follows the unprocessed voice, so the lip-sync is unchanged. The system voice (used while the local voice is not running) cannot be processed. Details and measurements: [docs/VOICE.md](docs/VOICE.md#24-voice-character).

**Lip-sync.** The mouth follows the actual words, with either voice. With the local voice it plays the viseme timeline that comes with the audio; with a Windows (system) voice it works the sounds out from the text and keeps them in step with the voice's word timing. The lips close on *m*, *b* and *p*, the lower lip tucks under the teeth on *f* and *v*, the lips round ahead of *o* and *oo*, the tongue shows on *th* and *l*, and the mouth rests at commas and full stops. While talking, the head nods slightly on stressed words, the brows lift on questions, blinks fall between phrases, and a friendly sentence ends with a small smile.

With the local voice the mouth also listens to the sound itself (analysed in the background as each sentence arrives): every vowel gets its own shape from what you hear, so "ah" opens wide, "ee" spreads, "oo" rounds small and an unstressed "uh" barely opens, instead of every vowel opening about the same; the lips close and part where the *m*, *b* and *p* are heard (also after another consonant, as in "and Pam"), approach the closure over a few frames, and open again over a few frames as the jaw follows them; a short vowel between two closures ("Maybe my") still parts the lips; "oo" and "o" make a small round opening; on *f* and *v* the upper teeth rest on the lower lip. While talking, the head's movements vary like a person's and do not follow a beat: the main stressed word of a phrase nods, others get a slight turn or tilt, a brow flick, or nothing, and the head never nods twice within about a second.

The face follows the sound in other ways too: the jaw opens with each syllable's loudness (stressed syllables wider), the head and brows follow the pitch of the voice, a falling sentence end settles the head, the avatar takes a breath (nostrils, a slight lift) before speaking on, glances away at the start of some phrases and looks back at you by their end. The jaw swings like a hinge, and the cheeks, the chin and the upper lip move with the mouth. *Settings → Avatar → Expressiveness* sets how much the head, brows and face move while speaking (0 % keeps the head still, 100 % is the default, 200 % is very animated). If the mouth runs ahead of or behind the voice (Bluetooth headphones add a delay the app cannot see), set *Settings → Voice → Lip-sync timing* (+ moves the mouth later; for Bluetooth try +100 to +200 ms) and press **Test lip-sync** to check it on a line full of *b*, *p* and *m*. [docs/RENDERER.md](docs/RENDERER.md#lip-sync) has the details and [before / after mouth shapes](docs/screenshots/lipsync_shapes.jpg); see also the [visemes](docs/screenshots/mouth_visemes.jpg), a [speech film strip](docs/screenshots/mouth_speech.jpg) and [the face moving with the mouth](docs/screenshots/face_with_mouth.jpg).

**Motion.** Everything moves smoothly, at any frame rate, and never repeats: the eyes jump between fixations the way human eyes do (quick saccades, holding still in between, following a moving cursor or face smoothly), the head turns a little after the eyes on bigger looks, blinks come at natural, irregular intervals (some partial, the lid following a downward look), the idle sway and breathing wander, and the lips part in a rounded opening with the corners closed. On the relief head the irises move under the lids, which stay put. [docs/RENDERER.md](docs/RENDERER.md#motion) has the details and the measurements.

**Life.** Between replies the avatar behaves like a person sitting at the screen, never in a loop: it looks around the room (the head going along) and back at you, tilts its head, shifts its posture, presses its lips, swallows, takes a deep breath now and then, in bursts with calm stretches of half a minute or more in between. You always come first: move the mouse or come back into the camera's view and its eyes are on you at once. While you type it leans in and glances down at the chat; while you talk it leans in and nods at the pauses of your voice; while it thinks it looks up and aside, presses or purses its lips and tilts its head ("hmm"). Brow flashes and smiles are for you: when you come back after a quiet minute, or (with the camera on) now and then when you look back at it after a while. Left alone for minutes it gets bored (longer looks away, a sigh, now and then a yawn). With the camera on it mirrors your head tilt a little. *Settings → Avatar → Liveliness* sets how much (0 % still, 100 % default, 200 % very lively). [docs/RENDERER.md](docs/RENDERER.md#behaviour) has the details.

**Look.** The hologram is lit as the 3-D head it is (turning toward the light brightens that side, a glint slides over the brow and nose, the edges turning away catch more cyan rim light), its gold lines and eyes are crisp and glow, and the aura moves with the head at its own depths. Its face is glass that hides a busy desktop behind it, with a thin dark outline around the head so it stands out over a bright or busy desktop too. *Settings → Avatar → Projector light* adds a cone of light under the bust. On a slow GPU the automatic quality first lowers the resolution a little, then the tier, whenever it cannot hold ~50 fps. [docs/RENDERER.md](docs/RENDERER.md#the-hologram-depth-light-glow) has the details and the cost.

![The hologram before (top) and after (bottom) over a dark, a bright and a busy desktop](docs/screenshots/pop_backdrops.jpg)

![Both renderers over a light desktop, a wallpaper and a dark checkerboard](docs/screenshots/transparency.jpg)

More comparisons with the reference video: [expressions](docs/screenshots/compare_expressions.jpg) (blink, speaking, teeth), [animation and states](docs/screenshots/animation_strip.jpg), [head motion](docs/screenshots/head_motion.jpg).

### Make an avatar from your own video

```bash
pip install -r tools/bake/requirements.txt
python tools/bake/bake_avatar.py --video my_head.mp4 --out public/assets/avatars/mine
```

Then set *Settings → Avatar → Pack* to `mine` (it maps to `settings.avatar.pack`). `npm run dev` serves the new pack right away; with `npm start`, restart it so the build copies the pack into `dist/`. The video should show a front-facing face on a dark background with at least one blink; [tools/bake/README.md](tools/bake/README.md) has the details.

## Development

```bash
npm run dev            # Vite dev server + Electron with hot reload
npm test               # unit tests (vitest): Electron main logic, Claude session (fake CLI), app logic, avatar director
npm run test:e2e       # Playwright: the app in Chromium with SwiftShader WebGL and a mock bridge
npm run test:voice     # pytest for the voice server (engines mocked)
npm run lint
npm run dist:win       # Windows installer + portable exe (electron-builder, unsigned) into release/
npm run dist:linux-dir # unpacked Linux build in release/linux-unpacked (quick packaging check)
npm run test:packaged  # scripts/electron-e2e.mjs --packaged; set ELECTRON_PATH to the built/installed app
npm run fetch:go2rtc   # the home camera's video component (pinned go2rtc 1.9.14, SHA-256 checked) into vendor/go2rtc/
                       #   (-- --platform win32-x64 | linux-x64 | all; dist:win needs the win32-x64 one)
npm run sim:tapo       # a simulated Tapo camera on 127.0.0.1 (ONVIF 12020, RTSP 10554, control 12021)
npm run test:tapo-e2e  # the home camera end to end in the real app against the simulator (xvfb-run -a on Linux)
npm run probe:tapo -- --host <ip> --user <camera account> [--move]   # a diagnostic report for a real camera (users: the camera window's "Copy diagnostic report")
```

To try the camera window with the simulator, start the app with `LAWNMOWER_TAPO_ALLOW_LOOPBACK=1` (the app otherwise refuses non-home-network addresses, including `127.0.0.1`) and enter `127.0.0.1` with the simulator's ports under the camera window's *Ports and stream*; the simulator's Camera Account is `camacct` / `se&cret`. In a browser, `http://127.0.0.1:4173/tapo/index.html?mock=1` shows the camera window with a mock camera.

Without Electron, open the app in a browser: `npm run build && npm run preview`, then go to `http://127.0.0.1:4173/index.html?mock=1`. The avatar harness with sliders for every rig control is at `/dev/avatar.html` (see [docs/RENDERER.md](docs/RENDERER.md)).

### Where things are

| Path | What |
|---|---|
| `electron/` | main process: window, tray, hotkeys, `app://` protocol, CSP, settings, Claude CLI session, voice sidecar |
| `src/avatar/` | hologram engine (three.js): stage, animation director, particles, bloom, relief / procedural / placeholder heads |
| `src/app/`, `src/audio/`, `src/speech/`, `src/ui/` | conversation state machine, sentence chunking, lip-sync, mic and VAD, voice client, chat UI |
| `src/vision/` | the camera: capture, face tracking (MediaPipe, in a worker), attention, presence, eye contact, snapshots ([docs/CAMERA.md](docs/CAMERA.md)) |
| `electron/tapo/`, `electron/preload-camera.cjs` | the home camera's main-process side: ONVIF client, pan/tilt with motor watchdogs, camera events, the go2rtc video component, clips, the security engine, notifications, Claude's camera tools ([docs/TAPO.md](docs/TAPO.md)) |
| `src/tapo/` | the home camera window (live view, controls, events, setup, calibration), its security worker (WebCodecs decoding, motion, the person detector), and the avatar's side (alerts, quick commands) |
| `tools/tapo-sim/`, `tools/tapo-probe.mjs` | a Tapo camera simulator (ONVIF, RTSP, pan/tilt, events) for tests and development; the diagnostic report for a real camera |
| `voice/` | Python voice server (FastAPI, faster-whisper, Kokoro) |
| `tools/bake/`, `tools/procedural/`, `tools/visual/` | avatar pack baker, procedural head builder, screenshot and compare tools |
| `tools/voicefx/` | renders the voice characters offline with the app's own DSP (demos, tuning) |
| `docs/ARCHITECTURE.md` | the interface contract between all of the above |
| `.github/workflows/release.yml` | Windows installer build, install + end-to-end test of the installed app, publishing on `v*` tags / GitHub releases |

### Publishing a test build

Every pull request builds the Windows installer, installs it on a GitHub Windows runner and drives the installed app; the tested executables are attached to that run as the `lawnmower-man-windows` artifact. To publish them on the [Releases page](https://github.com/gkchkump-commits/Lawnmower_Man/releases), either:

* on GitHub: **Releases → Draft a new release → Choose a tag →** type `v<version from package.json>` (for example `v0.1.0`) **→ Target:** the branch or commit to ship **→** tick *Set as a pre-release* **→ Publish release**. The workflow then builds, tests and attaches the installer, the portable exe and `SHA256SUMS.txt` (about 5 minutes); or
* push a tag: `git tag v0.1.0 && git push origin v0.1.0`, which creates the pre-release automatically.

The tag must match `version` in `package.json` (the files are named after it): bump the version for the next build.

Settings live in `%APPDATA%\Lawnmower Man\settings.json` (Linux: `~/.config/Lawnmower Man/`). Logs are in its `logs/` folder, reachable from the tray menu's *Open logs folder*.

## Troubleshooting

* **"Install Claude Code" card**: the CLI was not found. Follow the card, make sure `claude --version` works in a *new* terminal, then press **Retry**. Installed somewhere unusual? Set *Settings → Claude → CLI path*.
* **"Sign in to Claude Code" card**: the CLI is not logged in (or the login expired). Run `claude` once in a terminal and sign in, then press **Retry**. The card shows the CLI's own message.
* **No voice input / the mic button is disabled**: local voice isn't installed or running. Choose *Set up local voice…* in the tray menu (or *Restart voice* if it is installed). The tray shows the voice status.
* **"Local voice is not fully installed (missing: uvicorn)"**: an earlier setup stopped halfway. The app does not keep restarting the voice server in that state. Open *Settings › Voice*: the last lines of the failed step (pip's `ERROR: …`) are shown there, and **Open setup log** opens the whole log. Fix what it says (often: network, disk space, or a file locked by another program), then choose *Set up local voice again…*. If it fails again, send `setup.log`.
* **The mouth is ahead of or behind the voice** (common with Bluetooth headphones): *Settings → Voice → Lip-sync timing*, + moves the mouth later; **Test lip-sync** says a line to check it by.
* **Voice is slow the first time**: on RTX 50-series GPUs, the first Whisper GPU run compiles kernels once (30–90 s). After that it is fast.
* **More voice issues** (driver, "no kernel image", cuDNN, CPU fallback): see [docs/VOICE.md § Troubleshooting](docs/VOICE.md#5-troubleshooting).
* **Home camera: "Sign-in failed", offline, turns the wrong way, no notifications**: see the table in [docs/TAPO.md § Troubleshooting](docs/TAPO.md#7-troubleshooting). The app never retries a wrong camera password by itself (so the camera does not lock you out): fix it in the camera window's setup and press **Test connection**.
* **"The camera is blocked"**: in Windows *Settings › Privacy & security › Camera*, turn on **Camera access** and **Let desktop apps access your camera**, then press **Try again** on the card. "In use": close Teams, Zoom, the Camera app or a video call in the browser. More in [docs/CAMERA.md](docs/CAMERA.md#when-the-camera-does-not-start).

## Credits

Third-party models, assets and libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The procedural head is derived from the Lee Perry-Smith head scan by Infinite-Realities (CC BY 3.0).

## License

Lawnmower Man is open source under the [MIT License](LICENSE). The bundled third-party models and assets keep their own licenses (Apache-2.0, CC BY 3.0, …), listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
