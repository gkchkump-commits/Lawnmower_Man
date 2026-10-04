# Procedural head build (`tools/procedural/`)

Turns a head scan into the compact model used by the **procedural** hologram renderer
(`src/avatar/heads/procedural/`): `public/assets/models/head.json` + `head.bin` (~1.3 MB).
The committed model is the output of this tool; you only need to run it after changing the
pipeline or its inputs.

```bash
pip install -r tools/procedural/requirements.txt
python tools/procedural/build_head.py                      # uses the committed landmark cache
python tools/procedural/build_head.py --debug out/procdbg  # + diagnostic renders
python -m pytest tools/procedural/tests -q                 # pipeline unit tests
```

The MediaPipe landmarks of the scan render and of the reference frame are cached in
`data/landmarks.json`, so MediaPipe is **not** needed for a normal rebuild. If the cache is
missing, pass the model: `--landmarker face_landmarker.task`
(<https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task>).
`trimesh` ray casting is much faster with `embreex` installed (optional; `rtree` also works).

## Inputs

| file | what |
|---|---|
| `source/LeePerrySmith.glb` | Lee Perry-Smith head scan, Infinite-Realities, **CC BY 3.0** (from the three.js examples) |
| `docs/reference/neutral.jpg` | reference frame of the user's video — only its *geometry* is measured (landmarks + outline) |
| `data/landmarks.json` | cached MediaPipe Face Landmarker results (478 points per image) |

## Pipeline (`headbuild/`)

1. **reference.py** — measures the reference frame: silhouette widths, crown and chin, the jaw
   edge of the lower face (bright face edge per row), and the glowing eyes. MediaPipe misplaces
   the hologram's eyes (~20-30 px too low on neutral.jpg), so the pupils are found in the image
   (`correct_eyes`) and the eye openings are measured directly (`measure_almond`: the glow above
   a threshold, holes filled, per-column lid boundaries).
2. **geometry.py** — load + weld the scan, MediaPipe on a flat-shaded front render, lift the
   landmarks onto the surface (ray casts), similarity-align to the reference frame *through the
   app's perspective camera* (fov 12°, view 1 unit tall at z = 0 — the relief head's framing),
   crop the shoulders, Taubin-smooth (strong on cranium/neck, gentle on the face), one Loop
   subdivision, Gaussian-RBF warp of features and outline toward the reference
   (`warp.py`, with a fold-over guard; the silhouette targets sit `SIL_INSET` inside the
   reference outline because the renderer's rim + halo glow reaches beyond the surface), a
   **jaw taper** toward the reference's narrower V-shaped lower face, **feature softening**
   (smoother brow ridge, thinner lower lip — away from the scan's male likeness), tuck the ears.
3. **mouth.py** — find the lip seam (shortest path following the zero crossing of the normal's
   y component — where the surface stops facing down and starts facing up — with a penalty on
   row hopping, then shortcut + smoothing), split the mesh along it, build the double-sided
   mouth-cavity pouch welded to both lip edges.
4. **shading.py** — ambient occlusion (64 cosine rays/vertex), multi-scale feature convexity
   (Laplacian offset, high-passed), outer-shell normals (heavily smoothed head) for the edge
   glow, lips and ear masks (ellipsoid + "beyond the side of the face" in the front view), and
   the **neck mask** (below the 3D jaw contour at the same azimuth: the under-jaw and neck are
   dark in the reference). Computed on the *welded* surface and copied to the seam copies.
5. **rig.py** — 8 weight channels (jaw hinge, upper/lower lip, mouth corners, brows, cheeks)
   plus an inner-mouth mask; jaw weights combine a geometric split curve with the topological
   side of the seam and are scaled by `(1 - (x/hw)^2)^0.5` so the mouth opens as a **lens**
   (tight at the corners). Also the lip-seam closeness/side attributes (the shader's mouth
   line) and a polynomial fit of the seam (where the shader hangs the upper teeth).
6. **eyes.py** — per eye: aperture frame on the lid surface, lid curves fitted to the measured
   eye opening (MediaPipe contours as a fallback), analytic eyeball centred under the measured
   pupil, iris / pupil radii (the scan's lids are closed; the shader draws open eyes).
7. **curves.py** — gold contour lines: authored in reference-plate px (forehead flow lines with
   vein branches, glabella, temples, nostril and alar rims, open nasolabial arcs fading out
   beside the chin, chin line), **elliptical orbit loops** (open toward the nose, brightest
   along the cheekbone) and from the scan's own features (lip contours, seam), with per-point
   intensity profiles, projected onto the surface and chunked for two-level culling;
   per-vertex distance to the nearest curve lets the shader skip far fragments.
8. **outline.py** / **pack.py** — rest silhouette (hit test + particle aura), quantised binary.

The build is deterministic: two runs give byte-identical `head.json` / `head.bin`.

Format details: `public/assets/models/README.md`.
