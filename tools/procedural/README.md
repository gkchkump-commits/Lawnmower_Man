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

1. **geometry.py** — load + weld the scan, MediaPipe on a flat-shaded front render, lift the
   landmarks onto the surface (ray casts), similarity-align to the reference frame *through the
   app's perspective camera* (fov 12°, view 1 unit tall at z = 0 — the relief head's framing),
   crop the shoulders, Taubin-smooth (strong on cranium/neck, gentle on the face), one Loop
   subdivision, Gaussian-RBF warp of features and outline toward the reference
   (`warp.py`, with a fold-over guard), tuck the ears.
2. **mouth.py** — find the lip seam (shortest path following the zero crossing of the normal's
   y component — where the surface stops facing down and starts facing up — with a penalty on
   row hopping, then shortcut + smoothing), split the mesh along it, build the double-sided
   mouth-cavity pouch welded to both lip edges.
3. **shading.py** — ambient occlusion (64 cosine rays/vertex), multi-scale feature convexity
   (Laplacian offset, high-passed), outer-shell normals (heavily smoothed head) for the edge
   glow, lips and ear masks. Computed on the *welded* surface and copied to the seam copies.
4. **rig.py** — 8 weight channels (jaw hinge, upper/lower lip, mouth corners, brows, cheeks)
   plus an inner-mouth mask; jaw weights combine a geometric split curve with the topological
   side of the seam.
5. **eyes.py** — per eye: aperture frame on the lid surface, lid curves fitted to the reference
   eye contour, analytic eyeball (the scan's lids are closed; the shader draws open eyes).
6. **curves.py** — gold contour lines: authored in reference-plate px (forehead flow lines,
   glabella, temples, nostrils, nasolabial folds, chin) or from the scan's own features (eye
   rings, lip contours, seam), projected onto the surface and chunked for two-level culling;
   per-vertex distance to the nearest curve lets the shader skip far fragments.
7. **outline.py** / **pack.py** — rest silhouette (hit test + particle aura), quantised binary.

Format details: `public/assets/models/README.md`.
