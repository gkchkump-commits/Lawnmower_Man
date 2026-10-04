from __future__ import annotations

import asyncio
import base64
import io
import wave

import numpy as np
import pytest

from lawnmower_voice.config import DEFAULT_CORS_ORIGINS, VoiceConfig
from lawnmower_voice.device import DeviceReport, GpuInfo
from lawnmower_voice.engines import Engine, EngineInputError, EngineUnavailable, TTSResult
from lawnmower_voice.fake import DEFAULT_FAKE_TEXT, FakeSTT, FakeTTS
from lawnmower_voice.server import _Gate, ApiError, create_app
from lawnmower_voice.visemes import VISEMES

from .conftest import TOKEN, make_client, sine, wav_bytes


@pytest.fixture
def client(config):
    rep = DeviceReport(cuda=True, gpus=[GpuInfo(0, "NVIDIA GeForce RTX 5070 Laptop GPU", "12.0", 8151, 7000)], driver_version="581.57", cuda_driver_version="13.0")
    return make_client(create_app(config, FakeSTT(config), FakeTTS(config), rep))


class RecordingSTT(Engine):
    kind, backend = "stt", "recording"

    def __init__(self, error=None):
        super().__init__()
        self.calls = []
        self.error = error

    def _load(self):
        pass

    def transcribe(self, audio, language=None):
        self.calls.append((audio, language))
        if self.error:
            raise self.error
        return {"text": "ok", "language": language or "en"}

    def status(self):
        return {**super().status(), "model": "m", "device": "cpu"}


class BrokenTTS(Engine):
    kind, backend = "tts", "broken"

    def _load(self):
        raise EngineUnavailable("kokoro-onnx is not installed. Install the voice stack with scripts\\setup-voice.ps1")

    def synthesize(self, text, voice=None, speed=None):
        self.ensure_loaded()

    def voices(self):
        return []

    def status(self):
        return {**super().status(), "device": "cpu", "voices": []}


# --- health / auth ----------------------------------------------------------------------------


def test_health_shape_without_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    h = r.json()
    assert h["ok"] is True and isinstance(h["version"], str)
    d = h["device"]
    assert {"cuda", "name", "capability", "vramTotalMB", "vramFreeMB"} <= set(d)
    assert d["cuda"] is True and d["capability"] == "12.0" and d["vramTotalMB"] == 8151
    assert {"backend", "model", "device", "loaded"} <= set(h["stt"])
    assert {"backend", "device", "loaded", "voices"} <= set(h["tts"])
    assert isinstance(h["tts"]["voices"], list) and "af_heart" in h["tts"]["voices"]
    assert "error" not in h["stt"] and "error" not in h["tts"]


@pytest.mark.parametrize("method, path", [("post", "/stt"), ("post", "/tts"), ("get", "/voices"), ("post", "/warmup")])
@pytest.mark.parametrize("header", [None, "Bearer wrong", "Basic dGVzdA==", f"Token {TOKEN}", "Bearer"])
def test_auth_required(client, method, path, header):
    headers = {"Authorization": header} if header else {}
    r = getattr(client, method)(path, headers=headers)
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"
    assert r.headers["www-authenticate"] == "Bearer"


def test_bearer_scheme_is_case_insensitive(client):
    assert client.get("/voices", headers={"Authorization": f"bearer {TOKEN}"}).status_code == 200


def test_app_requires_a_token():
    with pytest.raises(ValueError):
        create_app(VoiceConfig(token=""), FakeSTT(VoiceConfig()), FakeTTS(VoiceConfig()))


# --- CORS / host ------------------------------------------------------------------------------


@pytest.mark.parametrize("origin", DEFAULT_CORS_ORIGINS)
def test_cors_preflight_allowed(client, origin):
    r = client.options(
        "/stt",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, x-sample-rate"},
    )
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == origin
    allowed = {h.strip() for h in r.headers["access-control-allow-headers"].split(",")}
    assert {"authorization", "content-type", "x-sample-rate"} <= allowed
    assert "POST" in r.headers["access-control-allow-methods"]
    assert "Origin" in r.headers["vary"]


