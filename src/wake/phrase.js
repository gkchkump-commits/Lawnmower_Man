// "Hey Jade": what the transcripts say (contract-wake §8.6; the rules measured in eval.md §7.1).
//
// Two transcripts per wake, both from the app's own /stt (faster-whisper on the GPU, no
// hotwords, no prompt: biasing turned "Hey Jay" into "hey Jade"):
//   * the wake segment (≤ 1.2 s before the end of "Jade" → when stage 1 decided, ≤ 0.6 s after
//     it): veto() decides whether the stage-1 hit was a real call. It rejects rival names ("Hey
//     Jude", "Hey Jay", "Hey Jodie"), her own lines ("I'm Jade", "Jade here", "say hey Jade") and
//     speech that is no call at all; everything else is accepted. The segment ends right after the
//     name, so the call is at its start or, after a lead-in ("Okay, so, hey Jade", TV words before
//     it), at its end: both are looked at. A veto, not a "must start with hey jade" rule: Whisper
//     writes "I enjoyed it" or "Hey Jayden" for about a quarter of isolated clean "Hey Jade."s.
//   * the command (the audio after the keyword's end, cut by stage 1's timing): decideCommand()
//     turns it into what the app does: send it to Claude, stop her, close the window, or keep
//     listening. stripCall() removes a residual "Jade," (or a whole "So, hey Jade,") first.
// The transcript fallback (no wake-word engine, §8.7) uses the stricter confirm rule instead:
// confirmCall() wants a greeting + her name at the start.
//
// Pure: unit-tested against the eval's real Whisper outputs (tests/unit/wake/phrase.test.js).

/**
 * Lower-case words: ’ → ', everything but [a-z0-9'] separates words.
 * @param {string} text @returns {string[]}
 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** jade jaid jayde jada gade (not jude, jay, jane, james, jaden, jed; the eval's exact pattern) */
export const JADE_LIKE = /^[jg](?:a|ai|ay|ei|ey|ae)i?d(?:e|ed|es|a)?$/;
/**
 * names and words Whisper hears instead of her name (eval.md §7.2; "joey" added after its one
 * AGC-mix leak; Jodie, Gage, JD/DJ, Dre after the review's fresh near-name and noisy-mix clips
 * woke her through the whole cascade). Not "joy" / "join": Whisper writes "Hey, joy!" for a clean
 * male "Hey Jade" about ten times as often as for a noisy "Hey Jane" (11 positives vs 4 hard
 * negatives in the eval's transcripts)
 */
