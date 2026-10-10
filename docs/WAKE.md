# "Hey Jade": talk to Jade hands-free

Say **"Hey Jade"** and she listens, the way you would call Siri on an iPhone: no key, no click. Jade
is the one you talk to. She is named after Jade from *Lawnmower Man 2* and runs on Claude, the AI
model made by Anthropic. *Lawnmower Man* is the app she appears in.

Everything that listens for her name runs on your PC. Nothing is recorded, transcribed or sent
anywhere until she hears "Hey Jade".

The guide comes first (sections 1 to 9). [How it works](#10-how-it-works) starts at section 10.

---

## 1. Quick start

1. **Install the update.** It brings the wake-word engine; nothing else to install.
2. **Check that the local voice works.** *Settings › Voice* shows it running. If it does not,
   use **Set up local voice…** there. "Hey Jade" needs the local voice, because Jade checks her
   name with the same speech recognition on your graphics card. The first time "Hey Jade" is
   turned on, the app also fetches its extra wake-word model through the voice setup: a one-time
   download of 33 MB, of which 5.5 MB are kept.
3. **Turn it on**, in any of these ways:
   * the card that says **New: talk hands-free** (it appears once): **Turn on**;
   * the tray menu: **Listen for "Hey Jade"**;
   * *Settings › Voice › Hey Jade*.

   The microphone then stays on while the app runs, and Windows shows its microphone icon in the
   taskbar.
4. **Windows, once:**
   * *Settings › Privacy & security › Microphone*: **Let desktop apps access your microphone**
     must be **On**.
   * If music or videos get quieter while she listens: *Settings › System › Sound › More sound
     settings*, the **Communications** tab, **Do nothing**.
5. **Try it:**
   * "Hey Jade, what time is it?"
   * "Hey Jade." (a chime) … "What's on my calendar?"
   * after she answers: "And tomorrow?" (no name needed for a few seconds)
   * while she talks: "Hey Jade, stop."
6. **Check the echo** with your speakers at their usual volume: **Test my echo** in
   *Settings › Voice*. If she hears herself, use headphones or turn off
   *Settings › Voice › Interrupt with her name*.
7. **Tune it** if needed: she misses you → *Settings › Voice › Sensitivity* › **More**; she wakes
   by mistake → **Less**.
8. **Help make her better** (optional): **Record a test clip (30 s)…** in *Settings › Voice*. Say
   "Hey Jade" about 5 times, near the PC and across the room, then send the two files from
   `Documents\Lawnmower Man\Hey Jade tests`. They let the wake word be tuned on your voice and
   your laptop's microphone instead of synthetic voices.
9. **Privacy:** everything stays on the PC; before she hears her name, nothing is recorded,
   transcribed or sent. Turn her off any time from the tray. She also stops listening while the PC
   is locked.

---

## 2. Turning it on and off

"Hey Jade" is **off** until you turn it on. Any of these switches it on or off, and the choice is
kept across restarts:

* the tray menu's **Listen for "Hey Jade"** checkbox;
* *Settings › Voice › Hey Jade*;
* the one-time card **New: talk hands-free** (**Turn on** / **Not now**). It appears the first
  time the local voice is ready.

You can also turn it **off** by voice: "Hey Jade, stop listening" (or "go to sleep", "mic off").
She answers "Okay, I stopped listening. Turn me back on in the tray." Turning it **on** always
needs a click: nobody can switch the microphone on by talking to the PC.

When it is off, the microphone is released within a second and the Windows microphone icon goes
away, unless you use push-to-talk or *Hands-free* at that moment.

## 3. How to talk to Jade

| You say | What happens |
|---|---|
| "Hey Jade, what's the weather?" | One breath: she takes the question and answers. |
| "Hey Jade." *(chime)* "Read me the last three commits." | A pause after her name is fine: after the chime she waits up to 8 seconds for you to start. |
| *(after her answer)* "And tomorrow?" | A **follow-up**: for about 6 seconds after she has finished speaking, you can go on without her name. |
| "Thanks." / "That's all." / "Never mind." | Closes the follow-up without asking Claude anything. |
| "Hey Jade, stop." *(while she talks or works)* | She stops talking and the running answer is cancelled. "Cancel" and "be quiet" work too. Nothing is sent to Claude. |
| "Hey Jade." *(while she talks)* | She stops talking and listens. The answer she was reading stays in the chat panel. |
| "Hey Jade, stop listening." | The wake word turns off (see above). |
| "Hey Jade, camera left." | Short Home camera commands run at once, as when you type them ([TAPO.md](TAPO.md)). |

Her name is removed before your words go to Claude: Claude gets "what's the weather?", not "Hey
Jade, what's the weather?". With *Settings › Voice › Wake phrase* set to **"Hey Jade" or "Jade"**,
"Jade, …" at the very start of a sentence works too.

Push-to-talk (hold **Space**), the mic button, the toggle-listen hotkey and typing all keep
working. The mic button or the hotkey while she waits for her name means "listen now".

**"Hey Jade" cannot wake a sleeping PC.** Phones have a separate always-on chip for that; a PC app
only hears you while the PC is awake and unlocked.

## 4. What you see and hear

The status bar shows a small **ear chip** whenever "Hey Jade" is on. Click it to open its settings.

| State | Chip | Jade | Sound |
|---|---|---|---|
| Waiting for her name | **Hey Jade** (dim) | as usual; she may doze off when you are away | — |
| She heard something like her name and checks it | **Hey Jade…** | her eyes brighten and she looks up (at your face if the camera sees you) | none yet |
| Listening | **Hey Jade**, and *Listening…* next to it | the listening pose | a short rising **chime** |
| Follow-up | **Follow-up** | still listening; the glow fades during the last 1.5 s | none (with *Sounds* › **Start + end**, a soft falling tone when it closes) |
| Look and talk | **Look & talk** | listening while you look at her (see §5) | none |
| Starting | **Hey Jade: starting…** | | |
| No local voice | **Hey Jade: needs the local voice** | | |
| Engine missing | **Hey Jade: unavailable** | | |
| Window hidden, *Listen while hidden* off | **Hey Jade: paused** | | |
| PC locked | **Hey Jade: PC locked** | | |
| Microphone blocked | **Microphone blocked** | | |
| Microphone muted | **Microphone is muted** | | |

The states without the microphone (paused, locked, blocked, muted, off) use a slashed ear, so they
never depend on colour alone. Screen readers hear "Listening", "Stopped listening", "Microphone
off" and "Microphone muted" through a polite live region.

The chime only plays once she is sure you called her. When she was not sure ("Hey Jude" from a
song, someone saying "Hey Jake"), you see her eyes flicker and nothing else: no sound, no message,
no chat entry. The tray tooltip says what she is doing: *Jade: listening for "Hey Jade"*,
*listening*, *mic off*, *paused (PC locked)*, *microphone blocked*.

*Settings › Voice* also shows a status line, the echo cancellation in use, and the **last 20
wake events** with their times: "woke · 280 ms", "ignored · sounded like "Hey Jude"",
"ignored · my own voice", "no command after 8 s". These keep only the kind of event, never what
was said.

## 5. Settings

All in *Settings › Voice*, right after *Hands-free*. Only *Hey Jade* shows while it is off.

| Setting | Default | What it does |
|---|---|---|
| *Settings › Voice › Hey Jade* | off | Listen for her name. The microphone stays on while the app runs. |
| *Settings › Voice › Wake phrase* | "Hey Jade" | **"Hey Jade" or "Jade"** also accepts "Jade, …" at the very start of what you say. More natural; more mistakes when other people talk about her. Saying "Jade" alone never interrupts her while she speaks. |
| *Settings › Voice › Sensitivity* | Normal | **More** hears you better in noise and wakes by mistake more often; **Less** the other way round (§8). |
| *Settings › Voice › Follow-up* | 6 s | How long after her answer you can go on without her name: **Off**, **6 s** or **10 s**. It counts from when you *start* speaking, so a longer sentence that starts in time is fine. |
| *Settings › Voice › Interrupt with her name* | on | "Hey Jade" while she talks stops her. Turn it off if her own voice stops her (§7). |
| *Settings › Voice › Sounds* | Start | The chime when she starts listening; **Start + end** adds a soft tone when she stops; **Off**. |
| *Settings › Voice › Listen while hidden* | on | Keep listening while the window is hidden in the tray. "Hey Jade" brings her back without taking the keyboard focus. Off: she pauses while hidden, like the camera. |
| *Settings › Voice › Transcript check* | off | Shown only when the wake-word engine cannot run (§9). Speech recognition then listens for her name instead: every sentence said in the room is transcribed on your graphics card and thrown away at once unless it starts with her name. |
| **Test my echo** | | She says "Just say hey Jade whenever you need me." twice, at the current volume, and tells you whether she heard herself (§7). It only reports; it changes no setting. |
| **Record a test clip (30 s)…** | | Records 30 s from the microphone with the wake-word events it saw, and saves both to `Documents\Lawnmower Man\Hey Jade tests` (§8). |

**Hands-free and "Hey Jade".** *Settings › Voice › Hands-free* listens to everything you say while
she is idle. While "Hey Jade" is on, the name is needed instead and *Hands-free* is greyed out. It
comes back unchanged when "Hey Jade" is off.

**Look and talk.** With the camera on and *Settings › Camera › Listen only when I look* on, looking
at her for a moment is enough: no name needed while you look at her (the chip says **Look &
talk**). Her name works either way. With the camera on, she also does not open the follow-up window
when she has not seen your face for 3 seconds: if you walked away, the TV cannot slip in.

## 6. Privacy

* **What runs where.** The wake-word engine runs in its own small process of the app, called
  **Jade wake word** in the Task Manager. It gets the microphone's sound from the app's window and
  answers "heard her name" or not. It opens no network connection and writes no files. The check
  of her name and your words then go to the app's local voice server (speech recognition on your
  graphics card), also on this PC. Only your words after her name go to Claude, as typed messages
  do.