def test_cors_preflight_rejects_unknown_origin(client):
    r = client.options("/tts", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert r.status_code == 403
    assert "access-control-allow-origin" not in r.headers


def test_cors_preflight_rejects_unknown_header(client):
    r = client.options("/tts", headers={"Origin": "app://lawnmower", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-evil"})
    assert r.status_code == 400


def test_private_network_preflight(client):
    r = client.options(
        "/tts",
        headers={"Origin": "app://lawnmower", "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"},
    )
    assert r.status_code == 204 and r.headers["access-control-allow-private-network"] == "true"


def test_cors_headers_on_actual_and_error_responses(client, auth):
    ok = client.get("/voices", headers={**auth, "Origin": "http://127.0.0.1:5173"})
    assert ok.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    denied = client.get("/voices", headers={"Origin": "app://lawnmower"})
    assert denied.status_code == 401 and denied.headers["access-control-allow-origin"] == "app://lawnmower"
    evil = client.get("/health", headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403


def test_host_header_must_be_loopback(config):
    app = create_app(config, FakeSTT(config), FakeTTS(config))
    from fastapi.testclient import TestClient

    assert TestClient(app, base_url="http://localhost:1234").get("/health").status_code == 200
    assert TestClient(app).get("/health", headers={"Host": "[::1]:1234"}).status_code == 200
    r = TestClient(app, base_url="http://attacker.example").get("/health")
    assert r.status_code == 403 and r.json()["code"] == "bad_host"


# --- /stt ---------------------------------------------------------------------------------------


def test_stt_wav_48k_stereo(config, auth):
    stt = RecordingSTT()
    c = make_client(create_app(config, stt, FakeTTS(config)))
    st = np.stack([sine(440, 48000, 1.5), sine(440, 48000, 1.5)], axis=1)
    r = c.post("/stt?language=en", content=wav_bytes(st, 48000), headers={**auth, "Content-Type": "audio/wav"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {**body, "text": "ok", "language": "en", "durationSec": 1.5}
    assert isinstance(body["processingMs"], int)
    audio, lang = stt.calls[0]
    assert lang == "en" and audio.dtype == np.float32 and abs(len(audio) - 24000) <= 1
    # resampled correctly: still a 440 Hz tone at the original level
    spec = np.abs(np.fft.rfft(audio * np.hanning(len(audio))))
    assert np.fft.rfftfreq(len(audio), 1 / 16000)[spec.argmax()] == pytest.approx(440, abs=2)
    assert np.sqrt(np.mean(audio[2000:-2000] ** 2)) == pytest.approx(0.5 / np.sqrt(2), rel=0.02)


def test_stt_float32_body(config, auth):
    stt = RecordingSTT()
    c = make_client(create_app(config, stt, FakeTTS(config)))
    x = sine(1000, 44100, 1.0)
    r = c.post("/stt", content=x.astype("<f4").tobytes(), headers={**auth, "Content-Type": "application/octet-stream", "X-Sample-Rate": "44100"})
    assert r.status_code == 200, r.text
    assert r.json()["durationSec"] == pytest.approx(1.0, abs=1e-3)
    audio, lang = stt.calls[0]
    assert lang is None
    assert abs(len(audio) - 16000) <= 1


def test_stt_fake_engine_text_and_silence(client, auth):
    r = client.post("/stt", content=wav_bytes(sine(300, 16000, 1.0), 16000), headers=auth)
    assert r.json()["text"] == DEFAULT_FAKE_TEXT
    r = client.post("/stt", content=wav_bytes(np.zeros(16000), 16000), headers=auth)
    assert r.json()["text"] == ""


def test_stt_very_short_audio_skips_the_engine(config, auth):
    stt = RecordingSTT()
    c = make_client(create_app(config, stt, FakeTTS(config)))
    r = c.post("/stt", content=wav_bytes(sine(300, 16000, 0.05), 16000), headers=auth)
    assert r.status_code == 200 and r.json()["text"] == "" and stt.calls == []


@pytest.mark.parametrize(
    "content, headers, code",
    [
        (b"", {}, "bad_audio"),
        (b"\x00" * 100, {}, "bad_audio"),
        (b"\x00" * 7, {"X-Sample-Rate": "16000"}, "bad_audio"),
        (b"\x00" * 8, {"X-Sample-Rate": "abc"}, "bad_audio"),
        (b"RIFF\x00\x00\x00\x00WAVEjunk", {}, "bad_audio"),
    ],
)
def test_stt_bad_audio(client, auth, content, headers, code):
    r = client.post("/stt", content=content, headers={**auth, **headers})
    assert r.status_code == 400
    assert r.json()["code"] == code and r.json()["error"]


def test_stt_size_and_duration_limits(tmp_path, auth):
    cfg = VoiceConfig(token=TOKEN, models_dir=tmp_path, max_upload_mb=0.1, max_audio_sec=2.0)
    c = make_client(create_app(cfg, RecordingSTT(), FakeTTS(cfg)))
    big = c.post("/stt", content=b"\x00" * 200_000, headers={**auth, "X-Sample-Rate": "16000"})
    assert big.status_code == 413 and big.json()["code"] == "too_large"
    long = c.post("/stt", content=sine(200, 8000, 3.0).tobytes(), headers={**auth, "X-Sample-Rate": "8000"})
    assert long.status_code == 413 and long.json()["code"] == "too_long"


def test_stt_engine_unavailable_is_503(config, auth):
    c = make_client(create_app(config, RecordingSTT(error=EngineUnavailable("faster-whisper is not installed")), FakeTTS(config)))
    r = c.post("/stt", content=wav_bytes(sine(300, 16000, 1.0), 16000), headers=auth)
    assert r.status_code == 503
    assert r.json() == {"error": "faster-whisper is not installed", "code": "stt_unavailable"}


# --- /tts ---------------------------------------------------------------------------------------


def test_tts_returns_valid_wav_and_visemes(client, auth):
    r = client.post("/tts", json={"text": "Hello there! How are you today?", "voice": "am_michael", "speed": 1.1}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert {"sampleRate", "audioB64", "durationSec", "processingMs", "visemes"} <= set(body)
    wav = base64.b64decode(body["audioB64"])
    with wave.open(io.BytesIO(wav)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, body["sampleRate"])
        frames = w.getnframes()
        pcm = np.frombuffer(w.readframes(frames), dtype="<i2")
    assert body["sampleRate"] == 24000
    assert frames / 24000 == pytest.approx(body["durationSec"], abs=1e-3)
    assert np.abs(pcm).max() > 1000  # not silent
    vis = body["visemes"]
    assert vis[0]["start"] == 0 and vis[-1]["end"] == pytest.approx(body["durationSec"], abs=1e-3)
    assert all(v["viseme"] in VISEMES for v in vis)
    assert all(a["end"] == pytest.approx(b["start"]) for a, b in zip(vis, vis[1:]))
    assert body["voice"] == "am_michael"


def test_tts_defaults_and_speed(client, auth):
    slow = client.post("/tts", json={"text": "Testing one two three", "speed": 0.5}, headers=auth).json()
    fast = client.post("/tts", json={"text": "Testing one two three", "speed": 2.0}, headers=auth).json()
    assert slow["voice"] == "af_heart"
    assert slow["durationSec"] > fast["durationSec"] * 2.5


@pytest.mark.parametrize(
    "payload, status",
    [
        ({"text": 5}, 400),
        ({}, 400),
        ({"text": "hi", "voice": 3}, 400),
        ({"text": "hi", "speed": "fast"}, 400),
        ({"text": "hi", "speed": True}, 400),
        ({"text": "hi", "voice": "xx_nobody"}, 400),
        ({"text": "x" * 5000}, 413),
        ([1, 2], 400),
    ],
)
def test_tts_validation(client, auth, payload, status):
    r = client.post("/tts", json=payload, headers=auth)
    assert r.status_code == status, r.text
    assert r.json()["error"]


def test_tts_bad_json(client, auth):
    r = client.post("/tts", content=b"{not json", headers={**auth, "Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["code"] == "bad_request"


def test_tts_empty_text_is_short_silence(client, auth):
    body = client.post("/tts", json={"text": ""}, headers=auth).json()
    assert body["durationSec"] < 0.2 and body["visemes"][0]["viseme"] == "sil"


def test_tts_unavailable_is_503_and_health_reports_it(config, auth):
    c = make_client(create_app(config, FakeSTT(config), BrokenTTS()))
    r = c.post("/tts", json={"text": "hi"}, headers=auth)
    assert r.status_code == 503 and "setup-voice" in r.json()["error"]
    h = c.get("/health").json()
    assert h["ok"] is True  # STT still works
    assert "kokoro-onnx is not installed" in h["tts"]["error"]


# --- /voices, /warmup, misc -----------------------------------------------------------------------


def test_voices(client, auth):
    r = client.get("/voices", headers=auth)
    assert r.status_code == 200
    voices = r.json()
    assert {"id": "af_heart", "name": "Heart", "lang": "en-us", "gender": "female"} in voices
    assert all(set(v) == {"id", "name", "lang", "gender"} for v in voices)


def test_warmup_loads_both(client, auth):
    assert client.get("/health").json()["stt"]["loaded"] is False
    r = client.post("/warmup", headers=auth)
    assert r.status_code == 200 and r.json()["ok"] is True
    h = client.get("/health").json()
    assert h["stt"]["loaded"] and h["tts"]["loaded"]


def test_warmup_reports_failure(config, auth):
    c = make_client(create_app(config, FakeSTT(config), BrokenTTS()))
    body = c.post("/warmup", headers=auth).json()
    assert body["ok"] is False and body["stt"]["loaded"] is True and "error" in body["tts"]


def test_unknown_route_is_json_404(client, auth):
    r = client.get("/nope", headers=auth)
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    r = client.get("/stt", headers=auth)
    assert r.status_code == 405 and r.json()["code"] == "method_not_allowed"


def test_engine_input_error_is_400(config, auth):
    class PickySTT(RecordingSTT):
        def transcribe(self, audio, language=None):
            raise EngineInputError("language 'xx' is not supported")

    c = make_client(create_app(config, PickySTT(), FakeTTS(config)))
    r = c.post("/stt?language=xx", content=wav_bytes(sine(300, 16000, 1.0), 16000), headers=auth)
    assert r.status_code == 400 and "not supported" in r.json()["error"]


def test_unexpected_engine_error_is_500_json(config, auth):
    from fastapi.testclient import TestClient

    app = create_app(config, RecordingSTT(error=ZeroDivisionError("boom")), FakeTTS(config))
    c = TestClient(app, base_url="http://127.0.0.1", raise_server_exceptions=False)
    r = c.post("/stt", content=wav_bytes(sine(300, 16000, 1.0), 16000), headers=auth)
    assert r.status_code == 500 and r.json()["code"] == "internal"


def test_gate_limits_queue():
    gate = _Gate("speech synthesis", 2)

    async def scenario():
        async with gate.enter():
            async with gate.enter():
                with pytest.raises(ApiError) as e:
                    async with gate.enter():
                        pass
                assert e.value.status == 503 and e.value.code == "busy"
        assert gate.count == 0

    asyncio.run(scenario())


def test_concurrent_requests_are_serialised_per_engine(config, auth):
    """Two TTS requests at once: the engine lock serialises them; both succeed."""
    import threading

    active = {"now": 0, "max": 0}

    class SlowTTS(FakeTTS):
        def synthesize(self, text, voice=None, speed=None):
            with self._lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
                import time

                time.sleep(0.15)
                active["now"] -= 1
                return TTSResult(np.zeros(2400, np.float32), 24000, None, None, "af_heart")

    c = make_client(create_app(config, FakeSTT(config), SlowTTS(config)))
    results = []

    def call():
        results.append(c.post("/tts", json={"text": "hi"}, headers=auth).status_code)

    threads = [threading.Thread(target=call) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [200, 200, 200] and active["max"] == 1
