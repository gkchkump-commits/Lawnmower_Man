"""Synthesize the "Hey Jade" engine-test fixtures (contract-wake §11.4) with Kokoro on the CPU.

    python -I tools/wake/make-fixtures.py <kokoro models dir> [out dir = tests/fixtures/wake]

Needs kokoro-onnx, onnxruntime, numpy and scipy (the voice venv, or any venv with them); the
models dir holds kokoro/kokoro-v1.0.onnx and kokoro/voices-v1.0.bin (the app's own Kokoro files).
Writes <out>/<id>.wav (16 kHz mono PCM16; 0.30 s lead and tail of digital silence, peak −6 dBFS,
as in the research eval set) and <out>/manifest.tsv with the columns

    id  class  text  voice  speed  jadeEndSec

jadeEndSec is where the word "Jade" ends (the first one; -1 when there is none): Kokoro's predicted
phoneme durations, corrected for its audio lead (lawnmower_voice/visemes.py kokoro_audio_lead) and
refined to the last 10 ms frame above -30 dB re the clip peak (wake/eval/scripts/jade_end.py).
Kokoro voices are Apache-2.0 (the app already uses them). Deterministic for a given Kokoro version.
"""
import os
import sys
import wave

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

LEAD, TAIL = 0.30, 0.30  # (the engine test puts 1 s of noise between clips; ≤ 2.5 MB in total)

# (id, class, text, voice, speed). Classes: pos (a call), jude (the song title), self (her own
# allowed lines, in her default voice af_heart), selfbad (a line the persona forbids: it SHOULD fire,
# which is why the text mask exists), neg (ordinary speech), name ("Jade, …" without "hey"), pause
# ("Hey Jade." + 1.5 s + a command; the e2e uses it).
CLIPS = [
    ("pos_hey_af_heart", "pos", "Hey Jade.", "af_heart", 1.0),
    ("pos_hey_am_michael", "pos", "Hey Jade.", "am_michael", 1.0),
    ("pos_hey_bf_emma", "pos", "Hey Jade.", "bf_emma", 1.0),
    ("pos_hey_bm_george", "pos", "Hey Jade.", "bm_george", 1.0),
    ("pos_cmd_af_bella", "pos", "Hey Jade, what time is it?", "af_bella", 1.0),
    ("pos_cmd_am_adam", "pos", "Hey Jade, what time is it?", "am_adam", 1.0),
    ("pos_cmd_bf_lily", "pos", "Hey Jade, what time is it?", "bf_lily", 1.0),
    ("pos_cmd_bm_lewis", "pos", "Hey Jade, what time is it?", "bm_lewis", 1.0),
    ("pos_comma_af_heart", "pos", "Hey, Jade!", "af_heart", 1.0),
    ("pos_comma_am_michael", "pos", "Hey, Jade!", "am_michael", 1.0),
    ("jude_af_heart", "jude", "Hey Jude.", "af_heart", 1.0),
    ("jude_am_michael", "jude", "Hey Jude.", "am_michael", 1.0),
    ("jude_bf_emma", "jude", "Hey Jude.", "bf_emma", 1.0),
    ("judesong_af_heart", "jude", "Hey Jude, don't make it bad.", "af_heart", 1.0),
    ("judesong_am_michael", "jude", "Hey Jude, don't make it bad.", "am_michael", 1.0),
    ("judesong_bf_emma", "jude", "Hey Jude, don't make it bad.", "bf_emma", 1.0),
    ("self_name", "self", "My name is Jade, and I run on Claude.", "af_heart", 1.0),
    ("self_here", "self", "Jade here. What can I do for you?", "af_heart", 1.0),
    ("self_call", "self", "You can call me Jade.", "af_heart", 1.0),
    ("self_sure", "self", "Sure, Jade can help with that.", "af_heart", 1.0),
    ("selfbad_1.0", "selfbad", "Just say hey Jade whenever you need me.", "af_heart", 1.0),
    ("selfbad_0.9", "selfbad", "Just say hey Jade whenever you need me.", "af_heart", 0.9),
    ("neg_siri", "neg", "Hey Siri, set a timer.", "am_adam", 1.0),
    ("neg_necklace", "neg", "She wore the jade necklace.", "bf_lily", 1.0),
    ("neg_commits", "neg", "Please read me the last three commits.", "am_michael", 1.0),
    ("neg_meeting", "neg", "The meeting has been moved to Thursday afternoon.", "bf_emma", 1.0),
    ("neg_ship", "neg", "Okay, that looks good, ship it.", "bm_george", 1.0),
    ("name_am_michael", "name", "Jade, what's on my calendar today?", "am_michael", 1.0),
    ("name_bf_emma", "name", "Jade, what's on my calendar today?", "bf_emma", 1.0),
]
PAUSE = ("pause_am_adam", "pause", "Hey Jade.", "What's the weather tomorrow?", "am_adam", 1.0, 1.5)


