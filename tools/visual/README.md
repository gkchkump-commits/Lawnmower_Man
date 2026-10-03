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
| `transparent=0\|1`, `bg=black\|checker\|desk\|white` | output mode / backdrop |
| `compare=1&ref=neutral\|blink\|teeth\|open` | show the pack's reference frame next to the render |
| `state=idle\|listening\|thinking\|speaking\|error\|sleep`, `speech=<0..1>` | director inputs |
| `jaw wide round smile browUp blink blinkL blinkR gazeX gazeY yaw pitch roll energy` | AnimState overrides |
| `w`, `h` | canvas size (CSS px); `ui=0` hides the controls; `stats=1` shows fps/draw calls |
| `follow=1` | eyes follow the mouse |

`window.__avatar` is the avatar API; `window.__ready` turns true after the first frames.
