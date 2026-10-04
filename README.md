# Lawnmower Man

A holographic desktop avatar for Claude. A glowing wireframe head floats on your desktop, listens, thinks and talks back, with lip-sync, blinks and eyes that follow your cursor.

<p align="center"><img src="docs/screenshots/hero.jpg" width="390" alt="The avatar and its chat panel on a dark desktop, speaking a reply that is still streaming in"></p>

<p align="center"><em>The real app (relief renderer) mid-reply, captured from Electron with its transparent window composited over a dark desktop.</em></p>

* **Brain:** your locally installed [Claude CLI](https://docs.claude.com/en/docs/claude-code). The app runs one persistent `claude -p` session over stream-json and uses your existing login; no API key is needed.
* **Face:** a real-time WebGL hologram on your GPU, built from the frames of the reference video (`docs/reference/`).
* **Voice:** runs locally on an NVIDIA GPU. Speech to text is [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`large-v3-turbo`); text to speech is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). Both are tuned for an **RTX 5070 Laptop GPU (8 GB, Blackwell)** and fall back to the CPU automatically.

![Reference video frame vs. the relief renderer vs. the procedural renderer](docs/screenshots/compare_rest.jpg)

*Left: a frame of the reference video. Middle: the default "relief" renderer, live and fully rigged. Right: the alternative fully 3D "procedural" renderer.*

---

## Requirements

| | |
|---|---|
| OS | Windows 11 (primary target) or Linux (x64) |
| Node.js | 22.12 or newer |
| Claude CLI | installed and logged in: run `claude` once in a terminal and complete the login |
| GPU | any WebGL2 GPU for the avatar. For local voice on the GPU: an NVIDIA driver **R570+** (R580+ for GPU text to speech) |
| Python | 3.12 (only for local voice; 3.11 also works) |

## Quick start

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
| **Ctrl+Shift+Space** (global; Linux/macOS: Ctrl+Alt+Space) | talk / interrupt |
| **Ctrl+Shift+F10** (global; Linux/macOS: Ctrl+Alt+X) | stop speaking |
| **Ctrl+Shift+F9** (global; Linux/macOS: Ctrl+Alt+C) | show/hide the chat panel |
| **Esc** | cancel listening, stop speaking, or stop the reply |
| drag the head | move the window |
| tray icon | show/hide, always on top, click-through, Claude mode, new conversation, restart voice, logs, quit |

Hotkeys, window size (small/medium/large), click-through, renderer, voice, speed, hands-free mode and the Claude settings are all in the **settings drawer** (gear icon). With click-through on, clicks on the transparent parts of the window go to the desktop underneath. The eyes follow the mouse anywhere on the desktop (*Settings → Avatar → Eyes follow the cursor*).

Windows avoids Ctrl+Alt global shortcuts: Windows reports AltGr as Ctrl+Alt, so they would swallow AltGr characters such as Polish ć/ź. Settings from an older version that still hold the Ctrl+Alt defaults are moved to the new ones once; shortcuts you chose yourself are kept.

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
npm run dist           # Windows installer + portable exe (electron-builder) into release/
                       # (the portable exe has local voice only if the installer build set it up; see docs/VOICE.md)
```

Without Electron, open the app in a browser: `npm run build && npm run preview`, then go to `http://127.0.0.1:4173/index.html?mock=1`. The avatar harness with sliders for every rig control is at `/dev/avatar.html` (see [docs/RENDERER.md](docs/RENDERER.md)).

### Where things are

| Path | What |
|---|---|
| `electron/` | main process: window, tray, hotkeys, `app://` protocol, CSP, settings, Claude CLI session, voice sidecar |
| `src/avatar/` | hologram engine (three.js): stage, animation director, particles, bloom, relief / procedural / placeholder heads |
| `src/app/`, `src/audio/`, `src/speech/`, `src/ui/` | conversation state machine, sentence chunking, lip-sync, mic and VAD, voice client, chat UI |
| `voice/` | Python voice server (FastAPI, faster-whisper, Kokoro) |
| `tools/bake/`, `tools/procedural/`, `tools/visual/` | avatar pack baker, procedural head builder, screenshot and compare tools |
| `docs/ARCHITECTURE.md` | the interface contract between all of the above |

Settings live in `%APPDATA%\Lawnmower Man\settings.json` (Linux: `~/.config/Lawnmower Man/`). Logs are in its `logs/` folder, reachable from the tray menu's *Open logs folder*.

## Troubleshooting

* **"Claude CLI not found"**: install it, make sure `claude --version` works in a new terminal, or set *Settings → Claude → CLI path*.
* **Claude starts, then errors right away**: run `claude` once interactively to log in. The error card shows the CLI's own message.
* **No voice input / the mic button is disabled**: local voice isn't installed or running. Run the setup script, then use *Restart voice*. The tray shows the voice status.
* **Voice is slow the first time**: on RTX 50-series GPUs, the first Whisper GPU run compiles kernels once (30–90 s). After that it is fast.
* **More voice issues** (driver, "no kernel image", cuDNN, CPU fallback): see [docs/VOICE.md § Troubleshooting](docs/VOICE.md#5-troubleshooting).

## Credits

Third-party models, assets and libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The procedural head is derived from the Lee Perry-Smith head scan by Infinite-Realities (CC BY 3.0).
