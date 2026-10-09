# Lawnmower Man: local GPU voice

The voice runs in a small Python server (`voice/`, package `lawnmower_voice`). The Electron
app starts it (`electron/voice-sidecar.js`) and the renderer calls it over
`http://127.0.0.1:<port>` with a bearer token:

* **Speech to text:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) running on CTranslate2. The default model is `large-v3-turbo`.
* **Text to speech:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) through [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) on onnxruntime. The default voice is `af_heart`.

Every reply also includes a **viseme timeline**, which drives the hologram's lip-sync.

The target machine is a Windows 11 laptop with an **NVIDIA GeForce RTX 5070 Laptop GPU (8 GB,
Blackwell, compute capability 12.0 / sm_120)**. Linux is also supported. If something is
missing, the voice degrades in steps:

1. GPU.
2. CPU (automatically, per engine).
3. The renderer's browser speech synthesis, when the server is absent or returns `503`.

---

## 1. Quick start

### From the app (installed or portable build, and `npm start`)

Choose **Set up local voice…** in the tray menu, in the settings drawer's Voice section, or in the
hint under the voice status. `electron/voice-setup.js` then:

1. stops the voice server if one is running (it keeps files of the venv open), and keeps it
   stopped until the setup has ended: no automatic restart, no *Restart voice*, no settings change
   starts it while the window installs into the venv (Windows locks files a running server uses);
2. opens a **visible PowerShell window** running the bundled `resources\scripts\setup-voice.ps1`
   (installed app) or `scripts\setup-voice.ps1` (repository) with `-ExecutionPolicy Bypass`. A
   windowless Windows PowerShell starts it with `Start-Process`, so it gets its own console with
   working input. All paths travel in environment variables, never on a command line or through
   `cmd.exe`, so user names with spaces, `&`, `%`, `'` or non-ASCII letters are fine. Both command
   lines are fixed, readable one-liners (no `-EncodedCommand`, no `-WindowStyle Hidden`). If the
   script cannot even start (a parse error, an execution policy set by Group Policy), the window
   shows the error, waits for Enter and reports it to the app instead of closing at once;
3. passes `-Cpu` when Chromium sees no NVIDIA GPU (`app.getGPUInfo`); when it cannot tell, the
   script asks (`nvidia-smi` missing → *"Install the CPU version instead? [Y/n]"*);
