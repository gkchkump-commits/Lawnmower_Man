"""Deterministic stand-in engines for ``--fake`` (tests and other lanes' end-to-end runs).

* :class:`FakeSTT` returns a fixed sentence for any non-silent audio (``""`` for silence).
  Override the text with ``LAWNMOWER_VOICE_FAKE_TEXT``, or script successive answers with
  ``LAWNMOWER_VOICE_FAKE_TEXTS=<path to a JSON array of strings>``: each call that hears sound
  takes the next entry and the last one repeats (it wins over ``LAWNMOWER_VOICE_FAKE_TEXT``).
  Rewriting the file starts over from its first entry, so one server can serve several test
  scenarios. The "Hey Jade" end-to-end test answers the wake segment and then the command this
  way (docs/WAKE.md). ``LAWNMOWER_VOICE_FAKE_STT_LOG=<path>`` appends one JSON line per such call
  (``{"n", "durationSec", "text"}``), so a test can count the calls and see what was sent.
* :class:`FakeTTS` synthesises a short vowel/consonant buzz from the text with a matching,
  exact viseme timeline (so lip-sync can be exercised without models).

``LAWNMOWER_VOICE_FAKE_DELAY_MS`` adds latency to every call (to exercise loading states).
"""

from __future__ import annotations

import json
import os
import threading
import time
import zlib

import numpy as np

from .audio import WHISPER_RATE
from .config import VoiceConfig
from .engines import Engine, EngineInputError, EngineUnavailable, TTSResult
from .tts import SAMPLE_RATE, clean_text, voice_info
from .visemes import normalize_timeline, text_to_pseudo_phonemes, tokenize

DEFAULT_FAKE_TEXT = "Hello Claude, this is a test of the fake voice server."
FAKE_VOICES = ("af_heart", "af_bella", "am_michael", "bf_emma", "bm_george")

# Two formants per vowel viseme (Hz), rough averages for an adult voice.
_FORMANTS = {"aa": (750, 1250), "E": (550, 1800), "I": (320, 2300), "O": (500, 900), "U": (330, 800), "RR": (450, 1300)}


def _delay() -> None:
    try:
        ms = float(os.environ.get("LAWNMOWER_VOICE_FAKE_DELAY_MS", "0") or 0)
    except ValueError:
        ms = 0.0
    if ms > 0:
        time.sleep(ms / 1000.0)


