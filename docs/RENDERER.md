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
src/audio/               player.js (Web Audio queue + dry analyser), voicefx.js (+ voicefx-worklet.js: the
                         voice character on the audio thread), lipsync.js (drivers), articulation.js
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
  are synthesized ahead of the one playing. The local voice plays through the voice character
  (*Settings › Voice › Character*: Synth by default; `src/audio/voicefx.js` in an AudioWorklet, see
  [VOICE.md](VOICE.md#24-voice-character)); the lip-sync analyser taps the dry voice before it.
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
jaw ≤ 0.12: the lips do most of the closing, the jaw stays partly open between open vowels as it
does in speech). A closure passed between two frames is shown, and the director closes the jaw
fast into it, so it also closes on screen at 30 fps.

| Source | Mouth |
|---|---|
| local voice (Kokoro) | the server's viseme timeline, re-timed on the clip's own sound and given per-vowel amounts from its formants (below), at the playback clock (smoothed, see [Motion](#motion)) + 40 ms visual lead for the lips, 60 ms for the jaw (58 ms for both until the analysis is back), and the clip's own audio (the player's decoded buffer, or its WAV): the loudness envelope opens the jaw, sampled a moment ahead so a syllable's onset opens it as sharply as the sound starts; each vowel's jaw is scaled by its measured loudness and length (stressed syllables wider, reduced ones less); every sound varies a little (jaw ±8 %, spread, rounding), so repeated syllables are never identical; a phrase-final sound rests where the voice really stops (Kokoro holds a final "d" ~200 ms into the pause) |
| system voice (Web Speech) | the utterance's words → phonemes (`g2p.js`: a ~500-word exception dictionary incl. "Claude", NRL letter-to-sound rules, stress, numbers, acronyms) → a timed plan (stressed vowels long, closures ≥ 50 ms, phrase-final lengthening, rests at punctuation that ends a word; a mark inside a token — `package.json`, `github.com`, `10:30` — is read straight through, with a spoken "dot" between letters). Word-boundary events (`charIndex`) anchor each word; between them the plan runs at a speed learned from the boundaries (per utterance rate); an early boundary compresses the rest of the word, a late one holds the word's last sound (or waits at rest in a pause). Voices without boundary events play the whole plan from `onstart`, and the next utterance uses the tempo the last one turned out to have. A voice that has not reported its start after 0.6 s is assumed to have started; when its real `onstart` (or first boundary) comes later, the mouth re-anchors there instead of leading the voice, and no tempo is learned from the guess. |
| audio without visemes | RMS → jaw (noise gate), band ratios → spread / round, quiet hiss → teeth |

The plan also yields prosody cues (accents on the stressed syllables of content words, the last one
of a phrase strongest; phrase starts and ends with their punctuation; emphasis; friendliness),
which the director turns into small nods, phrase lifts, a brow raise and head tilt on questions,
blinks at phrase boundaries rather than mid-word, and a micro-smile after a friendly sentence. All
of it is pure and unit-tested (`tests/unit/app/{g2p,articulation,lipsync}.test.js`,
`tests/unit/avatar/{director-speech,mouth-rig}.test.js`).

**Listening to the voice (local voice).** The viseme timeline gives the categories (closed,
tucked, spread, rounded, open); the sound gives the timing and the amounts. Each clip's WAV is
analysed in a Web Worker (`src/audio/acoustics-worker.js` → `acoustics.js`; `acoustics-client.js`
falls back to the main thread only where there is no Worker, e.g. Node): every 5 ms its loudness,
a low band (< 400 Hz, the nasal murmur of m / n), a high band (> 3 kHz), voicing, and F1-F3 by LPC
(order 14 at ~12 kHz, Levinson-Durbin, roots warm-started; F1 within 2-3 % of a numpy reference
on the clips). The first 0.8 s are posted at once, the rest when done (~30 ms per 5 s of speech);
the controller starts it when the speech queue has synthesised a clip, before it plays.
`src/audio/fusion.js` (0.15-0.25 ms per clip, compiled at idle) then:

| Step | What it does |
|---|---|
| landmarks | phrase onsets (the first frame within 22 dB of the phrase's peak); closures (m b p) and tucks (f v) between two vowels: the level dip below half its depth, only a true local minimum overlapping the segment (not the next consonant of a cluster) |
| time warp | a monotonic piecewise-linear warp of the timeline onto them (slopes 0.4-2.5, at most 90 ms), so the segments stay contiguous; anchored closures are marked `exact` and get crisper lip edges |
| amounts | per vowel: jaw from F1 (normalised to the voice's own range: the 12th-88th percentile of its vowels heard so far, from a prior by pitch), bounded per category (`JAW_RANGE`: U 0.04-0.3 … aa 0.3-0.95); spread from F2 (front vowels); stress from loudness and length (×0.62-1.18; reduced front vowels lose spread and teeth); rounded vowels 82-100 % rounded |

Result on 36 real clips (af_heart, am_michael, bf_emma × six sentences × speeds 0.9 / 1.1), the
relief head's aperture at the centre of each vowel: r(aperture, F1) 0.34 → 0.66; open vs close
vowels 1.39x → 1.72x; stressed vs unstressed 1.45x → 1.61x. Before, the rounded vowels opened the
most (ɔ / o 58-61 px, ahead of the open vowels' 50 px); now ɑ 52, æ 45, ɔ / o 40, ɪ / i 24-26,
ʊ / u 21-24 px.

**Prosody from the voice itself (local voice).** For a clip with audio, `src/audio/prosody.js`
measures the loudness envelope (all at once, under a millisecond) and the pitch: YIN on a 1 kHz
low-passed copy decimated to ~6 kHz, octave slips folded back, ~25 µs per 10 ms frame, at most 20
frames per frame of the app, up to 0.8 s ahead of playback. A clip's analysis is prepared one step
per frame over its first frames (the WAV's base64, the WAV, then the envelope and the cue plan;
the first two are skipped when the player offers its decoded buffer), while the timeline-only
mouth plays its leading silence, and the analysis code is compiled once while the app is idle, so
no frame pays for it all. From the pitch and the timeline it derives the cues that replace the
text's for these clips:

| Cue | From the audio | The face |
|---|---|---|
| `inhale` | the silence before the first phrase and pauses ≥ 0.22 s, sized to the time left | nostrils flare, free lips part a little, the head and chest lift; breathing while speaking follows the pauses |
| `phrase-start` | each run of speech between rests ≥ 100 ms | a small lift; some phrases start with a glance away |
| `accent` | vowels whose pitch peak (re the speaker's usual pitch), rise, loudness and length beat the vowels within 0.3 s | a phrase's strongest (nuclear) accent nods; weaker ones nod with a probability that grows with their strength, otherwise give a small turn / tilt beat, a brow flick, or nothing; nod sizes vary log-normally (±30 %), so the head never bobs once per stressed word |
| `emphasis` | an accent ≥ 5 semitones above the usual pitch, rising ≥ 3 | brows lift, a firmer nod |
| `phrase-end` | where the voice stops, with its final fall / rise (semitones), the pause after it and the text's punctuation | a fall settles the head (final lowering); a question or a rising end lifts the brows and tilts the head; eye contact again; a blink when the pause is real |

The intonation (pitch in semitones re the speaker's usual pitch, the median of the clips heard)
also goes to `avatar.setIntonation`: the head follows it a little (~0.2° per semitone) and the
brows lift on peaks well above it. Blinks wait while the voice sounds.

**The face moving with the mouth.** The director derives `cheekRaise` (spread vowels, smiles;
less with a wide-open jaw), `chinRaise` (pressed lips, tucks, puckers: the mentalis) and
`nostrilFlare` (breaths) from the mouth; the relief head moves soft regions around its mesh's
MediaPipe landmark vertices with them (the cheek apples and the nasolabial folds beside them, the
chin boss, the nostril wings), fills rounded lips out, raises the upper lip with the jaw (~30 % of
the lower lip, so the upper incisors show on open vowels) and shapes the jaw drop like a hinge: the jaw's sides near the joints drop less than
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

Timing, measured end to end with `tools/visual/lipsync-align.mjs` (the rendered mouth of LipSync
+ director + the relief head's rig at 60 Hz vs the audio; negative = the mouth leads), medians:

| | v0.2 | v0.3 | v0.4 |
|---|---|---|---|
| lips sealed (aperture < 1 px) vs the acoustic closure, start: median [IQR], 36 clips | | -32 [-37, -25] ms | -30 [-32, -25] ms |
| ... end | | -15 [-22, +2] ms | -20 [-22, -15] ms |
| ... start / end, the 12 clips of v0.3 | | -35 / -20 ms | -35 / -20 ms |
| fullest m / b / p closure vs the level dip, 12 clips | +12 ms | -33 ms | -38 ms |
| jaw opening after a pause vs the acoustic onset, 36 clips | | -53 ms | -49 ms |
| m / b / p sealed (all of them, at Kokoro's phoneme times, 36 clips) | | 78 / 78 | 78 / 78 |

(36 clips: af_heart, am_michael, bf_emma, six sentences each, speeds 0.9 and 1.1; the closures the
tool scores are the m / b / p between vowels with a clear level dip.) The display adds one to two
frames of its own, so on screen the seal lands within ~15 ms of the sound. The timing barely changed on average (it was right on average in v0.3); its spread did: the
fused timeline puts each closure on its own sound instead of on a 25 ms timeline frame.
*Settings → Voice → Lip-sync timing* (`voice.lipSyncOffsetMs`, ±200 ms) shifts it for audio
devices with an unreported delay (Bluetooth); **Test lip-sync** says a line of m / b / p to judge it
by ([VOICE.md](VOICE.md#23-lip-sync-in-the-renderer)).

Kinematics (36 clips, director springs `MOUTH_OMEGA`, `LIP_CONTACT`): the lips approach a closure
over ~60 ms (the press spring rises at 48 rad/s, starting `LIP_CLOSE_EARLY` = 28 ms sooner than it
falls) and meet at speed (contact at 80 % of the spring's way), then part abruptly (100 rad/s): the
largest one-frame change of the relief head's aperture went from 45 px (a wide-open vowel snapping
shut) to 31 px, its p99 from 18 to 17 px; the aperture's p95 closing / opening speed ratio is
0.86-0.96 (0.72 before: the mouth opened fast and drifted shut).

![The fourteen visemes on the relief and the procedural head](screenshots/mouth_visemes.jpg)

![Film strip of the system-voice lip-sync saying "Hello! I'm Claude. How are you feeling today?"](screenshots/mouth_speech.jpg)

Rendering: the relief head opens the lips as a lens that spans the corners where they are now
(narrow and round for O / U, wide for E): the commissures take only 40 % of the jaw drop and the
lower lip's share tapers toward them, so the corners stay closed and the opening's edges are smooth
curves that close into the seam without a kink over the last quarter of the way (no sharp dark tips
beside an O); the parted lips' inner edges roll into the mouth (a soft shadow, a thin moist highlight) and
the cavity darkens with depth. Its mouth region is refined to <= 6 px triangles at load (new
vertices on the baked edges, so the rest render is unchanged), which keeps those curves smooth at a
60 px jaw drop. The opening's outline follows the vowel: a slender almond for a small or rounded
opening, rounder-ended and flatter in the middle for an open or spread one (`uLens` z / w: the
lens profile's exponents for the upper and the lower lip), and the corners draw in a little as the
jaw drops (by its square), so a wide-open mouth is not a slot. The teeth belong to the jaw
(`heads/teeth.js`, shared by both heads): the upper incisors show with the parted lips (less
behind rounded ones), the lower teeth only once the jaw has dropped (or for an ee / s), never
behind pressed or tucked lips. It closes pressed lips over a slightly open jaw and thins them (the lip
texture is compressed toward the seam and the rest gap skipped; the shapes' parting fades with the
square of the press, so a press that is only half released still holds the lips together), brings a tucked lower lip up under
the incisors for f / v: the upper lip keeps half of the neighbouring vowel's lift and the opening
narrows by 20 %, so a narrow band of incisor crowns shows over the lower lip (the cavity shader
fills it from the mouth texture's incisor rows, found at load, `incisorBand`), not a dark slot;
it raises the upper lip for teeth (the incisors follow),
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

## Motion

Everything the head does moves with continuous velocity and acceleration, at any frame rate:
nothing starts at full speed or stops dead, nothing steps between frames, and nothing repeats.

* **Primitives** (`src/avatar/motion.js`, pure): critically damped springs with an exact step (the
  same curve at 30, 60 or 144 Hz and through a dropped frame; they replace the one-pole lags,
  which start at full speed), an under-damped spring for a slight rebound, minimum-jerk kernels
  (pulses and envelopes that start and end at rest), the One Euro filter, 1/f ("pink") noise from
  several octaves of smooth noise at non-integer frequency ratios and random phases (it never
  repeats), Gaussian and log-normal draws.
* **Mouth**: every mouth channel follows the lip-sync target through its own spring, faster
  opening than closing (jaw ω 55 / 38 rad/s, press 110 / 55, round 33 / 24, ...). The lips seal an
  m / b / p on their own (the rigs bring the lower lip up over a jaw still open), so even a 50 ms
  closure seals on screen at 30 fps, and the heavier jaw follows them (ω 50 into a closure) instead
  of snapping shut within a frame. The chin (mentalis) follows the lips' target, in step with the
  closure.
* **Eyes** (`src/avatar/eyes.js`): saccades on the human main sequence (duration 21 + 2.2 ms per
  degree, a minimum-jerk profile with the peak speed mid-way: a 10 degree shift takes 43 ms),
  fixations that hold still between them (with 0.2-0.25 degree micro-saccades), smooth
  pursuit of a moving target (gain 0.9, up to 30 deg/s, ~100 ms behind) with catch-up saccades when
  it gets away, and a ~170 ms reaction time for targets it follows (cursor, camera). The head goes
  along with a target it follows (the cursor, the user's face): 38 % of the look, a spring a few
  hundred ms behind the eyes (t50 ~0.25 s, anticipating a moving target a little), never turning
  against them; with the avatar's own looks (and a glance away from the user) it takes a share of
  large shifts (20-30 %, more for big ones), starting late, and of small ones over seconds. The
  eyes counter-rotate as the head arrives (vestibulo-ocular reflex), so eye + head land on the
  target without overshoot. Gaze is composed in degrees (`GAZE_DEG`: 17 deg per gaze unit across, 12.8
  up and down; the relief iris slides 0.6 / 0.45 iris radii).
* **Blinks**: log-normal intervals (median 2.8 s idle, 4 s listening, 2.4 s thinking, 2.3 s
  speaking; never closer than 0.8 s), a fast close (60-80 ms) and a slower open (150-220 ms) with
  a brief hold, 20 % of them partial, 4 % doubled, a blink with most gaze shifts over 15 degrees, and the
  upper lid follows a downward gaze part of the way. They wait while the voice sounds.
* **Idle**: the head sways on 1/f noise (`pinkNoise` has unit rms: 1 deg yaw, 0.45 pitch, 0.26
  roll from 0.1 Hz up, ~0.8 deg rms yaw and ~0.5 deg/s over two minutes, plus a faint fast tremor),
  breathing has a wandering period and depth with an occasional sigh, the eyes wander in saccades
  between fixations, and the head follows the eyes only for large shifts.
* **Thinking**: each episode picks a side and a look (up 85 % of the time) and holds it, switching
  after an exponential time (mean 11 s, at least 5-8 s), with small looks around it.
* **States**: listening / thinking / speaking blend in through springs (head pitch t90 0.3-0.8 s)
  with a saccade to the new gaze, instead of a slow glide; starting to speak, the first look goes
  to the listener.
* **Speech**: nods are minimum-jerk pulses (0.17 s up, 0.31 s back, each a little different in
  size and speed, with a touch of yaw and roll; nods close together merge into the larger one, a
  running nod growing by a second pulse), phrase lifts and the breath before speaking are
  envelopes, and the intonation is soft-clamped.
* **Clocks**: the lip-sync runs inside the avatar's own frame (one loop: `avatar.setFrameHook`), so
  it never samples a different time than the face it drives. The playback time is smoothed by a
  phase-locked clock (`PlaybackClock` in `src/audio/lipsync.js`: it follows the player's reported
  time by at most 2 ms per frame, never runs backwards, stays within 12 ms ahead and re-syncs when
  30 ms off), which turns Windows' 10 ms AudioContext clock steps into smooth time; the player
  reads the output timestamp and a median of the output latency.
* **Camera and cursor**: the face centre goes through a One Euro filter and eye contact
  alternates log-normal contact phases with glances away ([CAMERA.md](CAMERA.md)); targets that
  arrive at 12 Hz (camera) or 30 Hz (cursor) are reconstructed between samples, so the eyes never
  see a staircase. A cursor outside the window is looked at along its direction at full strength
  (`src/app/gaze.js`), so a cursor coming in from across the screen never turns the eyes away
  from it first.
* **Eyes on the relief head**: the pack's landmark eye centres sit ~25 px off the painted irises
  (and their radii are ~20 % small), so the head locates the painted irises on the plate at load
  (the dark pupil inside the bright iris; `avatar.headInfo()` reports them), paints the plate over
  beneath them (the eye white beside the iris, its texture carried across) and moves each iris as a
  rigid disc inside the open eye: the lids, the lid lines and the eye's outline stay put and the
  pupil stays round. The disc shows only where the plate shows the eye's inside; the lid margins'
  glow lies over it (looking down, the pupil goes under the lower lid). A hidden part of a moving
  iris comes from its mirror image near the horizontal axis, blended into the same radius turned
  toward it farther out; the fill under the iris carries the eye white's and the lid glows'
  texture on (the lid margins along their own curve). The layer fades in over the first few % of
  travel, so at rest and just off it the plate itself shows (no pop as the gaze crosses zero). A
  pack whose plate cannot be read back keeps the old uv warp.
* Settled renders (`fixedTime`, tests) use the same closed-form rest poses as before.

Measured on deterministic 60 Hz traces of the harness (idle 300 s, thinking 60 s, five Kokoro
clips, the system voice, the camera and cursor replays; closures over 52 m / b / p in 18 real
Kokoro clips), before -> after:

| | before | after |
|---|---|---|
| head pitch kinks while speaking (Kokoro) | 1.75 /s | 0 /s |
| head pitch velocity power above 8 Hz (Kokoro) | 0.20 | 0.003 |
| nod: one-frame velocity step at onset / of the peak speed | 26 deg/s / 118 % | 3.6 deg/s / 30 % |
| idle saccades >= 1 deg: duration / peak speed (main sequence 28 ms / 98 deg/s) | 133 ms / 51 deg/s | 50 ms (3 frames) / 91 deg/s |
| idle gaze path (eye in head): fixation / drift / saccadic | 7 / 56 / 37 % | 31 / 17 / 53 % (the drift: counter-rotation against the head's sway; in the world the gaze holds still 96 % of the time) |
| idle head sway: yaw rms / mean speed over 2 min (3 seeds) | 0.80 deg / 0.55-0.63 deg/s, with 58-70 acceleration ticks /min | 0.78-0.86 deg / 0.49-0.55 deg/s, no ticks |
| blinks: shortest interval, amplitude spread, closed >= 90 %, doubles in 5 min | 0.3 s, 0, 83 ms, 12 | 0.8 s, 0.11, 33 ms, 0 |
| thinking: side switches, interval CV, gaze autocorrelation at the switch period | 17 /min, 0.18, 0.63 | 5 /min, 0.46, <= 0.19 |
| breathing autocorrelation at 4 s / 8 s | 0.99 / 0.97 | 0.86 / 0.61 |
| cursor flick: where eye + head land (world gaze vs the target) | 30 % past it | on it (the head takes ~40 %: 7.2-8.8 deg of a 20 deg flick, 11 of 28) |
| cursor follow (30 Hz sweep and circle, 5 seeds): head lag behind the cursor | 333 ms | 100-330 ms (median 200) |
| cursor sweep (30 Hz polls): consecutive-frame eye speed ratio (1 = smooth), power at 25-30 Hz | 1.52, 0.045 | 1.06, 0.004 |
| camera, slow sway: velocity power above 8 Hz (outside glances), kinks | 0.25-0.30, 0.66 /s | 0.002, 0.19 /s |
| camera, the face jumps: eye t90, peak speed | 600 ms, 18 deg/s | 250 ms, 68 deg/s |
| listening / thinking / speaking: head pitch t90 | 0.97 / 1.05 / 0.78 s | 0.32 / 0.80 / 0.45 s |
| m / b / p closures sealed (lips < 1 plate px), sealed time median / p10 | 51 of 52, 67 / 33 ms | 52 of 52, 67 / 50 ms |
| jaw one-frame velocity steps while speaking, jaw rms jerk | 43 /min, 5700 | 2 /min, 3000 |
| chin with the pressed lips: correlation, lag | 0.83, 29 ms (pumping: range 0.89) | 0.83, 31 ms (range 0.58) |
| Windows clock (10 ms steps): jaw error rms | 0.0107 | 0.0081 |

The mouth's timing against the audio is unchanged (m / b / p closures 35 ms ahead of the sound).

## Using it

| Input | Action |
|---|---|
| Enter / Shift+Enter | send / new line (↑ recalls the last messages) |
| hold **Space** (focus not in a text field) | push-to-talk; release to send |
| mic button | click: listen until you stop talking (click again to stop); hold: push-to-talk |
| **Esc** | close settings · cancel listening · stop speaking · otherwise stop the reply |
| send button while busy | becomes Stop |
| global hotkeys (Settings › Shortcuts) | talk / interrupt, stop speaking, show/hide chat |
| drag the head (or the status line) | move the window (snaps to screen edges and corners) |

The window is the 2:3 avatar area plus a chat strip below it. With the chat panel on, the panel
fills the strip; with it off (minimal mode) the panel drops down from under the chin while
something happens or the pointer is near, and folds away when idle. It never covers the face,
and the window keeps its size when the mode changes; the folded strip is transparent. With click-through on (Windows/macOS), clicks on transparent
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
* `npx vitest run tests/unit/avatar` — the motion primitives and the eye controller
  (`motion.test.js`: springs exact at any step, main-sequence saccades, pursuit, head share,
  pinkNoise's unit rms), the director's motion (`director-motion.test.js`: continuous velocity, the
  same motion at 60 and 144 Hz, blink statistics, thinking episodes, nods and nods that grow, the
  head going along with a cursor sweep and flick but not with a glance, the idle sway's size,
  eye contact as speech starts, the settled poses unchanged), the relief head's mouth-mesh
  refinement and iris layer (`relief-refine.test.js`, `relief-iris.test.js`: the open map, the
  fill along an arched lid) and the rigs. `tests/unit/app/lipsync-real.test.js` keeps every
  m / b / p of the real Kokoro fixture sealed on the relief rig for >= 50 ms, the chin with it.
* `npx playwright test` — the built app in Chromium (SwiftShader) with the mock bridge: boot +
  hologram pixels, streaming states, safe Markdown + copy, permission cards, interrupt, error
  toasts, settings drawer + renderer switch, minimal mode, hotkeys, click-through, spoken replies
  with lip-sync (`voice=fake`), push-to-talk through Chromium's fake microphone, and the full loop
  against the real Python voice server in `--fake` mode (skipped when Python/FastAPI are missing),
  and the relief head's irises (located on the plate; no change at all as the gaze leaves zero,
  `avatar-eyes.spec.js`). Screenshots go to `$LM_SHOTS_DIR` (default `test-results/screenshots`).
