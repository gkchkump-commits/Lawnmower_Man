// Speech services used by the conversation controller:
//   tts: local voice server (Kokoro, with visemes) → browser speech synthesis → none
//   stt: local voice server (faster-whisper) only; unavailable otherwise (mic button disabled)
// Both read the live settings (voice id, speed, language) on every call.

import { normalizeVisemes } from '../audio/lipsync.js';
import { VoiceError, isAbortError } from './voice-client.js';

export const VOICE_SETUP_HINT =
  'Voice input needs the local voice server. Install it with scripts\\setup-voice.ps1 (Windows) or scripts/setup-voice.sh (Linux), turn on "Local voice" in Settings, then choose "Restart voice" in the tray menu.';

/**
 * @param {object} deps
 * @param {import('./voice-client.js').VoiceClient} deps.voiceClient
 * @param {import('./web-speech.js').WebSpeechTTS|null} deps.webSpeech
 * @param {() => any} deps.getSettings  current settings
 * @param {(err: Error) => void} [deps.onFallback]  server TTS failed, browser voice used instead
 */
export function createSpeechServices(deps) {
  const { voiceClient, webSpeech, getSettings } = deps;
  const voiceSettings = () => getSettings()?.voice || {};

  const serverOk = (/** @type {'stt'|'tts'} */ kind) => {
    if (!voiceClient.ready) return false;
    if (voiceSettings().enabled === false) return false;
    const h = voiceClient.health;
    const eng = h && h[kind];
    // an engine that reports an error and is not loaded will not work until fixed
    return !(eng && eng.error && !eng.loaded);
  };

  const tts = {
    /** @returns {'server'|'browser'|'none'} */
    mode() {
      if (serverOk('tts')) return 'server';
      if (webSpeech && webSpeech.available) return 'browser';
      return 'none';
    },
    available() {
      return tts.mode() !== 'none';
    },
    /**
     * Synthesize one chunk into a playable clip.
     * @param {string} text @param {{ signal?: AbortSignal }} [o]
     * @returns {Promise<import('../audio/player.js').Clip>}
     */
    async synthesize(text, o = {}) {
      const v = voiceSettings();
      const rate = Number.isFinite(v.ttsSpeed) ? v.ttsSpeed : 1;
      if (tts.mode() === 'server') {
        try {
          const r = await voiceClient.synthesize(text, { voice: v.ttsVoice || undefined, speed: rate, signal: o.signal });
          return {
            kind: 'audio',
            audioB64: r.audioB64,
            visemes: normalizeVisemes(r.visemes),
            text,
            durationSec: r.durationSec,
          };
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (webSpeech && webSpeech.available) {
            deps.onFallback?.(/** @type {Error} */ (err));
            return { kind: 'speech', text, rate };
          }
          throw err;
        }
      }
      if (webSpeech && webSpeech.available) return { kind: 'speech', text, rate };
      throw new VoiceError('No voice output is available', { code: 'no_tts' });
    },
  };

  const stt = {
    available() {
      return serverOk('stt');
    },
    /** Why voice input is unavailable (tooltip / toast text). */
    unavailableReason() {
      const info = voiceClient.info || {};
      if (voiceSettings().enabled === false) return 'Voice input is off. Turn on "Local voice" in Settings (it needs the local voice server).';
      if (info.status === 'starting') return `The voice server is starting${info.detail ? ` (${info.detail})` : ''}…`;
      const sttErr = voiceClient.health?.stt?.error;
      if (info.status === 'ready' && sttErr) return `Speech recognition is unavailable: ${sttErr}`;
      if (info.status === 'error' && info.detail) return `The voice server failed: ${info.detail}`;
      if (info.status === 'disabled' && info.detail) return `${info.detail} ${VOICE_SETUP_HINT}`;
      return VOICE_SETUP_HINT;
    },
    /**
     * @param {ArrayBuffer} wav @param {{ signal?: AbortSignal }} [o]
     */
    async transcribe(wav, o = {}) {
      const lang = voiceSettings().sttLanguage || 'en';
      return voiceClient.transcribe(wav, { language: lang, signal: o.signal });
    },
  };

  return { tts, stt };
}
