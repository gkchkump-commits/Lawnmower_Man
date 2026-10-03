"""Runtime configuration for the voice server and its engines."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

#: Origins allowed by CORS (contract section 6) - the Vite dev server, `vite preview`,
#: the packaged app's custom protocol and opaque ("null") origins.
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "app://lawnmower",
    "null",
)

#: Whisper models that are too slow for interactive use on a CPU. When the STT engine
#: ends up on the CPU (explicitly or after a CUDA failure) these are swapped for
#: ``stt_cpu_model`` (settings comment in contract section 4: "CPU fallback uses 'base.en'").
LARGE_STT_MODELS = frozenset(
    {
        "large",
        "large-v1",
        "large-v2",
        "large-v3",
        "large-v3-turbo",
        "turbo",
        "distil-large-v2",
        "distil-large-v3",
        "distil-large-v3.5",
        "medium",
        "medium.en",
    }
)

DEFAULT_STT_MODEL = "large-v3-turbo"
DEFAULT_STT_CPU_MODEL = "base.en"
DEFAULT_TTS_VOICE = "af_heart"
DEFAULT_KOKORO_MODEL = "kokoro-v1.0.onnx"
DEFAULT_KOKORO_VOICES = "voices-v1.0.bin"

ENV_TOKEN = "LAWNMOWER_VOICE_TOKEN"
ENV_MODELS = "LAWNMOWER_VOICE_MODELS"


def package_root() -> Path:
    """The ``voice/`` directory that contains the ``lawnmower_voice`` package."""
    return Path(__file__).resolve().parent.parent


def _writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-test"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except OSError:
        return False


def user_cache_dir() -> Path:
    """Per-user cache directory used when ``voice/models`` is not writable."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "LawnmowerMan" / "voice" / "models"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "LawnmowerMan" / "voice" / "models"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "lawnmower-man" / "voice" / "models"


def default_models_dir() -> Path:
    """Resolve the model cache directory.

    Order: ``$LAWNMOWER_VOICE_MODELS`` > ``voice/models`` (next to the venv, created by the
    setup scripts) when writable > a per-user cache directory.
    """
    env = os.environ.get(ENV_MODELS, "").strip()
    if env:
        return Path(env).expanduser()
    local = package_root() / "models"
    if local.is_dir() or _writable_dir(local):
        return local
    return user_cache_dir()


def cpu_model_for(model: str, cpu_model: str, language: str | None) -> str:
    """Pick the Whisper model to use on a CPU.

    ``cpu_model == "same"`` keeps ``model``. An English-only ``*.en`` CPU model is swapped for
    its multilingual sibling when the configured language is not English.
    """
    if not cpu_model or cpu_model == "same" or model not in LARGE_STT_MODELS:
        return model
    lang = (language or "").lower()
    if cpu_model.endswith(".en") and lang not in ("en", ""):
        return cpu_model[: -len(".en")]
    return cpu_model


@dataclass
class VoiceConfig:
    """All knobs of the server. Mirrors the CLI flags of ``python -m lawnmower_voice``."""

    host: str = "127.0.0.1"
    port: int = 0
    token: str = ""
    device: str = "auto"  # auto | cuda | cpu
    models_dir: Path = field(default_factory=default_models_dir)
    allow_download: bool = True
    preload: bool = False
    fake: bool = False

    # Speech to text (faster-whisper)
    stt_model: str = DEFAULT_STT_MODEL
    stt_compute_type: str = "auto"  # auto | float16 | int8_float16 | int8 | float32 ...
    stt_cpu_model: str = DEFAULT_STT_CPU_MODEL  # 'same' keeps stt_model on CPU
    stt_language: str = "en"  # '' or 'auto' = detect
    stt_beam_size: int = 0  # 0 = auto (5 on GPU, 1 on CPU)
    stt_cpu_threads: int = 0  # 0 = auto
    stt_initial_prompt: str = ""
    stt_hotwords: str = ""

    # Text to speech (Kokoro)
    tts_backend: str = "auto"  # auto | onnx | torch
    tts_voice: str = DEFAULT_TTS_VOICE
    tts_model: str = DEFAULT_KOKORO_MODEL  # kokoro-v1.0.onnx | kokoro-v1.0.fp16.onnx | kokoro-v1.0.int8.onnx | path
    tts_voices_file: str = DEFAULT_KOKORO_VOICES
    tts_gpu_mem_limit_mb: int = 2048  # cap for onnxruntime's CUDA arena (8 GB budget)
    tts_g2p: str = "auto"  # auto (misaki if installed, for English) | espeak | misaki

    # HTTP limits
    max_upload_mb: float = 64.0
    max_audio_sec: float = 180.0
    max_tts_chars: int = 4000
    max_queue: int = 8  # waiting requests per engine before 503
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS

    log_level: str = "info"

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    def whisper_dir(self) -> Path:
        return Path(self.models_dir) / "whisper"

    def kokoro_dir(self) -> Path:
        return Path(self.models_dir) / "kokoro"

    def kokoro_model_path(self) -> Path:
        p = Path(self.tts_model).expanduser()
        return p if p.is_absolute() or p.parent != Path(".") else self.kokoro_dir() / self.tts_model

    def kokoro_voices_path(self) -> Path:
        p = Path(self.tts_voices_file).expanduser()
        return p if p.is_absolute() or p.parent != Path(".") else self.kokoro_dir() / self.tts_voices_file
