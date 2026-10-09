# Renderer app (chat, voice pipeline, UI)

The renderer is everything in the window around the hologram: the conversation state machine,
the speech pipeline, the chat panel and the settings. It talks to the Electron main process only
through `window.lawnmower` (contract §3); in a plain browser it uses a mock of the same API.

```
src/main.js              bootstrap: bridge → settings → speech/audio → UI → avatar → controller
src/bridge/              index.js (real bridge or mock), mock.js, mock-voice.js (in-page fake voice server)
src/app/                 controller.js      conversation state machine (contract §7)
                         sentence-chunker.js streaming text → speakable chunks
                         speech-text.js     Markdown → speech text
                         speech-queue.js    ordered TTS with limited parallel prefetch
                         permission.js      tool-call summaries, spoken prompts and cues
                         click-through.js   setIgnoreMouse decisions with hysteresis
                         gaze.js            cursor position (desktop-wide in Electron) → avatar.lookAt
                         settings-defaults.js renderer copy of the §4 defaults, getPath/patchFor
                         emitter.js         tiny event emitter
src/audio/               player.js (Web Audio queue + analyser), lipsync.js (drivers), articulation.js
                         (coarticulation model, speech plans), prosody.js (a clip's loudness and pitch →
                         speech events), g2p.js (text → phonemes), mic.js (+ mic-worklet.js), vad.js,
                         dsp.js (resampler), wav.js
src/speech/              voice-client.js (voice server §6), web-speech.js (browser voice), index.js (tts/stt routing)
src/ui/                  app-view.js, transcript.js, markdown.js, composer.js, permission-cards.js,
                         toasts.js, status.js, settings-drawer.js, accelerator.js, avatar-host.js, layout.js, dom.js
src/styles/app.css       the glass UI
```

## Conversation

`idle → listening → transcribing → thinking → speaking → idle`, mirrored on `body[data-state]`.

* Typed text enters at *thinking*. Sending while Claude is busy pre-empts the current reply
  (speech stops, the turn is interrupted, its partial text stays in the chat).
* Streamed text goes to the transcript (safe Markdown, re-rendered at most once per frame) and,
  when replies are spoken, through the sentence chunker → `toSpeechText` → the speech queue.
  The first chunk may be cut early at a clause (~40 characters) for a fast first sound; code
  blocks and tables are never spoken ("I've put the code in the chat.").
* Speech: the local voice server (Kokoro, with a viseme timeline) when it is running, otherwise
  the system's speech synthesis (Web Speech: the voice chosen in *Settings › Voice*, saved as
  `voice.systemVoice`, or the most natural English one; the list refreshes on `voiceschanged`),
  otherwise text only. Up to two sentences
  are synthesized ahead of the one playing.
