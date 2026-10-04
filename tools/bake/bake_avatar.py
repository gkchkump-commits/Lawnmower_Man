#!/usr/bin/env python3
"""Bake a Lawnmower Man "relief" avatar pack from a reference video.

    python tools/bake/bake_avatar.py --video generated_video.mp4 --out public/assets/avatars/reference
        [--model face_landmarker.task] [--debug-dir <dir>] [--no-cache]

See tools/bake/README.md for what the pack contains and how each part is derived.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lawnmower_bake import __version__  # noqa: E402
from lawnmower_bake.util import log  # noqa: E402


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--video", required=True, help="reference video (mp4)")
    p.add_argument("--out", required=True, help="output pack directory, e.g. public/assets/avatars/reference")
    p.add_argument("--model", default=None,
                   help="MediaPipe face_landmarker.task (downloaded + cached in tools/bake/.cache when omitted)")
    p.add_argument("--debug-dir", default=None, help="write debug overlays / intermediate images here")
    p.add_argument("--no-cache", action="store_true", help="re-run face tracking even if a cached analysis exists")
    p.add_argument("--grid", type=float, default=17.0, help="interior mesh sample spacing in plate pixels")
    p.add_argument("--name", default=None, help="pack name (defaults to the output folder name)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    t0 = time.time()
    from lawnmower_bake.pipeline import run  # heavy imports (cv2, mediapipe) after arg parsing
    run(video=args.video, out_dir=args.out, model=args.model, debug_dir=args.debug_dir,
        use_cache=not args.no_cache, grid=args.grid, name=args.name)
    log(f"done in {time.time() - t0:.1f}s (baker {__version__})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
