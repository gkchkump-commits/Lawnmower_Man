from __future__ import annotations

from dataclasses import dataclass

import pytest

from lawnmower_voice.visemes import (
    VISEMES,
    kokoro_audio_lead,
    normalize_timeline,
    text_to_pseudo_phonemes,
    tokenize,
    viseme_for,
    visemes_from_phonemes,
    visemes_from_text,
    visemes_from_timings,
)


def assert_valid(tl, duration):
    assert tl, "timeline must not be empty"
    assert tl[0]["start"] == 0.0
    assert tl[-1]["end"] == pytest.approx(duration, abs=1e-3)
    for a, b in zip(tl, tl[1:]):
        assert a["end"] == pytest.approx(b["start"], abs=1e-3), (a, b)
        assert a["viseme"] != b["viseme"], "consecutive duplicates must be merged"
    for seg in tl:
        assert seg["viseme"] in VISEMES
        assert seg["end"] > seg["start"]
        assert set(seg) == {"start", "end", "viseme"}


@pytest.mark.parametrize(
    "ph, vis",
    [
        ("m", "PP"), ("b", "PP"), ("p", "PP"),
        ("f", "FF"), ("v", "FF"),
        ("θ", "TH"), ("ð", "TH"),
        ("t", "DD"), ("d", "DD"), ("n", "DD"), ("l", "DD"), ("ɾ", "DD"),
        ("k", "kk"), ("ɡ", "kk"), ("g", "kk"), ("ŋ", "kk"),
        ("ʃ", "CH"), ("ʒ", "CH"), ("ʧ", "CH"), ("ʤ", "CH"),
        ("s", "SS"), ("z", "SS"),
        ("ɹ", "RR"), ("r", "RR"), ("ɚ", "RR"),
        ("a", "aa"), ("ɑ", "aa"), ("æ", "aa"), ("ʌ", "aa"),
        ("e", "E"), ("ɛ", "E"), ("ə", "E"), ("ɜ", "E"), ("ᵊ", "E"),
        ("i", "I"), ("ɪ", "I"), ("j", "I"), ("ᵻ", "I"),
        ("o", "O"), ("ɔ", "O"),
        ("u", "U"), ("ʊ", "U"), ("w", "U"),
        (".", "sil"), (",", "sil"), ("?", "sil"),
        ("A", "E"), ("I", "aa"), ("O", "O"), ("W", "aa"), ("Y", "O"),  # misaki diphthongs (first target)
        ("ˈ", None), ("ː", None),
    ],
)
def test_viseme_table(ph, vis):
    assert viseme_for(ph) == vis


def test_tokenize_groups_multichar_units():
    units = tokenize("tʃeɪn dʒˈɑːb")
    names = [u.text for u in units]
    assert names == ["tʃ", "eɪ", "n", " ", "dʒ", "ɑː", "b"]
    assert units[1].visemes == ("E", "I")
    assert units[5].weight > 1.0  # length mark makes the vowel longer


def test_timings_with_kokoro_like_objects():
    @dataclass(frozen=True)
    class Timing:
        phoneme: str
        start: float
        end: float

    # "həlˈoʊ, wˈɜːld" with a comma pause
    seq = [("h", 0.05, 0.10), ("ə", 0.10, 0.16), ("l", 0.16, 0.22), ("ˈ", 0.22, 0.23), ("o", 0.23, 0.31), ("ʊ", 0.31, 0.38),
           (",", 0.38, 0.55), (" ", 0.55, 0.58), ("w", 0.58, 0.63), ("ˈ", 0.63, 0.64), ("ɜ", 0.64, 0.72), ("ː", 0.72, 0.76),
           ("l", 0.76, 0.82), ("d", 0.82, 0.88)]
    tl = visemes_from_timings([Timing(*s) for s in seq], duration=1.0)
    assert_valid(tl, 1.0)
    vis = [s["viseme"] for s in tl]
    assert vis[0] == "sil" and tl[0]["end"] == pytest.approx(0.05)
    assert vis[1:5] == ["kk", "E", "DD", "O"]
    # stress mark time moved into the following vowel
    o = next(s for s in tl if s["viseme"] == "O")
    assert o["start"] == pytest.approx(0.22)
    assert "sil" in vis[5:7]  # comma pause
    # length mark extended the vowel, final silence fills to the end
    e2 = [s for s in tl if s["viseme"] == "E"][-1]
    assert e2["end"] == pytest.approx(0.76)
    assert tl[-1] == {"start": 0.88, "end": 1.0, "viseme": "sil"}


def test_timings_accept_tuples_dicts_and_diphthong_pairs():
    tl = visemes_from_timings([("e", 0.0, 0.1), ("ɪ", 0.1, 0.2), {"phoneme": "m", "start": 0.2, "end": 0.3}], 0.3)
    assert_valid(tl, 0.3)
    assert [s["viseme"] for s in tl] == ["E", "I", "PP"]
    # misaki single-letter diphthong is split 60/40
    tl = visemes_from_timings([("A", 0.0, 0.2)], 0.2)
    assert [s["viseme"] for s in tl] == ["E", "I"]
    assert tl[0]["end"] == pytest.approx(0.12)


