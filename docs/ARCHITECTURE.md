# Lawnmower Man — Architecture & Interface Contract

A holographic desktop avatar for Claude. The "brain" is the user's locally installed
**Claude CLI** (`claude -p` in persistent stream-json mode, using their existing login);
the face is a real-time WebGL hologram rendered on the GPU; voice is local on the GPU
(faster-whisper speech-to-text, Kokoro text-to-speech) via a Python sidecar.

Target machine: Windows 11 (primary) or Linux, NVIDIA RTX 5070 **Laptop** GPU with 8 GB
VRAM (Blackwell, compute capability sm_120 → needs CUDA 12.8+ builds). Everything must
degrade gracefully: no voice server → text chat + browser speech synthesis; no CUDA →
CPU inference; low-end GPU → lower render quality.

The look is defined by `docs/reference/*.jpg` (frames of the user's reference video
`generated_video.mp4`, 784×1168, 24 fps, 15 s): a translucent holographic human head made of a
fine blue-white wireframe grid with an irregular web of brighter nodes, warm gold
contour/"circuit" lines (forehead flow lines, rings around the eyes, nasolabial and lip
contours, center line), intensely glowing amber eyes with a ring iris and dark pupil,
glowing gold lips, a neck that dissolves into particles, a cyan + amber particle/bokeh
aura and cyan wisps around the head on a pure black void. It blinks (eyes collapse to a
glowing gold line) and speaks (lips part, dark mouth interior, teeth hint).

---

## 0. Build & serve

Vite root is `src/`, `publicDir` is `public/` (served at `./`), build output `dist/`, `base: './'`.
`npm run dev` = Vite dev server (127.0.0.1:5173) + Electron pointed at it (`VITE_DEV_SERVER_URL`).
`npm start` = `vite build` then Electron, which serves `dist/` through a privileged custom
protocol `app://lawnmower/` (`protocol.handle`, standard+secure+supportFetchAPI) — **not**
`file://`, because three.js loaders use `fetch()`, which Chromium does not allow on `file:`.
Renderer CSP must allow `connect-src 'self' http://127.0.0.1:*` for the voice server.

## 1. Processes

```
┌─────────────────────────── Electron main (Node 22, ESM) ───────────────────────────┐
│ electron/main.js          app lifecycle, BrowserWindow (transparent, frameless,     │
│                           always-on-top), tray, global shortcuts, IPC wiring        │
│ electron/claude-session.js ClaudeSession: spawns `claude -p` persistent stream-json │
│ electron/voice-sidecar.js  VoiceSidecar: spawns/monitors the Python voice server    │
│ electron/settings.js       Settings store (JSON in app.getPath('userData'))         │
│ electron/preload.cjs       contextBridge → window.lawnmower (see §3)                │
└──────────────┬───────────────────────────────────────────────┬─────────────────────┘
               │ IPC (contextIsolation, sandbox)                │ spawn + stdio
┌──────────────▼──────────── Renderer (Chromium, WebGL2) ──┐   ┌▼──────────────────────┐
│ src/avatar/*   hologram renderer (three.js)              │   │ claude -p (user's CLI) │
│ src/app/*      conversation controller & text pipeline   │   └───────────────────────┘
│ src/audio/*    mic capture/VAD, playback, lip-sync        │
│ src/speech/*   voice-server client + Web Speech fallback  │──HTTP──┐
│ src/ui/*       chat panel, settings, permission cards     │        │ 127.0.0.1, bearer token
└───────────────────────────────────────────────────────────┘   ┌────▼──────────────────┐
                                                                 │ voice/ (Python 3.12)  │
                                                                 │ FastAPI: /stt /tts …  │
                                                                 │ faster-whisper, Kokoro│
                                                                 └───────────────────────┘
```

## 2. Repository layout (and which build lane owns it)

