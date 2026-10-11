"""Phonemes / timestamps -> viseme timeline for the renderer's lip-sync.

Viseme ids are shared with the renderer (contract section 6)::

    sil, PP (m b p), FF (f v), TH, DD (t d n l), kk (k g), CH (ch j sh), SS (s z), RR (r),
    aa, E, I, O, U

Inputs understood:

* IPA as produced by espeak-ng (kokoro-onnx's phonemizer) - e.g. ``həlˈoʊ wˈɜːld``;
* misaki (Kokoro's own G2P), which adds single-letter diphthongs ``A I O W Y Q`` and
  symbols such as ``ʤ ʧ ᵊ ɾ``;
* plain text letters as a last resort (``visemes_from_text``).

Two ways to place them in time:

* :func:`visemes_from_timings` - per-phoneme ``(phoneme, start, end)`` from the TTS model's
  duration output (exact);
* :func:`visemes_from_phonemes` - only the total duration is known; phonemes are spread over
  the audible region weighted by class (vowels longer, stops shorter) with ``sil`` at
  punctuation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

VISEMES: tuple[str, ...] = ("sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "RR", "aa", "E", "I", "O", "U")
VOWEL_VISEMES = frozenset({"aa", "E", "I", "O", "U"})

# --- symbol tables ---------------------------------------------------------------------------

_CONSONANTS: dict[str, str] = {}


def _add(viseme: str, symbols: str) -> None:
    for s in symbols.split():
        _CONSONANTS[s] = viseme


_add("PP", "p b m ɸ β ʙ ɓ")
_add("FF", "f v ʋ ɱ")
_add("TH", "θ ð")
_add("DD", "t d n l ɾ ɫ ɬ ɮ ɗ ʈ ɖ ɳ ɭ ɽ ɲ ʎ ɺ ʟ ɴ")
_add("kk", "k g ɡ ŋ x ɣ q ɢ χ ħ ʕ h ɦ ʔ c ɟ ɰ ʍ")
_add("CH", "ʃ ʒ ʧ ʤ ɕ ʑ ʂ ʐ ç ʝ ʨ ʥ")
_add("SS", "s z ʦ ʣ")
_add("RR", "ɹ r ʁ ɻ ʀ ɚ ɝ ʴ ꭧ")

_VOWELS: dict[str, str] = {}


def _addv(viseme: str, symbols: str) -> None:
    for s in symbols.split():
        _VOWELS[s] = viseme


_addv("aa", "a ɑ ɐ æ ä ʌ ɒ ɶ")
_addv("E", "e ɛ ə ɘ ɜ ᵊ ɞ ɤ")
_addv("I", "i ɪ ɨ ᵻ j ʏ")
_addv("O", "o ɔ ø œ ɵ")
_addv("U", "u ʊ w ɯ ɥ y ʉ")

# Multi-character units (matched greedily before single symbols).
_MULTI: dict[str, tuple[str, ...]] = {
    "tʃ": ("CH",),
    "dʒ": ("CH",),
    "t͡ʃ": ("CH",),
    "d͡ʒ": ("CH",),
    "ts": ("SS",),
    "dz": ("SS",),
    "tɕ": ("CH",),
    "dʑ": ("CH",),
    "eɪ": ("E", "I"),
    "aɪ": ("aa", "I"),
    "ɑɪ": ("aa", "I"),
    "oʊ": ("O", "U"),
    "əʊ": ("E", "U"),
    "aʊ": ("aa", "U"),
    "ɔɪ": ("O", "I"),
    "ɪə": ("I", "E"),
    "eə": ("E", "E"),
    "ʊə": ("U", "E"),
}
_MULTI_KEYS = sorted(_MULTI, key=len, reverse=True)

# misaki single-letter diphthongs / extras.
_MISAKI: dict[str, tuple[str, ...]] = {
    "A": ("E", "I"),  # eɪ
    "I": ("aa", "I"),  # aɪ
    "O": ("O", "U"),  # oʊ
    "Q": ("E", "U"),  # əʊ (British)
    "W": ("aa", "U"),  # aʊ
    "Y": ("O", "I"),  # ɔɪ
    # Two more capitals exist in Kokoro's vocabulary (used by non-English G2P); best guesses.
    "S": ("SS",),
    "T": ("DD",),
}

# Characters that modify a neighbour rather than being a sound of their own.
_SUFFIX_MODIFIERS = frozenset(
    "\u02d0\u02d1"  # length marks: long, half-long
    "\u0329\u032f\u0303\u0325\u032c\u030a\u031a\u0361"  # combining: syllabic, non-syllabic, nasal, voiceless, voiced, ring, unreleased, tie
    "\u02b0\u02b2\u02b7\u02e0\u02e4\u02bc"  # aspirated, palatalised, labialised, velarised, pharyngealised, ejective
    "\u203f\u1d5d"  # linking undertie, Kokoro "compressed" (Japanese)
)  # merge into the previous unit
_PREFIX_MODIFIERS = frozenset("ˈˌ")  # stress: merge into the next unit
_PAUSE_PUNCT = frozenset(".,!?;:—–…()[]{}\"«»“”„¡¿、。，！？；：")
_WORD_GAP = frozenset(" \t\n\r-_/")
_IGNORED = frozenset("'`’‘^*#~|→↓↗↘")

# Relative durations used when only the total length is known.
_WEIGHTS = {
    "vowel": 1.0,
    "diphthong": 1.4,
    "PP": 0.62,
    "DD": 0.55,
    "kk": 0.6,
    "FF": 0.75,
    "TH": 0.75,
    "SS": 0.8,
    "CH": 0.8,
    "RR": 0.65,
    "gap": 0.25,
}
_PAUSE_WEIGHT = {",": 1.6, ";": 2.0, ":": 2.0, "—": 2.0, "–": 1.6, ".": 2.6, "!": 2.6, "?": 2.6, "…": 3.0}


@dataclass(frozen=True)
class Unit:
    """One articulatory unit: its visemes (1, or 2 for diphthongs) and weight."""

    visemes: tuple[str, ...]
    weight: float
    kind: str  # "sound" | "gap" | "pause"
    text: str


def _unit_for_symbol(sym: str) -> Unit | None:
    if sym in _MULTI:
        vs = _MULTI[sym]
        w = _WEIGHTS["diphthong"] if len(vs) > 1 else _WEIGHTS.get(vs[0], 0.7)
        return Unit(vs, w, "sound", sym)
    if sym in _MISAKI:
        vs = _MISAKI[sym]
        return Unit(vs, _WEIGHTS["diphthong"] if len(vs) > 1 else _WEIGHTS["DD"], "sound", sym)
    if sym in _VOWELS:
        return Unit((_VOWELS[sym],), _WEIGHTS["vowel"], "sound", sym)
    if sym in _CONSONANTS:
        v = _CONSONANTS[sym]
        return Unit((v,), _WEIGHTS.get(v, 0.7), "sound", sym)
    low = sym.lower()
    if low != sym and (low in _VOWELS or low in _CONSONANTS):
        return _unit_for_symbol(low)
    return None


def viseme_for(phoneme: str) -> str | None:
    """Primary viseme of one phoneme symbol (``None`` for modifiers and unknown symbols)."""
    if not phoneme:
        return None
    if phoneme in _PAUSE_PUNCT:
        return "sil"
    u = _unit_for_symbol(phoneme)
    return u.visemes[0] if u else None


def tokenize(phonemes: str) -> list[Unit]:
    """Split a phoneme string into articulatory units (greedy multi-char match)."""
    units: list[Unit] = []
    i = 0
    s = phonemes or ""
    n = len(s)
    while i < n:
        ch = s[i]
        if ch in _PAUSE_PUNCT:
            units.append(Unit(("sil",), _PAUSE_WEIGHT.get(ch, 1.2), "pause", ch))
            i += 1
            continue
        if ch in _WORD_GAP:
            if units and units[-1].kind == "gap":
                i += 1
                continue
            units.append(Unit(("sil",), _WEIGHTS["gap"], "gap", ch))
            i += 1
            continue
        if ch in _SUFFIX_MODIFIERS:
            if ch in "ːˑ" and units and units[-1].kind == "sound":
                prev = units[-1]
                units[-1] = Unit(prev.visemes, prev.weight * (1.5 if ch == "ː" else 1.25), prev.kind, prev.text + ch)
            i += 1
            continue
        if ch in _PREFIX_MODIFIERS or ch in _IGNORED:
            i += 1
            continue
        matched = False
        for key in _MULTI_KEYS:
            if s.startswith(key, i):
                u = _unit_for_symbol(key)
                if u:
                    units.append(u)
                    i += len(key)
                    matched = True
                    break
        if matched:
            continue
        u = _unit_for_symbol(ch)
        if u:
            units.append(u)
        i += 1
    # Trim leading/trailing gaps (pauses are kept: they become sil).
    while units and units[0].kind == "gap":
        units.pop(0)
    while units and units[-1].kind == "gap":
        units.pop()
    return units


def _round(t: float) -> float:
    return round(max(0.0, float(t)), 3)


def normalize_timeline(items: Iterable[dict], duration: float, min_dur: float = 0.015) -> list[dict]:
    """Clean a raw timeline: sort, clamp to ``[0, duration]``, fill gaps with ``sil``, merge
    consecutive identical visemes and absorb slivers shorter than ``min_dur``."""
    duration = max(0.0, float(duration))
    raw = sorted(
        ({"start": max(0.0, float(it["start"])), "end": min(duration, float(it["end"])), "viseme": it["viseme"]} for it in items),
        key=lambda d: (d["start"], d["end"]),
    )
    out: list[dict] = []
    t = 0.0
    for it in raw:
        if it["viseme"] not in VISEMES:
            continue
        start = max(it["start"], t)
        end = it["end"]
        if end - start <= 1e-6:
            continue
        if start - t > 1e-6:
            out.append({"start": t, "end": start, "viseme": "sil"})
        out.append({"start": start, "end": end, "viseme": it["viseme"]})
        t = end
    if duration - t > 1e-6:
        out.append({"start": t, "end": duration, "viseme": "sil"})

    # Absorb slivers into the previous (or next) segment.
    cleaned: list[dict] = []
    for seg in out:
        if cleaned and seg["end"] - seg["start"] < min_dur:
            cleaned[-1]["end"] = seg["end"]
            continue
        cleaned.append(dict(seg))
    if len(cleaned) > 1 and cleaned[0]["end"] - cleaned[0]["start"] < min_dur:
        cleaned[1]["start"] = cleaned[0]["start"]
        cleaned.pop(0)

    merged: list[dict] = []
    for seg in cleaned:
        if merged and merged[-1]["viseme"] == seg["viseme"]:
            merged[-1]["end"] = seg["end"]
        else:
            merged.append(seg)
    result = [{"start": _round(s["start"]), "end": _round(s["end"]), "viseme": s["viseme"]} for s in merged]
    if not result and duration > 0:
        result = [{"start": 0.0, "end": _round(duration), "viseme": "sil"}]
    if result:
        result[-1]["end"] = _round(duration)
    return [r for r in result if r["end"] > r["start"]]


def _emit(unit: Unit, start: float, end: float, out: list[dict]) -> None:
    if end <= start:
        return
    if len(unit.visemes) == 1:
        out.append({"start": start, "end": end, "viseme": unit.visemes[0]})
        return
    # Diphthong: 60 % on the first target, 40 % on the glide.
    mid = start + (end - start) * 0.6
    out.append({"start": start, "end": mid, "viseme": unit.visemes[0]})
    out.append({"start": mid, "end": end, "viseme": unit.visemes[1]})


def visemes_from_phonemes(
    phonemes: str,
    duration: float,
    speech_start: float = 0.0,
    speech_end: float | None = None,
) -> list[dict]:
    """Spread ``phonemes`` over ``[speech_start, speech_end]`` weighted by phoneme class.

    Everything outside the audible region is ``sil``; punctuation becomes ``sil`` too.
    """
    duration = max(0.0, float(duration))
    end = duration if speech_end is None else min(duration, max(0.0, float(speech_end)))
    start = min(max(0.0, float(speech_start)), end)
    units = tokenize(phonemes)
    if not units or end - start <= 0:
        return normalize_timeline([], duration)
    # Leading/trailing pauses (e.g. a final ".") belong to the silent tail, not the speech span.
    while units and units[-1].kind == "pause":
        units.pop()
    while units and units[0].kind == "pause":
        units.pop(0)
    if not units:
        return normalize_timeline([], duration)
    total = sum(u.weight for u in units)
    span = end - start
    t = start
    out: list[dict] = []
    for u in units:
        d = span * (u.weight / total)
        if u.kind == "gap":
            # Short word gaps keep the previous mouth shape rather than snapping shut.
            if out:
                out[-1]["end"] = t + d
        else:
            _emit(u, t, t + d, out)
        t += d
    return normalize_timeline(out, duration)


#: Kokoro's audio runs ahead of the times its predicted durations give. Measured on real clips
#: (af_heart and am_michael, six sentences each, speeds 0.8 / 1.0 / 1.35): acoustic onsets after a
#: pause, the level dip of m / b / p between vowels and the cross-correlation of the timeline's
#: openness with the level envelope all come 47-62 ms early, about one 25 ms frame plus one frame
#: scaled by 1 / speed. :func:`kokoro_audio_lead` is that offset; the TTS backends shift their
#: timelines by it, so a timeline describes the audio (the renderer adds its own visual lead).
KOKORO_LEAD_FIXED = 0.025
KOKORO_LEAD_PER_SPEED = 0.025


def kokoro_audio_lead(speed: float | None = 1.0) -> float:
    """Seconds by which Kokoro's audio precedes its duration-derived phoneme times."""
    sp = float(speed) if speed else 1.0
    return KOKORO_LEAD_FIXED + KOKORO_LEAD_PER_SPEED / min(2.0, max(0.5, sp))


