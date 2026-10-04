# Avatar baker — reference video → relief avatar pack

`bake_avatar.py` turns a short, frontal "talking hologram head" video (like the user's
`generated_video.mp4`) into the **relief avatar pack** that the `relief` head
(`src/avatar/heads/relief/`) animates in real time: a 2.5D mesh of one reference frame, textured
with that frame's own pixels and rigged from MediaPipe face landmarks.

```bash
python -m pip install -r tools/bake/requirements.txt
python tools/bake/bake_avatar.py --video generated_video.mp4 --out public/assets/avatars/reference \
    [--model face_landmarker.task] [--debug-dir out/bake-debug] [--no-cache] [--grid 17]
```

* `--model` — MediaPipe Face Landmarker model. When omitted it is downloaded once from
  `storage.googleapis.com/mediapipe-models/...` into `tools/bake/.cache/` (git-ignored).
* Tracking all frames takes ~30 s on 4 CPU cores; the per-frame analysis is cached in
  `tools/bake/.cache/analysis_v*_<video hash>.npz`, so re-runs take ~10 s. `--no-cache` re-tracks.
* The output is **deterministic**: a cached and a fresh run produce byte-identical packs.
* `--debug-dir` writes intermediate images (plate, alpha, masks, closed eyes, mouth atlas) and
  `debug_overlay.png` (mesh wireframe + rig weights over the plate).

## Pipeline

1. **Track** every frame with MediaPipe Face Landmarker in VIDEO mode (478 landmarks + 52
   blendshapes; low confidence thresholds keep the lock on the unusual hologram face), and
   measure per frame: rigid upper-face shift (phase correlation), eye brightness inside the
   eye boxes, inner-lip opening, teeth / tongue fractions inside the lips, background clutter
   around the head and sharpness.
