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

When it is off, the app releases the microphone at once, also in the middle of a command (what
she was hearing is dropped, nothing is sent), unless you use push-to-talk or *Hands-free* at that
moment. Windows then removes its microphone icon from the taskbar.

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

**The ear badge.** Whenever "Hey Jade" has the microphone open, a small round ear badge sits in
the top-left corner of her window, also when the status bar is hidden (minimal chat mode): dim
while she waits for her name, bright while she listens, slashed when the microphone is muted or
blocked. Click it to turn "Hey Jade" off. The **tray icon** carries a cyan dot for as long as the
microphone is open for her name, so you can tell while the window is hidden too.

The chime only plays once she is sure you called her. When she was not sure ("Hey Jude" from a
song, someone saying "Hey Jake"), you see her eyes flicker and nothing else: no sound, no message,
no chat entry. The tray tooltip says what she is doing: *Jade: listening for "Hey Jade"*,
*listening*, *mic off*, *paused (PC locked)*, *microphone blocked*.

*Settings › Voice* also shows a status line (with **Retry** when the wake-word engine keeps
stopping or could not start; the details are in the tray's **Open logs folder**), the echo
cancellation in use, and the **last 20 wake events** with their times: *09:41 woke · 520 ms
(noticed after 230 ms)* (from the end of "Jade" until she listened, and until her eyes
brightened), *09:43 ignored · sounded like “Hey Jude”*, *09:50 ignored · my own voice*, *10:02 no
command after 8 s*. These keep only the kind of event, never what was said.

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
| **Test my echo** | | She says "Just say hey Jade whenever you need me." twice, at the current volume, and tells you whether she heard herself (§7). It only reports; it changes no setting. It needs her voice (*Settings › Voice › Speak replies*) and gives up after 20 s. |
| **Record a test clip (30 s)…** | | Records 30 s from the microphone with the wake-word events it saw, and saves both to `Documents\Lawnmower Man\Hey Jade tests` (§8). **Cancel recording** stops it and saves nothing; turning "Hey Jade" off, locking the PC or hiding the window (with *Listen while hidden* off) cancels it too. |

**Hands-free and "Hey Jade".** *Settings › Voice › Hands-free* listens to everything you say while
she is idle. While "Hey Jade" is on, the name is needed instead and *Hands-free* is greyed out. It
comes back unchanged when "Hey Jade" is off.

**Look and talk.** With the camera on and *Settings › Camera › Listen only when I look* on, looking
at her for a moment is enough: no name needed while you look at her (the chip says **Look &
talk**). Her name works either way. With the camera on, she also does not open the follow-up window
when she has not seen your face for 3 seconds: if you walked away, the TV cannot slip in.

## 6. Privacy

* **What runs where.** The wake-word engine runs in its own small process of the app (in the
  Task Manager one more **Lawnmower Man** process; see §9 for how to tell which). It gets the
  microphone's sound from the app's window and answers "heard her name" or not. It opens no
  network connection and writes no files: its code refuses network and process modules and has no
  fetch or sockets. This is a check inside the process, not an operating-system sandbox. The check
  of her name and your words then go to the app's local voice server (speech recognition on your
  graphics card), also on this PC. Only your words after her name go to Claude, as typed messages
  do.
* **Before her name, nothing is kept.** The app holds the last 3 seconds of sound in memory, so it
  can check the moment you said her name, and forgets everything older; when the microphone is
  released, those 3 seconds are wiped too. Nothing is written to disk, logged or transcribed unless
  the engine heard her name.
* **The wake log** in the settings keeps the last 20 events (time and kind), in memory only, never
  text or sound.
* **The Windows microphone icon stays on** while "Hey Jade" is on, because the microphone really
  is open; the ear badge on her window and the tray dot say the same (§4). Turn it off and the app
  releases the microphone at once, even while she is listening to a command.
* **Locked PC, sleep:** the microphone is released when you lock the PC or it goes to sleep, at
  once and also in the middle of a command, and taken again only when you unlock it. A PC that
  wakes up at the lock screen stays locked for her. Nobody in the room can talk to Jade (or to an
  agent session) while the PC is locked.
