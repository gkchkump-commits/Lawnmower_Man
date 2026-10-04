"""Shared fixtures for the voice server tests. No test downloads models or needs a GPU."""

from __future__ import annotations

import io
import socket
import struct
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lawnmower_voice.config import VoiceConfig  # noqa: E402

TOKEN = "test-token-123"


@pytest.fixture
def config(tmp_path) -> VoiceConfig:
    return VoiceConfig(token=TOKEN, models_dir=tmp_path / "models", allow_download=False, fake=True)


def make_client(app):
    from fastapi.testclient import TestClient

    return TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture
def auth() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


def sine(freq: float, sr: int, seconds: float, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(sr * seconds), dtype=np.float64) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def wav_bytes(samples: np.ndarray, sr: int, sampwidth: int = 2) -> bytes:
    """PCM WAV via the stdlib (samples: (n,) or (n, channels) float in [-1, 1])."""
    x = np.asarray(samples, dtype=np.float64)
    channels = 1 if x.ndim == 1 else x.shape[1]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(sr)
        if sampwidth == 1:
            data = np.clip(np.round(x * 127 + 128), 0, 255).astype(np.uint8).tobytes()
        elif sampwidth == 2:
            data = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2").tobytes()
        elif sampwidth == 3:
            v = np.clip(np.round(x * 8388607), -8388608, 8388607).astype(np.int32).reshape(-1)
            b = v.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]
            data = b.tobytes()
        elif sampwidth == 4:
            data = np.clip(np.round(x * 2147483647), -2147483648, 2147483647).astype("<i4").tobytes()
        else:
            raise ValueError(sampwidth)
        w.writeframes(data)
    return buf.getvalue()


def float_wav_bytes(samples: np.ndarray, sr: int, extensible: bool = False, bits: int = 32) -> bytes:
    """IEEE-float WAV (optionally WAVE_FORMAT_EXTENSIBLE)."""
    x = np.asarray(samples)
    channels = 1 if x.ndim == 1 else x.shape[1]
    dtype = "<f4" if bits == 32 else "<f8"
    data = x.astype(dtype).tobytes()
    width = bits // 8
    if extensible:
        guid = struct.pack("<H", 3) + b"\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"
        fmt = struct.pack("<HHIIHHHHI", 0xFFFE, channels, sr, sr * width * channels, width * channels, bits, 22, bits, 0) + guid
    else:
        fmt = struct.pack("<HHIIHH", 3, channels, sr, sr * width * channels, width * channels, bits)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def dominant_freq(x: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return float(np.fft.rfftfreq(len(x), 1.0 / sr)[int(np.argmax(spec))])
