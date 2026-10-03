"""End-to-end: launch ``python -m lawnmower_voice`` as a real process and talk HTTP to it."""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import pytest

from .conftest import free_port, sine, wav_bytes

VOICE_DIR = Path(__file__).resolve().parent.parent


class Server:
    def __init__(self, *args: str, env: dict | None = None, python_args: list[str] | None = None):
        e = {k: v for k, v in os.environ.items() if k != "LAWNMOWER_VOICE_TOKEN"}
        e.update({"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"})
        e.update(env or {})
        cmd = [sys.executable, *(python_args or []), "-m", "lawnmower_voice", *args]
        self.proc = subprocess.Popen(cmd, cwd=VOICE_DIR, env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.stdout_lines: list[str] = []
        self.stderr_lines: list[str] = []
        self._t = threading.Thread(target=self._drain_err, daemon=True)
        self._t.start()

    def _drain_err(self):
        for line in self.proc.stderr:
            self.stderr_lines.append(line)

    def wait_ready(self, timeout: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    raise AssertionError(f"server exited {self.proc.returncode}: {''.join(self.stderr_lines)[-2000:]}")
                continue
            self.stdout_lines.append(line)
            msg = json.loads(line)  # every stdout line must be JSON
            if msg.get("event") == "ready":
                return msg
        raise AssertionError("no ready line")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        rest = self.proc.stdout.read() if self.proc.stdout else ""
        self.stdout_lines += [ln for ln in rest.splitlines(True) if ln.strip()]


def request(url: str, data: bytes | None = None, headers: dict | None = None, method: str | None = None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


@pytest.fixture
def server():
    started = []

    def start(*args, **kw):
        s = Server(*args, **kw)
        started.append(s)
        return s

    yield start
    for s in started:
        s.stop()


def test_fake_server_end_to_end(server, tmp_path):
    port = free_port()
    srv = server("--fake", "--host", "127.0.0.1", "--port", str(port), "--models-dir", str(tmp_path), "--preload", env={"LAWNMOWER_VOICE_TOKEN": "s3cret"})
    ready = srv.wait_ready()
    assert ready["port"] == port and ready["device"] == "cpu" and ready["fake"] is True
    assert "token" not in ready  # the token came from the environment; never echo it
    base = f"http://127.0.0.1:{port}"

    status, health = request(base + "/health")
    assert status == 200 and health["ok"] is True
    assert health["stt"]["backend"] == "fake" and health["tts"]["backend"] == "fake"
    assert {"cuda", "name", "capability", "vramTotalMB", "vramFreeMB"} <= set(health["device"])

    status, body = request(base + "/tts", json.dumps({"text": "Hello from the hologram."}).encode(), {"Content-Type": "application/json"})
    assert status == 401

    auth = {"Authorization": "Bearer s3cret"}
    status, body = request(base + "/tts", json.dumps({"text": "Hello from the hologram."}).encode(), {**auth, "Content-Type": "application/json"})
    assert status == 200
    with wave.open(io.BytesIO(base64.b64decode(body["audioB64"]))) as w:
        assert w.getframerate() == body["sampleRate"] == 24000 and w.getnchannels() == 1
    assert body["visemes"] and body["visemes"][-1]["end"] == pytest.approx(body["durationSec"], abs=1e-3)

    status, body = request(base + "/stt?language=en", wav_bytes(sine(330, 48000, 1.0), 48000), {**auth, "Content-Type": "audio/wav"})
    assert status == 200 and body["text"] and body["language"] == "en"

    status, voices = request(base + "/voices", headers=auth)
    assert status == 200 and any(v["id"] == "af_heart" for v in voices)

    srv.stop()
    # Only JSON protocol lines ever reach stdout.
    for line in srv.stdout_lines:
        json.loads(line)
    assert any("listening on" in ln for ln in srv.stderr_lines)


def test_generated_token_and_port_zero(server, tmp_path):
    srv = server("--fake", "--port", "0", "--models-dir", str(tmp_path))
    ready = srv.wait_ready()
    assert ready["port"] > 0 and len(ready["token"]) >= 32
    status, _ = request(f"http://127.0.0.1:{ready['port']}/voices", headers={"Authorization": f"Bearer {ready['token']}"})
    assert status == 200


def test_native_stdout_writes_cannot_corrupt_the_protocol(server, tmp_path):
    """A library writing straight to file descriptor 1 must end up on stderr."""
    hook = tmp_path / "sitecustomize.py"
    hook.write_text(
        textwrap.dedent(
            """
            import os, threading
            def noisy():
                import time
                time.sleep(1.0)
                os.write(1, b"native printf noise\\n")
                print("python print noise")
            threading.Thread(target=noisy, daemon=True).start()
            """
        )
    )
    env = {"PYTHONPATH": str(tmp_path) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    srv = server("--fake", "--port", "0", "--models-dir", str(tmp_path), env=env)
    ready = srv.wait_ready()
    time.sleep(1.5)
    status, _ = request(f"http://127.0.0.1:{ready['port']}/health")
    assert status == 200
    srv.stop()
    for line in srv.stdout_lines:
        json.loads(line)
    err = "".join(srv.stderr_lines)
    assert "native printf noise" in err and "python print noise" in err


def test_port_in_use_exits_nonzero(server, tmp_path):
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    port = s.getsockname()[1]
    try:
        srv = server("--fake", "--port", str(port), "--models-dir", str(tmp_path))
        code = srv.proc.wait(30)
        assert code != 0
    finally:
        s.close()


def test_real_engines_without_libraries_start_and_explain(server, tmp_path):
    """No faster-whisper/kokoro installed: the server still starts; /tts and /stt answer 503."""
    blocker = tmp_path / "sitecustomize.py"
    blocker.write_text(
        textwrap.dedent(
            """
            import sys
            BLOCK = ("faster_whisper", "ctranslate2", "kokoro_onnx", "kokoro", "onnxruntime", "torch", "misaki")
            class _Block:
                def find_spec(self, name, path=None, target=None):
                    if name.split(".")[0] in BLOCK:
                        raise ModuleNotFoundError(f"No module named {name!r}")
                    return None
            sys.meta_path.insert(0, _Block())
            """
        )
    )
    env = {"PYTHONPATH": str(tmp_path) + os.pathsep + os.environ.get("PYTHONPATH", ""), "LAWNMOWER_VOICE_TOKEN": "t"}
    srv = server("--port", "0", "--models-dir", str(tmp_path / "m"), "--no-download", "--device", "auto", env=env)
    ready = srv.wait_ready()
    base = f"http://127.0.0.1:{ready['port']}"
    status, body = request(base + "/tts", json.dumps({"text": "hi"}).encode(), {"Authorization": "Bearer t", "Content-Type": "application/json"})
    assert status == 503 and "kokoro-onnx is not installed" in body["error"] and "setup-voice" in body["error"]
    status, body = request(base + "/stt", wav_bytes(sine(300, 16000, 1.0), 16000), {"Authorization": "Bearer t"})
    assert status == 503 and "faster-whisper is not installed" in body["error"]
    status, health = request(base + "/health")
    assert status == 200 and health["ok"] is False
    assert health["stt"]["error"] and health["tts"]["error"]
