// Which teeth the lips reveal (both heads; pure). The upper incisors hang from the skull behind
// the upper lip: they show as the lips part, not behind protruded (rounded) or pressed lips; in an
// f / v they rest on the tucked lower lip. The lower incisors ride on the jaw behind the lower lip:
// hidden while the jaw is nearly closed (behind the upper teeth and the lip), uncovered as it opens
// wide or as spread lips draw back from them; a tucked lower lip and rounded lips cover them.

/** @typedef {import('../director.js').AnimState} AnimState */

/** Upper teeth visibility 0..1. @param {AnimState} a */
export function upperTeeth(a) {
  const open = Math.max(a.jawOpen, a.mouthWide * 0.5, a.mouthRound * 0.06, a.mouthTeeth ?? 0, (a.mouthTuck ?? 0) * 0.8);
  return open * (1 - 0.6 * a.mouthRound * (1 - (a.mouthTeeth ?? 0))) * (1 - (a.mouthPress ?? 0));
}

/** Lower teeth visibility 0..1. @param {AnimState} a */
export function lowerTeeth(a) {
  const j = Math.min(1, Math.max(0, (a.jawOpen - 0.16) / 0.34));
  const jaw = j * j * (3 - 2 * j);
  const spread = 0.55 * (a.mouthTeeth ?? 0) * Math.min(1, 1.4 * a.mouthWide);
  const v = Math.min(1, jaw + spread);
  return v * (1 - 0.85 * a.mouthRound) * (1 - (a.mouthTuck ?? 0)) * (1 - (a.mouthPress ?? 0));
}
