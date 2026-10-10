// The calibration wizard (contract §8.4, §9.2): main turns the camera a little left/right and
// up/down and the security worker measures how the picture moved, to learn which way the
// motors turn and how far one step goes. This dialog explains it, shows the progress, asks
// when the picture could not be measured (dark or plain view), and sums up the result.

import { clear, h } from '../../ui/dom.js';
import { openDialog } from './dialogs.js';
import { tapoIcon } from './icons.js';

export const STEP_TEXT = Object.freeze({
  idle: 'Ready.',
  pan: 'Turning left and right…',
  tilt: 'Tilting up and down…',
  'min-step': 'Trying the smallest steps…',
  ask: 'Your help is needed',
  done: 'Done',
  failed: 'Calibration did not finish',
});

/** A sentence about a calibration result. @param {any} r */
export function describeResult(r) {
  if (!r) return '';
  const pan = r.invertPan ? 'Left and right are swapped on this camera; the app now corrects that.' : 'Left and right are the right way round.';
  const tilt = r.invertTilt ? 'Up and down are swapped; the app now corrects that.' : 'Up and down are the right way round.';
  return `${pan} ${tilt}`;
}

export class CalibrationDialog {
  /** @param {{ calibrate: (req: any) => Promise<any>, toast: (m: string, l?: string) => void }} o */
  constructor(o) {
    this.o = o;
    /** @type {HTMLDialogElement|null} */
    this.dlg = null;
    /** @type {any} */
    this.state = { step: 'idle', progress: 0 };
    this.started = false;
  }

  get open() {
    return !!this.dlg;
  }

  show() {
    if (this.dlg) return;
    this.started = false;
    this.body = h('div', { class: 'calib' });
    this.actions = h('div', { class: 'calib-actions' });
    this.dlg = openDialog({
      id: 'calibrate',
      title: 'Calibrate pan and tilt',
      icon: 'calibrate',
      className: 'dlg-calib',
      body: [this.body, this.actions],
      onClose: () => {
        if (this.started && !['done', 'failed', 'idle'].includes(this.state.step)) this.o.calibrate({ action: 'cancel' }).catch(() => {});
        this.dlg = null;
      },
    });
    this.render({ step: 'idle', progress: 0 }, true);
  }

  close() {
    this.dlg?.close();
  }

  async start() {
    this.started = true;
    this.render({ step: 'pan', progress: 0 });
    try {
      const s = await this.o.calibrate({ action: 'start' });
      if (s) this.update(s);
    } catch (err) {
      this.update({ step: 'failed', progress: 0, error: String(/** @type {any} */ (err)?.message || err) });
    }
  }

  /** @param {'left'|'right'|'up'|'down'|'none'} answer */
  async answer(answer) {
    const asked = this.state;
    this.render({ ...asked, step: asked.step === 'ask' ? 'pan' : asked.step, question: undefined });
    try {
      const s = await this.o.calibrate({ action: 'answer', answer });
      // main's state after the answer; still asking (the answer was not taken): ask again
      if (s) this.update(s);
      else this.render(asked);
    } catch (err) {
      this.render(asked);
      this.o.toast(`Could not send the answer: ${/** @type {any} */ (err)?.message || err}`, 'error');
    }
  }

  /** main's lm:tapo:calibration. @param {any} s CalibrationState */
  update(s) {
    if (!s || typeof s !== 'object') return;
    if (!this.dlg) return;
    if (!this.started && s.step !== 'idle') this.started = true;
    this.render(s);
  }

  /** @param {any} s @param {boolean} [intro] */
  render(s, intro = false) {
    this.state = s;
    if (!this.body || !this.actions) return;
    clear(this.body);
    clear(this.actions);
    this.dlg?.setAttribute('data-step', intro ? 'intro' : s.step);
    if (intro) {
      this.body.append(
        h('p', null, 'The camera will turn a little left and right, then up and down, and come back. The app watches how the picture moves, so the arrows and clicks turn it the right way. It takes about 30 seconds.'),
        h('ul', { class: 'calib-tips' },
          h('li', null, 'Point it at a room with some things in view (not a blank wall, not in the dark).'),
          h('li', null, 'Keep people and pets out of the way for a moment.')));
      const go = h('button', { type: 'button', class: 'btn amber', onclick: () => this.start() }, 'Start');
      const cancel = h('button', { type: 'button', class: 'btn ghost', onclick: () => this.close() }, 'Cancel');
      this.actions.append(cancel, go);
      requestAnimationFrame(() => go.focus());
      return;
    }
    const pct = Math.round(Math.max(0, Math.min(1, Number(s.progress) || 0)) * 100);
    if (s.step === 'done') {
      this.body.append(
        h('div', { class: 'calib-done' }, tapoIcon('check', 'icon'), h('strong', null, 'Calibrated.')),
        h('p', null, describeResult(s.result)),
        h('p', { class: 'calib-small' }, 'You can calibrate again any time from the camera settings.'));
      const ok = h('button', { type: 'button', class: 'btn amber', onclick: () => this.close() }, 'Close');
      this.actions.append(ok);
      requestAnimationFrame(() => ok.focus());
      return;
    }
    if (s.step === 'failed') {
      this.body.append(
        h('div', { class: 'calib-failed' }, tapoIcon('warn', 'icon'), h('strong', null, STEP_TEXT.failed)),
        h('p', null, s.error || 'Something went wrong.'),
        h('p', { class: 'calib-small' }, 'If the arrows turn the wrong way, you can also swap the directions by hand in the camera settings.'));
      const again = h('button', { type: 'button', class: 'btn amber', onclick: () => this.start() }, 'Try again');
      const close = h('button', { type: 'button', class: 'btn ghost', onclick: () => this.close() }, 'Close');
      this.actions.append(close, again);
      return;
    }
    this.body.append(
      h('div', { class: 'calib-step' }, s.step === 'ask' ? tapoIcon('help', 'icon') : h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, STEP_TEXT[/** @type {keyof typeof STEP_TEXT} */ (s.step)] || s.step)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('div', { class: 'progress-bar', style: { width: `${pct}%` } })));
    if (s.step === 'ask') {
      // main says why the picture could not tell (too plain, lagging behind, disagreeing with itself)
      const why = typeof s.note === 'string' && s.note ? s.note : 'The picture was too dark or too plain to measure.';
      this.body.append(h('p', { class: 'calib-q' }, s.question || 'Which way did the camera turn?'), h('p', { class: 'calib-small' }, `${why} Watch the live view behind this window, then choose.`));
      // only the answers main asks for (the axis it just moved), about the camera, as the question is
      const answers = Array.isArray(s.answers) && s.answers.length ? s.answers : ['left', 'right', 'none'];
      const pad = h('div', { class: 'calib-pad', role: 'group', 'aria-label': 'The camera turned' });
      for (const dir of /** @type {const} */ (['up', 'left', 'right', 'down'])) {
        if (!answers.includes(dir)) continue;
        const verb = dir === 'up' || dir === 'down' ? 'tilted' : 'turned';
        pad.append(h('button', { type: 'button', class: `btn ghost calib-${dir}`, dataset: { answer: dir }, onclick: () => this.answer(dir) }, tapoIcon(dir, 'icon tiny'), `The camera ${verb} ${dir}`));
      }
      this.body.append(pad);
      if (answers.includes('none')) this.actions.append(h('button', { type: 'button', class: 'btn ghost', dataset: { answer: 'none' }, onclick: () => this.answer('none') }, 'It did not move'));
    }
    this.actions.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => this.close() }, 'Stop'));
  }
}