| Path | Owner lane | Contents |
|---|---|---|
| `package.json`, `vite.config.js`, `playwright.config.js`, `eslint.config.js` | integrator | already created; lanes may ADD scripts/devDeps but must not remove |
| `electron/` | **systems** | main.js, preload.cjs, claude-session.js, stream-json.js, claude-path.js, voice-sidecar.js, settings.js, window-manager.js |
| `src/avatar/` (except `src/avatar/heads/procedural/`) | **avatar-core** | `index.js` (createAvatar), `stage.js`, `director.js`, `fx/`, `heads/relief/`, `heads/placeholder/` |
| `src/avatar/heads/procedural/` | **procedural** | ProceduralHead implementing the Head interface (§5.2) |
| `tools/bake/` | **avatar-core** | Python: reference video → avatar pack |
| `public/assets/avatars/reference/` | **avatar-core** | the baked pack generated from the user's video (committed; served at `./assets/avatars/reference/`) |
| `public/assets/models/` | **procedural** | head mesh(es) for the procedural renderer + LICENSE notes (served at `./assets/models/`) |
| `src/app/`, `src/audio/`, `src/speech/`, `src/ui/`, `src/bridge/`, `src/main.js`, `src/index.html`, `src/styles/` | **renderer-app** | conversation pipeline, audio, UI, mock bridge |
| `voice/` | **voice** | Python package `lawnmower_voice`, pyproject, tests |
| `scripts/` | **voice** (setup-voice.*) / **systems** (others) | setup scripts |
| `src/dev/` | each lane its own file(s): `src/dev/avatar.html` (avatar-core), `src/dev/procedural.html` (procedural) | dev/visual harness pages served by Vite at `/dev/*.html` (add them to `build.rollupOptions.input` in vite.config.js if tests need them in `vite preview`) |
| `tests/unit/<lane>/` | each lane | vitest specs (node environment unless a spec opts into another) |
| `tests/e2e/` | renderer-app | Playwright specs |
| `docs/` | everyone may add files; README.md at root by integrator | |

Rules for every lane: plain modern JavaScript (ESM) with JSDoc types — no TypeScript; no
new runtime dependencies without strong need (three.js is the only renderer dependency);
never commit or push (the integrator does); never edit another lane's files — if you need
something from another lane, code against this contract and note it in your report.

## 3. Preload bridge: `window.lawnmower`

Exposed by `electron/preload.cjs` via `contextBridge.exposeInMainWorld('lawnmower', …)`.
`src/bridge/index.js` returns `window.lawnmower` when present, otherwise a **mock bridge**
(`src/bridge/mock.js`) so the renderer runs in a plain browser (`vite dev`, Playwright).
The mock is also selected when the URL has `?mock=1`.