def visemes_from_timings(timings: Sequence, duration: float, gap_sil: float = 0.12, shift: float = 0.0) -> list[dict]:
    """Convert per-phoneme timings into a viseme timeline.

    ``timings`` items are ``(phoneme, start, end)`` tuples, dicts with those keys, or objects
    with ``phoneme/start/end`` attributes (kokoro-onnx ``Timing``). Stress marks lend their time
    to the next phoneme, length marks to the previous one, word gaps shorter than ``gap_sil``
    keep the previous shape, punctuation is ``sil``. ``shift`` (seconds) moves every timing, e.g.
    ``-kokoro_audio_lead(speed)`` to line Kokoro's durations up with its audio.
    """
    items: list[tuple[str, float, float]] = []
    for t in timings or ():
        if isinstance(t, dict):
            ph, s, e = t.get("phoneme", ""), t.get("start", 0.0), t.get("end", 0.0)
        elif isinstance(t, (tuple, list)):
            ph, s, e = t[0], t[1], t[2]
        else:
            ph, s, e = getattr(t, "phoneme", ""), getattr(t, "start", 0.0), getattr(t, "end", 0.0)
        try:
            s, e = float(s), float(e)
        except (TypeError, ValueError):
            continue
        if e < s:
            s, e = e, s
        items.append((str(ph), s + shift, e + shift))
    if not items:
        return normalize_timeline([], duration)

    # Group symbols into units with time spans, applying the modifier rules.
    out: list[dict] = []
    pending_start: float | None = None  # stress mark time carried into the next unit
    i = 0
    n = len(items)
    while i < n:
        ph, s, e = items[i]
        if pending_start is not None:
            s = min(s, pending_start)
        if ph in _PREFIX_MODIFIERS or ph in _IGNORED:
            pending_start = s if pending_start is None else pending_start
            i += 1
            continue
        pending_start = None
        if ph in _SUFFIX_MODIFIERS:
            if out:
                out[-1]["end"] = max(out[-1]["end"], e)
            i += 1
            continue
        if ph in _PAUSE_PUNCT:
            out.append({"start": s, "end": e, "viseme": "sil"})
            i += 1
            continue
        if ph in _WORD_GAP or not ph.strip():
            if e - s >= gap_sil or not out:
                out.append({"start": s, "end": e, "viseme": "sil"})
            else:
                out[-1]["end"] = max(out[-1]["end"], e)
            i += 1
            continue
        # Try to join this and the next symbol into a multi-char unit (tʃ, eɪ, ...).
        unit = None
        if i + 1 < n:
            pair = ph + items[i + 1][0]
            if pair in _MULTI:
                unit = _unit_for_symbol(pair)
                if unit:
                    e = max(e, items[i + 1][2])
                    i += 1
        if unit is None:
            unit = _unit_for_symbol(ph) if len(ph) == 1 else None
            if unit is None and len(ph) > 1:
                sub = tokenize(ph)
                sounds = [u for u in sub if u.kind == "sound"]
                if sounds:
                    span = (e - s) / len(sounds)
                    for k, u in enumerate(sounds):
                        _emit(u, s + k * span, s + (k + 1) * span, out)
                i += 1
                continue
        if unit is not None:
            _emit(unit, s, e, out)
        elif out:
            out[-1]["end"] = max(out[-1]["end"], e)  # unknown symbol: hold the previous shape
        i += 1
    return normalize_timeline(out, duration)


