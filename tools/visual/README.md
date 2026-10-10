# Visual tools

Headless screenshots and image comparisons for visual checks (any lane). Chromium comes from
`@playwright/test`; WebGL runs on SwiftShader (software), so keep viewports small.

## snap.mjs — screenshots

```bash
# one shot (waits for window.__ready === true; pages may set window.__error to fail fast)
node tools/visual/snap.mjs --url "http://127.0.0.1:5173/dev/avatar.html?fixedTime=1&ui=0" \
     --out out/rest.png --w 392 --h 584 --wait-ready

# side-by-side with the reference frame (screenshot one element)
node tools/visual/snap.mjs --url "http://127.0.0.1:5173/dev/avatar.html?fixedTime=1&ui=0&compare=1" \
     --out out/compare.png --w 784 --h 584 --selector "#stage" --wait-ready

# many shots, one browser
node tools/visual/snap.mjs --batch shots.json --wait-ready
#   shots.json: [{ "url": "...", "out": "a.png", "w": 392, "h": 584, "selector": "#stage" }, ...]
```

Options: `--dpr <n>`, `--delay <ms>` (extra wait after ready), `--timeout <ms>`, `--quiet`.
Page errors and `console.error` lines are printed to stderr; exit code 2 if the page reported
`window.__error`, 1 for other failures.

## compare.py — scores and contact sheets

```bash
# luminance SSIM / PSNR inside the head region (pack silhouette mask), plus a diff image
python tools/visual/compare.py score --a out/rest_full.png \
    --b public/assets/avatars/reference/preview/neutral.jpg \
    --mask public/assets/avatars/reference/masks_a.png --out out/rest_vs_ref.png

# labelled grid
python tools/visual/compare.py grid --out out/sheet.jpg --cols 4 --height 438 out/*.png
```

`score` resizes the reference to the render; with `--mask` the render must show the whole
plate frame (the relief head's default framing, e.g. `/dev/avatar.html?w=784&h=1168`).
It reports SSIM, SSIM on a 2 px blur (less sensitive to the hologram's fine grid), PSNR and
mean absolute RGB error.

## Avatar harness URL parameters (`src/dev/avatar.html`)

| param | meaning |
|---|---|
| `renderer=relief\|procedural\|placeholder` | head (falls back relief → procedural → placeholder) |
| `fixedTime=<s>` | freeze the clock (deterministic frames) |
| `seed`, `quality=low\|medium\|high`, `particles`, `bloom`, `fx` (living effects 0..1.5), `idle` (idle motion), `zoom` | render options |
| `transparent=0\|1`, `bg=black\|checker\|desk\|white\|dark\|bright\|busy` | output mode / backdrop (`dark`, `bright`, `busy`: desktops painted behind the transparent canvas, src/dev/backdrops.js) |
| `sim=1&t=<s>` | a live run (the behaviour layer) on a scripted 60 Hz clock: `window.__seek(t)` steps it |
| `life=<0..2>`, `projector=1` | liveliness of the spontaneous behaviour, the projector light |
| `compare=1&ref=neutral\|blink\|teeth\|open` | show the pack's reference frame next to the render |
| `state=idle\|listening\|thinking\|speaking\|error\|sleep`, `speech=<0..1>` | director inputs |
| `jaw wide round smile browUp blink blinkL blinkR gazeX gazeY yaw pitch roll energy` | AnimState overrides |
| `w`, `h` | canvas size (CSS px); `ui=0` hides the controls; `stats=1` shows fps/draw calls |
| `follow=1` | eyes follow the mouse |
| `press tuck teeth tongue asym` | the speech mouth channels (AnimState `mouthPress` …) |
| `cheek chin nostril` | the face moving with the mouth (AnimState `cheekRaise`, `chinRaise`, `nostrilFlare`) |
| `expr=<0..2>` | expressiveness of the speech motion (settings `avatar.expressiveness`) |
| `vis=<sil\|PP\|FF\|TH\|DD\|kk\|CH\|SS\|RR\|aa\|E\|I\|O\|U>` | one viseme's mouth shape (explicit sliders still win) |
| `say=<text>&t=<s>` | the system-voice lip-sync path run deterministically to `t` seconds (a scripted voice with word boundaries); `bounds=0`, `rate`, `voiceTempo` (1.1), `jitter` (0.15), `latency` (0.06), `caption=1` (shows the word being said) |

| `clip=<url>[,<url>...]&t=<s>` | the local-voice path on REAL voice-server clips (the `/tts` JSON: `text`, `visemes`, `audioB64` or `wav=<url>`), played back to back through the real LipSync, director and head at 60 Hz; `gap` (s between clips, 0.06), `latency` (analyser lead, 0.02), `pre` (s of thinking first, 0.8), `caption=1` |

`window.__avatar` is the avatar API; `window.__ready` turns true after the first frames. In `say`
and `clip` mode `window.__seek(t)` steps the simulation to `t` and renders (`window.__schedule`
lists the clips' start / end times).

## film.mjs — speech videos

```bash
# system voice (scripted word boundaries)
node tools/visual/film.mjs --url "http://127.0.0.1:5173/dev/avatar.html?ui=0&idle=0&caption=1" \
     --say "Hello! I'm Claude. How are you feeling today?" --fps 30 --dur 4 --out out/film
ffmpeg -framerate 30 -i out/film/%04d.png -pix_fmt yuv420p out/film.mp4

# local voice: real Kokoro clips (name.json = the /tts response, name.wav next to it), with sound
node tools/visual/film.mjs --url "http://127.0.0.1:5173/dev/avatar.html?ui=0&caption=1" \
     --clip out/hello.json,out/maybe.json --fps 30 --t0 -0.6 --out out/film --mp4 out/film.mp4
```

Loads the harness once and saves one PNG per `__seek` step (`--t0`, `--w`, `--h`, `--selector`;
`--dur` defaults to the clips' length). `--clip` hands the files to the page itself (nothing is
copied into `public/`); `--mp4` encodes the frames with the clips' audio muxed in at the times the
harness played them (ffmpeg).

## lipsync-align.mjs — lip-sync timing on real speech

```bash
node tools/visual/lipsync-align.mjs out/clips [--latency 0.02]
```

Plays every clip of a folder (`name.wav` + `name.json`) through the real LipSync and Director at
60 Hz in Node and compares the mouth with the sound: the fullest closure of m / b / p between
vowels vs the level dip in the audio, the jaw opening after a pause vs the acoustic onset, and
the lag of the best jaw / level correlation (negative = the mouth leads). Use it after changing
the timeline, the lead or the smoothing.