```js
lawnmower = {
  claude: {
    send(text: string): Promise<{ turnId: string }>,   // queue a user turn
    cancel(turnId: string): Promise<{ cancelled: boolean, interrupted: boolean }>,
                                                         // drop a turn that has not started (→ turn_cancelled);
                                                         // a running one is interrupted instead
    interrupt(): Promise<void>,                          // stop the current turn
    reset(): Promise<void>,                              // start a fresh conversation
    respondPermission(requestId: string, decision: { behavior: 'allow'|'deny', message?: string, updatedInput?: object }): Promise<void>,
    status(): Promise<ClaudeStatus>,
    retry(): Promise<void>,                              // setup card "Retry": look for the CLI again (refreshing PATH
                                                         // from the registry on Windows) and restart it, same conversation
    onEvent(cb: (ev: ClaudeEvent) => void): () => void, // returns unsubscribe
  },
  voice: {
    info(): Promise<{ status: 'disabled'|'starting'|'ready'|'error'|'stopped', installed?: boolean, url?: string, token?: string,
                      detail?: string, health?: object,
                      missing?: string[],                // the venv lacks these packages (a setup that failed halfway)
                      setupLog?: string,                 // the setup log exists (its path)
                      setup?: { state: 'running'|'done'|'failed'|'manual', detail: string, cpu: boolean,
                                mode?: 'console'|'terminal'|'manual', command?: string,
                                errorTail?: string[] /* failed: the last lines of the failed step */ } }>,
    restart(): Promise<void>,
    setup(o?: { cpu?: boolean }): Promise<SetupState>,  // "Set up local voice…": runs the bundled setup script in a
                                                         // visible console/terminal (manual mode: only returns the command);
                                                         // cpu defaults to "no NVIDIA GPU detected". Progress via onStatus.
    openSetupLog(): Promise<{ ok: boolean, path?: string, error?: string }>,
                                                         // no arguments: main opens <voice home>/setup.log (only that file)
    onStatus(cb: (info) => void): () => void,
  },
  settings: {
    get(): Promise<Settings>,
    set(patch: Partial<Settings>): Promise<Settings>,   // deep-merged, validated, persisted
    onChange(cb: (settings: Settings) => void): () => void,
  },
  window: {
    setIgnoreMouse(ignore: boolean): void,  // click-through for transparent pixels (forward:true)
    setSizePreset(preset: 'small'|'medium'|'large'): void,
    setAlwaysOnTop(on: boolean): void,
    dragStart(): void,     // primary button pressed on the head / status bar / settings header
    dragEnd(): void,       // released (or blur / hidden): settle on the display, save the position
    resetPosition(): void, // default corner of the current display
    minimize(): void, hide(): void, quit(): void,
  },
  onHotkey(cb: (name: 'toggleListen'|'stopSpeaking'|'toggleChat') => void): () => void,
  onCursor(cb: (p: { x: number, y: number }) => void): () => void,
                          // global cursor position in CSS px relative to the window's top-left
                          // (may be outside the window); ~30 Hz, only while the window is visible,
                          // avatar.followCursor is on and the cursor moved. Absent in the mock bridge.
  app: { info(): Promise<{ version: string, platform: string, electron: string, chrome: string }> },
}
```

Moving the window: there are no CSS drag regions (`-webkit-app-region: drag`). On Windows they fight
click-through: entering one reads as the pointer leaving the page, the click-through gate makes the
window transparent to clicks and the press lands on the desktop. Instead the renderer
(`src/app/window-drag.js`) calls `dragStart()` on a primary press over the head's silhouette, the
status bar or the settings header, holds the gate interactive and captures the pointer; main follows
`screen.getCursorScreenPoint()` at ~60 Hz (`dragBounds` in `electron/window-manager.js`: nothing moves
until the cursor travelled 3 DIP, so a click stays a click; `setBounds` keeps the size exact on
fractional display scaling) and refuses click-through until `dragEnd()`, which settles the window
fully onto the display it was dropped on and saves the position. A drag also ends when the window
hides, minimizes or its renderer dies, and after 2 minutes at most. `window.lockPosition` disables it.

Renderer use of `onCursor`: the eyes follow the cursor anywhere on the desktop (`src/app/gaze.js`:
inside the avatar stage exactly like pointer tracking, outside it the gaze keeps the direction but
eases off with distance); without `onCursor` (browser preview) pointer events over the page are used.

### 3.1 `ClaudeEvent` (main → renderer, in order of occurrence)

```js
{ type: 'status', status: 'starting'|'ready'|'busy'|'restarting'|'exited'|'error', detail?: string }
{ type: 'session', sessionId: string, model: string, tools: string[] }        // from system/init
{ type: 'turn_start', turnId: string, text: string }
{ type: 'text_delta', turnId: string, text: string }      // assistant text, streamed (stream_event content_block_delta text_delta)
{ type: 'thinking', turnId: string }                      // thinking_delta seen (no content forwarded)
{ type: 'tool_use', turnId: string, id: string, name: string, input: object }
{ type: 'tool_result', turnId: string, id: string, isError: boolean, summary: string }
{ type: 'permission_request', turnId: string|null, requestId: string, toolName: string, input: object, description?: string }
{ type: 'message_end', turnId: string }                   // an assistant message finished (there may be several per turn when tools run)
{ type: 'turn_end', turnId: string, result: string, isError: boolean, interrupted?: true, durationMs?: number, costUsd?: number, sessionId?: string }
                                                          // interrupted: interrupt(), or reset()/stop() during the turn
{ type: 'turn_cancelled', turnId: string }                // cancel() dropped a queued turn (no turn_start, never sent to the CLI)
{ type: 'error', message: string, turnId?: string }
{ type: 'problem', problem: { kind: 'cli-missing'|'auth', detail: string } | null }
                                                          // something the user must fix outside the app (first run): no CLI
                                                          // found, or the CLI is not logged in ("Not logged in · Please run
                                                          // /login", expired OAuth, invalid API key…). Sent before the failed
                                                          // turn_end; null once fixed (successful turn, CLI found, retry()).
```