2. **Select frames** (scores in `pack.json → selection`):
   * *neutral* — eyes open and bright, mouth closed, low blendshape activity, clean background,
     sharp (frame 15 for the reference video; `docs/reference/neutral.jpg` is frame 24, which has
     the lips slightly parted — the rest pose deliberately uses a closed mouth so it can open).
   * *blink* — darkest eye boxes (MediaPipe under-reports the hologram's blink; frame 126).
   * *teeth* — most visible teeth, no tongue, lips apart (frame 269); *open* — widest opening.
   * *median set* — near-neutral frames around the neutral one (for the edge/background median).
   * *aura* — busiest particle/wisp frame, only used to sample the particle colours.
3. **Plate** — the single neutral frame keeps the face's grid/sparkle detail crisp; near the
   silhouette edge and on the neck an aligned temporal median of the median set removes the
   moving background particles. The source video's bokeh motes baked into the dissolving neck
   (from just above `neckFade[0]`, outside the face oval) are found with a white top-hat (thin
   grid lines excluded) and inpainted, so all motes there are the engine's live particles.
4. **Silhouette alpha** — luminance threshold on the median plate, morphology, largest
   component, hole fill; cranium + ears from the threshold, the jaw from the (dilated) face oval,
   the neck from robust edges fitted below the jaw; smoothed outline, 2 px feather; below the jaw
   the alpha ramps in from the sides and the neck dissolves toward the bottom of the frame.
   Pixels outside are transparent so the engine's animated particles replace the baked ones.
5. **Closed eyes + lid map** — the blink frame registered to the plate per eye (exhaustive NCC
   on high-passed images around the eye, excluding the aperture; bicubic resampling keeps the
   thin closed-lid line sharp). Per eye the visible "almond" is measured in the images, because
   MediaPipe's lids are much tighter than the hologram's glowing eye: the closed-lid line of the
   blink frame (its extent gives the eye's tips), the upper lid margin of the open eye (traced
   as a continuous ridge outward from above the iris) and the lower lid (MediaPipe + 2 px).
   From these curves the baker writes a per-pixel **lid coordinate** w (0 on the open lid
   margins, 1 on the closed-lid line, < 0 outside the eye) and an eye region = almond grown by
   14 px (the glow halo) with a 26 px soft edge. The closed-eye texture holds the full blink
   frame inside that region, brightness-matched to the plate on the soft edge only. The engine
   blinks with a **lid wipe**: the closed frame shows where w < blink (no geometry moves, so no
   texel slides), the open plate elsewhere, with a thin amber margin on the moving edge.
6. **Mouth atlas** (`mouth.webp`, two layers) — from the teeth frame registered on the nose/upper
   lip. The opening (teeth + cavity, without the glowing lip rims) is found per column; the top
   layer holds the cavity with the upper teeth hanging from the closed-mouth slit (upper-jaw
   space), the bottom layer the lower teeth shifted into jaw space (they ride on a strip that
   moves with the lower lip).
7. **Masks** (8-bit RGB PNGs, no alpha so browsers cannot premultiply them):
   * `masks_a.png`: R silhouette alpha, G gold contour lines (warm white top-hat), B sparkle/grid nodes.
   * `masks_b.png`: R eye apertures, G eye regions (blink), B mouth region.
   * `masks_c.png` (baker >= 1.1, optional for the engine): R lid coordinate (0.5 + 0.5 w),
     G upper lid (above the closed line), B desktop **occlusion** — 1 on the face and cranium
     where they visibly glow (blurred brightness gate), 0 on the ears, the gap next to them,
     the outer ~6 px of the silhouette and the dissolving neck, so on a light desktop those
     add light instead of painting grey. Packs without it keep the old cross-fade blink.
8. **Relief mesh** (`mesh.json`, plate pixels: x right, y down, z toward the camera):
   * points = the 478 landmarks (inner lips snapped onto the detected dark line between the
     closed lips, ±1.1 px, plus 2 extra points per lip segment) + smoothed outline samples +
     a triangular lattice (17 px) inside;
   * constrained Delaunay (Triangle) with the outline, the eyelid curves and the inner-lip loop
     as segments; the inner-lip loop is a **hole**, so the lips form a slit that can open;
   * depth = circular inflation of the silhouette (head shape) + MediaPipe facial *detail*
     (landmark z minus a fitted quadratic trend, so nose / eye sockets / lips survive without a
     ridge where the two fields meet), harmonically smoothed across the transition;
   * per-vertex rig weights (0..1, quantised to 0..255):

     | weight | region | used for |
     |---|---|---|
     | `jaw` | lower lip (lens profile: 0 at the corners, 1 at the centre), chin, lower face; fades into the neck | `jawOpen` (drop + slight recede) |
     | `lowerLip`, `upperLip` | the lips (same lens profile) | wide / smile / round lip motion |
     | `cornerL`, `cornerR` | radial falloff around the outer mouth corners | wide, round, smile |
     | `lidUpperL/R`, `lidLowerL/R` | fraction of each vertex's travel to the closed-lid line (inside the aperture: collapse onto it; lid skin: decaying) | smile squint; `blinkL/R` only for packs without `masks_c` (lid wipe otherwise) |
     | `browL`, `browR` | brows, falling off down to the lid and up the forehead | `browUp` |

     plus `edge` (distance to the silhouette edge, px) and `face` (inside the face oval);
   * a cavity mesh: back quad (upper jaw) + lower-teeth strip whose weights copy the lower lip.
9. **Manifest** `pack.json` — format/version, source video hash, plate size, files, mask channel
   meanings, framing (silhouette box, chin, neck, head ellipse), mouth rect, rig geometry (eye
   centres / iris radii / heights, mouth centre and corners, jaw and head pivots, slit line),
   per-eye lid curves (`rig.eyes.*.lids`, 17 samples, informational), key landmarks, outline polygons (`outline` = mesh coverage, `visibleOutline` = visibly lit
   head, used for the particle aura and `hitTest`) and the sampled palette (`eye`, `line`, `rim`,
   `grid`, plus full-brightness `*Glow` variants, `wisp` and `mote` from the aura frame).
   `preview/*.jpg` are the selected source frames (used by `/dev/avatar.html?compare=1`).

The pack for the user's reference video is ~1.7 MB (target < 6 MB).

Tests for the lid map / eye region / occlusion helpers: `python3 -m pytest tools/bake/tests -q`.

## Using a different video

Any similar footage works if the face is frontal, fairly static, on a dark background, with
at least one blink, one clearly open mouth showing teeth and a calm closed-mouth stretch.
Bake into `public/assets/avatars/<name>/` and select it with the `avatar.pack` setting
(`packUrl: './assets/avatars/<name>/'`). Check the result with `tools/visual/snap.mjs` and
`tools/visual/compare.py` (see `tools/visual/` and the harness at `/dev/avatar.html`).

## Licensing

The pack is derived from the user's own video. MediaPipe (Apache-2.0) is used offline only;
no model weights are shipped in the pack.
