"""Audio helpers: WAV decode/encode, raw float32 bodies, mono mixdown and resampling.

Only numpy is required. ``scipy.signal.resample_poly`` is used for resampling when scipy is
installed; otherwise a vectorised windowed-sinc (Kaiser) resampler of comparable quality
is used.
"""

from __future__ import annotations

import io
import math
import struct
from fractions import Fraction

import numpy as np

WHISPER_RATE = 16000

_WAVE_FORMAT_PCM = 0x0001
_WAVE_FORMAT_IEEE_FLOAT = 0x0003
_WAVE_FORMAT_EXTENSIBLE = 0xFFFE
# Sub-format GUID tail shared by KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT.
_GUID_TAIL = b"\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"

MIN_SAMPLE_RATE = 4000
MAX_SAMPLE_RATE = 384000


class AudioError(ValueError):
    """Raised for malformed or unsupported audio input (mapped to HTTP 400)."""


def is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] in (b"RIFF", b"RIFX") and data[8:12] == b"WAVE"


def _check_rate(sample_rate: int) -> int:
    if not isinstance(sample_rate, (int, np.integer)) or not MIN_SAMPLE_RATE <= int(sample_rate) <= MAX_SAMPLE_RATE:
        raise AudioError(f"sample rate {sample_rate!r} is out of range ({MIN_SAMPLE_RATE}-{MAX_SAMPLE_RATE} Hz)")
    return int(sample_rate)


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """Decode a RIFF/WAVE file into ``(float32 mono samples in [-1, 1], sample_rate)``.

    Supports PCM 8/16/24/32-bit, IEEE float 32/64 and WAVE_FORMAT_EXTENSIBLE, any channel
    count (mixed down to mono). Tolerates streaming writers that leave the RIFF/data sizes
    unset (0 or 0xFFFFFFFF) and odd chunk padding.
    """
    if not is_wav(data):
        raise AudioError("not a RIFF/WAVE file")
    if data[:4] == b"RIFX":
        raise AudioError("big-endian WAV (RIFX) is not supported")

    fmt = None
    pcm = None
    pos = 12
    n = len(data)
    while pos + 8 <= n:
        cid = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body_start = pos + 8
        if cid == b"data":
            # Streaming writers may leave 0 / 0xFFFFFFFF; clamp to what is actually present.
            end = n if size in (0, 0xFFFFFFFF) or body_start + size > n else body_start + size
            pcm = data[body_start:end]
            if fmt is not None:
                break
            pos = end + (size & 1 if end - body_start == size else 0)
            continue
        if body_start + size > n:
            break
        if cid == b"fmt ":
            if size < 16:
                raise AudioError("WAV fmt chunk is too short")
            fmt = data[body_start : body_start + size]
        pos = body_start + size + (size & 1)

    if fmt is None:
        raise AudioError("WAV file has no fmt chunk")
    if pcm is None:
        raise AudioError("WAV file has no data chunk")

    tag, channels, rate, _byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == _WAVE_FORMAT_EXTENSIBLE:
        if len(fmt) < 40:
            raise AudioError("WAVE_FORMAT_EXTENSIBLE fmt chunk is too short")
        # The container size (``bits``) is what matters for unpacking; ``wValidBitsPerSample``
        # (offset 18) only says how many of those bits carry signal.
        sub = fmt[24:40]
        if sub[2:] != _GUID_TAIL:
            raise AudioError("unsupported WAVE_FORMAT_EXTENSIBLE sub-format")
        tag = struct.unpack_from("<H", sub, 0)[0]
    if channels < 1:
        raise AudioError("WAV file reports zero channels")
    rate = _check_rate(rate)
    width = bits // 8
    if bits % 8 or width < 1:
        raise AudioError(f"unsupported WAV bit depth {bits}")
    # Some writers put odd values in block_align; the bit depth and channel count are trusted.
    del block_align
    frame = width * channels
    usable = len(pcm) - (len(pcm) % frame)
    raw = pcm[:usable]

    if tag == _WAVE_FORMAT_PCM:
        if width == 1:
            x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif width == 2:
            x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        elif width == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
            v = np.where(v & 0x800000, v - 0x1000000, v)
            x = v.astype(np.float32) / 8388608.0
        elif width == 4:
            x = (np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0).astype(np.float32)
        else:
            raise AudioError(f"unsupported PCM bit depth {bits}")
    elif tag == _WAVE_FORMAT_IEEE_FLOAT:
        if width == 4:
            x = np.frombuffer(raw, dtype="<f4").astype(np.float32)
        elif width == 8:
            x = np.frombuffer(raw, dtype="<f8").astype(np.float32)
        else:
            raise AudioError(f"unsupported float bit depth {bits}")
    else:
        raise AudioError(f"unsupported WAV encoding (format tag 0x{tag:04x}); send PCM or float WAV")

    x = to_mono(x.reshape(-1, channels) if channels > 1 else x)
    return sanitize(x), rate