* Lip-sync each frame (see [Lip-sync](#lip-sync) below) → `avatar.setMouth` (jaw, wide, round,
  press, tuck, teeth, tongue), loudness → `avatar.setSpeechLevel`, prosody cues → `avatar.setProsody`,
  the local voice's pitch → `avatar.setIntonation`.
* Tool calls show as chips; if Claude goes straight to a tool the avatar says a short cue.
  Permission requests (agent mode) show a card with Allow/Deny and a spoken prompt. Nothing is
  ever approved automatically. Cards disappear when their turn ends or the CLI restarts.
* Voice input needs the local voice server (faster-whisper). Without it the mic button is
  disabled and its tooltip explains how to install it (*Set up local voice…*).
* First run: a missing or logged-out Claude CLI (main's `problem` event) shows a setup card over
  the avatar with the official install commands, Copy buttons and Retry (`src/ui/setup-cards.js`,
  `src/app/setup-help.js`); a voice setup that has to be run by hand shows its command the same way.
* Hands-free (setting): a VAD listens whenever the conversation is idle and pauses while the
  avatar thinks or speaks (half-duplex, so it never hears itself).
* After 10 idle minutes the avatar dozes (`sleep` state); any activity wakes it.

## Lip-sync

Every source ends in the same coarticulation model (`src/audio/articulation.js`): timed segments,
each an articulatory target on seven channels, blended by dominance functions (Cohen & Massaro):
the lips own m/b/p (press) and f/v (tuck), the jaw owns the vowels, rounding spreads ~120 ms ahead
into the consonants before an O / U (unless a spread vowel is in between), an h or a schwa takes
its neighbours' shape, and a closure is dominant enough that a 50 ms "m" still closes (press ≥ 0.8,
jaw ≤ 0.06). A closure passed between two frames is shown, and the director closes the jaw fast
into it, so it also closes on screen at 30 fps.

| Source | Mouth |
|---|---|
| local voice (Kokoro) | the server's viseme timeline (aligned with the audio by the server, [VOICE.md](VOICE.md#21-http-api)) at the playback clock + 50 ms visual lead, and the clip's own audio (the player's decoded buffer, or its WAV): the loudness envelope opens the jaw, sampled a moment ahead so a syllable's onset opens it as sharply as the sound starts; each vowel's jaw is scaled by its measured loudness and length (stressed syllables wider, reduced ones less); every sound varies a little (jaw ±8 %, spread, rounding), so repeated syllables are never identical; a phrase-final sound rests where the voice really stops (Kokoro holds a final "d" ~200 ms into the pause) |
| system voice (Web Speech) | the utterance's words → phonemes (`g2p.js`: a ~500-word exception dictionary incl. "Claude", NRL letter-to-sound rules, stress, numbers, acronyms) → a timed plan (stressed vowels long, closures ≥ 50 ms, phrase-final lengthening, rests at punctuation that ends a word; a mark inside a token — `package.json`, `github.com`, `10:30` — is read straight through, with a spoken "dot" between letters). Word-boundary events (`charIndex`) anchor each word; between them the plan runs at a speed learned from the boundaries (per utterance rate); an early boundary compresses the rest of the word, a late one holds the word's last sound (or waits at rest in a pause). Voices without boundary events play the whole plan from `onstart`, and the next utterance uses the tempo the last one turned out to have. A voice that has not reported its start after 0.6 s is assumed to have started; when its real `onstart` (or first boundary) comes later, the mouth re-anchors there instead of leading the voice, and no tempo is learned from the guess. |
| audio without visemes | RMS → jaw (noise gate), band ratios → spread / round, quiet hiss → teeth |

The plan also yields prosody cues (accents on the stressed syllables of content words, the last one
of a phrase strongest; phrase starts and ends with their punctuation; emphasis; friendliness),
which the director turns into small nods, phrase lifts, a brow raise and head tilt on questions,
blinks at phrase boundaries rather than mid-word, and a micro-smile after a friendly sentence. All
of it is pure and unit-tested (`tests/unit/app/{g2p,articulation,lipsync}.test.js`,
`tests/unit/avatar/{director-speech,mouth-rig}.test.js`).

**Prosody from the voice itself (local voice).** For a clip with audio, `src/audio/prosody.js`
measures the loudness envelope (all at once, under a millisecond) and the pitch: YIN on a 1 kHz
low-passed copy decimated to ~6 kHz, octave slips folded back, ~25 µs per 10 ms frame, analysed
0.4 s at the clip's start and then at most 30 frames per frame of the app, up to 0.8 s ahead of
playback (measured on the real clips: 3 ms on a clip's first frame, 0.04 ms on the others). From
the pitch and the timeline it derives the cues that replace the text's for these clips:

| Cue | From the audio | The face |
|---|---|---|
| `inhale` | the silence before the first phrase and pauses ≥ 0.22 s, sized to the time left | nostrils flare, free lips part a little, the head and chest lift; breathing while speaking follows the pauses |
| `phrase-start` | each run of speech between rests ≥ 100 ms | a small lift; some phrases start with a glance away |
| `accent` | vowels whose pitch peak (re the speaker's usual pitch), rise, loudness and length beat the vowels within 0.3 s | a nod (varying in size) |
| `emphasis` | an accent ≥ 5 semitones above the usual pitch, rising ≥ 3 | brows lift, a firmer nod |
| `phrase-end` | where the voice stops, with its final fall / rise (semitones), the pause after it and the text's punctuation | a fall settles the head (final lowering); a question or a rising end lifts the brows and tilts the head; eye contact again; a blink when the pause is real |

The intonation (pitch in semitones re the speaker's usual pitch, the median of the clips heard)
also goes to `avatar.setIntonation`: the head follows it a little (~0.2° per semitone) and the
brows lift on peaks well above it. Blinks wait while the voice sounds.

**The face moving with the mouth.** The director derives `cheekRaise` (spread vowels, smiles;
less with a wide-open jaw), `chinRaise` (pressed lips, tucks, puckers: the mentalis) and
`nostrilFlare` (breaths) from the mouth; the relief head moves soft regions around its mesh's
MediaPipe landmark vertices with them (the cheek apples and the nasolabial folds beside them, the
chin boss, the nostril wings), fills rounded lips out, raises the upper lip with the jaw (~15 % of
the lower lip) and shapes the jaw drop like a hinge: the jaw's sides near the joints drop less than
the chin and lips, the chin travels 12 % farther (the lower face lengthens) and swings back. The
procedural head does the same in its vertex rig (its jaw already turns about the joint). All of it
is zero at rest: the rest render is unchanged.

**Conversational gaze.** While speaking, about half of the phrase starts bring a short glance
away (sideways, slightly up or down, 0.35-0.9 s) that ends by the phrase end; it is an offset on
top of `lookAt`, so the camera's eye contact and the cursor follow stay in charge.

**Expressiveness.** *Settings → Avatar → Expressiveness* (`avatar.expressiveness`, 0..2,
default 1) scales nods, lifts, tilts, brows, smiles, glances and the intonation; at 0 the head is
still while speaking. The face coupling is anatomy, so it keeps 40 % at 0.

![The face moving with the mouth on real Kokoro speech: rest, an open vowel (hinged jaw), a spread vowel (cheeks), an m (lips press, chin bunches)](screenshots/face_with_mouth.jpg)

![Mouth film strip of "Maybe we should move the meeting to Friday?" (Kokoro af_heart): before (top) and after (bottom)](screenshots/speech_real_voice.jpg)

Timing, measured end to end on 12 real Kokoro clips with `tools/visual/lipsync-align.mjs` (the
rendered mouth of LipSync + director at 60 Hz vs the audio; negative = the mouth leads):

| | before | after |
|---|---|---|
| fullest m / b / p closure vs the level dip | +12 ms | -35 ms |
| jaw opening after a pause vs the acoustic onset | -6 ms | -52 ms |
| jaw / level correlation lag | +17 ms | -33 ms |

The display adds one to two frames of its own, so on screen the closures land within a few ms of
the sound instead of ~40 ms after it.

![The fourteen visemes on the relief and the procedural head](screenshots/mouth_visemes.jpg)

![Film strip of the system-voice lip-sync saying "Hello! I'm Claude. How are you feeling today?"](screenshots/mouth_speech.jpg)

Rendering: the relief head closes pressed lips over a slightly open jaw and thins them (the lip
texture is compressed toward the seam and the rest gap skipped), brings a tucked lower lip up under
the incisors (which fill the small opening), raises the upper lip for teeth (the incisors follow),
draws a dim tongue tip at the teeth, pulls the corners in for round and out for spread, and tilts
them slightly with `mouthAsym`. The procedural head does the same in its vertex rig and cavity
shader; the placeholder maps wide / round / press onto its mouth line.

Check it in the avatar harness: `/dev/avatar.html?fixedTime=1&vis=PP` (one viseme),
`?fixedTime=1&press=1`, `?fixedTime=1&tuck=1&jaw=0.08`, `?fixedTime=1&tongue=1&jaw=0.2`, and
`/dev/avatar.html?ui=0&caption=1&say=Hello!%20I'm%20Claude.&t=0.9`: a deterministic run of the real
system-voice path at 60 Hz (a scripted voice sends word boundaries at its own tempo with jitter;
`bounds=0` is a voice without boundaries; `rate`, `voiceTempo`, `jitter`, `latency`).
`window.__seek(t)` steps it; `node tools/visual/film.mjs` records the frames for a video
(see tools/visual/README.md). The local-voice path on real voice-server clips:
`/dev/avatar.html?ui=0&caption=1&clip=hello.json,maybe.json` (the `/tts` JSON with `audioB64`, or
`wav=<url>`) plays them back to back through the real LipSync, director and head;
`film.mjs --clip a.json,b.json --mp4 out.mp4` films it with the sound muxed in, and `expr=<0..2>`
sets the expressiveness.

## Using it

| Input | Action |
|---|---|
| Enter / Shift+Enter | send / new line (↑ recalls the last messages) |
| hold **Space** (focus not in a text field) | push-to-talk; release to send |
| mic button | click: listen until you stop talking (click again to stop); hold: push-to-talk |
| **Esc** | close settings · cancel listening · stop speaking · otherwise stop the reply |
| send button while busy | becomes Stop |
| global hotkeys (Settings › Shortcuts) | talk / interrupt, stop speaking, show/hide chat |
| drag the head (or the status line) | move the window |

The window is the 2:3 avatar area plus, when the chat panel is on, a strip below it. With the
panel off (minimal mode) the panel floats over the avatar while something happens or the pointer
is near, and hides when idle. With click-through on (Windows/macOS), clicks on transparent
pixels reach the desktop; the head, the panel and cards stay clickable.

## Browser preview (no Electron)

`npm run build && npm run preview`, or Vite dev, then open `index.html?mock=1`:

| URL parameter | Effect |
|---|---|
| `mock=1` | use the mock bridge (also automatic when `window.lawnmower` is missing) |
| `voice=fake` | in-page fake voice server: spoken replies with visemes, canned speech recognition |
| `voice=http://127.0.0.1:PORT&voiceToken=T` | a real voice server, e.g. `LAWNMOWER_VOICE_TOKEN=T python -m lawnmower_voice --fake --port PORT` (from `voice/`; CORS allows 127.0.0.1:5173/4173) |
| `mockDelay=ms`, `mockFirst=ms` | streaming speed of the mock |
| `settings={"avatar":{"quality":"low"}}` | initial settings patch |
| `clickThrough=1` | exercise click-through decisions (recorded in `__app.bridge.__mock.calls`) |
| `claude=missing` / `claude=auth` | first run without a Claude CLI / with a CLI that is not logged in: the setup cards; `claudeRetries=N` makes the first N Retry clicks fail |
| `layout=electron` | use the desktop window's layout rule |
| `bg=desk` | a colourful backdrop to judge transparency |

The mock streams canned replies: a greeting ("hello"), a code example ("code"), a Markdown
showcase ("markdown"), a long answer ("story", "explain"), a Bash tool call that waits for the
permission card ("run", "tool"), a failure ("simulate error"), otherwise an echo.
`window.__app` exposes the controller, view, avatar and bridge for debugging.

## Tests

* `npx vitest run tests/unit/app` — chunker, speech text, controller (fake bridge/player/TTS/STT/mic),
  speech queue, G2P, coarticulation and speech plans, lip-sync drivers (incl. Web Speech → player →
  lip-sync with fake timers, with and without boundary events), audio prosody (pitch on tones and
  glides, voiced / unvoiced, accents, final falls and rises, breaths) and the jaw from a clip's
  loudness, VAD/resampler/WAV, mic (fake
  getUserMedia), player (fake Web Audio), Markdown parser/renderer, mock bridge, voice client,
  Web Speech, permissions, UI logic.
* `npx playwright test` — the built app in Chromium (SwiftShader) with the mock bridge: boot +
  hologram pixels, streaming states, safe Markdown + copy, permission cards, interrupt, error
  toasts, settings drawer + renderer switch, minimal mode, hotkeys, click-through, spoken replies
  with lip-sync (`voice=fake`), push-to-talk through Chromium's fake microphone, and the full loop
  against the real Python voice server in `--fake` mode (skipped when Python/FastAPI are missing).
  Screenshots go to `$LM_SHOTS_DIR` (default `test-results/screenshots`).