`ClaudeStatus = { status, sessionId?: string, model?: string, busy: boolean, queue: number, cliPath?: string, cliVersion?: string,
  problem?: { kind, detail }, activeTurnId?: string, queuedTurnIds: string[], pendingPermissions: [{ requestId, turnId, toolName, input, description? }] }`

The renderer shows a `problem` as a setup card (`src/ui/setup-cards.js`, content in `src/app/setup-help.js`): the
official install commands for the platform (verified against code.claude.com/docs/en/setup) with Copy buttons, the
`claude` login step and **Retry**. The app never runs an installer itself.

Events are not replayed: a renderer that (re)loads (start-up, crash recovery, F5 in development) calls
`status()` and picks up the running turn, the queued turns and the open approval cards from it.
Main also makes the window interactive again on every (re)load (click-through is re-enabled by the new page).
Stop/Esc and newer input cancel messages that have not started yet (`cancel`), so a message waiting
behind a stopping turn, a CLI start-up or a restart is never answered after the user moved on.

### 3.2 Claude CLI protocol (verified against Claude Code 2.1.x)

Spawn once and keep alive (one process = one conversation):

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --permission-prompt-tool stdio
       [--model <m>] [--effort <e>] [--resume <sessionId>]
       --setting-sources user
       (chat mode)  --tools "" --system-prompt-file <persona.txt> --strict-mcp-config
       (assistant)  --tools "Read,Glob,Grep,WebSearch,WebFetch" --allowedTools "WebSearch" --append-system-prompt-file <persona.txt>
       (agent)      --append-system-prompt-file <persona.txt> [--permission-mode acceptEdits]