def kokoro(models: str) -> Kokoro:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(os.path.join(models, "kokoro", "kokoro-v1.0.onnx"), opts, providers=["CPUExecutionProvider"])
    return Kokoro.from_session(sess, os.path.join(models, "kokoro", "voices-v1.0.bin"))


def synth(k: Kokoro, text: str, voice: str, speed: float):
    """16 kHz float audio (no padding) and Kokoro's phoneme timings."""
    lang = "en-gb" if voice[0] == "b" else "en-us"
    a, _sr, tm = k.create_timed(text, voice=voice, speed=speed, lang=lang)
    return resample_poly(a.astype(np.float64), 2, 3), tm


def jade_end(tm, speed: float, x: np.ndarray, offset: float) -> float:
    """End of the first word "Jade" in x (seconds), or -1. `offset` = where the synth starts in x."""
    ph = [t.phoneme for t in tm]
    lead = 0.025 + 0.025 / speed  # kokoro_audio_lead() in voice/lawnmower_voice/visemes.py
    fr = x[: len(x) // 160 * 160].reshape(-1, 160)
    e = np.sqrt((fr ** 2).mean(1))
    thr = e.max() * 10 ** (-30 / 20)
    for i in range(len(ph) - 1):
        if ph[i] == "d" and ph[i + 1] == "ʒ" and (i == 0 or ph[i - 1] in " ,.!?"):
            j = i + 2
            while j < len(ph) and ph[j] not in " ,.!?;:":
                j += 1
            word = "".join(ph[i:j]).replace("ˈ", "").replace("ˌ", "")
            if not word.startswith("dʒeɪd"):
                continue
            st = tm[i].start - lead + offset
            en = tm[j - 1].end - lead + offset
            lo, hi = int(st * 100), int(en * 100) + 1
            idx = np.where(e[lo:hi] > thr)[0]
            return round((lo + idx.max() + 1) / 100, 2) if len(idx) else round(en, 2)
    return -1.0


def write(path: str, x: np.ndarray) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    models = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "..", "tests", "fixtures", "wake")
    os.makedirs(out, exist_ok=True)
    k = kokoro(models)
    rows = []
    for cid, cls, text, voice, speed in CLIPS:
        a, tm = synth(k, text, voice, speed)
        x = np.concatenate([np.zeros(int(LEAD * 16000)), a, np.zeros(int(TAIL * 16000))])
        x = x / max(1e-9, np.abs(x).max()) * 0.5
        je = jade_end(tm, speed, x, LEAD) if "jade" in text.lower() else -1.0
        write(os.path.join(out, cid + ".wav"), x)
        rows.append((cid, cls, text, voice, speed, je))
        print(cid, je, flush=True)
    cid, cls, t1, t2, voice, speed, gap = PAUSE
    a1, tm1 = synth(k, t1, voice, speed)
    a2, _ = synth(k, t2, voice, speed)
    x = np.concatenate([np.zeros(int(LEAD * 16000)), a1, np.zeros(int(gap * 16000)), a2, np.zeros(int(TAIL * 16000))])
    x = x / max(1e-9, np.abs(x).max()) * 0.5
    je = jade_end(tm1, speed, x, LEAD)
    write(os.path.join(out, cid + ".wav"), x)
    rows.append((cid, cls, f"{t1} … {t2}", voice, speed, je))
    print(cid, je, flush=True)
    with open(os.path.join(out, "manifest.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("id\tclass\ttext\tvoice\tspeed\tjadeEndSec\n")
        for r in rows:
            f.write("\t".join(str(v) for v in r) + "\n")
    print("wrote", len(rows), "clips to", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