* **Before her name, nothing is kept.** The app holds the last 3 seconds of sound in memory, so it
  can check the moment you said her name, and forgets everything older. Nothing is written to
  disk, logged or transcribed unless the engine heard her name.
* **The wake log** in the settings keeps the last 20 events (time and kind), in memory only, never
  text or sound.
* **The Windows microphone icon stays on** while "Hey Jade" is on, because the microphone really
  is open. Turn it off and the icon goes away within a second.
* **Locked PC, sleep:** the microphone is released when you lock the PC or it goes to sleep, and
  taken again when you unlock it. Nobody in the room can talk to Jade (or to an agent session)
  while the PC is locked.
* **Test clips** are written only when you click **Record a test clip (30 s)…**, and only to your
  Documents folder.
* **Voice never approves anything.** An approval card (Agent mode) can only be answered with its
  buttons. While a card is waiting, no follow-up window opens, so a "yes" in the room is not taken
  as an answer.

## 7. Interrupting her, and her own voice

When Jade talks through your speakers, the microphone hears her too. Several things keep her from
waking herself:

* **Echo cancellation.** While "Hey Jade" is on, the app asks Windows 11 to cancel the sound of
  **every app** on the PC from the microphone (her voice, music, videos, a call). The settings
  show which kind is in use: **Echo cancellation: all apps**, or **this app** (other apps' sound is
  not removed; Windows 10, Linux).