```
cwd = `settings.claude.workdir`. `--setting-sources user`: `-p` shows no workspace-trust prompt, so the
working folder's `.claude/settings*.json` (hooks!) are never loaded. Assistant mode pre-approves only
WebSearch: a bare `Read`/`WebFetch` rule would allow reads anywhere on disk and fetches to any URL;
without one the CLI allows reads inside the working folder and asks (an approval card) for the rest.
stdin lines (JSON, newline-terminated):

* `{"type":"control_request","request_id":"<id>","request":{"subtype":"initialize"}}` — send first; reply arrives as `control_response`.
* `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` — one turn.
* `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` — interrupt.
* Reply to a permission prompt: `{"type":"control_response","response":{"subtype":"success","request_id":"<their id>","response":{"behavior":"allow","updatedInput":{…original input…}}}}`
  or `{"behavior":"deny","message":"User denied"}`.

stdout lines: `system/init` (session_id, model, tools), `stream_event` (`event.type` ∈ message_start,
content_block_start, content_block_delta{text_delta|thinking_delta|input_json_delta},
content_block_stop, message_delta, message_stop), `assistant` (full message incl. `tool_use`
blocks), `user` (tool_result blocks), `control_request` with `request.subtype === "can_use_tool"`
(`tool_name`, `input`, `description`, `permission_suggestions`), `control_response`, `result`
(`subtype` success|error_*, `result`, `is_error`, `session_id`, `total_cost_usd`, `duration_ms`),
plus ignorable types (`rate_limit_event`, `active_goal`, `autocompact_state`, `system/status`,
`system/post_turn_summary`, `system/task_summary`, …). **Unknown types must be ignored.**
The session id from `init`/`result` is persisted so the next launch can `--resume` it.

Windows: `claude` may be `claude.exe` (native installer, `%USERPROFILE%\.local\bin`) or
`claude.cmd` (npm global, `%APPDATA%\npm`). `.cmd`/`.bat` must be spawned through
`cmd.exe` (Node refuses them without a shell); never interpolate user text into the
command line — user text only ever travels over stdin; long prompts go in files.

## 4. Settings (persisted JSON, defaults)

```js
{
  claude: {
    cliPath: '',                 // '' = auto-detect
    model: '',                   // '' = CLI default; e.g. 'sonnet', 'opus'
    effort: '',                  // '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    mode: 'chat',                // 'chat' | 'assistant' | 'agent'
    workdir: '',                 // '' = <home>/LawnmowerMan (created on demand)
    persona: '',                 // '' = built-in persona (electron/persona.js); else custom text
    resumeLastSession: true,
    lastSessionId: '',
  },
  voice: {
    enabled: true,               // start the Python sidecar if installed
    pythonPath: '',              // '' = auto (voice/.venv)
    sttModel: 'large-v3-turbo',  // faster-whisper model name; CPU fallback uses 'base.en'
    sttLanguage: 'en',
    ttsVoice: 'af_heart',        // Kokoro voice id
    ttsSpeed: 1.0,
    systemVoice: '',             // Web Speech voice (name or voiceURI) while the local voice is not running; '' = automatic
    device: 'auto',              // 'auto' | 'cuda' | 'cpu'
    handsFree: false,            // continuous VAD listening (half-duplex)
    speakReplies: true,
  },
  avatar: {
    renderer: 'relief',          // 'relief' (from the reference video) | 'procedural'
    pack: 'reference',           // assets/avatars/<pack>
    quality: 'high',             // 'low' | 'medium' | 'high'
    particles: 1.0,              // density multiplier 0..2
    bloom: 1.0,                  // strength multiplier 0..2
    followCursor: true,
  },
  window: {
    sizePreset: 'medium',        // small 300x450, medium 400x600, large 560x840 (avatar area; chat panel extra)
    alwaysOnTop: true,
    clickThrough: true,          // transparent pixels pass clicks to the desktop
    position: null,              // {x,y} remembered
    showChat: true,
    lockPosition: false,         // true: pressing on the head does not move the window
  },
  hotkeys: {                     // Linux/macOS defaults
    toggleListen: 'CommandOrControl+Alt+Space',
    toggleChat: 'CommandOrControl+Alt+C',
    stopSpeaking: 'CommandOrControl+Alt+X',
  },                             // Windows: Control+Shift+Space / Control+Shift+F9 / Control+Shift+F10
}
```
Windows reports AltGr as Ctrl+Alt, so a Ctrl+Alt+<key> global shortcut would swallow AltGr characters
(Polish ć/ź, Hungarian/Czech & and #, …). settings.json carries a top-level `"version"`; loading a v1
file on Windows moves hotkeys that still hold the old Ctrl+Alt defaults to the new ones (once).

## 5. Avatar module (renderer)

### 5.1 Public API — `src/avatar/index.js`

```js
const avatar = await createAvatar(canvas, {
  renderer: 'relief' | 'procedural' | 'placeholder',
  packUrl: './assets/avatars/reference/',  // relief only (relative: works under vite and app://)
  quality: 'high', particles: 1, bloom: 1,
  seed: 1,                 // deterministic particles/noise
  fixedTime: undefined,    // number → freeze the clock (tests/visual diffs)
  transparent: true,       // premultiplied black→alpha output for the desktop overlay
});
avatar.setState(s)               // 'idle'|'listening'|'thinking'|'speaking'|'error'|'sleep'
avatar.setMouth({ jaw, wide, round, press, tuck, teeth, tongue })
                                 // 0..1 each, missing fields = 0; lip-sync target, director smooths.
                                 // press: lips pressed / rolled in (m b p); tuck: lower lip under the
                                 // upper teeth (f v); teeth: upper lip raised, teeth show (s z ee);
                                 // tongue: tongue tip at the teeth (th l)
