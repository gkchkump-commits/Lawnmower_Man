"""Offline mesh processing for the procedural hologram head (Lawnmower Man).

The pipeline (see build_head.py) turns a head scan into the compact binary model consumed by
src/avatar/heads/procedural/: crop + smooth + subdivide, landmark-driven warp toward the
reference proportions, lip-seam split + mouth cavity, rig weights, shading attributes and the
gold contour curves.

World units match the relief head: the reference plate is 1 unit tall, x right, y up, z toward
the camera; screen positions are what a perspective camera at (0, 0, CAMERA_DIST) sees.
"""

__version__ = "1.1.0"