# --- text fallback (no phonemes available) ---------------------------------------------------

_LETTER_PHONEMES = {
    "a": "æ", "e": "ɛ", "i": "ɪ", "o": "ɒ", "u": "ʌ", "y": "i",
    "b": "b", "c": "k", "d": "d", "f": "f", "g": "ɡ", "h": "h", "j": "dʒ", "k": "k", "l": "l",
    "m": "m", "n": "n", "p": "p", "q": "k", "r": "ɹ", "s": "s", "t": "t", "v": "v", "w": "w",
    "x": "ks", "z": "z",
}
_DIGRAPHS = {"th": "θ", "sh": "ʃ", "ch": "tʃ", "ph": "f", "ng": "ŋ", "ck": "k", "oo": "u", "ee": "i", "ea": "i", "ou": "aʊ", "ow": "oʊ", "ai": "eɪ", "ay": "eɪ", "oi": "ɔɪ", "oy": "ɔɪ", "wh": "w", "qu": "kw"}


def text_to_pseudo_phonemes(text: str) -> str:
    """Very rough letter-to-sound conversion used when no G2P is available."""
    s = (text or "").lower()
    out: list[str] = []
    i = 0
    while i < len(s):
        two = s[i : i + 2]
        if two in _DIGRAPHS:
            out.append(_DIGRAPHS[two])
            i += 2
            continue
        ch = s[i]
        if ch in _LETTER_PHONEMES:
            if i + 1 < len(s) and s[i + 1] == ch:  # double letters sound once
                i += 1
            out.append(_LETTER_PHONEMES[ch])
        elif ch.isdigit():
            out.append("ɛ")
        elif ch in _PAUSE_PUNCT or ch in _WORD_GAP:
            out.append(ch)
        i += 1
    return "".join(out)


def visemes_from_text(text: str, duration: float, speech_start: float = 0.0, speech_end: float | None = None) -> list[dict]:
    """Approximate visemes straight from text (no phonemizer available)."""
    return visemes_from_phonemes(text_to_pseudo_phonemes(text), duration, speech_start, speech_end)