avatar.setSpeechLevel(level)     // 0..1 loudness envelope (drives glow/energy)
avatar.setProsody(cue | cue[])   // speech prosody from the lip-sync: { type: 'accent'|'emphasis'|
                                 // 'phrase-start'|'phrase-end', strength?, punct?, friendly? } →
                                 // small nods, brow raises (emphasis, questions), phrase-end blinks,
                                 // micro-smiles after friendly sentences
avatar.setExpression({ smile, browUp }) // 0..1
avatar.blink()
avatar.lookAt(x, y)              // -1..1 in canvas space (cursor follow); lookAt(null) releases
avatar.setOptions(partial)       // quality/particles/bloom/colors at runtime
avatar.hitTest(clientX, clientY) // true if the pointer is over visible avatar pixels
avatar.renderOnce(time)          // render a single frame at time (tests)
avatar.advance(dt, { render })   // tests / harness: step a scripted clock with live dynamics
avatar.dispose()
```
`createAvatar` falls back renderer: relief → procedural → placeholder if loading fails, and
logs why. The canvas is cleared to transparent; the final pass outputs premultiplied
alpha derived from brightness so pure black is fully transparent on the desktop.

### 5.2 Head interface — `src/avatar/heads/<name>/index.js`

```js
export default class Head {
  /** @param {{ THREE, renderer, scene, camera, options, assetsBase: string }} ctx */
  constructor(ctx) {}
  async load() {}                         // fetch assets, build meshes, add to ctx.scene
  /** @param {number} dt seconds @param {number} time seconds @param {AnimState} a */
  update(dt, time, a) {}
  framing() { return { center: [x,y,z], height: h } } // stage frames the camera on this
  dispose() {}
}
```
`AnimState` (produced by `src/avatar/director.js`, all numbers, smoothed):
`jawOpen, mouthWide, mouthRound, mouthPress, mouthTuck, mouthTeeth, mouthTongue, mouthAsym (-1..1, lips a
little lopsided while talking), smile, blinkL, blinkR (0 open → 1 closed), gazeX, gazeY (-1..1),
browUp, headYaw, headPitch, headRoll (radians, small), breath (0..1 cycle), speech (0..1 loudness),
energy (0..1 overall glow), listen, think, speak, error, sleep (0..1 state weights)`.

## 6. Voice server — `voice/` (Python 3.12, FastAPI + uvicorn)

Launch: `python -m lawnmower_voice --host 127.0.0.1 --port <p> --token <t> [--device auto|cuda|cpu] [--stt-model large-v3-turbo] [--stt-language en|de|…|auto] [--tts-voice af_heart] [--preload]`
(token can also come from env `LAWNMOWER_VOICE_TOKEN`; the app passes it only there, plus `--preload`
so both models load right after start-up, and `--stt-language` from settings, which also picks the
CPU-fallback Whisper model). Prints one JSON line
`{"event":"ready","port":p}` to stdout once listening. When its own packages are missing (a venv
where the setup stopped halfway) it prints `{"event":"not-installed","missing":["uvicorn",…]}`
instead and exits with code 2; the app then shows "not fully installed" and does not restart it
until the setup runs again (or *Restart voice* / a settings change). All endpoints except `/health`
require `Authorization: Bearer <token>`. CORS: allow `http://127.0.0.1:5173`, `http://localhost:5173`,
`http://127.0.0.1:4173`, `http://localhost:4173` and `app://lawnmower` (not `null`: any web page can send
it; `--cors-origin null` opts in for debugging); headers Authorization, Content-Type, X-Sample-Rate.
Errors, including unexpected 500s, are JSON `{error, code}` and carry the CORS header.

