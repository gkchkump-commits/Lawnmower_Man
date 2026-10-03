"""Bake pipeline orchestration."""

from __future__ import annotations

from pathlib import Path

from . import video as V
from .select import select_frames
from .util import ensure_dir, log, sha256_file

ANALYSIS_VERSION = 2  # bump when the per-frame metrics change


def analysis_for(video: str, model: str | None, use_cache: bool):
    info = V.probe(video)
    model_path = V.ensure_model(model)
    vid_hash = sha256_file(video)
    cache = V.DEFAULT_CACHE / f"analysis_v{ANALYSIS_VERSION}_{vid_hash[:16]}.npz"
    frames = V.load_analysis(cache) if use_cache else None
    if frames is None or len(frames) != info.frames:
        log(f"tracking {info.frames} frames ({info.width}x{info.height} @ {info.fps:g} fps)")
        frames = V.analyze(info, model_path)
        V.save_analysis(cache, frames)
    else:
        log(f"using cached analysis {cache.name}")
    return info, frames, vid_hash


def run(video: str, out_dir: str, model: str | None = None, debug_dir: str | None = None,
        use_cache: bool = True, grid: float = 17.0, name: str | None = None) -> None:
    from . import mesh as MESH
    from . import pack as PACK
    from . import textures as TEX

    out = ensure_dir(out_dir)
    dbg = ensure_dir(debug_dir) if debug_dir else None
    info, frames, vid_hash = analysis_for(video, model, use_cache)
    sel = select_frames(frames)
    log(f"selected neutral={sel.neutral} blink={sel.blink} teeth={sel.teeth} open={sel.open} "
        f"aura={sel.aura} median={sel.median}")

    wanted = set(sel.median) | {sel.neutral, sel.blink, sel.teeth, sel.open, sel.aura}
    imgs = V.read_frames(video, wanted)
    tex = TEX.build_textures(info, frames, sel, imgs, dbg)
    mesh = MESH.build_mesh(info, frames[sel.neutral].lm, tex, grid=grid, debug_dir=dbg)
    PACK.write_pack(out, info=info, frames=frames, sel=sel, imgs=imgs, tex=tex, mesh=mesh,
                    video_hash=vid_hash, name=name or Path(out).name, debug_dir=dbg)