* **Test clips** are recorded only after a click on **Record a test clip (30 s)…**, and only to
  your Documents folder. Turning "Hey Jade" off, locking the PC or **Cancel recording** ends the
  recording without saving it; a later click starts a new one.
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
  "say Jade"; she explains the wake word as "just call my name". If a reply still contains such a
  phrase, her voice says it differently ("just call my name", "hey there"); the chat text is
  unchanged.
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
  about 1 in 4. With a TV or other people talking only 10 dB below you, about half of the calls
  get through (closer to the PC, or a pause in the talk, helps). Together with the name check: no
  false wake in 4.4 hours of audio, and no "Hey Jude" (song title or first line) woke her. **These
  numbers come from synthetic voices**, not from you, your accent or your laptop's microphone.
  That is why the test clip recorder exists.
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
| Stops talking when she says her name | weak echo cancellation (loud speakers, Bluetooth delay) | **Test my echo**; headphones; turn off *Settings › Voice › Interrupt with her name* |
| Music gets quieter while she listens | Windows communications ducking | *Settings › System › Sound › More sound settings* › Communications › **Do nothing** |
| Headphones sound like a phone call | a Bluetooth headset's microphone is the input | use the laptop's microphone for input |
| "The extra wake-word model could not be downloaded" | offline, or a proxy | **Download the extra wake-word model** later; she works with the basic model meanwhile |
| "Jade can't hear anything" | the microphone delivers silence (a driver, a privacy switch, a hardware mute key) | check the input in Windows' sound settings |
| The chat shows your question without "Hey Jade" | normal: her name is removed before Claude sees your words | — |
| "Hey Jade: unavailable" with **Retry** | the engine kept stopping or did not start | **Retry**; the reason is in the log (tray › **Open logs folder**) |

**Checking it on your PC** (once, after installing; the shipped settings were tuned on synthetic
voices, so these checks tell whether they suit your voice, room and microphone):

