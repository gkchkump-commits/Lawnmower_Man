from __future__ import annotations

import builtins
import io
import struct
import wave

import numpy as np
import pytest

from lawnmower_voice import audio
from lawnmower_voice.audio import AudioError, decode_float32, decode_wav, encode_wav_pcm16, load_for_whisper, resample, speech_bounds

from .conftest import dominant_freq, float_wav_bytes, sine, wav_bytes


def test_pcm16_roundtrip():
    x = sine(440, 16000, 0.5)
    y, sr = decode_wav(encode_wav_pcm16(x, 16000))
    assert sr == 16000
    assert y.dtype == np.float32 and y.shape == x.shape
    assert np.max(np.abs(y - x)) < 1e-4


@pytest.mark.parametrize("width", [1, 2, 3, 4])
def test_pcm_bit_depths(width):
    x = sine(300, 22050, 0.25, amp=0.6)
    y, sr = decode_wav(wav_bytes(x, 22050, sampwidth=width))
    assert sr == 22050 and len(y) == len(x)
    tol = 0.02 if width == 1 else 1e-3
    assert np.max(np.abs(y - x)) < tol


@pytest.mark.parametrize("extensible", [False, True])
@pytest.mark.parametrize("bits", [32, 64])
def test_float_wav(extensible, bits):
    x = sine(500, 44100, 0.2, amp=0.7)
    y, sr = decode_wav(float_wav_bytes(x, 44100, extensible=extensible, bits=bits))
    assert sr == 44100
    assert np.allclose(y, x, atol=1e-6)


def test_stereo_is_mixed_to_mono():
    left = sine(440, 48000, 0.1, amp=0.5)
    right = -left * 0.5
    y, sr = decode_wav(wav_bytes(np.stack([left, right], axis=1), 48000))
    assert sr == 48000
    assert np.allclose(y, (left + right) / 2, atol=1e-4)


def test_streaming_wav_with_unset_sizes():
    data = bytearray(encode_wav_pcm16(sine(200, 16000, 0.1), 16000))
    data[4:8] = b"\xff\xff\xff\xff"
    data[40:44] = b"\xff\xff\xff\xff"
    y, sr = decode_wav(bytes(data))
    assert sr == 16000 and len(y) == 1600


def test_extra_chunks_and_odd_padding():
    pcm = (np.arange(10, dtype="<i2") * 100).tobytes()
    fmt = struct.pack("<HHIIHH", 1, 1, 8000, 16000, 2, 16)
    junk = b"abc"  # odd size -> one pad byte
    body = b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt + b"LIST" + struct.pack("<I", 3) + junk + b"\x00" + b"data" + struct.pack("<I", len(pcm)) + pcm
    y, sr = decode_wav(b"RIFF" + struct.pack("<I", len(body)) + body)
    assert sr == 8000 and len(y) == 10
    assert y[1] == pytest.approx(100 / 32768)


@pytest.mark.parametrize(
    "blob, msg",
    [
        (b"not a wav file at all", "not a RIFF"),
        (b"RIFF\x04\x00\x00\x00WAVE", "no fmt"),
    ],
)
def test_bad_wavs(blob, msg):
    with pytest.raises(AudioError, match=msg):
        decode_wav(blob)


def test_wav_without_data_chunk():
    fmt = struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16)
    body = b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt
    with pytest.raises(AudioError, match="no data"):
        decode_wav(b"RIFF" + struct.pack("<I", len(body)) + body)


def test_unsupported_encoding():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * 10)
    data = bytearray(buf.getvalue())
    data[20:22] = struct.pack("<H", 6)  # A-law
    with pytest.raises(AudioError, match="unsupported WAV encoding"):
        decode_wav(bytes(data))


def test_float32_body():
    x = sine(1000, 44100, 0.3)
    y, sr = decode_float32(x.astype("<f4").tobytes(), "44100")
    assert sr == 44100 and np.array_equal(y, x)
    with pytest.raises(AudioError, match="multiple of 4"):
        decode_float32(b"\x00\x00\x00", 16000)
    with pytest.raises(AudioError, match="X-Sample-Rate"):
        decode_float32(b"\x00\x00\x00\x00", "fast")
    with pytest.raises(AudioError, match="out of range"):
        decode_float32(b"\x00\x00\x00\x00", 100)