* **Her own words.** While she says a sentence that contains her name, and 0.4 s after it, a "Hey
  Jade" from the speakers is ignored ("ignored · my own voice" in the log). So saying her name
  cannot interrupt the few sentences in which she says it herself.
* **She never says the words that wake her.** Her instructions forbid "hey Jade", "okay Jade" and
  "say Jade"; she explains the wake word as "say hey, then my name".
* **The check of her name** rejects transcripts that sound like her talking about herself ("I'm
  Jade", "Jade here"), and what she hears after her name is dropped when it repeats one of her own
  recent sentences.

**Test my echo** checks this at your volume: "Echo cancellation: good. I did not hear myself." or
"I heard my own voice 2 times …". If she hears herself: use headphones, lower the volume, or turn
off *Interrupt with her name* (then only the keys and the mic button interrupt her).

With the **system voice** (when the local voice is not running, Windows speaks for her), her name
interrupts her only when Windows cancels the echo of all apps. A real TV or radio in the room can
never be cancelled; that is what the name check and *Sensitivity* are for.

## 8. Accuracy and tuning

* **Sensitivity**: **Less** needs a clearer "Hey Jade" (fewer mistakes, more misses); **Normal**
  is the measured best balance; both reject a call that the check hears as another name. **More**
  hears noisy or distant calls better and lets through some "Hey Jay" or "Hey Jane" (never "Hey
  Jude").
* **Mistakes in a row.** After 3 rejected calls within a minute (a TV show, the Beatles song), she
  is stricter for 5 minutes and does not even flicker her eyes ("many mistakes in a row" in the
  log).
* **Two wake-word models.** The installer brings a basic one. The first time "Hey Jade" is turned
  on, the voice setup downloads an extra, more accurate one (5 MB, from its authors' GitHub
  release; its licence is not stated, so it is fetched on your PC instead of shipped). Until it is
  there, the settings say "Using the basic wake-word model" and she still works; if the download
  fails, **Download the extra wake-word model** tries again.
* **How good is it?** Measured on 252 synthetic "Hey Jade"s (28 computer voices) and 2.2 hours of
  real speech, words and music per condition: in a quiet room the engine missed about 1 in 100
  calls with both models (about 1 in 10 with the basic model alone); with room noise and reverb
  about 1 in 4. Together with the name check: no false wake in 4.4 hours of audio, and no "Hey
  Jude" (song title or first line) woke her. **These numbers come from synthetic voices**, not
  from you, your accent or your laptop's microphone. That is why the test clip recorder exists.
* **Record a test clip (30 s)…** records what the microphone hears plus what the engine thought of
  it. Two files land in `Documents\Lawnmower Man\Hey Jade tests` (a WAV and a JSON); send them in,
  and the thresholds can be checked on real audio (`npm run wake:eval`, §10.8).

## 9. Windows notes and troubleshooting

* **Windows privacy switch:** *Settings › Privacy & security › Microphone* › **Let desktop apps
  access your microphone**. If it is off, the chip says the microphone is blocked and the settings
  offer **Open Windows microphone settings**.
* **Voice activation** (*Settings › Privacy & security › Voice activation*) is for Windows' own
  voice assistants and does **not** apply to Jade.
* **Communications ducking.** Windows may lower other sounds while an app has the microphone open
  for a call. If music gets quieter while she listens: *Settings › System › Sound › More sound
  settings* › **Communications** › **Do nothing**.
* **Bluetooth headsets.** When a headset's microphone is used, Windows switches the headset to
  "hands-free" telephone quality for as long as the microphone is open, which with "Hey Jade" is
  always. Use the laptop's microphone for input (*Settings › System › Sound › Input*); she shows a
  hint once when she notices a headset microphone.
* **A sleeping PC** cannot hear "Hey Jade" (§3).

| Symptom | Likely cause | Fix |
|---|---|---|
| "Hey Jade: needs the local voice" | the local voice is off, not installed or still starting | *Settings › Voice › Set up local voice…*, or wait until *Voice* shows it ready |
| "Hey Jade: unavailable" | the wake-word engine is missing or keeps stopping (an antivirus may have quarantined it) | reinstall Lawnmower Man; until then *Transcript check* can stand in (§5) |
| Never wakes | microphone blocked or muted; the wrong input device; a very quiet microphone | the chip says which; *Settings › System › Sound › Input*; *Sensitivity* › **More** |
| Wakes by mistake | TV or podcasts with similar names | *Sensitivity* › **Less**; after repeated mistakes she gets stricter on her own |
| Stops talking when she says her name | weak echo cancellation (loud speakers, Bluetooth delay) | **Test my echo**; headphones; turn off *Interrupt with her name* |
| Music gets quieter while she listens | Windows communications ducking | *Settings › System › Sound › More sound settings* › Communications › **Do nothing** |
| Headphones sound like a phone call | a Bluetooth headset's microphone is the input | use the laptop's microphone for input |
| "The extra wake-word model could not be downloaded" | offline, or a proxy | **Download the extra wake-word model** later; she works with the basic model meanwhile |
| "Jade can't hear anything" | the microphone delivers silence (a driver, a privacy switch, a hardware mute key) | check the input in Windows' sound settings |
| She answers "Yes?" to nothing / starts mid-sentence | normal: the call is removed before Claude sees your words | — |

---

## 10. How it works

### 10.1 Two stages

```
microphone ─ Chromium (echo cancellation, noise suppression, gain) ─► avatar window (src/audio/mic.js)
   16 kHz tap ─┬─► 3 s ring buffer (memory only)
               └─► MessagePort ─► "Jade wake word" utility process (electron/wake/utility/)
                                    level normaliser → Silero VAD (onsets) → two keyword spotters
                                    (sherpa-onnx; zh-en "A" OR GigaSpeech "B") → hit
   hit ◄────────────────────────────┘
   src/wake/feature.js: WakeMachine (src/wake/machine.js)
     stage 2: the wake segment from the ring → the local voice's /stt (Whisper on the GPU)
              → phrase.veto(): reject rival names, her own lines, non-calls
     the command, cut where the keyword ended → /stt → decideCommand() → controller.sendText
```

* **Stage 1** (always on, CPU, about 0.1 s of CPU per second of speech and almost nothing in
  silence) is open-vocabulary keyword spotting with sherpa-onnx 1.13.8: no training, the phrase is
  given as phonemes / word pieces. Two tiny models run on the same audio and either may fire:
  **A** = `kws-zipformer-zh-en-3M-2025-12-20` (four pronunciations of HEY_JADE), **B** =
  `kws-zipformer-gigaspeech-3.3M-2024-01-01`. Both also know **HEY_JUDE**, a label that soaks up
  the song title. A fresh stream starts at each speech onset after ≥ 0.6 s of quiet, with 0.4 s of
  sound before it; nothing is fed after a 0.7 s hangover.
* **Stage 2** (only on a hit, GPU) transcribes **only the wake segment** (at most 2.5 s before the
  end of "Jade", plus 0.15 s) with the app's own faster-whisper, without hotwords or a prompt (a
  "Jade" hotword turns "Hey Jay" into "hey Jade"). Its **veto** rejects: a rival name among the
  first three words (Jude, Jay, Jane, James, Jake, Joey, …), her own lines ("I'm Jade", "Jade
  here", "okay/say Jade"), and anything that does not start like a call. Otherwise it accepts. It
  is a veto rather than a "must say hey Jade" rule because Whisper writes "I enjoyed it" or "Hey
  Jayden" for about a quarter of isolated "Hey Jade."s.
* **The command** is captured from where the keyword ended and transcribed on its own, so no
  fragile "remove 'hey Jade' from Whisper's spelling" step is needed. Any leftover "Jade," at the
  start is stripped.

### 10.2 Processes and files

| Where | What |
|---|---|
| `electron/wake/` (main) | `createWake()` (`index.js`): supervises the utility (`host.js`: start, `ready` within 15 s, restarts after 1 / 5 / 30 s, at most 5 in 10 min), the IPC (`ipc.js`, validators in `validate.js`), lock/sleep (`power.js`), the Windows microphone permission (`mic-access.js`), test clips (`clips.js`), the zh-en download through the voice package (`zhen.js`), keyword and threshold configuration (`config.js`), paths (`paths.js`) |
| `electron/wake/utility/` | the "Jade wake word" `utilityProcess`: the raw N-API addon (`sherpa.js`), the onset recipe (`recipe.js`) and the level normaliser (`agc.js`). Minimal environment (PATH, SystemRoot, TEMP, `LAWNMOWER_*`), no sockets, no files |
| `src/wake/` (avatar window) | `machine.js` (the state machine, pure, injected clock), `phrase.js` (veto and command rules), `self-mask.js` (her own sentences), `earcons.js`, `port.js` (the MessagePort), `feature.js` (composition), `ui.js` + `wake.css` (chip, settings block, offer card) |
| `src/audio/mic.js`, `player.js` | the tap and the 3 s ring; the master gain that ducks her voice, and the chime through the player's AudioContext (so the echo canceller knows it) |
| `src/app/controller.js` | the `wakeWord*` block: captures, silent drops, the follow-up hook |
| `electron/persona.js` | her name and the wake-word section of her instructions |

The audio port goes **directly** from the avatar window to the utility (`MessageChannelMain`);
main is not in the data path. Frames are posted as copies, never transferred (an `ArrayBuffer` in
a transfer list arrives as `null` on a `MessagePortMain`). Port messages are validated on both
ends (≤ 4096 samples per frame, finite values, monotonic sample indices).

### 10.3 The states

`body[data-wake]` mirrors the state machine: `off · unavailable · starting · paused · locked ·
blocked · muted · waiting · attention · listening · followup · look · busy · barge`. The mic is
open when the wake word is on, the local voice's speech recognition is available, the engine is
ready (or the transcript check is on), the microphone is not blocked, the PC is not locked, and
the window is shown or *Listen while hidden* is on. The constants (`WAKE` in `src/wake/machine.js`):
3 s ring, 2.5 s verify timeout on the GPU (8 s on the CPU), 8 s command window, 350 ms tail
before the follow-up, a face absent for 3 s closes it, −15 dB duck with a 60 ms ramp, a 300 ms
unduck, 100 ms before and 400 ms after her own sentences, 3 rejects in 60 s → 5 strict minutes.

### 10.4 Her own voice

1. Echo cancellation: `echoCancellation: { ideal: 'all' }` while the wake word is on (the system
   loopback reference on Windows 11, +170 ms of capture delay; elsewhere it falls back to
   Chromium's reference of this app's own playback).
2. The text mask: a hit whose keyword interval overlaps one of her sentences that contains her
   name (from 100 ms before to 400 ms after it) is ignored. Sample indices map to
   `performance.now()` through the tap's arrival times.
3. Stage 2 rejects self-talk patterns and transcripts that repeat a sentence she started in the
   last 10 s (word-set Jaccard ≥ 0.8).
4. The persona never puts "hey", "hi", "okay" or "say" in front of her name. Stage 1 fires on
   such lines almost every time (82 of 84 clean clips), so this rule is not optional. The
   structural check is in `tests/unit/systems/persona-jade.test.js`.
5. With the system voice, barge-in only when the track reports `'all'`.

### 10.5 Persona

`electron/persona.js` (`PERSONA_VERSION = 2`): the character is Jade, a holographic companion who
runs on Claude (Anthropic) and never claims to be human. `IDENTITY_RULES` is kept in every mode
and with a custom persona (like `SPEECH_RULES`): her name, "Lawnmower Man" is the app, "you may
have called yourself Claude earlier; you are Jade now", and never a greeting, "okay" or "say" in
front of her name. While the wake word is on, `createWake().personaContext()` adds "How the user
calls you": the call is removed from messages, short follow-ups belong to the previous topic, her
name while she talks means she was interrupted on purpose. Turning the wake word on or off
rewrites the persona at the next CLI start (after the running turn).

UI names: **Jade** names the one you talk to (the stage, the message box, approval cards, the
camera texts); **Claude** names the engine and where data goes (the status chip, setup cards,
"sent to Claude"); **Lawnmower Man** names the app (window, tray, installer, folders).

### 10.6 Shipping and licences

| Part | Size | Licence | Where |
|---|---|---|---|
| sherpa-onnx 1.13.8 N-API addon (win-x64 / linux-x64) with onnxruntime 1.28.2 | 23.5 / 33.4 MB | Apache-2.0, onnxruntime MIT | installer, `resources/wake/sherpa-onnx/<platform>/` |
| KWS model B, GigaSpeech 3.3M | 6.0 MB | Apache-2.0 (model card) | installer, `resources/wake/models/gigaspeech-3.3m/` |
| Silero VAD v4 (k2-fsa export) | 0.64 MB | MIT | installer, `resources/wake/models/silero_vad.onnx` |
| KWS model A, zh-en 3M | 5.5 MB (33 MB download) | not stated | **never shipped**: the voice package downloads it on the user's PC into `<voice models>/kws/zh-en-3m/` (`python -m lawnmower_voice.download --kws`, pinned SHA-256) |

`npm run fetch:wake` fetches the shipped parts into `vendor/wake/` with pinned SHA-256 hashes
(`--platform win32-x64|linux-x64|all`, `--with-zhen` for development and tests only, into
`vendor/wake/dev-models/`, which no packaging rule copies; `--from <dir>` offline). No openWakeWord,
Porcupine or GPL code. Details: `THIRD_PARTY_NOTICES.md`.

### 10.7 Measured

Synthetic speech (Kokoro, 28 voices), from the wake-word evaluation:

| | clean | noise + reverb (after gain) |
|---|---|---|
| stage 1 missed, A + B | 1.2 % (3/252) | 23.4 % |
| stage 1 missed, B alone | 10.3 % | 31.7 % |
| cascade (stage 1 + veto) missed | 0/56 (sample) | 17/42 (sample) |
| false wakes, cascade | 0 in 4.4 h | |
| "Hey Jude" woke the cascade | 0/18 | 0/18 |

In the real app (`scripts/wake-e2e.mjs`, Linux under xvfb on shared vCPUs, load 2-9, five runs):

| | |
|---|---|
| end of "Jade" → stage-1 hit in the utility | 216-230 ms with A + B; 536 ms with B alone |
| end of "Jade" → *attention* shown | 222-268 ms |
| *attention* → *listening* (stage 2 on the fake voice server, 200 ms per call) | 236-246 ms |
| her voice 10 dB down after a barge-in hit | 43-50 ms (duck to −15 dB) |
| PC locked → microphone track ended | 9-13 ms |
| follow-up window | 6.00 s |
| utility CPU in silence (20 s) | 1.95-2.2 % of one core |
| utility CPU while people talk without her name | 9.1-9.8 % of one core (107-110 ms per second of speech) |
| engine start (both models) | 1.7-8.2 s, depending on load |

GPU latency of stage 2 on the RTX 5070 is not measured yet; about 0.1-0.2 s for a short segment
is an estimate.

### 10.8 Tests and tools

* Unit tests: `tests/unit/wake/` (machine, phrase, self-mask, earcons, port, UI, controller),
  `tests/unit/wake-engine/` (recipe, AGC, config, paths, host, IPC validation, settings, tray,
  zh-en download, the fetch script), `tests/unit/systems/persona-jade.test.js`,
  `voice/tests/test_download_kws.py`, `voice/tests/test_fake_texts.py`.
* Engine test: `tests/unit/wake-engine/engine-fixtures.test.js` runs the real addon and models over
  the committed Kokoro fixtures (`tests/fixtures/wake/`). It skips without `vendor/wake` unless
  `WAKE_ENGINE_REQUIRED=1` (CI).
* Browser: `tests/e2e/wake.spec.js` (mock bridge, a pretend spotter, scripted microphone).
* Real app: `npx vite build && xvfb-run -a node scripts/wake-e2e.mjs` (`npm run test:wake-e2e`).
  It runs the real utility with both models on Chromium's fake microphone (the fixtures,
  resampled to 48 kHz, on a −60 dBFS noise floor), the fake voice server answering `/stt` from
  `LAWNMOWER_VOICE_FAKE_TEXTS`, and the fake Claude CLI. In one launch, each scenario writes a new
  capture file and reopens the microphone. The scenarios are listed in its header: the positive
  path with the follow-up, a follow-up inside and after the window, "Hey Jude", her own line
  (masked), barge-in with the duck, the hidden window, lock, a utility crash, CPU budgets, no
  network, no sockets in the utility, no audio files, a clean quit. `--b-only` runs without model
  A; `--shots <dir>`, `--report <file>`, `--work <dir>`, `--only <steps>`. Without lanes A/B, the
  engine or a build it skips (exit 0) with the reason; `WAKE_ENGINE_REQUIRED=1` makes that exit 2.
* CI (`.github/workflows/ci.yml`): the unit jobs fetch the engine and require the engine test;
  `app-windows` runs `node scripts/wake-smoke.mjs` (the real Windows load of the addon and its
  DLLs); the `wake-e2e-linux` job runs the real-app test with both models and with B alone.
  `vendor/wake` is cached, keyed on the files that hold the pins.
* Tools: `node scripts/wake-smoke.mjs` (the engine over the fixture stream, JSON report),
  `npm run wake:eval -- <folder of 16 kHz WAVs with manifest.tsv>` (`tools/wake/eval-folder.mjs`,
  the runtime recipe over recordings such as the test clips), `tools/wake/make-fixtures.py`.

### 10.9 Environment variables (development and tests)

| Variable | Effect |
|---|---|
| `LAWNMOWER_WAKE_DIR` | the engine folder (default `resources/wake` packaged, `vendor/wake` otherwise) |
| `LAWNMOWER_WAKE_ZHEN_DIR` | model A's folder (only this one is tried) |
| `LAWNMOWER_VOICE_KWS_URL` | mirror for the zh-en download |
| `LAWNMOWER_E2E=1` | `__lawnmowerE2E.wake` in main: `status`, `utilityPid`, `metrics`, `emitPower`, `lastHits`, `stats`, `restartUtility` |
| `LAWNMOWER_VOICE_FAKE_TEXTS` | fake voice server: `/stt` answers from a JSON array file, call by call ([VOICE.md](VOICE.md#22-fake-mode)) |
| `WAKE_ENGINE_REQUIRED=1` | the engine test and `wake-e2e.mjs` fail instead of skipping |

### 10.10 Not in this version

The bare name "Jade" as an interrupt while she speaks; running the detector over her outgoing
voice; a "second chance" threshold (the engine reports no score); speaker enrolment; a custom wake
phrase; a "pause time" setting for slow speakers; a microphone-off hotkey; "pause during calls";
detecting Windows' communications ducking; bundling the zh-en model once its licence is
confirmed.