def decode_float32(data: bytes, sample_rate: int | str) -> tuple[np.ndarray, int]:
    """Decode a raw little-endian float32 mono body (``X-Sample-Rate`` header)."""
    try:
        rate = int(str(sample_rate).strip())
    except (TypeError, ValueError):
        raise AudioError(f"invalid X-Sample-Rate header {sample_rate!r}") from None
    rate = _check_rate(rate)
    if len(data) % 4:
        raise AudioError("raw float32 body length is not a multiple of 4 bytes")
    x = np.frombuffer(data, dtype="<f4").astype(np.float32)
    return sanitize(x), rate


def to_mono(x: np.ndarray) -> np.ndarray:
    """Average channels: ``(n, channels)`` -> ``(n,)``."""
    if x.ndim == 1:
        return x.astype(np.float32, copy=False)
    return x.mean(axis=1, dtype=np.float64).astype(np.float32)


def sanitize(x: np.ndarray) -> np.ndarray:
    """Replace NaN/Inf by 0 and clip to [-1, 1] (float32, contiguous)."""
    x = np.asarray(x, dtype=np.float32)
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    return np.ascontiguousarray(np.clip(x, -1.0, 1.0), dtype=np.float32)


# --------------------------------------------------------------------------------------------
# Resampling


def _kaiser_kernel(d: np.ndarray, cutoff: float, taps: int, beta: float) -> np.ndarray:
    """Kaiser-windowed sinc low-pass evaluated at distances ``d`` (input samples)."""
    w = np.clip(1.0 - (d / float(taps)) ** 2, 0.0, None)
    return cutoff * np.sinc(d * cutoff) * (np.i0(beta * np.sqrt(w)) / np.i0(beta))