def test_shift_moves_the_timeline_and_kokoro_lead_depends_on_speed():
    seq = [("p", 0.2, 0.3), ("a", 0.3, 0.5)]
    tl = visemes_from_timings(seq, 0.6, shift=-0.05)
    assert [(s["viseme"], s["start"], s["end"]) for s in tl] == [("sil", 0.0, 0.15), ("PP", 0.15, 0.25), ("aa", 0.25, 0.45), ("sil", 0.45, 0.6)]
    # a shift past the clip start is clamped (no negative times)
    early = visemes_from_timings([("a", 0.02, 0.2)], 0.3, shift=-0.05)
    assert early[0] == {"start": 0.0, "end": 0.15, "viseme": "aa"}
    # measured on Kokoro: ~50 ms at speed 1, a little more when it speaks slowly
    assert kokoro_audio_lead(1.0) == pytest.approx(0.05)
    assert kokoro_audio_lead(None) == pytest.approx(0.05)
    assert kokoro_audio_lead(0.8) == pytest.approx(0.05625)
    assert kokoro_audio_lead(1.35) < kokoro_audio_lead(1.0) < kokoro_audio_lead(0.8)
    assert kokoro_audio_lead(0.1) == kokoro_audio_lead(0.5)  # clamped like the server's speed


def test_short_word_gap_holds_shape_long_gap_is_silence():
    short = visemes_from_timings([("a", 0.0, 0.1), (" ", 0.1, 0.14), ("a", 0.14, 0.24)], 0.24)
    assert [s["viseme"] for s in short] == ["aa"]
    long = visemes_from_timings([("a", 0.0, 0.1), (" ", 0.1, 0.3), ("a", 0.3, 0.4)], 0.4)
    assert [s["viseme"] for s in long] == ["aa", "sil", "aa"]


def test_distribution_weights_and_bounds():
    tl = visemes_from_phonemes("pɑp", 1.0, speech_start=0.2, speech_end=0.8)
    assert_valid(tl, 1.0)
    assert [s["viseme"] for s in tl] == ["sil", "PP", "aa", "PP", "sil"]
    dur = {s["viseme"] + str(i): s["end"] - s["start"] for i, s in enumerate(tl)}
    assert dur["aa2"] > dur["PP1"]  # vowels last longer than stops
    assert tl[0]["end"] == pytest.approx(0.2) and tl[-1]["start"] == pytest.approx(0.8)


def test_distribution_inserts_silence_at_punctuation():
    tl = visemes_from_phonemes("hˈɛlO, wˈɜɹld.", 1.5)
    assert_valid(tl, 1.5)
    vis = [s["viseme"] for s in tl]
    i = vis.index("sil")
    assert 0 < i < len(vis) - 1  # the comma pause sits inside the utterance
    assert vis[-1] != "sil"  # trailing '.' does not steal speech time


def test_empty_and_garbage_inputs():
    for tl in (visemes_from_phonemes("", 0.5), visemes_from_timings([], 0.5), visemes_from_phonemes("☃☃", 0.5)):
        assert tl == [{"start": 0.0, "end": 0.5, "viseme": "sil"}]
    assert visemes_from_phonemes("abc", 0.0) == []


def test_text_fallback():
    assert text_to_pseudo_phonemes("Ship the cheese") == "ʃɪp θɛ tʃisɛ"
    tl = visemes_from_text("Hello, world!", 1.2)
    assert_valid(tl, 1.2)
    vis = [s["viseme"] for s in tl]
    assert "sil" in vis and "U" in vis and "DD" in vis


def test_normalize_merges_and_absorbs_slivers():
    raw = [
        {"start": 0.0, "end": 0.1, "viseme": "aa"},
        {"start": 0.1, "end": 0.105, "viseme": "PP"},  # sliver -> absorbed
        {"start": 0.105, "end": 0.2, "viseme": "aa"},
        {"start": 0.25, "end": 0.3, "viseme": "bogus"},  # unknown id dropped -> gap becomes sil
    ]
    tl = normalize_timeline(raw, 0.3)
    assert tl == [{"start": 0.0, "end": 0.2, "viseme": "aa"}, {"start": 0.2, "end": 0.3, "viseme": "sil"}]


def test_overlapping_input_is_made_monotonic():
    raw = [{"start": 0.0, "end": 0.2, "viseme": "aa"}, {"start": 0.1, "end": 0.3, "viseme": "O"}]
    tl = normalize_timeline(raw, 0.3)
    assert_valid(tl, 0.3)
    assert tl[1]["start"] == pytest.approx(0.2)
