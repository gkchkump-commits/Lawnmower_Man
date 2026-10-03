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
    interrupt(): Promise<void>,                          // stop the current turn
    reset(): Promise<void>,                              // start a fresh conversation
    respondPermission(requestId: string, decision: { behavior: 'allow'|'deny', message?: string, updatedInput?: object }): Promise<void>,
    status(): Promise<ClaudeStatus>,
    onEvent(cb: (ev: ClaudeEvent) => void): () => void, // returns unsubscribe
  },
  voice: {
    info(): Promise<{ status: 'disabled'|'starting'|'ready'|'error'|'stopped', url?: string, token?: string, detail?: string, health?: object }>,
    restart(): Promise<void>,
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
    minimize(): void, hide(): void, quit(): void,
  },
  onHotkey(cb: (name: 'toggleListen'|'stopSpeaking'|'toggleChat') => void): () => void,
  app: { info(): Promise<{ version: string, platform: string, electron: string, chrome: string }> },
}
```

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
{ type: 'turn_end', turnId: string, result: string, isError: boolean, durationMs?: number, costUsd?: number, sessionId?: string }
{ type: 'error', message: string, turnId?: string }
```

`ClaudeStatus = { status, sessionId?: string, model?: string, busy: boolean, queue: number, cliPath?: string, cliVersion?: string }`

### 3.2 Claude CLI protocol (verified against Claude Code 2.1.x)

Spawn once and keep alive (one process = one conversation):

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --permission-prompt-tool stdio
       [--model <m>] [--effort <e>] [--resume <sessionId>]
       (chat mode)  --tools "" --system-prompt-file <persona.txt>
       (assistant)  --tools "Read,Glob,Grep,WebSearch,WebFetch" --allowedTools "Read,Glob,Grep,WebSearch,WebFetch" --append-system-prompt-file <persona.txt>
       (agent)      --append-system-prompt-file <persona.txt> [--permission-mode acceptEdits]
```
cwd = `settings.claude.workdir`. stdin lines (JSON, newline-terminated):

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
  },
  hotkeys: {
    toggleListen: 'CommandOrControl+Alt+Space',
    toggleChat: 'CommandOrControl+Alt+C',
    stopSpeaking: 'CommandOrControl+Alt+X',
  },
}
```

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
avatar.setMouth({ jaw, wide, round })   // 0..1 each; lip-sync target, director smooths
avatar.setSpeechLevel(level)     // 0..1 loudness envelope (drives glow/energy)
avatar.setExpression({ smile, browUp }) // 0..1
avatar.blink()
avatar.lookAt(x, y)              // -1..1 in canvas space (cursor follow); lookAt(null) releases
avatar.setOptions(partial)       // quality/particles/bloom/colors at runtime
avatar.hitTest(clientX, clientY) // true if the pointer is over visible avatar pixels
avatar.renderOnce(time)          // render a single frame at time (tests)
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
`jawOpen, mouthWide, mouthRound, smile, blinkL, blinkR (0 open → 1 closed), gazeX, gazeY (-1..1),
browUp, headYaw, headPitch, headRoll (radians, small), breath (0..1 cycle), speech (0..1 loudness),
energy (0..1 overall glow), listen, think, speak, error, sleep (0..1 state weights)`.

## 6. Voice server — `voice/` (Python 3.12, FastAPI + uvicorn)

Launch: `python -m lawnmower_voice --host 127.0.0.1 --port <p> --token <t> [--device auto|cuda|cpu] [--stt-model large-v3-turbo] [--tts-voice af_heart]`
(token can also come from env `LAWNMOWER_VOICE_TOKEN`). Prints one JSON line
`{"event":"ready","port":p}` to stdout once listening. All endpoints except `/health`
require `Authorization: Bearer <token>`. CORS: allow `http://127.0.0.1:5173`, `http://localhost:5173`,
`http://127.0.0.1:4173`, `app://lawnmower` and `null` origins; headers Authorization, Content-Type.

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
lip-sync) → idle`. Barge-in: hotkey/click while speaking stops playback, interrupts the
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
* Visual check: `/dev/avatar.html?fixedTime=1&compare=1` renders the avatar next to
  the reference frame (copy reference frames the harness needs into `public/` or import them).