def _kaiser_sinc_resample(x: np.ndarray, up: int, down: int, half_width: int = 16, beta: float = 8.0) -> np.ndarray:
    """Band-limited resampling by ``up/down`` with a Kaiser-windowed sinc kernel (numpy only).

    Output sample ``n`` sits at input position ``t = n * down / up`` and is the dot product of
    the ``2 * taps`` neighbouring inputs with the kernel evaluated at their distance. Because
    ``up/down`` is rational, the fractional part of ``t`` takes only ``up`` distinct values, so
    the kernel is tabulated once per phase (polyphase). Processed in blocks to bound memory.
    """
    n_in = len(x)
    n_out = int(math.ceil(n_in * up / down))
    if n_in == 0 or n_out == 0:
        return np.zeros(0, dtype=np.float32)
    cutoff = min(1.0, up / down)  # normalised to the input Nyquist (anti-aliasing when down-sampling)
    taps = int(math.ceil(half_width / cutoff))
    offsets = np.arange(-taps + 1, taps + 1)  # input indices relative to floor(t)
    xp = np.concatenate([np.zeros(taps, np.float64), x.astype(np.float64), np.zeros(taps + 1, np.float64)])
    table = None
    if up <= 4096:  # one kernel row per phase
        frac = np.arange(up)[:, None] / float(up)
        table = _kaiser_kernel(frac - offsets[None, :], cutoff, taps, beta)
    out = np.empty(n_out, dtype=np.float64)
    block = max(1, 262144 // len(offsets))
    for start in range(0, n_out, block):
        n = np.arange(start, min(n_out, start + block), dtype=np.int64)
        num = n * down
        base = num // up
        phase = num - base * up
        idx = base[:, None] + offsets[None, :]
        if table is not None:
            kern = table[phase]
        else:
            kern = _kaiser_kernel((phase / float(up))[:, None] - offsets[None, :], cutoff, taps, beta)
        out[n] = np.einsum("ij,ij->i", xp[idx + taps], kern)
    return out.astype(np.float32)


def resample(x: np.ndarray, sr_in: int, sr_out: int = WHISPER_RATE) -> np.ndarray:
    """High-quality resampling of a mono float32 signal from ``sr_in`` to ``sr_out``."""
    sr_in = _check_rate(sr_in)
    sr_out = _check_rate(sr_out)
    x = np.asarray(x, dtype=np.float32)
    if sr_in == sr_out or len(x) == 0:
        return x.copy()
    frac = Fraction(sr_out, sr_in)
    up, down = frac.numerator, frac.denominator
    try:
        from scipy.signal import resample_poly  # type: ignore

        y = resample_poly(x.astype(np.float64), up, down)
        return sanitize(y)
    except ImportError:
        return sanitize(_kaiser_sinc_resample(x, up, down))


def load_for_whisper(data: bytes, sample_rate_header: str | None = None) -> tuple[np.ndarray, int]:
    """Decode a request body (WAV, or raw float32 when ``X-Sample-Rate`` is given).

    Returns ``(16 kHz float32 mono samples, original sample rate)``.
    """
    if not data:
        raise AudioError("empty audio body")
    if is_wav(data):
        x, sr = decode_wav(data)
    elif sample_rate_header is not None and str(sample_rate_header).strip():
        x, sr = decode_float32(data, sample_rate_header)
    else:
        raise AudioError("unsupported audio: send a WAV file, or raw little-endian float32 mono with an X-Sample-Rate header")
    return resample(x, sr, WHISPER_RATE), sr


# --------------------------------------------------------------------------------------------
# Encoding / analysis


def encode_wav_pcm16(x: np.ndarray, sample_rate: int) -> bytes:
    """Encode mono float samples as a 16-bit PCM WAV file."""
    sample_rate = _check_rate(sample_rate)
    pcm = np.round(sanitize(x) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(pcm)))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, _WAVE_FORMAT_PCM, 1, sample_rate, sample_rate * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", len(pcm)))
    buf.write(pcm)
    return buf.getvalue()


def rms(x: np.ndarray) -> float:
    if len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def speech_bounds(x: np.ndarray, sample_rate: int, threshold_db: float = -40.0, frame_ms: float = 10.0) -> tuple[float, float]:
    """Return ``(start, end)`` seconds of the region louder than ``threshold_db`` below peak.

    Used to place estimated visemes inside the audible part of synthesized speech.
    Returns ``(0, duration)`` for silence.
    """
    duration = len(x) / float(sample_rate) if sample_rate else 0.0
    if len(x) == 0:
        return 0.0, 0.0
    hop = max(1, int(sample_rate * frame_ms / 1000.0))
    n = len(x) // hop
    if n == 0:
        return 0.0, duration
    frames = np.asarray(x[: n * hop], dtype=np.float64).reshape(n, hop)
    env = np.sqrt(np.mean(frames * frames, axis=1))
    peak = float(env.max())
    if peak <= 1e-6:
        return 0.0, duration
    loud = np.nonzero(env >= peak * (10.0 ** (threshold_db / 20.0)))[0]
    start = loud[0] * hop / sample_rate
    end = min(duration, (loud[-1] + 1) * hop / sample_rate)
    return float(start), float(end)
