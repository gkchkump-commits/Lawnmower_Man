"""Choose the frames the pack is built from (deterministic scoring)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .video import FrameData


@dataclass
class Selection:
    neutral: int
    blink: int
    teeth: int
    open: int
    aura: int                  # busiest particle/wisp background (palette sampling only)
    median: list[int]          # near-neutral frames used for the edge/background median
    face_height: float
    scores: dict


def _norm(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, np.float64)
    lo, hi = np.nanmin(a), np.nanmax(a)
    return np.zeros_like(a) if hi - lo < 1e-9 else (a - lo) / (hi - lo)


def select_frames(frames: list[FrameData], median_radius: int = 6) -> Selection:
    ok = np.array([f.ok for f in frames])
    idx = np.nonzero(ok)[0]
    n = len(frames)

    def bs(name):
        return np.array([f.bs.get(name, 0.0) if f.ok else np.nan for f in frames])

    blink = (bs("eyeBlinkLeft") + bs("eyeBlinkRight")) / 2
    jaw = bs("jawOpen")
    mouth_act = bs("mouthPucker") + bs("mouthFunnel") + 0.5 * (bs("mouthSmileLeft") + bs("mouthSmileRight"))
    face_h = float(np.median([f.lm[152, 1] - f.lm[10, 1] for f in frames if f.ok]))
    lip = np.array([f.lip_gap if f.ok else np.nan for f in frames]) / face_h
    eye = np.array([f.eye_bright for f in frames])
    clutter = np.array([f.clutter for f in frames])
    sharp = np.array([f.sharp for f in frames])
    shift = np.array([f.shift for f in frames])
    teeth = np.array([f.teeth for f in frames])
    tongue = np.array([f.tongue for f in frames])

    eye_n = _norm(eye)
    # ---- neutral: eyes open & bright, mouth closed, calm, clean background, sharp -------------
    candidate = ok & (jaw < 0.06) & (lip < 0.025) & (blink < 0.35)
    if not candidate.any():
        candidate = ok
    score = (1.0 * np.nan_to_num(blink, nan=1) + 1.0 * (1 - eye_n) + 1.5 * _norm(clutter)
             + 0.5 * (1 - _norm(sharp)) + 20.0 * np.nan_to_num(lip, nan=1) + 0.5 * np.nan_to_num(mouth_act, nan=1)
             + 3.0 * np.nan_to_num(jaw, nan=1))
    score = np.where(candidate, score, np.inf)
    neutral = int(np.argmin(score))
    s0 = shift[neutral]
    dist = np.linalg.norm(shift - s0, axis=1)

    # ---- blink: darkest eye boxes (MediaPipe under-reports the hologram's blink) ---------------
    closed = 1.0 - eye / max(eye[neutral], 1e-6)
    bscore = closed - 4.0 * np.nan_to_num(lip, nan=1) - dist / 40.0 + 0.3 * np.nan_to_num(blink, nan=0)
    bscore = np.where(ok, bscore, -np.inf)
    blink_i = int(np.argmax(bscore))

    # ---- teeth: most visible teeth, no tongue, moderately open --------------------------------
    tscore = teeth - 3.0 * tongue - dist / 60.0
    tscore = np.where(ok & (lip > 0.025), tscore, -np.inf)
    teeth_i = int(np.argmax(tscore)) if np.isfinite(tscore).any() else neutral

    # ---- open: widest opening without tongue ---------------------------------------------------
    oscore = np.nan_to_num(lip, nan=0) * (1.0 - np.clip(tongue * 4.0, 0, 1)) - dist / 400.0
    oscore = np.where(ok, oscore, -np.inf)
    open_i = int(np.argmax(oscore))

    aura_i = int(np.argmax(np.where(ok, clutter, -np.inf)))

    # ---- median set: near-neutral frames close in time (background particles move, face does not)
    med = []
    for j in range(max(0, neutral - median_radius), min(n, neutral + median_radius + 1)):
        if ok[j] and candidate[j] and dist[j] < 1.5:
            med.append(j)
    if neutral not in med:
        med.append(neutral)
    med.sort()

    return Selection(
        neutral=neutral, blink=blink_i, teeth=teeth_i, open=open_i, aura=aura_i, median=med, face_height=face_h,
        scores={
            "neutral": {"score": float(score[neutral]), "blink": float(blink[neutral]),
                        "jawOpen": float(jaw[neutral]), "lipGapPx": float(frames[neutral].lip_gap)},
            "blink": {"closedness": float(closed[blink_i])},
            "teeth": {"teeth": float(teeth[teeth_i]), "tongue": float(tongue[teeth_i]),
                      "lipGapPx": float(frames[teeth_i].lip_gap)},
            "open": {"lipGapPx": float(frames[open_i].lip_gap), "tongue": float(tongue[open_i])},
            "headMotionPx": {"x": [float(np.min(shift[idx, 0])), float(np.max(shift[idx, 0]))],
                             "y": [float(np.min(shift[idx, 1])), float(np.max(shift[idx, 1]))],
                             "stdX": float(np.std(shift[idx, 0])), "stdY": float(np.std(shift[idx, 1]))},
            "trackedFrames": int(ok.sum()),
        })