4. watches the JSON file the script writes when it ends (`-StatusFile`, in the app's settings
   folder). As soon as it reports success, the app turns local voice on and starts the new server
   — no restart, no *Restart voice* needed. A window closed early, or a failure, is reported in the
   drawer and as a toast, and the previous voice (if any) is started again. For a failure the
   drawer (*Settings › Voice*) also shows the last lines of the step that failed — where pip prints
   its `ERROR: …` — with **Open setup log** and **Copy** (see [5.1](#51-when-the-setup-fails)).

If **Python 3.12 is missing**, the script offers to install it for the current user with winget
(`winget install -e --id Python.Python.3.12 --scope user`, Y/n), then re-reads PATH and continues.
Without winget it prints the python.org link and stops cleanly. The window waits for Enter at the
end (`-PauseAtEnd`) so the output can be read.

**Linux:** the first terminal emulator found (gnome-terminal, konsole, xfce4-terminal, mate-terminal,
kitty, alacritty, wezterm, foot, xterm) runs `bash setup-voice.sh --pause-at-end --status-file …`;
without one (or without a display) the app shows the command with a Copy button. The browser
preview always shows the command.

The app never runs anything elevated, and it only runs the bundled script.

### By hand

**Windows 11** (PowerShell, from the repository folder, or from the installed app's `resources` folder):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1        # GPU (default)
powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1 -Cpu   # no NVIDIA GPU
# or double-click scripts\setup-voice.cmd
```

**Linux**:

```bash
scripts/setup-voice.sh          # GPU
scripts/setup-voice.sh --cpu    # CPU only
```

After that, start the app. The tray menu's "Restart voice" picks up a fresh install. **When you run
the script by hand, quit the app first** (tray > Quit): the running voice server locks files in the
venv, and the script refuses to touch a venv that is in use rather than leaving it half-deleted.
(*Set up local voice…* stops the server for you.)

**Installed app.** When the script runs from an installed app's `resources` folder (it finds
`resources\app.asar`), nothing goes into the install folder — the installer replaces it on every
update, and Program Files is not writable. Instead (the app looks in the same places):

| | Windows | Linux |
|---|---|---|
| venv | `%LOCALAPPDATA%\LawnmowerMan\voice\.venv` | `${XDG_DATA_HOME:-~/.local/share}/lawnmower-man/voice/.venv` |
| models | `%LOCALAPPDATA%\LawnmowerMan\voice\models` | `…/lawnmower-man/voice/models` |
| package copy used by pip | `…\voice\src` | `…/voice/src` |

The portable Windows build unpacks to a temporary folder on every start, but it bundles the same
script, and *Set up local voice…* works there too: the script sees `resources\app.asar` and installs
into `%LOCALAPPDATA%\LawnmowerMan\voice`, where the installed and the portable build both look.
Until local voice is set up, replies use a system (Windows) voice; *Settings › Voice* lists the
installed system voices (`voice.systemVoice`; *Automatic* picks the most natural English one).

The setup script does the following:

1. Finds Python 3.12 (`py -3.12`, `python3.12`, then `python`/`python3`, then the per-user install
   folders `%LOCALAPPDATA%\Programs\Python\Python312` (winget / python.org "just me") and
   `%LOCALAPPDATA%\Python\pythoncore-3.12-64` (Python install manager), which also covers a PATH
   that is stale right after winget installed Python; 3.11 is accepted). On Windows it offers to
   install 3.12 with winget when none is found.
2. Creates `voice/.venv` (or the per-user venv above), and records the models folder in it
   (`lawnmower-models-dir.txt`) when it is not the default, so the app's server finds the models.
3. Installs the GPU wheels described in section 3.
4. Removes the CPU `onnxruntime` wheel that dependencies drag in.
5. Checks CUDA.
6. Downloads the models into `voice/models/`.
7. Runs a smoke test that loads both engines and times one request each.

It is idempotent: re-running it reuses the venv and skips models it already has. It needs no
admin rights and no CUDA Toolkit, only the NVIDIA driver.

Every run (except `-CheckOnly` / `--check-only`) writes its whole output to **`setup.log`** in the
voice folder, and keeps the run before as `setup.prev.log` — see [5.1](#51-when-the-setup-fails).

| Option (PowerShell / bash) | Meaning |
|---|---|
| `-Cpu` / `--cpu` | CPU-only install (no NVIDIA wheels) |
| `-NoModels` / `--no-models` | Skip model downloads (they download on first use) |
| `-SttModel NAME` / `--stt-model NAME` | Whisper model to pre-download and smoke-test (default `large-v3-turbo`) |
| `-ModelsDir DIR` / `--models-dir DIR` | Model cache (default `voice/models`, or `$LAWNMOWER_VOICE_MODELS`). Recorded in the venv: the app and later runs use it without the option. A trailing `\` is fine. |
| `-Misaki` / `--misaki` | Install misaki, Kokoro's English G2P (pulls spaCy) |
| `-TorchTts` / `--torch-tts` | Install the optional PyTorch Kokoro backend (about 3 GB; Windows: torch cu128 from download.pytorch.org, Linux: the PyPI CUDA 13 build, so its cuDNN matches onnxruntime-gpu's) |
| `-Python PATH` / `--python PATH` | Use this interpreter |
| `-Recreate` / `--recreate` | Rebuild `voice/.venv` |
| `-SkipSmoke` / `--skip-smoke` | Skip the final smoke test |
| `-PauseAtEnd` / `--pause-at-end` | Wait for Enter before the window closes (the app passes it) |
| `-StatusFile FILE` / `--status-file FILE` | Write the result as JSON (`{ok, error, errorTail, log, voiceHome, venv, python, cpu, packaged, check}`); the app watches it. On a failure `error` is the failed step plus the last ~20 lines of its output, `errorTail` those lines, `log` the setup log |
| `-CheckOnly` / `--check-only` | Only report where the voice would go and which Python would be used; changes nothing |
| `-Yes` | Answer yes to questions (install Python 3.12 with winget) |

**Download sizes.** The GPU wheels are about 1.8 GB:

| Wheel | Size |
|---|---|
| cuBLAS 12 | 553 MB |
| cuBLAS 13 | 423 MB |
| cuDNN 9 (CUDA 13) | 436 MB |
| cuFFT | 161 MB |
| onnxruntime-gpu | 160 MB |
| CTranslate2 | 19 MB |

The models are about 2.0 GB:

| Model | Size |
|---|---|
| Whisper large-v3-turbo (CT2 fp16) | about 1.6 GB |
| Whisper base.en (CPU fallback) | 145 MB |
| Kokoro ONNX | 326 MB |
| Kokoro voices | 28 MB |

---

## 2. Architecture

```
Electron main ── spawn ──► python -m lawnmower_voice --host 127.0.0.1 --port P --device auto
 (voice-sidecar.js)          --stt-model large-v3-turbo --stt-language en --tts-voice af_heart --preload
                             (cwd voice/, env LAWNMOWER_VOICE_TOKEN)
        ▲  stdout: {"event":"status",...}* then {"event":"ready","port":P,"device":"cuda","gpu":"…"}
        │  GET /health polling
Renderer ── fetch (Bearer token, CORS) ──► FastAPI (uvicorn, 127.0.0.1 only)
                                            ├─ /stt  → audio.py (decode WAV/float32, resample→16 kHz) → stt.py (faster-whisper)
                                            ├─ /tts  → tts.py (Kokoro) → visemes.py → WAV PCM16 + visemes
                                            ├─ /voices, /warmup, /health (device.py: NVML/nvidia-smi/CT2/ORT probes)
                                            └─ fake.py engines with --fake (tests, other lanes' e2e)
```

| Module | Role |
|---|---|
| `__main__.py` | CLI. Prints exactly one `ready` JSON line once listening. File descriptor 1 is pointed at stderr, so a native library's `printf` cannot corrupt the protocol pipe. Exits when the launching process dies. `--preload` loads both engines in the background after `ready`. |
| `server.py` | `create_app(config, stt, tts, device)` with injectable engines. Pure-ASGI CORS (including Chromium's Private-Network preflight) and a loopback `Host` check against DNS rebinding. Constant-time bearer auth on everything except `/health`. Body-size and duration limits. JSON errors `{error, code}`. Blocking work runs in the threadpool. A per-engine queue limit returns `503 busy`. |
| `engines.py` | Base class: lazy `ensure_loaded()` and one lock per engine, so GPU work is serialised per engine. A failed load is cached for 30 s; `/warmup` forces a retry. |
| `stt.py` | `FasterWhisperSTT` and its device plan with fallback (section 4.3). |
| `tts.py` | `KokoroOnnxTTS` (primary), `KokoroTorchTTS` (optional), the voice catalogue. |
| `visemes.py` | IPA, misaki or text input to `[{start, end, viseme}]`. |
| `audio.py` | WAV PCM 8/16/24/32-bit, float32/64 and EXTENSIBLE; stereo to mono; `scipy.signal.resample_poly` or a numpy Kaiser-sinc polyphase fallback; PCM16 WAV encoder. |
| `device.py` | GPU detection without torch, plus Blackwell compatibility warnings. |
| `cuda_libs.py` | Makes the pip NVIDIA DLLs and .so files findable, in the right order (section 4.2). |
| `download.py` | Model pre-download (atomic `.part` files). |
| `doctor.py` | Environment report and GPU smoke tests. |

### 2.1 HTTP API

This implements contract section 6. Extra fields are additive.

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` (no auth) | n/a | `{ok, version, device:{cuda, name, capability, vramTotalMB, vramFreeMB, driverVersion, cudaDriverVersion, warnings[]}, stt:{backend, model, device, computeType, loaded, loading?, error?, note?, requestedModel?}, tts:{backend, device, loaded, voices[], defaultVoice, error?, note?}, fake, uptimeSec, pid}` |
| `POST /stt?language=en` | A WAV body (any rate or channels). Or raw little-endian float32 mono with `X-Sample-Rate: 48000`. Up to 64 MB and 180 s. | `{text, language, durationSec, processingMs}` |
| `POST /tts` | `{"text": "...", "voice": "af_heart", "speed": 1.0}`. One sentence per request is best; the limit is 4000 characters. | `{sampleRate: 24000, audioB64 (16-bit PCM mono WAV), durationSec, processingMs, visemes:[{start,end,viseme}], voice}` |
| `GET /voices` | n/a | `[{id, name, lang, gender}]` (54 Kokoro v1.0 voices) |
| `POST /warmup` | n/a | `{ok, stt, tts}`: loads TTS, then STT |

Notes on the fields:

* `ok` is `false` only when **both** engines report an error.
* `note` explains a fallback, for example "fell back to cuda int8_float16 after: …".

Errors return `{error, code}`:

| Status | When |
|---|---|
| 400 | Bad audio, JSON or voice |
| 401 | Missing or wrong token. Includes `WWW-Authenticate: Bearer`. |
| 403 | Disallowed `Origin` or `Host` |
| 413 | Body or audio too large or too long |
| 503 | Engine unavailable or busy |

The `error` text always says how to fix the problem; for example, it names the setup script.

**Viseme ids** (shared with the renderer): `sil PP FF TH DD kk CH SS RR aa E I O U`.

* Times are in seconds from the start of the returned audio.
* Segments are contiguous, cover `[0, durationSec]`, and never repeat the same viseme twice in a row.
* Diphthongs split 60/40, for example `eɪ` becomes `E` then `I`.
* Stress marks lend their time to the next phoneme and length marks to the previous one.
* Word gaps under 120 ms keep the mouth shape; punctuation becomes `sil`.

The Kokoro v1.0 export used here has a `duration` output, so these are **real per-phoneme
times**. If an engine only reports the total duration, phonemes are spread across the audible
span, weighted by class: vowels and diphthongs get the longest slots, stops the shortest.

**Aligned with the audio.** Kokoro's audio runs ahead of the times its durations give. Measured
on real clips (`af_heart`, `am_michael`, six sentences each, speeds 0.8 / 1.0 / 1.35), acoustic
onsets after a pause, the level dip of m / b / p between vowels and the cross-correlation of the
timeline's openness with the level envelope all came 47-62 ms early: about one 25 ms frame plus
one frame scaled by 1 / speed. Both backends therefore shift the timeline by
`kokoro_audio_lead(speed)` (50 ms at speed 1, `visemes.py`). Afterwards (median, 12 clips):

| | before | after |
|---|---|---|
| closure (m b p between vowels): level dip vs segment centre | -54 ms | -5 ms |
| onset after a pause: sound vs first segment | -46 ms | +5 ms |
| openness / level cross-correlation lag | -50 ms | 0 ms |

(negative = the sound comes before the timeline). The PyTorch backend uses the same model and gets
the same shift; it was not measured separately.

### 2.2 Fake mode

`python -m lawnmower_voice --fake` needs no models:

* **STT** returns `"Hello Claude, this is a test of the fake voice server."` for non-silent audio and `""` for silence. Override the text with `LAWNMOWER_VOICE_FAKE_TEXT`.
* **TTS** synthesises a short formant buzz with an exact viseme timeline.
* `LAWNMOWER_VOICE_FAKE_DELAY_MS` adds latency.

Without `--token` or `LAWNMOWER_VOICE_TOKEN`, a token is generated and included in the `ready` line.

### 2.3 Lip-sync in the renderer

`src/audio/lipsync.js` samples the timeline at the playback clock with a 50 ms visual lead and
blends neighbouring visemes with the renderer's coarticulation model (`src/audio/articulation.js`,
dominance functions): closures (`PP`) and tucks (`FF`) stay crisp even when they are only 50 ms
long, and rounding (`O`, `U`) is anticipated by up to ~120 ms. The renderer also analyses the
clip's own audio (`src/audio/prosody.js`): its loudness envelope opens the jaw (stressed, louder
syllables wider), its pitch drives nods, brows, phrase-final lowering and breaths, and a
phrase-final sound rests where the voice really stops. The 14 viseme ids and the WAV are the
whole interface. Measured end to end with `tools/visual/lipsync-align.mjs` on real Kokoro clips,
the rendered mouth now leads the sound by ~35 ms at closures (it trailed by ~12 ms before), which
the display's own latency (one to two frames) brings close to zero on screen.

When the local voice is not running, the system voice speaks and there is no timeline: the
renderer predicts one from the words (`src/audio/g2p.js`) and anchors it on the voice's word
boundary events (details in [RENDERER.md](RENDERER.md#lip-sync)).

### 2.4 Voice character

The renderer gives the local voice a synthetic "hologram" timbre (*Settings → Voice → Character*
and *Settings → Voice → Intensity*, saved as `voice.character` and `voice.fxAmount`):

| Character | What it does |
|---|---|
| **Synth** (default) | The voice stays the strongest layer. Under it: a vocoder copy exactly at the voice's own pitch (a perfectly periodic, buzz-bright double), a doubler (two slowly drifting 11/17 ms copies), a short metallic comb resonance and a high shelf for digital air. Clearly synthetic, still easy to understand. |
| **Vocoder** | Everything is vocoded (28 bands); the pitch snaps to semitones, a classic synth voice. Noise excites the consonants and the dry sibilance is mixed back so *s*, *sh* and *t* stay crisp. |
| **Robot** | A monotone vocoder (one note per sentence: the sentence's median pitch, plus a sub-octave), 55 Hz ring modulation, a little bit-crush grit and a low metallic comb. |
| **Natural** | The voice exactly as Kokoro made it (the effect is bypassed bit-exactly). |

*Intensity* (0–100 %, default 60 %) scales the wet layers and their strength. All characters keep
the loudness of the dry voice (a gated AGC, measured starting points per character) and a peak
limiter keeps every sample under 0.95.

It applies to the **local voice only**: the system voice (Web Speech) plays outside the page's
audio graph and cannot be processed; the drawer says so while it is the one speaking.

**How it runs.** `src/audio/voicefx.js` is pure JS (no imports, unit-tested in Node);
`src/audio/voicefx-worklet.js` runs it in an AudioWorklet on the audio thread, one node for the
whole session. The player routes each clip through it (or straight to the speakers for Natural)
and keeps its AnalyserNode on the **dry** voice, so the lip-sync and `current.time` are exactly
what they were. The effect has no latency (one 128-sample block); tails (comb, doubler) ring out in
the shared node after a clip has ended instead of delaying the next one. The player hands every
clip's samples to the worklet before it plays, so the carrier's pitch comes from a YIN analysis
of the clip itself with windows centred on each instant: no tracking lag and no octave slips
(median error 0.6 % against librosa's pYIN on real Kokoro speech; a live tracker lagged by ~25 ms).
The worklet module loads in the background at start-up; only a very first clip may wait for it,
at most 30 ms. Without AudioWorklet, when the module cannot load or when the processor fails, the
voice plays unprocessed and the console says why.

**Measured** on 24 real Kokoro sentences (af_heart and am_michael: 10 Harvard sentences, a greeting
and a question), at 48 kHz:

| | STOI vs the dry voice | recogniser word error rate | loudness vs dry |
|---|---|---|---|
| Natural | 1.00 | 22.9 % | 0 dB |
| Synth 40 % / **60 %** / 90 % | 0.97 / **0.94** / 0.87 | 24.8 / **30.3** / 51.1 % | 0.0 / 0.0 / +0.1 dB |
| Vocoder 60 % | 0.74 | 79 % | +0.3 dB |
| Robot 60 % | 0.65 | 90 % | +0.6 dB |

STOI (short-time objective intelligibility, `pystoi`) predicts intelligibility from the band
envelopes; the word error rates come from pocketsphinx, an old recogniser trained on natural speech
that is far harsher on vocoded timbres than people are (16–20-channel vocoded sentences are close to
fully intelligible to listeners: Shannon et al. 1995, Friesen et al. 2001), so treat them as a
relative measure. The synth default was tuned
on these numbers: a louder vocoder layer, or 20 bands instead of 28, smears the formants enough to
cost ~10 points of recogniser accuracy. Cost: 1.9 % of the audio thread in Chromium (~0.05 ms per
2.7 ms block) on average; the main thread only hands the clip over (~0.1 ms). Cold start: the
first voiced clip of a session used to run the pitch analysis and the voiced DSP before V8 had
compiled them, on the audio thread (its first 200 ms of audio took 85-120 ms of CPU, single blocks
4-7 ms against the 2.7 ms budget: a possible crackle at the start of the first reply). While the
node idles, the processor now warms up a scratch effect on a synthetic voice (one block per idle
block, synth then vocoder and robot, ~1.2 s, never output, dropped as soon as a clip arrives):
18-30 ms for the first clip against 11-21 ms for the second, with at most a few blocks just over
budget (`node tools/voicefx/coldstart.mjs`, Node on a shared 2.1 GHz vCPU). A clip start (decode + graph) takes
p50 1.6 ms / max 6.1 ms for a 7-second sentence, with the native base64 decoder and a typed 16-bit
WAV path in `src/audio/wav.js`.

**Tuning or demos:** `node tools/voicefx/render.mjs --dry --out DIR clip.wav …` renders every
character at 40/60/90 % with the app's own DSP (resampled to 48 kHz like the AudioContext); the
preset parameters are `presetParams()` in `src/audio/voicefx.js`.

---

## 3. Research and decision (October 2026)

### 3.1 Speech to text: faster-whisper 1.2.1 + CTranslate2 4.8.2 (primary)

These facts come from inspecting the published wheels, not only from documentation:

* **Build.** CTranslate2's wheels are built with **CUDA 12.8**, with `CUDA_ARCH_LIST=Common`, **`WITH_CUDNN=OFF`** and `CUDA_DYNAMIC_LOADING=ON` (from the [Windows build script](https://github.com/OpenNMT/CTranslate2/blob/master/python/tools/prepare_build_environment_windows.sh) and the [Linux build script](https://github.com/OpenNMT/CTranslate2/blob/master/python/tools/prepare_build_environment_linux.sh)). Since 4.6.3 there is a pure-CUDA Conv1d ([changelog](https://github.com/OpenNMT/CTranslate2/blob/master/CHANGELOG.md)), so **no cuDNN is needed at runtime, only cuBLAS 12**.
* **Kernels.** Parsing the fatbins of `ctranslate2-4.8.2` (both the Windows and the Linux wheel) shows SASS for sm_53 to sm_86 plus **PTX compute_86**. On an RTX 50-series GPU, CTranslate2's own kernels are therefore JIT-compiled by the driver on first use. The result is cached, so the setup script's smoke test pays that cost once; the server raises `CUDA_CACHE_MAXSIZE` to 1 GiB so the cache is not evicted. The GEMMs run in cuBLAS 12.9, which has native Blackwell kernels.
* **How cuBLAS is loaded.** The loader ([`src/cuda/cublas_stub.cc`](https://github.com/OpenNMT/CTranslate2/blob/master/src/cuda/cublas_stub.cc)) calls `LoadLibraryA("cublas64_12.dll")` after `SetDllDirectoryA(%CUDA_PATH%\bin)` on Windows, and `dlopen("libcublas.so.12")` on Linux. It ignores `os.add_dll_directory`. `cuda_libs.py` therefore pre-loads cuBLAS from the `nvidia-cublas-cu12` wheel by **full path** (an already loaded module wins) and prepends its folder to `PATH`. This also stops an old CUDA Toolkit referenced by `%CUDA_PATH%` from being used.
* **int8 bug.** Before 4.7, `int8` on sm_120 failed with `CUBLAS_STATUS_NOT_SUPPORTED`; `float16` worked ([SubtitleEdit #10180](https://github.com/SubtitleEdit/subtitleedit/issues/10180), fixed upstream in CTranslate2 PR #1982; also [hermes-agent #17526](https://github.com/NousResearch/hermes-agent/issues/17526) and [voxint #429](https://github.com/bengizmo/voxint/issues/429)). The server requires `ctranslate2>=4.7` and **defaults to `float16`** (the most widely confirmed path). It also falls back automatically: `int8_float16`, then the CPU.
* **pip NVIDIA libraries.** faster-whisper's README documents only the `LD_LIBRARY_PATH` method on Linux ([README](https://github.com/SYSTRAN/faster-whisper#gpu)). The pip `nvidia-cublas-cu12` wheels have shipped `win_amd64` builds with `nvidia/cublas/bin/cublas64_12.dll` for a long time; the layout was verified from the wheel's zip directory. With the full-path pre-load, no PATH editing or CUDA Toolkit is needed on either OS.

### 3.2 Text to speech: kokoro-onnx 0.6.1 + onnxruntime-gpu ≥ 1.27 (primary)

| | **kokoro-onnx 0.6.1** (chosen) | PyTorch `kokoro` 0.9.4 (optional backend) |
|---|---|---|
| RTX 50-series | `onnxruntime-gpu` 1.27+ on PyPI is **built for CUDA 13** (`build_and_package_info.cuda_version = '13.0'`). Its Windows CUDA provider DLL contains **native SASS for sm_75 to sm_120 plus PTX 120**, verified by parsing the 1.30.0 wheel ([pipeline archs](https://github.com/microsoft/onnxruntime/blob/main/tools/ci_build/github/azure-pipelines/py-cuda-packaging-pipeline.yml)). Older wheels such as 1.23 failed on Blackwell with `cudaErrorNoKernelImageForDevice` ([onnxruntime #26245](https://github.com/microsoft/onnxruntime/issues/26245), [Natfii/onnxruntime-gpu-blackwell](https://github.com/Natfii/onnxruntime-gpu-blackwell)). | `torch` cu128 from download.pytorch.org has supported sm_120 since torch 2.7 (cu129 is deprecated; cu130 is newer). |
| Install on Windows | All from PyPI: `onnxruntime-gpu[cuda,cudnn]` pulls the CUDA 13 runtime, cuBLAS 13, cuFFT, cuRAND and `nvidia-cudnn-cu13`. `onnxruntime.preload_dlls()` finds them. espeak-ng is bundled by `espeakng-loader`. About 1.2 GB. | Needs an extra index URL for torch (about 3 GB). `misaki[en]` pulls spaCy, plus a runtime `en_core_web_sm` download. Requires Python < 3.13. |
| Driver | CUDA 13 needs **R580+** ([CUDA 13.0 notes](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html): Linux ≥ 580.65.06). Older drivers make the server fall back to the CPU, with a warning. | R570+ (CUDA 12.8) |
| Timestamps | The `model-files-v1.1` export has a **`duration` output**. `create_timed()` returns per-phoneme `(phoneme, start, end)`, verified with the real model here. | Word timestamps for English, plus per-token `pred_dur` (also used for per-phoneme timings) |
| Latency | onnxruntime CUDA; measured **RTF 0.26 on the CPU** (4 shared vCPUs) here. GPU numbers are not measured here (no GPU). | Similar on GPU, heavier start-up |
| G2P | espeak-ng (bundled). misaki is optional (`-Misaki`). | misaki (gold dictionaries) with espeak fallback |

**Decision.** The primary TTS is kokoro-onnx on onnxruntime-gpu (CUDA 13), with the CUDA
provider's arena capped at 2 GB and `cudnn_conv_algo_search=HEURISTIC` (EXHAUSTIVE would
re-benchmark convolutions for every new sentence length). There are three fallbacks:

* the same engine on the CPU execution provider, chosen automatically at load or on a CUDA error;
* `--tts-backend torch` (PyTorch kokoro);
* the renderer's browser speech.

**Shared-process caveat (Windows).** The CTranslate2 wheel bundles its own `cudnn64_9.dll`
(a CUDA 12 build) and loads it on import, and the Windows loader resolves imports by module
name. `cuda_libs.prepare()` therefore runs onnxruntime's `preload_dlls()`, and loads its CUDA
provider DLL, *before* CTranslate2 is imported.

**Dependency clash.** Both `faster-whisper` and `kokoro-onnx` depend on the CPU `onnxruntime`
wheel, which owns the same `onnxruntime/` folder as `onnxruntime-gpu`. The setup scripts
uninstall both wheels and force-reinstall `onnxruntime-gpu` (`--no-deps`). `/health` warns if
both wheels are present.

### 3.3 VRAM budget (8 GB laptop)

| Consumer | Estimate | Source |
|---|---|---|
| Whisper large-v3-turbo, `float16` | **~2.5 GB** peak (~1.6 GB weights) | Community measurement of 2,537 MB ([Spheron](https://www.spheron.network/tools/gpu-recommender/openai/whisper-large-v3-turbo/), [GigaGPU](https://gigagpu.com/whisper-vram-requirements/)). faster-whisper's own table for large-v2 (2× the parameters) is 4.5 GB fp16 / 2.9 GB int8 on an RTX 3070 Ti 8 GB. |
| ...or `int8_float16` | ~1.5 to 1.8 GB | Same sources |
| Kokoro-82M ONNX fp32 on CUDA | ~0.6 to 1.0 GB (326 MB weights; arena capped at 2 GB) | Estimate |
| CUDA context (one process, shared) | ~0.3 to 0.5 GB | Estimate |
| WebGL hologram (Electron) | ~0.3 to 0.8 GB | Estimate; depends on quality setting |
| Windows desktop and other apps | ~0.5 to 1.0 GB | Estimate |
| **Total** | **~4.5 to 6 GB of 8 GB** | Leaves headroom |

The defaults (`float16` turbo, fp32 Kokoro, 2 GB arena cap) fit comfortably. If VRAM is
tight (a game is running, `/health` shows low `vramFreeMB`), try these:

* `--stt-compute-type int8_float16` saves about 0.8 GB.
* `--tts-gpu-mem-mb 1024` lowers the arena cap.
* `--tts-model kokoro-v1.0.fp16.onnx` (164 MB) uses less memory; download it into `voice/models/kokoro/` first.
* `--stt-model small.en` is much smaller.

On GPUs under 5 GB, the server starts with `int8_float16` automatically.

---

## 4. Details

### 4.1 Python version

* **3.12 is recommended**. 3.11 works.
* 3.10 installs, but onnxruntime-gpu ≥ 1.27 needs Python ≥ 3.11, so the TTS runs on the CPU there.
* 3.13 is excluded: PyTorch `kokoro` needs < 3.13, and the pins are kept consistent.
* On Windows, the "python" stub that opens the Microsoft Store is detected and skipped.

### 4.2 How the NVIDIA libraries are found (`cuda_libs.prepare`)

1. Collect `site-packages/nvidia/*/bin` (cuBLAS 12, cuDNN) and `nvidia/cu13/bin/x86_64` (CUDA 13 runtime, cuBLAS 13, cuFFT) on Windows, or `nvidia/*/lib` on Linux. Then call `os.add_dll_directory` and prepend the folders to `PATH`.
2. If onnxruntime-gpu is installed: `onnxruntime.preload_dlls()` (stdout redirected to stderr), then load `onnxruntime_providers_cuda.dll`.
3. Load `cublasLt64_12.dll` and then `cublas64_12.dll` by full path (`libcublasLt.so.12` and `libcublas.so.12` with `RTLD_GLOBAL` on Linux).
4. Set `CUDA_CACHE_MAXSIZE=1GiB` unless it is already set.

The report shows up in `python -m lawnmower_voice.doctor --human`.

### 4.3 STT device plan

`--device auto` with a GPU tries these in order:

1. `cuda float16`
2. `cuda int8_float16`
3. `cpu int8` with **`base.en`**: on the CPU, large models are swapped for `--stt-cpu-model`. `base` is used instead for non-English, and `--stt-cpu-model same` keeps the large model.

Each step must survive a warm-up transcription; that is where the PTX JIT and cuBLAS
problems show up. A CUDA-looking error during a later request also moves to the next step and
retries once. `/health` `stt.note` says what happened.

Recognition settings:

* Silero VAD filter (`min_silence_duration_ms=500`, `speech_pad_ms=200`).
* `condition_on_previous_text=False`, `without_timestamps=True`.
* Beam 5 on the GPU, 1 on the CPU (`--stt-beam-size`).
* Segments that are probably not speech are dropped, as are Whisper's classic "Thank you." hallucinations on near-silence.

### 4.4 Changing voices and models

* **Voice:** *Settings → Voice → Voice* (saved as `voice.ttsVoice`; the list comes from `GET /voices`). Or pass `--tts-voice`, or send `voice` per request. `GET /voices` lists all 54:

  | Prefix | Language |
  |---|---|
  | `af_*` / `am_*` | US English, female / male (`af_heart`, `af_bella`, `af_nicole`, `am_michael`, `am_fenrir`, …) |
  | `bf_*` / `bm_*` | British English (`bf_emma`, `bm_george`, …) |
  | `e*` | Spanish |
  | `f*` | French |
  | `h*` | Hindi |
  | `i*` | Italian |
  | `j*` | Japanese |
  | `p*` | Brazilian Portuguese |
  | `z*` | Mandarin |

  The espeak language is picked from the voice prefix. Japanese and Mandarin quality is better with misaki's language packs and the torch backend.
* **Speed:** the `speed` parameter, 0.5 to 2.0 (clamped).
* **Whisper model:** *Settings → Voice → Speech model* (`voice.sttModel`, passed as `--stt-model`; changing it restarts the server). Any faster-whisper name works (`large-v3-turbo`, `turbo`, `large-v3`, `distil-large-v3.5`, `medium.en`, `small.en`, `base.en`, …), or a path to a CTranslate2 model folder. Pre-download with `voice/.venv/.../python -m lawnmower_voice.download --stt-model NAME`.
* **Language:** `voice.sttLanguage` in settings.json (no drawer control) → `/stt?language=` on every request, and `--stt-language` at
  start-up (it picks the CPU-fallback model: `base.en` for English, multilingual `base` otherwise).
  `auto` (or empty) detects the language; switching between English and another language restarts the server.
* **Kokoro precision:** `--tts-model kokoro-v1.0.fp16.onnx` or `kokoro-v1.0.int8.onnx` (int8 is audibly worse). Files come from [model-files-v1.1](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1); a mirror can be set with `LAWNMOWER_VOICE_KOKORO_URL`.
* **Better English pronunciation:** `-Misaki` / `--misaki`, then `--tts-g2p misaki` (auto-used when installed).
* **PyTorch backend:** `-TorchTts`, then `--tts-backend torch`.
* **Extra server flags from the app:** `LAWNMOWER_VOICE_ARGS="--stt-compute-type int8_float16"` (read by `voice-sidecar.js`). The app always passes `--preload`, so both engines load (and the RTX 50-series kernel JIT happens) right after start-up; until speech recognition reports `loaded`, the first `/stt` gets a 4-minute timeout instead of 60 s.
* **Model cache location:** `LAWNMOWER_VOICE_MODELS` > the folder recorded in the venv by the setup script > the per-user folder (installed app) > `voice/models`. `--models-dir` overrides all. Whisper files live under `whisper/`, Kokoro files under `kokoro/`.
* **Changing the voice** in Settings takes effect with the next sentence; it does not restart the server.

---

## 5. Troubleshooting

Start with `voice\.venv\Scripts\python -m lawnmower_voice.doctor --smoke --human` (on Linux,
`voice/.venv/bin/python`). Also check `GET /health`: `device.warnings`, `stt.note/error` and
`tts.note/error`.

| Symptom | Cause and fix |
|---|---|
| `nvidia-smi` missing, or `/health` `device.cuda=false` on the laptop | Install the current NVIDIA Studio or Game Ready driver from nvidia.com. On hybrid laptops, set *NVIDIA Control Panel → Manage 3D settings → Program settings* for `python.exe`/`Lawnmower Man.exe` to *High-performance NVIDIA processor*. |
| Warning "needs an NVIDIA driver with CUDA 12.8+ (R570 or newer)" | RTX 50-series requires R570 or newer. Update the driver. |
| TTS on CPU with "driver only supports CUDA 12.x" | onnxruntime-gpu ≥ 1.27 is a CUDA 13 build and needs **R580+**. Update the driver. Speech recognition still uses the GPU. |
| `no kernel image is available for execution on the device` / `cudaErrorNoKernelImageForDevice` | A library built without sm_120. Check `doctor`: you need `ctranslate2 >= 4.7`, `onnxruntime-gpu >= 1.27` (CUDA 13 build) and, for the torch backend, torch 2.7+ with CUDA 12.8 or newer (Windows: `https://download.pytorch.org/whl/cu128`; Linux: the PyPI build). Re-run the setup script. The server already fell back to the next option. |
| `CUBLAS_STATUS_NOT_SUPPORTED` | CTranslate2 < 4.7 running int8 on Blackwell, or an old cuBLAS from `%CUDA_PATH%`. Re-run setup. The pip cuBLAS 12.9 is pre-loaded by full path. Forcing `--stt-compute-type float16` also avoids it. |
| `Library cublas64_12.dll is not found or cannot be loaded` | `nvidia-cublas-cu12` is missing from the venv. Run `voice\.venv\Scripts\python -m pip install "nvidia-cublas-cu12>=12.8"`, or re-run setup. |
| `cudnn64_9.dll` / `Could not locate cudnn_ops64_9.dll` (TTS) | `nvidia-cudnn-cu13` is missing. Run `pip install "onnxruntime-gpu[cuda,cudnn]>=1.27"`, or re-run setup. Do **not** install `nvidia-cudnn-cu12` in the same venv: it uses the same folder and DLL names. |
| Warning: both `onnxruntime` and `onnxruntime-gpu` installed | Run `pip uninstall -y onnxruntime onnxruntime-gpu`, then `pip install --no-deps --force-reinstall "onnxruntime-gpu>=1.27"`. The setup script does this. |
| First GPU request after install takes 30 to 90 s | One-time PTX JIT of CTranslate2 kernels for sm_120. It is cached in `%APPDATA%\NVIDIA\ComputeCache` (Windows) or `~/.nv/ComputeCache` (Linux); a driver update invalidates it. The app starts the server with `--preload`, so this happens at start-up (the mic tooltip says "still loading"); run the server with `--preload` (or call `/warmup`) when you start it by hand. |
| `Microsoft Visual C++ Redistributable is not installed` or a DLL load failure | Run `winget install -e --id Microsoft.VCRedist.2015+.x64`. |
| `espeak` / `Failed to load espeak shared library` | `espeakng-loader` ships espeak-ng. If your antivirus quarantined it, restore it, or install espeak-ng system-wide and set `PHONEMIZER_ESPEAK_LIBRARY` to `libespeak-ng.dll`/`.so`. |
| User name with non-ASCII letters (`C:\Users\José`), or a very long venv path | espeak-ng opens its data folder with ANSI file APIs on Windows (and has a fixed path buffer), and exits the process when it cannot. The server hands it the 8.3 short path, or makes a one-time copy in `%PROGRAMDATA%\LawnmowerMan\espeak-ng-data` (Linux: `~/.cache/lawnmower-man`). `doctor` warns when this applies. |
| `OMP: Error #15: Initializing libiomp5md.dll, but found libiomp5md.dll already initialized` | CTranslate2 and torch (`-TorchTts`, or pulled in by `-Misaki`) each ship Intel OpenMP. The app and the server set `KMP_DUPLICATE_LIB_OK=TRUE` on Windows; set it yourself when you run the server by hand. |
| `doctor` warns that `nvidia-cudnn-cu12` and `nvidia-cudnn-cu13` are both installed | They overwrite each other's files in `nvidia/cudnn` (typically after a cu12/cu128 torch build on Linux). Re-run the setup script with `--recreate`. |
| `Python 3.12 was not found` | Answer **Y** when the setup offers winget, or run `winget install -e --id Python.Python.3.12 --scope user`, or use python.org (tick *Add to PATH*). The Store alias does not count. Then run *Set up local voice…* again. |
| `running scripts is disabled on this system` | Use `powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1`, or `setup-voice.cmd`. Run it in a normal PowerShell window, not the ISE. |
| Model download fails (proxy or offline) | Re-run the setup script later. The server reports `Whisper model '…' is not downloaded` with a 503 until then; Kokoro has the same behaviour. Copy model folders from another machine into `voice/models/whisper` (Hugging Face cache layout) and `voice/models/kokoro/`. `--no-download` forbids network access at runtime. |
| Everything works but runs on the CPU | Read `stt.note` and `tts.note` in `/health`; they quote the GPU error. The CPU fallback is deliberate, so the avatar keeps talking. |
| Port or start-up problems | The server prints `{"event":"ready",...}` only after binding, and exits non-zero if the port is taken. The app chooses a free port. Logs go to stderr, and the Electron log keeps the tail. |
| The voice sounds unprocessed although *Character* is Synth, Vocoder or Robot | The system voice is speaking (only the local voice can be processed), or the effect could not start: the renderer then logs `[player] the voice character effect is unavailable (…)` (DevTools with F12 in a dev build, or `main.log` with `LAWNMOWER_DEBUG=1`). The voice keeps working unprocessed; restart the app. |
| The synthetic voice is too much, or not enough | *Settings → Voice → Intensity*, or another *Character*; Natural turns it off. |
| *Server: disabled* — "Local voice is not fully installed (missing: uvicorn)" | The venv exists but the setup stopped before the packages were installed (the server reports `{"event":"not-installed","missing":[…]}` and exits with code 2). The app does not restart it in a loop; it waits for *Set up local voice again…*, *Restart voice* or a changed setting. Find out why the setup stopped in its log (5.1), fix that, run the setup again. |

### 5.1 When the setup fails

The setup window prints the error at the end, and the app shows it in *Settings › Voice*: the
failed step, the last lines of its output (monospace, scrollable, selectable) and the buttons
**Open setup log** (opens the log in your text editor) and **Copy** (the error, those lines and
where the log is, ready to paste into a bug report). *Set up local voice again…* is right below.

The full output of every run is in the voice folder:

| | Log of the last run | The run before |
|---|---|---|
| Windows, installed app | `%LOCALAPPDATA%\LawnmowerMan\voice\setup.log` | `…\setup.prev.log` |
| Linux, installed app | `${XDG_DATA_HOME:-~/.local/share}/lawnmower-man/voice/setup.log` | `…/setup.prev.log` |
| Repository (`npm start`, or run by hand) | `voice/setup.log` | `voice/setup.prev.log` |

It is UTF-8 text: a header (date, script path and version, PowerShell or bash version, Python,
the switches, the voice/venv/models folders), every step header, every command with all of its
output (pip's included) and exit code, the summary, and at the end the result the app received.
It is written as the setup goes, so it is complete up to the point where a window was closed.

**What to send** when you report a failed setup: `setup.log` (and `setup.prev.log` if you ran it
twice), plus the app's `main.log` (tray > *Open logs folder*). Paths in them include your Windows
user name; nothing else personal is logged. The *Copy* text is a good summary for the report
itself.

Common causes visible in the log: no network or a proxy (`Could not fetch URL`, `ProxyError`),
no disk space (`No space left on device` / `[Errno 28]`), a file locked by a running program
(`[WinError 32]` / `[WinError 5] Access is denied` — quit Lawnmower Man and any Python using the
venv), or a package that pip cannot find for that Python (`No matching distribution found` — the log
header shows which Python built the venv; 3.10 to 3.12 are supported, 3.12 is recommended).

---

## 6. Development

```bash
pip install fastapi uvicorn httpx pytest numpy scipy   # minimal; engines are mocked
cd voice && python -m pytest -q                         # npm run test:voice
python -m lawnmower_voice --fake --port 8765 --token dev
python -m lawnmower_voice.doctor --human
```

The tests never download models and need no GPU. They cover:

* auth (401), CORS preflight, Host checks;
* `/stt` with 48 kHz stereo WAV and float32 bodies (resampling accuracy and anti-aliasing for both resamplers);
* `/tts` WAV validity and viseme coverage;
* `/voices` and the `/health` shape;
* the STT fallback chain: load-time and inference-time CUDA errors, a missing model;
* TTS CUDA-to-CPU fallback;
* device detection with everything missing, plus Blackwell warnings;
* DLL directory layouts;
* the real kokoro-onnx pipeline (espeak G2P and `create_timed`) with a fake ONNX session, when installed;
* subprocess integration: the ready line, a guarded stdout, a port already in use, and a run with all engine libraries blocked.

### What was verified, and where

| Status | Item |
|---|---|
| **Verified here** (Linux, no GPU) | The full test suite in a bare Python 3.11 (engines absent) and in a 3.12 venv with the real faster-whisper 1.2.1, CTranslate2 4.8.2, onnxruntime 1.30.0 and kokoro-onnx 0.6.1. |
| **Verified here** | `scripts/setup-voice.sh --cpu --no-models` end to end, and its re-run. `scripts/setup-voice.ps1 -Cpu -NoModels` under PowerShell 7.6 on Linux. |
| **Verified here** (2026-10) | *Set up local voice…* in the packaged Linux build (electron-builder `linux dir`, under xvfb, a stand-in terminal): the bundled `setup-voice.sh --cpu` installed into a per-user folder whose path contains a space and `ñ`, Kokoro downloaded, and the app started the new voice server by itself (CPU mode) three seconds after the script finished. `-CheckOnly` of both scripts in a packaged layout under `…/Lawnmower Man ñ & Co (x)/resources` reports the folder the sidecar looks in (unit tests); the winget offer (with a fake winget) under PowerShell 7 on Linux. |
| **Verified here** (2026-10) | The setup log and error tail of both scripts (PowerShell 7.6 on Linux, bash): a real run with a stand-in Python whose `pip install -e …[gpu]` fails with `ERROR: …` lines on stderr after warnings, non-ASCII, carriage-return and colour output; the status file's `error`/`errorTail` end with pip's `ERROR:` line, `setup.log` has the header, steps, commands and full output, a second run keeps the first as `setup.prev.log`; `VoiceSetupRunner` turns it into the drawer's output tail. The voice server with `uvicorn` (or `pydantic`) blocked exits with code 2 and the `not-installed` line, and the sidecar stops after that one run. |
| **Verified here** (PowerShell 7 standing in for `powershell.exe`) | The whole Windows launcher chain except the new window: the launcher one-liner → `Start-Process` → the console bootstrap → `setup-voice.ps1 -CheckOnly` in a packaged layout under a path with spaces, `&`, `ñ` and `'`; a script with a parse error or an unknown switch is reported in the window and in the status file; the winget offer with a fake winget that installs Python only into `%LOCALAPPDATA%\Programs\Python\Python312` (stale PATH). `ci.yml`'s Windows job runs the bootstrap and `-CheckOnly` tests with the real Windows PowerShell 5.1. |
| **Not verifiable here** | The new console window itself (`Start-Process` from the windowless launcher), `Read-Host` answers in that window, the real winget install, a full install under Windows PowerShell 5.1 — including its handling of pip's stderr (`2>&1` turning lines into error records, which the script converts back with the error preference at `Continue`) and the console code page (the script sets `PYTHONUTF8`/`PYTHONIOENCODING` and reads the output as UTF-8). The release workflow runs the launcher in `-CheckOnly` mode and the bundled setup for real (`voice-setup` job) on `windows-latest`, and uploads `setup.log`. |
| **Verified here** | `pip --dry-run` resolution of the `[gpu]` extra for Linux and Windows (cp312). |
| **Verified here** | Kokoro v1.0 TTS with the **real model on the CPU**: 54 voices, `duration` output present, visemes aligned with the audio, RTF 0.26. |
| **Verified here, by binary inspection** | sm_120 kernels in onnxruntime-gpu 1.30.0; PTX-only Blackwell support in CTranslate2 4.8.2; the DLL names and wheel layouts above. |
| **Verified here** (2026-10) | The voice character on real Kokoro speech: the 24 sentences above offline, and end to end with the real voice server (CPU) → the browser app → the AudioWorklet, capturing what the app outputs (it matches the offline DSP: spectrogram correlation 0.94 for Synth; 99.9 % of the processed blocks used the look-ahead pitch; Natural bypassed). In Chromium at 44.1 kHz and offline at 48 kHz; in the Electron app the worklet loads over `app://` under the CSP and processes a clip (smoke test). Not heard by a person here: the demo files are for that. |
| **Not verifiable here** | Anything on an actual RTX 5070 or Windows: CUDA inference, the DLL pre-load order on Windows, VRAM use, GPU latency, Windows PowerShell 5.1 itself, NVML on a real driver. Real Whisper inference was also not possible, because Hugging Face is blocked in the build environment; STT is covered by mocked tests plus a signature check against the real faster-whisper API. |