1. *Settings › Voice*: the Hey Jade box says **Echo cancellation: all apps** (Windows 11 removes
   every app's sound from the microphone) or **this app**. Run **Test my echo** with the speakers at
   your usual volume.
2. Say "Hey Jade" 20 times at the desk, 20 times from about 3 m away and 20 times with the TV on:
   she should miss at most about 1, 2 and 2 of them.
3. Play the song "Hey Jude" three times from another device, and once on this PC (YouTube): she
   should not wake up (on the PC not even flicker, with *all apps* echo cancellation).
4. Interrupt a long answer with "Hey Jade", then "Hey Jade, stop"; after an answer, ask "And
   tomorrow?" without her name.
5. Turn *Let desktop apps access your microphone* off: the chip says the microphone is blocked and
   the settings offer **Open Windows microphone settings**. Try the microphone mute key, and unplug
   and replug a USB microphone: she comes back on her own.
6. Play music (Spotify) with "Hey Jade" on and watch the Volume Mixer: if the music gets quieter,
   set *Communications* to **Do nothing** (above).
7. Task Manager › **Details**: right-click a column header › *Select columns* › **Command line**.
   Of the several `Lawnmower Man.exe` processes, the wake-word engine is the one whose command
   line contains `--utility-sub-type=node.mojom.NodeService` (Windows does not show the name "Jade
   wake word"; that is the app's internal name). It should use about 0-1 % while it is quiet and a
   few % while people talk.
8. **Timing**: say "Hey Jade" a few times. The wake log in *Settings › Voice* says for each call
   when she noticed it, e.g. *woke · 520 ms (noticed after 230 ms)*: the second number is from the
   end of "Jade" to her eyes brightening. It should be under about 500 ms (measured on Linux
   0.2-0.6 s; on Windows the echo cancellation of all apps adds about 0.17 s, and it is slower
   until the extra wake-word model is there).
9. Minimize the window, then say "Hey Jade, what time is it?": she comes back and answers, and the
   app you are typing in keeps the keyboard focus.
10. **Record a test clip (30 s)…**: say "Hey Jade" about 5 times, near and across the room, and send
    the two files from `Documents\Lawnmower Man\Hey Jade tests`.

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
  sound before it; nothing is fed after a 0.7 s hangover. In speech without such a gap (a TV, a
  conversation) a new set of streams starts every 8 s while the old one runs on for 2 s, so a call
  across the change is heard whole. The spotter's keyword timestamps drift early in long streams
  (by seconds, measured up to 50 s); a hit whose "Jade" ends more than 0.9 s before the moment it
  was decided is re-anchored to 0.45 s before that moment.
* **Stage 2** (only on a hit, GPU) transcribes **only the wake segment**: from 1.2 s before the
  end of "Jade" (not before the stream started) to where stage 1 decided, at most 0.6 s after
  "Jade" (≤ 1.8 s in all, inside the 3 s ring even when the hit is late). It uses the app's own
  faster-whisper, without hotwords or a prompt (a "Jade" hotword turns "Hey Jay" into "hey Jade").
  Its **veto** rejects: a "Jude"-like word anywhere (Jude, Judy, Judge, …); her own lines ("I'm
  Jade", "Jade here", "okay/say Jade", "just say hey Jade"); a rival name at the call (Jay, Jane,
  James, Jake, Joey, Jodie, Gage, JD, Jayden followed by more words, …); and anything that is not a
  call at the start ("hey …" or "Jade" among the first three words) or at the end ("… hey Jade",
  so a lead-in such as "Okay, so, hey Jade" works). Otherwise it accepts. It is a veto rather than
  a "must say hey Jade" rule because Whisper writes "I enjoyed it" or "Hey Jayden" for about a
  quarter of isolated "Hey Jade."s.
* **The command** is captured from where the keyword ended and transcribed on its own, so no
  fragile "remove 'hey Jade' from Whisper's spelling" step is needed. Any leftover "Jade," at the
  start is stripped.

### 10.2 Processes and files

| Where | What |
|---|---|
| `electron/wake/` (main) | `createWake()` (`index.js`): supervises the utility (`host.js`: start, `ready` within 15 s, a ping every 10 s and a kill after 30 s of silence (a frozen utility), restarts after 1 / 5 / 30 s, at most 5 in 10 min, **Retry** for a fresh budget; stopped after the local voice has been unusable for a minute, started again with it), the IPC (`ipc.js`, validators in `validate.js`), lock/sleep (`power.js`: lock and sleep tracked separately, the OS asked again 1 s after waking up), the Windows microphone permission (`mic-access.js`), test clips (`clips.js`; main allows one per 25 s and 20 per run), the zh-en download through the voice package (`zhen.js`), keyword and threshold configuration (`config.js`), paths (`paths.js`), the onset recipe (`recipe.js`), the level normaliser (`agc.js`), the tray's listening dot (`tray-icon.js`) |
| `electron/wake/utility/` | the "Jade wake word" `utilityProcess` (that is its `serviceName` in `app.getAppMetrics()`; the OS shows it as one more app process): `lockdown.js` first (refuses `net`, `http(s)`, `dgram`, `child_process`, `worker_threads`, … and removes `fetch`/`WebSocket`; an in-process check, not an OS sandbox), the raw N-API addon (`sherpa.js`), the engine (`engine.js`: the strict-mode twin is built ahead while it is quiet), the port protocol (`protocol.js`). Minimal environment (PATH, SystemRoot, TEMP, `LAWNMOWER_*`), no sockets, no files |
| `src/wake/` (avatar window) | `machine.js` (the state machine, pure, injected clock), `phrase.js` (veto and command rules), `self-mask.js` (her own sentences), `earcons.js`, `port.js` (the MessagePort), `feature.js` (composition), `ui.js` + `wake.css` (chip, the ear badge on the stage, settings block, offer card) |
| `src/audio/mic.js`, `player.js` | the tap and the 3 s ring (wiped when the tap is removed); the master gain that ducks her voice, and the chime through the player's AudioContext (so the echo canceller knows it) |
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
3 s ring, a wake segment of 1.2 s before and at most 0.6 s after the end of "Jade" (at least
0.4 s of it still in the ring), 2.5 s verify timeout on the GPU (8 s on the CPU), 8 s command
window, 350 ms tail before the follow-up, a face absent for 3 s closes it, −15 dB duck with a
60 ms ramp, a 300 ms unduck, 100 ms before and 400 ms after her own sentences, 3 rejects that
sounded like "Hey Jude" or another name in 60 s → 5 strict minutes (a "not a call" or "nothing
understood" does not count, so retrying in noise cannot make her stricter), and a transcription
that never answers ends the episode after 30 s.

The microphone is released as soon as the state leaves the ones that need it (the wake word off,
the PC locked or asleep, the window hidden): a command being captured at that moment is cancelled
and dropped, and so is a test clip being recorded. No follow-up window opens after one of her own
`say()` lines (such as a greeting or "Okay, I stopped listening"), only after a reply to
a spoken question.

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
   structural check is in `tests/unit/systems/persona-jade.test.js`. On the output side,
   `wakeSafeSpeech()` (`src/app/speech-text.js`) rewrites "(just) say hey Jade" and "hey/hi/okay
   Jade" in the text that is spoken (not in the chat) before it reaches the voice.
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

Synthetic speech (Kokoro, 28 voices; 252 calls per condition), offline through the runtime recipe
with both models, stage 2 with Whisper large-v3-turbo on the CPU:

| | clean | noise + reverb (after gain) |
|---|---|---|
| stage 1 missed, A + B | 1.2 % (3/252) | 27.4 % (69/252) |
| stage 1 missed, B alone | 10.3 % | 31.7 % |
| cascade (stage 1 + veto) accepted | 109 of 115 transcribed calls | 40 of 47 sampled (≈ 62 % of all calls) |
| false wakes, cascade | 0 in 4.4 h, and 0 in 100 min of continuous prose | "Hey Jay / Jane / Jake …": 5 of 756 clips (before: 8) |
| "Hey Jude" woke the cascade | 0 | 0 |

The level normaliser misses its acceptance figure (contract §7.6, at most 3 points under the
evaluation's reference): with noise and reverb, stage 1 finds 72.6 % of the calls against the
reference's 76.6 %, 4 points under. This is an accepted deviation for now; the test clips are
meant to retune it on real recordings.

**A call over other speech** (a TV or people talking, one continuous stream, the same 252 calls):

| speech bed under the caller | stage 1, correct keyword stamp | stamps off by more than 0.4 s | cascade accepted |
|---|---|---|---|
| 10 dB, before the fix | 118 | 36 | ≈ 13 % (11 of 38 sampled) |
| 10 dB, now | 160 | 2 | 119 of 160 (47 % of all calls; 33 of the same 38) |
| 20 dB, before the fix | 174 | 52 | 40-56 % (the review's estimate) |
| 20 dB, now | 222 | 3 | 56 of 59 sampled (≈ 84 % of all calls) |

The contract's target (at most 2 of 20 calls missed with a TV on) is **not met**: about half the
calls under a TV 10 dB down still fail, mostly because Whisper hears the call as something else
in that noise ("no-call" 24, a rival name 17 of the 41 rejected).

Other cascade results on the same clips, before → now: calls with a lead-in ("I wonder, hey Jade,
…") 8 → 28 of 28; near names (Jodie, JD, Gage, Jed, Jayden, …) let through 15 → 5 of 27 (the five
are "Hey Jayden" / "Hey Jaden" alone, which is also how Whisper writes a real "Hey Jade."); "Hey
Jodie" 13 → 0 of 13; clean "Hey Jay / Jane / Jude" 2 → 0 of 26; clean calls 68 → 67 of 71 (one
"Say Jade!"). Stream renewal costs CPU in continuous speech: 80 → 97 ms per second of prose
(+21 %), 87 → 96 ms with a TV bed.

End of "Jade" → stage-1 decision, offline: p50 352 / p90 495 ms clean (A + B), 378 / 530 ms with
noise and reverb.

In the real app (`scripts/wake-e2e.mjs`, Linux under xvfb on 4 shared vCPUs at load 2-6; three
runs of this version with both models, the last one passing all 71 checks, and two passing runs
with B alone; one positive call each, plus 12 calls measured by the review):

| | both models (A + B) | B alone |
|---|---|---|
| end of "Jade" → stage-1 hit in the utility | 219-532 ms (review: p50 411 / p90 550) | 538-552 ms |
| end of "Jade" → *attention* shown | 222-593 ms (review: p50 418 / p90 553) | 547-593 ms |
| *attention* → *listening* (stage 2 on the fake voice server, 200 ms per call) | 250-273 ms | 245-270 ms |
| her voice 10 dB down after a barge-in hit (duck to −15 dB) | 44-51 ms | 25-55 ms |
| PC locked → microphone track ended | 10-22 ms | 12-22 ms |
| PC locked while she listens for a command → track ended | 11-15 ms | 12-14 ms |
| follow-up window | 6.00 s | 6.00 s |
| strict thresholds built ahead, once, after 1.5 s of quiet | 3.2-4.4 s of CPU | 1.7-2.1 s |
| utility CPU in silence (20 s, after that) | 2.05-2.3 % of one core | 1.9-2.35 % |
| utility CPU while people talk without her name | 9.1-9.9 % of one core (99-107 ms per second of speech) | 5.5-6.3 % (60-67 ms) |
| engine start | 3.2-4.5 s | 1.6-2.5 s |

The latency target (attention ≤ 500 ms p50 after the end of "Jade") is met only in some runs
here, and Windows' echo cancellation of all apps adds about 170 ms of capture delay (§10.4), so
on the laptop it is likely missed, more so with B alone. It is on the laptop checklist (§9).

GPU latency of stage 2 on the RTX 5070 is not measured yet; about 0.1-0.2 s for a short segment
is an estimate.

### 10.8 Tests and tools

* Unit tests: `tests/unit/wake/` (machine, phrase, self-mask, earcons, port, UI, controller),
  `tests/unit/wake-engine/` (recipe, AGC, config, paths, host, the utility's engine and lockdown,
  IPC validation, settings, tray and its icon, zh-en download, the fetch script), `tests/unit/systems/persona-jade.test.js`,
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
  path with the follow-up (and LAT-1: attention ≤ 600 ms after "Jade" with both models, 800 ms
  with B alone), a call over TV-like speech 10 dB under her (stamp and segment checked), a
  follow-up inside and after the window, "Hey Jude", her own line (masked), barge-in with the
  duck, the hidden window, lock (also while she listens for a command, and locked → asleep → woken
  at the lock screen), a utility crash, CPU budgets, no network, no sockets in the utility, no
  audio files, a clean quit. `--b-only` runs without model
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
