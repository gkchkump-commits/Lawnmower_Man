// "Claude describes the alert" (security.describe) sends a picture of the user's home to
// Anthropic as part of the Claude conversation, so it is off by default and the first time it is
// turned on — in the camera window or the avatar's settings drawer — a card says so and asks.
// The answer is remembered on this PC (localStorage), like the webcam's privacy card.

export const DESCRIBE_CONSENT_KEY = 'lawnmower.tapo.describe-consent.v1';

export const DESCRIBE_CONSENT = Object.freeze({
  title: 'Let Claude describe what the camera sees?',
  points: Object.freeze([
    'When the camera sees a person, a snapshot of your home will be sent to Anthropic as part of the Claude conversation, and the avatar says in one sentence what it shows.',
    'It never happens while you are talking with Claude, in quiet hours, or for movement alone.',
    'Everything else the camera does (watching, detecting people, the clips) stays on this PC.',
  ]),
  accept: 'Turn it on',
  decline: 'Not now',
});

/** @param {{ getItem: (k: string) => string|null }} [store] */
export function hasDescribeConsent(store = safeStorage()) {
  try {
    return store?.getItem(DESCRIBE_CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

/** @param {{ setItem: (k: string, v: string) => void }} [store] */
export function rememberDescribeConsent(store = safeStorage()) {
  try {
    store?.setItem(DESCRIBE_CONSENT_KEY, 'yes');
  } catch { /* private mode: asked again next time */ }
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
