// "Hey Jade": what the transcripts say (contract-wake §8.6; the rules measured in eval.md §7.1).
//
// Two transcripts per wake, both from the app's own /stt (faster-whisper on the GPU, no
// hotwords, no prompt: biasing turned "Hey Jay" into "hey Jade"):
//   * the wake segment (stream start → end of "Jade" + 0.15 s): veto() decides whether the
//     stage-1 hit was a real call. It rejects rival names ("Hey Jude", "Hey Jay"), her own lines
//     ("I'm Jade", "Jade here") and speech that is no call at all; everything else is accepted.
//     A veto, not a "must start with hey jade" rule: Whisper writes "I enjoyed it" or "Hey Jayden"
//     for about a quarter of isolated clean "Hey Jade."s.
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
/** names and words Whisper hears instead of her name (eval.md §7.2; "joey" added after its one AGC-mix leak) */
export const RIVAL = /^(?:jud\w*|jay|jays|j|jane|james|jams|jim|jimmy|jamie|jake|jen|jenn|jean|jack|joe|joey|jed|jason|jess|jesse|dave|kate|grace|wade|shade|fade|they|day)$/;
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
  if (first3.some((w) => /^jud/.test(w))) return { ok: false, reason: 'jude' };
  if (mode === 'full' && first3.some((w) => RIVAL.test(w))) return { ok: false, reason: 'rival' };
  if (selfTalk(words)) return { ok: false, reason: 'self' };
  if (mode === 'full' && !HEY_LIKE.test(words[0]) && !first3.some((w) => JADE_LIKE.test(w))) return { ok: false, reason: 'no-call' };
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