export const RIVAL = /^(?:jud\w*|juj\w*|jay|jays|j|jane|james|jams|jim|jimmy|jamie|jake|jen|jenn|jean|jack|joe|joey|jed|jason|jess|jesse|dave|kate|grace|wade|shade|fade|they|day|jod(?:y|ie|i|ee)(?:'s)?|jo|jd|dj|dre|gage|gauge)$/;
/** "Jude" as Whisper writes it, also when the segment cuts it short ("Hey, Jujoo!") */
export const JUDE_LIKE = /^ju[dj]\w*$/;
/** "Jayden": Whisper's spelling of a real isolated "Hey Jade." too, so it counts as a rival only with words after it */
const JAYDEN_LIKE = /^ja[iy]?d[eo]n$/;
/** her telling someone how to call her ("just say hey Jade"): a self line */
const SAY = /^(?:say|says|said|saying)$/;
/** what a "hey" becomes in a transcript */
export const HEY_LIKE = /^(?:hey|hay|hi|heya|hello|helly|hell|how|a|ay|eh|oh|harry|helen|i)$/;

/** Closes a command or follow-up window without calling Claude (matched on the normalized words). */
export const ENDERS = /^(?:thanks?(?: you)?(?: jade)?|that'?s all|no thanks|goodbye|bye|never ?mind|nothing|forget it|stop)\W*$/i;
/** Stops her (and the running turn) when something runs; otherwise ends the window silently. */
export const STOP_WORDS = /^(?:stop|cancel|be quiet|quiet|shut up|cancel that|stop talking|that'?s enough)\W*$/i;
/** "Hey Jade, stop listening": turns the wake word off (turning it on again is never possible by voice). */
export const STOP_LISTENING = /^(?:stop listening|go to sleep|mic off|turn (?:the )?(?:mic|microphone) off)\W*$/i;
/** "Never mind" stops a running turn too (BRG-4), but only closes an idle window. */
const NEVER_MIND = /^never ?mind\W*$/i;

/** Words that make a leading "I'm/call me/it's … Jade" her own line. */
// (as measured in eval.md §7.1, whose rule also had "this is", "again" and "says")
const SELF_INTRO = [['i\'m'], ['im'], ['i', 'am'], ['my', 'name', 'is'], ['my', 'names'], ['call', 'me'], ['it\'s'], ['its'], ['this', 'is'], ['as'], ['me']];
const SELF_AFTER = /^(?:here|is|can|will|speaking|again)$/;

/**
 * Her own way of talking about herself, in the first 6 words: "I'm Jade", "my name is Jade",
 * "call me Jade", "this is Jade"…; a leading "Jade here / is / can / will / speaking / again"; a
 * leading "(just) okay / ok / say Jade" (lines the persona forbids, which every engine wakes on).
 * @param {string[]} words normalized
 */
export function selfTalk(words) {
  const w = words.slice(0, 6);
  for (let k = 0; k < w.length; k++) {
    if (!JADE_LIKE.test(w[k])) continue;
    for (const intro of SELF_INTRO) {
      const s = k - intro.length;
      if (s >= 0 && intro.every((x, i) => w[s + i] === x)) return true;
    }
  }
  if (w.length >= 2 && JADE_LIKE.test(w[0]) && SELF_AFTER.test(w[1])) return true;
  const i = w[0] === 'just' ? 1 : 0;
  if (/^(?:okay|ok|say|says)$/.test(w[i] || '') && JADE_LIKE.test(w[i + 1] || '')) return true;
  // "(just) say hey Jade" anywhere (the line the persona forbids, which every engine wakes on)
  for (let k = 1; k < words.length; k++) {
    if (!JADE_LIKE.test(words[k])) continue;
    if (SAY.test(words[k - 1]) || (k >= 2 && HEY_LIKE.test(words[k - 1]) && SAY.test(words[k - 2]))) return true;
  }
  return false;
}

/**
 * @typedef {{ ok: true } | { ok: false, reason: 'jude'|'rival'|'self'|'no-call'|'empty' }} VetoResult
 */

/**
 * Stage 2: was the stage-1 hit a call? Applied to the wake-segment transcript only.
 * 'full' (Less, Normal): rival names and non-calls are rejected too; 'jude' (More): only "Jude"
 * and her own lines (better recall in noise, more "Hey Jay" wakes).
 * @param {string} text @param {'full'|'jude'} [mode]
 * @returns {VetoResult}
 */
export function veto(text, mode = 'full') {
  const words = normalize(text);
  if (!words.length) return { ok: false, reason: 'empty' };
  const first3 = words.slice(0, 3);
  // "Jude" anywhere in the short segment: the song, also after a lead-in ("I, uh, hey Jude")
  if (words.some((w) => JUDE_LIKE.test(w))) return { ok: false, reason: 'jude' };
  if (selfTalk(words)) return { ok: false, reason: 'self' };
  if (mode !== 'full') return { ok: true };
  // the call at the start: a hey-like first word or her name in the first three, no rival there
  const headRival = first3.some((w) => RIVAL.test(w));
  const head = !headRival && (HEY_LIKE.test(words[0]) || first3.some((w) => JADE_LIKE.test(w)));
  // the call at the end, after a lead-in: "…, hey Jade" (a hey-like word right before her name)
  let k = -1;
  for (let i = words.length - 1; i >= 1 && k < 0; i--) if (JADE_LIKE.test(words[i])) k = i;
  const win = k >= 1 ? words.slice(Math.max(0, k - 2), k + 1) : null;
  const tail = !!win && HEY_LIKE.test(words[k - 1]) && !win.some((w) => RIVAL.test(w));
  if (!head && !tail) return { ok: false, reason: headRival || (win && win.some((w) => RIVAL.test(w))) ? 'rival' : 'no-call' };
  // "Hey Jayden, come here": a name that is not hers, unless it is all Whisper heard
  const j = words.findIndex((w) => JAYDEN_LIKE.test(w));
  if (j >= 0 && !words.some((w) => JADE_LIKE.test(w)) && j < words.length - 1) return { ok: false, reason: 'rival' };
  return { ok: true };
}

/** Words of the original text with their positions (case and punctuation kept for the rest). @param {string} text */
function tokens(text) {
  const out = [];
  const re = /[A-Za-z0-9'’]+/g;
  let m;
  while ((m = re.exec(text))) out.push({ w: normalize(m[0])[0] || '', end: m.index + m[0].length });
  return out;
}

/**
 * Remove a call at the start: up to 2 leading words, an optional "hey"-like word, a Jade-like
 * word and the punctuation after it ("So, hey Jade, tell me a joke." → "tell me a joke.";
 * "Jade, what time is it?" → "what time is it?"; "Hey, Jade." → ""). Text without a call is
 * returned unchanged.
 * @param {string} text @returns {string}
 */
export function stripCall(text) {
  const s = String(text ?? '');
  const t = tokens(s);
  for (let k = 0; k <= 2 && k < t.length; k++) {
    let end = -1;
    if (HEY_LIKE.test(t[k].w) && t[k + 1] && JADE_LIKE.test(t[k + 1].w)) end = t[k + 1].end;
    else if (JADE_LIKE.test(t[k].w)) end = t[k].end;
    if (end >= 0) return s.slice(end).replace(/^[\s,.!?;:—–-]+/, '').trim();
  }
  return s.trim();
}

/**
 * The transcript fallback's rule (no wake-word engine): a greeting + her name in the first
 * three words ("Hey Jade", "So hey Jade"); with phrase 'jade' also her name first ("Jade, …").
 * @param {string} text @param {'hey-jade'|'jade'} [phrase]
 */
export function confirmCall(text, phrase = 'hey-jade') {
  const w = normalize(text).slice(0, 3);
  for (let k = 0; k + 1 < w.length; k++) if (HEY_LIKE.test(w[k]) && JADE_LIKE.test(w[k + 1])) return !selfTalk(normalize(text));
  return phrase === 'jade' && w.length > 0 && JADE_LIKE.test(w[0]) && !selfTalk(normalize(text));
}

/**
 * What the app does with a transcript of the command, a follow-up or a look-and-talk capture.
 *   send       a message for Claude (the call stripped)
 *   interrupt  "stop" / "cancel" while something runs: stop speaking and stop the turn (local)
 *   end        closes the window without a Claude call ("thanks", "never mind", a "stop" with nothing running)
 *   drop       nothing usable (empty, a Whisper hallucination on a short sound, failed STT); silent
 *   again      the command window: the capture held only the end of her name or a noise, so it keeps listening
 *   local      'stop-listening': turn the wake word off
 * @typedef {{ action: 'send', text: string }
 *   | { action: 'interrupt', reason: string }
 *   | { action: 'end', reason: string }
 *   | { action: 'drop', reason: string }
 *   | { action: 'again', reason: string }
 *   | { action: 'local', run: 'stop-listening' }} WakeDecision
 */

/**
 * @param {string} text the transcript
 * @param {{ kind: 'command'|'followup'|'look', turnRunning?: boolean, speechMs?: number, hallucination?: RegExp, failed?: boolean }} o
 * @returns {WakeDecision}
 */
export function decideCommand(text, o) {
  if (o.failed) return { action: 'drop', reason: 'stt-failed' };
  const whole = normalize(text).join(' ');
  const rest = stripCall(text);
  const said = normalize(rest).join(' ');
  // Whisper's classic outputs for a short noise ("Thank you.", "you") mean nothing was said
  const hallucinated = !!o.hallucination && (o.speechMs || 0) < 1500 && (o.hallucination.test(rest) || o.hallucination.test(String(text ?? '').trim()));
  // ("Thanks, Jade." is an ender as a whole, although stripping the call leaves nothing)
  if (hallucinated || (!said && !ENDERS.test(whole))) return o.kind === 'command' ? { action: 'again', reason: 'empty' } : { action: 'drop', reason: 'empty' };
  const stops = (/** @type {string} */ x) => STOP_WORDS.test(x) || NEVER_MIND.test(x);
  if (o.turnRunning && (stops(said) || stops(whole))) return { action: 'interrupt', reason: 'stop' };
  if (ENDERS.test(said) || ENDERS.test(whole)) return { action: 'end', reason: 'ender' };
  if (STOP_WORDS.test(said)) return { action: 'end', reason: 'stop' };
  if (STOP_LISTENING.test(said)) return { action: 'local', run: 'stop-listening' };
  return { action: 'send', text: rest };
}
