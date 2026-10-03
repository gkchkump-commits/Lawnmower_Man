"""Video decoding, MediaPipe face tracking and per-frame metrics."""

from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import landmarks as LM
from .util import log, luminance, to_float

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")
DEFAULT_CACHE = Path(__file__).resolve().parent.parent / ".cache"


def ensure_model(model: str | None, cache_dir: Path = DEFAULT_CACHE) -> Path:
    """Return a path to face_landmarker.task, downloading (and caching) it when not given."""
    if model:
        p = Path(model)
        if not p.is_file():
            raise FileNotFoundError(f"--model {model} does not exist")
        return p
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / "face_landmarker.task"
    if target.is_file() and target.stat().st_size > 1_000_000:
        return target
    log(f"downloading face landmarker model -> {target}")
    fd, tmp = tempfile.mkstemp(dir=str(cache_dir), suffix=".part")
    os.close(fd)
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        if os.path.getsize(tmp) < 1_000_000:
            raise RuntimeError("downloaded model is unexpectedly small")
        os.replace(tmp, target)
    except Exception as e:  # pragma: no cover - network dependent
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(
            f"could not download the MediaPipe model ({e}). Download it manually from\n  {MODEL_URL}\n"
            f"and pass --model <path>.") from e
    return target


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: float
    frames: int


def probe(path: str) -> VideoInfo:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video {path}")
    info = VideoInfo(path=path, width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                     height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                     fps=float(cap.get(cv2.CAP_PROP_FPS) or 24.0),
                     frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    cap.release()
    return info


def iter_frames(path: str):
    """Yield (index, BGR uint8 frame) sequentially (seeking in H.264 is not frame-exact)."""
    cap = cv2.VideoCapture(path)
    i = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            yield i, frame
            i += 1
    finally:
        cap.release()


def read_frames(path: str, wanted) -> dict[int, np.ndarray]:
    wanted = set(int(w) for w in wanted)
    out: dict[int, np.ndarray] = {}
    if not wanted:
        return out
    last = max(wanted)
    for i, f in iter_frames(path):
        if i in wanted:
            out[i] = f
        if i >= last:
            break
    missing = wanted - set(out)
    if missing:
        raise RuntimeError(f"could not decode frames {sorted(missing)}")
    return out


@dataclass
class FrameData:
    index: int
    ok: bool
    lm: np.ndarray | None = None          # (478, 3) pixels; z in pixels, negative = toward camera
    bs: dict = field(default_factory=dict)
    shift: tuple = (0.0, 0.0)            # rigid upper-face translation relative to frame 0 (px)
    eye_bright: float = 0.0              # fraction of very bright pixels in the eye boxes
    lip_gap: float = 0.0                 # inner-lip opening at the centre (px)
    teeth: float = 0.0                   # bright low-saturation fraction inside the inner lips
    tongue: float = 0.0                  # reddish fraction inside the inner lips
    clutter: float = 0.0                 # mean luminance of the background ring around the head
    sharp: float = 0.0                   # Laplacian variance in the face box


def _make_landmarker(model_path: Path):
    import mediapipe as mp  # imported lazily so --help works without mediapipe
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision

    opts = vision.FaceLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=str(model_path),
                                     delegate=mpt.BaseOptions.Delegate.CPU),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=False,
        # The hologram face is unusual; low thresholds + VIDEO tracking keep the lock on every frame.
        min_face_detection_confidence=0.1,
        min_face_presence_confidence=0.1,
        min_tracking_confidence=0.1,
    )
    return mp, vision.FaceLandmarker.create_from_options(opts)


def _inner_lip_polygon(lm: np.ndarray) -> np.ndarray:
    return np.concatenate([lm[LM.LIPS_INNER_UPPER, :2], lm[LM.LIPS_INNER_LOWER[::-1], :2]])


