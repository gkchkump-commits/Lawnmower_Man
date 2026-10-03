"""Lawnmower Man avatar baker: reference video -> relief avatar pack.

The pipeline (see tools/bake/README.md):

1. ``video``     decode every frame, run MediaPipe Face Landmarker (VIDEO mode),
                 collect per-frame metrics (blendshapes, rigid shift, eye brightness,
                 mouth contents, background clutter, sharpness).
2. ``select``    choose the neutral / blink / teeth / open-mouth frames.
3. ``textures``  plate, silhouette alpha, closed-eye texture, mouth cavity texture, masks.
4. ``mesh``      2.5D relief mesh (constrained triangulation with a lip slit), depth, rig weights.
5. ``pack``      write the pack (pack.json manifest + images + mesh.json) and debug overlays.
"""

__version__ = "1.1.0"
PACK_FORMAT = "lawnmower-avatar-pack"
PACK_VERSION = 1
