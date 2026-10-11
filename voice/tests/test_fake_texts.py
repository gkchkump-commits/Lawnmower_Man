"""``LAWNMOWER_VOICE_FAKE_TEXTS``: scripted answers of the fake ``/stt`` (contract-wake §10.4).

The "Hey Jade" end-to-end test makes the fake voice server answer the wake segment and then the
command differently, so the queue's order, its repeating last entry, its precedence over
``LAWNMOWER_VOICE_FAKE_TEXT`` and its failure modes are pinned here, directly and over HTTP.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from lawnmower_voice.fake import DEFAULT_FAKE_TEXT, FakeSTT, FakeTextQueue
from lawnmower_voice.engines import EngineUnavailable
from lawnmower_voice.server import create_app

from .conftest import make_client, sine, wav_bytes

SPEECH = sine(220, 16000, 0.6, 0.3)
SILENCE = np.zeros(16000, np.float32)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("LAWNMOWER_VOICE_FAKE_TEXTS", "LAWNMOWER_VOICE_FAKE_TEXT", "LAWNMOWER_VOICE_FAKE_STT_LOG", "LAWNMOWER_VOICE_FAKE_DELAY_MS"):
        monkeypatch.delenv(k, raising=False)


def write_queue(path, items) -> str:
    path.write_text(json.dumps(items), encoding="utf-8")
    return str(path)


def test_entries_in_order_then_the_last_repeats(tmp_path, monkeypatch, config):
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "q.json", ["Hey Jade.", "what time is it?"]))
    stt = FakeSTT(config)
    texts = [stt.transcribe(SPEECH)["text"] for _ in range(4)]
    assert texts == ["Hey Jade.", "what time is it?", "what time is it?", "what time is it?"]
    assert stt.calls == 4


def test_overrides_the_single_text_and_silence_takes_no_entry(tmp_path, monkeypatch, config):
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXT", "the single text")
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "q.json", ["first", "second"]))
    stt = FakeSTT(config)
    assert stt.transcribe(SILENCE) == {"text": "", "language": "en"}
    assert stt.transcribe(SPEECH)["text"] == "first"  # silence did not use up "first"
    assert stt.transcribe(SILENCE)["text"] == ""
    assert stt.transcribe(SPEECH)["text"] == "second"
    assert stt.calls == 2
    monkeypatch.delenv("LAWNMOWER_VOICE_FAKE_TEXTS")
    assert stt.transcribe(SPEECH)["text"] == "the single text"
    monkeypatch.delenv("LAWNMOWER_VOICE_FAKE_TEXT")
    assert stt.transcribe(SPEECH)["text"] == DEFAULT_FAKE_TEXT


def test_a_rewritten_file_starts_over(tmp_path, monkeypatch, config):
    q = tmp_path / "q.json"
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(q, ["Hey Jade.", "what time is it?"]))
    stt = FakeSTT(config)
    assert [stt.transcribe(SPEECH)["text"] for _ in range(3)] == ["Hey Jade.", "what time is it?", "what time is it?"]
    write_queue(q, ["Hey Jude."])  # the next scenario
    assert [stt.transcribe(SPEECH)["text"] for _ in range(2)] == ["Hey Jude.", "Hey Jude."]
    write_queue(q, ["Hey Jude."])  # the same content again: no restart, the last entry repeats
    assert stt.transcribe(SPEECH)["text"] == "Hey Jude."
    write_queue(q, ["a", "b"])
    assert stt.transcribe(SPEECH)["text"] == "a"


def test_another_path_is_another_queue(tmp_path, monkeypatch, config):
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "a.json", ["a1", "a2"]))
    stt = FakeSTT(config)
    assert stt.transcribe(SPEECH)["text"] == "a1"
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "b.json", ["b1", "b2"]))
    assert stt.transcribe(SPEECH)["text"] == "b1"


@pytest.mark.parametrize(
    "content, reason",
    [
        (None, "cannot read"),
        ("not json", "is not JSON"),
        ("[]", "non-empty JSON array of strings"),
        ('{"a": 1}', "non-empty JSON array of strings"),
        ('["ok", 3]', "non-empty JSON array of strings"),
    ],
)
def test_a_bad_file_fails_loudly(tmp_path, content, reason):
    path = tmp_path / "q.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    with pytest.raises(EngineUnavailable, match=reason):
        FakeTextQueue(str(path)).next()


def test_utf8_with_a_bom_and_non_ascii_text(tmp_path):
    path = tmp_path / "q.json"
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps(["Hey Jade, ¿qué hora es?"], ensure_ascii=False).encode("utf-8"))
    assert FakeTextQueue(str(path)).next() == "Hey Jade, ¿qué hora es?"


def test_the_call_log(tmp_path, monkeypatch, config):
    log = tmp_path / "stt.jsonl"
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_STT_LOG", str(log))
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "q.json", ["Hey Jade.", "what time is it?"]))
    stt = FakeSTT(config)
    stt.transcribe(sine(220, 16000, 1.25, 0.3))
    stt.transcribe(SILENCE)  # not logged: it takes no entry
    stt.transcribe(SPEECH)
    lines = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert lines == [
        {"n": 1, "durationSec": 1.25, "text": "Hey Jade."},
        {"n": 2, "durationSec": 0.6, "text": "what time is it?"},
    ]


def test_over_http_the_queue_answers_call_by_call(tmp_path, monkeypatch, config, auth):
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", write_queue(tmp_path / "q.json", ["Hey Jade.", "what time is it?"]))
    from lawnmower_voice.fake import FakeTTS

    client = make_client(create_app(config, FakeSTT(config), FakeTTS(config)))
    body = wav_bytes(sine(220, 48000, 0.8, 0.3), 48000)
    texts = [client.post("/stt", content=body, headers={**auth, "Content-Type": "audio/wav"}).json()["text"] for _ in range(3)]
    assert texts == ["Hey Jade.", "what time is it?", "what time is it?"]


def test_over_http_a_bad_file_is_a_503_with_the_reason(tmp_path, monkeypatch, config, auth):
    monkeypatch.setenv("LAWNMOWER_VOICE_FAKE_TEXTS", str(tmp_path / "missing.json"))
    from lawnmower_voice.fake import FakeTTS

    client = make_client(create_app(config, FakeSTT(config), FakeTTS(config)))
    r = client.post("/stt", content=wav_bytes(SPEECH, 16000), headers={**auth, "Content-Type": "audio/wav"})
    assert r.status_code == 503
    assert "LAWNMOWER_VOICE_FAKE_TEXTS" in r.json()["error"]