def analyze(info: VideoInfo, model_path: Path) -> list[FrameData]:
    """Track the face on every frame and compute the metrics used for frame selection."""
    mp, landmarker = _make_landmarker(model_path)
    W, H = info.width, info.height
    frames: list[FrameData] = []
    ref_crop = None
    crop_box = None
    eye_boxes = None
    ring = None
    face_box = None
    win = None
    try:
        for i, bgr in iter_frames(info.path):
            rgb_u8 = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            res = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb_u8)),
                int(round(i * 1000.0 / info.fps)))
            fd = FrameData(index=i, ok=bool(res.face_landmarks))
            rgb = rgb_u8.astype(np.float32) / 255.0
            gray = luminance(rgb)
            if fd.ok:
                pts = np.array([[p.x * W, p.y * H, p.z * W] for p in res.face_landmarks[0]], np.float32)
                fd.lm = pts
                fd.bs = {b.category_name: float(b.score) for b in res.face_blendshapes[0]}
            if crop_box is None and fd.ok:
                # Geometry for the metrics is defined once, from the first tracked frame.
                lm0 = fd.lm
                up = lm0[LM.UPPER_RIGID, :2]
                x0, y0 = np.floor(up.min(0) - [10, 30]).astype(int)
                x1, y1 = np.ceil(up.max(0) + [10, 10]).astype(int)
                crop_box = (max(0, x0), max(0, y0), min(W, x1), min(H, y1))
                eye_boxes = []
                for upper, lower in ((LM.EYE_L_UPPER, LM.EYE_L_LOWER), (LM.EYE_R_UPPER, LM.EYE_R_LOWER)):
                    e = lm0[upper + lower, :2]
                    ex0, ey0 = np.floor(e.min(0) - [4, 10]).astype(int)
                    ex1, ey1 = np.ceil(e.max(0) + [4, 10]).astype(int)
                    eye_boxes.append((ex0, ey0, ex1, ey1))
                oval = lm0[LM.FACE_OVAL, :2]
                c = oval.mean(0)
                fx0, fy0 = np.floor(oval.min(0)).astype(int)
                fx1, fy1 = np.ceil(oval.max(0)).astype(int)
                face_box = (fx0, fy0, fx1, fy1)
                rx = (oval[:, 0].max() - oval[:, 0].min()) / 2
                ry = (oval[:, 1].max() - oval[:, 1].min()) / 2
                yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
                # Ellipse radius scaled up to include cranium + ears; ring = background just outside.
                r = np.sqrt(((xx - c[0]) / (rx * 1.25)) ** 2 + ((yy - (c[1] - ry * 0.25)) / (ry * 1.35)) ** 2)
                ring = (r > 1.08) & (r < 1.45) & (yy < c[1] + ry)
                cx0, cy0, cx1, cy1 = crop_box
                win = cv2.createHanningWindow((cx1 - cx0, cy1 - cy0), cv2.CV_32F)
                ref_crop = gray[cy0:cy1, cx0:cx1].copy()
            if crop_box is not None:
                cx0, cy0, cx1, cy1 = crop_box
                (dx, dy), _ = cv2.phaseCorrelate(ref_crop, gray[cy0:cy1, cx0:cx1], win)
                fd.shift = (float(dx), float(dy))
                sdx, sdy = int(round(dx)), int(round(dy))
                vmax = rgb.max(axis=2)
                tot = 0.0
                for (ex0, ey0, ex1, ey1) in eye_boxes:
                    patch = vmax[ey0 + sdy:ey1 + sdy, ex0 + sdx:ex1 + sdx]
                    tot += float((patch > 0.88).mean()) if patch.size else 0.0
                fd.eye_bright = tot / 2.0
                fd.clutter = float(gray[ring].mean())
                fx0, fy0, fx1, fy1 = face_box
                fd.sharp = float(cv2.Laplacian(gray[fy0:fy1, fx0:fx1], cv2.CV_32F).var())
            if fd.ok:
                lm = fd.lm
                fd.lip_gap = float(lm[14, 1] - lm[13, 1])
                poly = _inner_lip_polygon(lm)
                m = np.zeros((H, W), np.uint8)
                cv2.fillPoly(m, [np.round(poly).astype(np.int32)], 1)
                inside = m.astype(bool)
                if inside.sum() > 20:
                    hsv = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2HSV).astype(np.float32)
                    v = hsv[..., 2][inside] / 255.0
                    s = hsv[..., 1][inside] / 255.0
                    r_, g_ = rgb[..., 0][inside], rgb[..., 1][inside]
                    fd.teeth = float(((v > 0.55) & (s < 0.28)).mean())
                    fd.tongue = float(((r_ > g_ * 1.22 + 0.03) & (v > 0.22)).mean())
            frames.append(fd)
            if i % 60 == 0:
                log(f"  tracked frame {i}/{info.frames}")
    finally:
        landmarker.close()
    if not any(f.ok for f in frames):
        raise RuntimeError("MediaPipe did not find a face in any frame")
    return frames