| Method & path | Request | Response |
|---|---|---|
| `GET /health` | — | `{ ok, version, device: { cuda: bool, name, capability: "12.0", vramTotalMB, vramFreeMB }, stt: { backend, model, device, loaded, error? }, tts: { backend, device, loaded, voices: [..], error? } }` |
| `POST /stt` | body = WAV (PCM16 mono, any rate) — or raw little-endian float32 mono with header `X-Sample-Rate`; query `language` optional | `{ text, language, durationSec, processingMs }` |
| `POST /tts` | JSON `{ text, voice?, speed? }` | `{ sampleRate, audioB64 /* WAV PCM16 mono */, durationSec, processingMs, visemes: [{ start, end, viseme }] or null }` |
| `GET /voices` | — | `[{ id, name, lang, gender }]` |
| `POST /warmup` | — | `{ ok }` (loads models) |

Viseme ids (shared with the renderer's lip-sync): `sil, PP (m b p), FF (f v), TH, DD (t d n l), kk (k g), CH (ch j sh), SS (s z), RR (r), aa, E, I, O, U`.

## 7. Conversation pipeline (renderer)

`idle → listening (mic, VAD) → transcribing (/stt) → thinking (claude turn, no text yet) →
speaking (text streams → sentence chunker → /tts per sentence → ordered playback queue →
lip-sync) → idle`. Lip-sync (`src/audio/lipsync.js`): the voice server's viseme timeline, or for the
system voice the utterance's own words (`g2p.js` → an `articulation.js` plan, anchored by the voice's
word-boundary events), blended by a coarticulation model into the `setMouth` channels, plus
prosody cues for `setProsody`. Barge-in: hotkey/click while speaking stops playback, interrupts the
Claude turn and starts listening. Text typed in the chat panel enters at `thinking`.
Markdown and code are stripped for speech (`src/app/speech-text.js`); code blocks are shown
in the chat panel and replaced in speech by a short phrase. Permission requests (agent
mode) show an approval card and the avatar says a short prompt; nothing is auto-approved.

## 8. Testing

* `npm test` — vitest unit tests (electron modules with fake `claude` CLI script; app logic;
  avatar director). No network, no GPU, no Electron binary needed.
* `npm run test:e2e` — Playwright (Chromium, SwiftShader WebGL) against `vite preview` with
  the mock bridge: app boots, avatar renders non-black, typed message round-trips through
  the mock, states change.
* `npm run test:voice` — pytest with model backends mocked (no downloads).
* Visual check: `/dev/avatar.html?fixedTime=1&compare=1` renders the avatar next to the
  pack's reference frame (`assets/avatars/<pack>/preview/{neutral,blink,teeth,open}.jpg`);
  `tools/visual/` has the screenshot and compare tools (URL parameters in its README).
* Real app: `ELECTRON_PATH=<electron binary> xvfb-run -a node scripts/electron-e2e.mjs [--live]`
  launches `electron/main.js` with Playwright's Electron driver (fake or real Claude CLI) and checks
  app://, CSP, the bridge, settings IPC, the "not logged in" card + Retry, a streamed turn, voice
  status and a clean boot without console errors.
* Packaged app: `ELECTRON_PATH=<installed "Lawnmower Man.exe" | release/linux-unpacked/lawnmower-man>
  node scripts/electron-e2e.mjs --packaged` (no app path) also checks `app.isPackaged`, the
  resources an installer must deliver, the per-user voice folder and — through the real launcher in
  `-CheckOnly` mode — that the bundled setup script reports that same folder. The fake CLI reaches
  the packaged app through `LAWNMOWER_CLAUDE_CLI` (honoured when packaged on purpose; threat model in
  `electron/main.js`), `LAWNMOWER_E2E=1` exposes a few main-process helpers to `app.evaluate()`.
  `.github/workflows/release.yml` runs it against the silently installed NSIS build on windows-latest
  (`--software-webgl`: the runner has no GPU), then installs the same build over itself (the update
  path: the previous version's uninstaller runs with `/S --updated`) and checks that the per-user voice
  folder and the settings folder survive the update and a silent uninstall. An interactive uninstall
  asks before deleting those two folders (default No; `electron/assets/installer.nsh`).