def test_nan_and_clipping_are_sanitized():
    x = np.array([np.nan, np.inf, -np.inf, 2.0, -3.0, 0.25], dtype=np.float32)
    y, _ = decode_float32(x.tobytes(), 16000)
    assert np.all(np.isfinite(y)) and y.max() <= 1.0 and y.min() >= -1.0
    assert y[-1] == pytest.approx(0.25)


@pytest.mark.parametrize("sr_in", [8000, 22050, 44100, 48000, 96000])
def test_resample_preserves_tone_and_length(sr_in):
    x = sine(1000, sr_in, 1.0, amp=0.5)
    y = resample(x, sr_in, 16000)
    assert abs(len(y) - 16000) <= 1
    assert dominant_freq(y, 16000) == pytest.approx(1000, abs=3)
    mid = y[2000:-2000]
    assert np.sqrt(np.mean(mid**2)) == pytest.approx(0.5 / np.sqrt(2), rel=0.02)


def _no_scipy(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("scipy"):
            raise ImportError("scipy disabled for this test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)


@pytest.mark.parametrize("sr_in", [44100, 48000, 22050, 8000])
def test_numpy_fallback_resampler(monkeypatch, sr_in):
    _no_scipy(monkeypatch)
    x = sine(1000, sr_in, 0.5, amp=0.5)
    y = resample(x, sr_in, 16000)
    assert abs(len(y) - 8000) <= 1
    assert dominant_freq(y, 16000) == pytest.approx(1000, abs=4)
    mid = y[1000:-1000]
    assert np.sqrt(np.mean(mid**2)) == pytest.approx(0.5 / np.sqrt(2), rel=0.02)


def test_numpy_fallback_matches_scipy():
    pytest.importorskip("scipy")
    rng = np.random.default_rng(1)
    x = (0.3 * rng.standard_normal(44100)).astype(np.float32)
    # band-limit the test signal well below 8 kHz so both resamplers should agree closely
    from scipy.signal import butter, sosfiltfilt

    x = sosfiltfilt(butter(8, 5000, fs=44100, output="sos"), x).astype(np.float32)
    a = resample(x, 44100, 16000)
    b = audio._kaiser_sinc_resample(x, 160, 441)
    n = min(len(a), len(b))
    err = np.sqrt(np.mean((a[200 : n - 200] - b[200 : n - 200]) ** 2)) / np.sqrt(np.mean(a[200 : n - 200] ** 2))
    assert err < 0.02


@pytest.mark.parametrize("use_scipy", [True, False])
def test_resampler_rejects_aliasing(monkeypatch, use_scipy):
    if use_scipy:
        pytest.importorskip("scipy")
    else:
        _no_scipy(monkeypatch)
    # 11 kHz at 48 kHz would alias to 5 kHz at 16 kHz; it must be filtered out.
    x = sine(11000, 48000, 0.5, amp=0.5)
    y = resample(x, 48000, 16000)
    assert np.sqrt(np.mean(y[500:-500] ** 2)) < 0.5 / np.sqrt(2) * 0.01  # > 40 dB down


def test_load_for_whisper_variants():
    st = np.stack([sine(440, 48000, 1.0), sine(440, 48000, 1.0)], axis=1)
    y, sr = load_for_whisper(wav_bytes(st, 48000))
    assert sr == 48000 and abs(len(y) - 16000) <= 1
    y2, sr2 = load_for_whisper(sine(440, 32000, 0.5).tobytes(), "32000")
    assert sr2 == 32000 and abs(len(y2) - 8000) <= 1
    with pytest.raises(AudioError, match="empty"):
        load_for_whisper(b"")
    with pytest.raises(AudioError, match="unsupported audio"):
        load_for_whisper(b"\x00" * 64)


def test_encode_wav_header_is_standard():
    data = encode_wav_pcm16(np.zeros(240, np.float32), 24000)
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24000, 240)


def test_speech_bounds():
    sr = 24000
    x = np.concatenate([np.zeros(sr // 4), sine(200, sr, 0.5), np.zeros(sr // 2)]).astype(np.float32)
    s, e = speech_bounds(x, sr)
    assert s == pytest.approx(0.25, abs=0.02)
    assert e == pytest.approx(0.75, abs=0.02)
    assert speech_bounds(np.zeros(1000, np.float32), sr) == (0.0, pytest.approx(1000 / sr))