class FakeTextQueue:
    """The answers of successive ``/stt`` calls, read from a JSON array of strings in a file.

    :meth:`next` returns the next entry; past the end the last entry repeats. The file is read on
    every call (it is tiny): when its content changes, the queue starts again from its first entry.
    A missing or malformed file raises :class:`EngineUnavailable` (HTTP 503 with the reason), so a
    misconfigured test fails loudly instead of hearing the default sentence.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._raw: bytes | None = None
        self._items: list[str] = []
        self._pos = 0
        self._lock = threading.Lock()

    def _load(self) -> None:
        try:
            with open(self.path, "rb") as f:
                raw = f.read(1 << 20)
        except OSError as exc:
            raise EngineUnavailable(f"LAWNMOWER_VOICE_FAKE_TEXTS: cannot read {self.path}: {exc.strerror or exc}") from None
        if raw == self._raw:
            return
        try:
            items = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EngineUnavailable(f"LAWNMOWER_VOICE_FAKE_TEXTS: {self.path} is not JSON: {exc}") from None
        if not isinstance(items, list) or not items or not all(isinstance(t, str) for t in items):
            raise EngineUnavailable(f"LAWNMOWER_VOICE_FAKE_TEXTS: {self.path} must hold a non-empty JSON array of strings")
        self._raw, self._items, self._pos = raw, items, 0

    def next(self) -> str:
        with self._lock:
            self._load()
            text = self._items[min(self._pos, len(self._items) - 1)]
            self._pos += 1
            return text


class FakeSTT(Engine):
    kind = "stt"
    backend = "fake"

    def __init__(self, config: VoiceConfig) -> None:
        super().__init__()
        self.config = config
        self._queue: FakeTextQueue | None = None
        self.calls = 0  # calls that heard sound (the ones that take a queue entry)

    def _load(self) -> None:
        _delay()

    def _text(self) -> str:
        path = os.environ.get("LAWNMOWER_VOICE_FAKE_TEXTS", "")
        if path:
            if self._queue is None or self._queue.path != path:
                self._queue = FakeTextQueue(path)
            return self._queue.next()
        return os.environ.get("LAWNMOWER_VOICE_FAKE_TEXT", DEFAULT_FAKE_TEXT)

    def transcribe(self, audio: np.ndarray, language: str | None = None) -> dict:
        with self._lock:
            self.ensure_loaded()
            _delay()
            lang = (language or self.config.stt_language or "en").split("-")[0] or "en"
            level = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if len(audio) else 0.0
            if level < 1e-4:
                return {"text": "", "language": lang}
            text = self._text()
            self.calls += 1
            _log_call(self.calls, len(audio) / float(WHISPER_RATE), text)
            return {"text": text, "language": lang}

    def status(self) -> dict:
        st = super().status()
        st.update({"model": self.config.stt_model, "device": "cpu", "computeType": "none"})
        return st


def _log_call(n: int, duration_sec: float, text: str) -> None:
    """``LAWNMOWER_VOICE_FAKE_STT_LOG``: one JSON line per transcription that heard sound."""
    path = os.environ.get("LAWNMOWER_VOICE_FAKE_STT_LOG", "")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"n": n, "durationSec": round(duration_sec, 3), "text": text}) + "\n")
    except OSError:
        pass  # a test helper only: never fail the request over it


def _resonate(src: np.ndarray, freq: float, bw: float, sr: int) -> np.ndarray:
    """Two-pole resonator (Klatt-style) applied to ``src``."""
    r = np.exp(-np.pi * bw / sr)
    a1 = 2 * r * np.cos(2 * np.pi * freq / sr)
    a2 = -r * r
    g = 1 - a1 - a2
    try:
        from scipy.signal import lfilter  # noqa: PLC0415

        return lfilter([g], [1.0, -a1, -a2], src)
    except ImportError:
        y = np.zeros_like(src)
        y1 = y2 = 0.0
        for i in range(len(src)):  # short segments only
            y0 = g * src[i] + a1 * y1 + a2 * y2
            y[i] = y0
            y2, y1 = y1, y0
        return y


class FakeTTS(Engine):
    kind = "tts"
    backend = "fake"

    def __init__(self, config: VoiceConfig) -> None:
        super().__init__()
        self.config = config
        self.device = "cpu"
        ids = list(FAKE_VOICES)
        if config.tts_voice and config.tts_voice not in ids:
            ids.insert(0, config.tts_voice)
        self._voices = ids

    def _load(self) -> None:
        _delay()
        try:  # pay the scipy import now rather than on the first request
            import scipy.signal  # noqa: F401, PLC0415
        except ImportError:
            pass

    def voices(self) -> list[dict]:
        return [voice_info(v) for v in self._voices]

    def status(self) -> dict:
        st = super().status()
        st.update({"device": "cpu", "voices": list(self._voices), "defaultVoice": self.config.tts_voice})
        return st

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> TTSResult:
        with self._lock:
            self.ensure_loaded()
            _delay()
            v = voice or self.config.tts_voice
            if v not in self._voices:
                raise EngineInputError(f"unknown voice '{v}'. Available: {', '.join(self._voices)}")
            try:
                sp = float(speed) if speed is not None else 1.0
            except (TypeError, ValueError):
                sp = 1.0
            sp = min(2.0, max(0.5, sp if np.isfinite(sp) else 1.0))
            return self._render(clean_text(text), v, sp)

    def _render(self, text: str, voice: str, speed: float) -> TTSResult:
        sr = SAMPLE_RATE
        phonemes = text_to_pseudo_phonemes(text)
        units = tokenize(phonemes)
        rng = np.random.default_rng(zlib.crc32(f"{voice}|{text}".encode("utf-8")))
        f0 = 200.0 if voice[1:2] == "f" else 115.0
        unit_sec = 0.085 / speed
        lead = 0.05
        pieces: list[np.ndarray] = [np.zeros(int(lead * sr), np.float32)]
        timeline: list[dict] = []
        t = lead
        for u in units:
            dur = max(0.03, u.weight * unit_sec)
            n = int(dur * sr)
            seg = np.zeros(n, np.float32)
            if u.kind == "sound":
                vis = u.visemes[0]
                tt = np.arange(n) / sr
                if vis in _FORMANTS:
                    # Glottal pulse train through two formants, with gentle pitch drift.
                    phase = np.cumsum(2 * np.pi * f0 * (1 + 0.03 * np.sin(2 * np.pi * 3 * tt)) / sr)
                    src = (np.sin(phase) > 0.95).astype(np.float64)
                    f1, f2 = _FORMANTS[vis]
                    y = _resonate(src, f1, 90, sr) + 0.5 * _resonate(src, f2, 120, sr)
                    seg = (0.6 * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)
                elif vis in ("SS", "CH", "FF", "TH"):
                    seg = (0.12 * rng.standard_normal(n)).astype(np.float32)
                elif vis in ("PP", "DD", "kk"):
                    burst = min(n, int(0.015 * sr))
                    seg[:burst] = (0.25 * rng.standard_normal(burst)).astype(np.float32)
                    seg[burst:] = (0.05 * np.sin(2 * np.pi * f0 * tt[burst:])).astype(np.float32)
                env = np.minimum(1.0, np.minimum(np.arange(n), np.arange(n)[::-1]) / max(1, int(0.008 * sr)))
                seg = (seg * env).astype(np.float32)
                if len(u.visemes) == 2:
                    mid = t + dur * 0.6
                    timeline += [{"start": t, "end": mid, "viseme": u.visemes[0]}, {"start": mid, "end": t + dur, "viseme": u.visemes[1]}]
                else:
                    timeline.append({"start": t, "end": t + dur, "viseme": vis})
            else:
                timeline.append({"start": t, "end": t + dur, "viseme": "sil"})
            pieces.append(seg)
            t += n / sr
        pieces.append(np.zeros(int(0.08 * sr), np.float32))
        audio = np.concatenate(pieces).astype(np.float32)
        duration = len(audio) / sr
        return TTSResult(audio, sr, normalize_timeline(timeline, duration), phonemes, voice, {"fake": True})
