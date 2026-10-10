// Small modal dialogs for the Home camera window, on the native <dialog> element (focus is
// trapped, Esc closes): a name prompt, a confirmation, and the keyboard help.

import { h } from '../../ui/dom.js';
import { tapoIcon } from './icons.js';

/**
 * A <dialog> with a title bar and a close button; removed from the page when it closes.
 * @param {{ id?: string, title: string, icon?: any, className?: string, body: any, actions?: any[], onClose?: () => void }} o
 */
export function openDialog(o) {
  const close = h('button', { type: 'button', class: 'icon-btn dlg-close', 'aria-label': 'Close', title: 'Close (Esc)' }, tapoIcon('close'));
  const dlg = /** @type {HTMLDialogElement} */ (h('dialog', { class: `dlg ${o.className || ''}`, id: o.id, 'aria-labelledby': o.id ? `${o.id}-title` : undefined },
    h('header', { class: 'dlg-head' }, o.icon ? tapoIcon(o.icon, 'icon dlg-icon') : null, h('h2', { class: 'dlg-title', id: o.id ? `${o.id}-title` : undefined }, o.title), close),
    h('div', { class: 'dlg-body' }, o.body),
    o.actions?.length ? h('footer', { class: 'dlg-actions' }, o.actions) : null));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    o.onClose?.();
    dlg.remove();
  });
  // a click on the backdrop closes it
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  (document.getElementById('dialogs') || document.body).append(dlg);
  dlg.showModal();
  return dlg;
}

/**
 * Ask for a short name. Resolves with the trimmed text, or null when cancelled.
 * @param {{ title: string, label: string, value?: string, placeholder?: string, okLabel?: string, maxLength?: number }} o
 * @returns {Promise<string|null>}
 */
export function promptText(o) {
  return new Promise((resolve) => {
    let result = /** @type {string|null} */ (null);
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'dlg-input', value: o.value || '', placeholder: o.placeholder || '', maxlength: o.maxLength || 40, spellcheck: 'false', autocomplete: 'off' }));
    const ok = h('button', { type: 'submit', class: 'btn amber' }, o.okLabel || 'Save');
    const cancel = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const form = h('form', { class: 'dlg-form', method: 'dialog' }, h('label', { class: 'dlg-label' }, o.label, input));
    const dlg = openDialog({ title: o.title, className: 'dlg-small', body: form, actions: [cancel, ok], onClose: () => resolve(result) });
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      result = v;
      dlg.close();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    ok.addEventListener('click', (e) => {
      e.preventDefault();
      submit();
    });
    cancel.addEventListener('click', () => dlg.close());
    input.focus();
    input.select();
  });
}

/**
 * @param {{ title: string, text: string, okLabel: string, danger?: boolean }} o
 * @returns {Promise<boolean>}
 */
export function confirmAction(o) {
  return new Promise((resolve) => {
    let yes = false;
    const ok = h('button', { type: 'button', class: `btn ${o.danger ? 'danger' : 'amber'}` }, o.okLabel);
    const cancel = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const dlg = openDialog({ title: o.title, className: 'dlg-small', body: h('p', { class: 'dlg-text' }, o.text), actions: [cancel, ok], onClose: () => resolve(yes) });
    ok.addEventListener('click', () => {
      yes = true;
      dlg.close();
    });
    cancel.addEventListener('click', () => dlg.close());
    cancel.focus();
  });
}

export const SHORTCUTS = Object.freeze([
  ['← → ↑ ↓', 'Turn the camera (hold to keep turning)'],
  ['Shift + arrow', 'A big turn'],
  ['Alt + arrow', 'A small turn'],
  ['Click the picture', 'Turn the camera to that spot'],
  ['Double-click', 'Full screen'],
  ['H or Home', 'Back to the home position'],
  ['1 – 8', 'Go to a saved position'],
  ['Space', 'Copy a picture to the clipboard'],
  ['A', 'Arm or disarm'],
  ['E', 'Show or hide the events'],
  ['F', 'Full screen'],
  ['Esc', 'Stop the camera / close a window'],
  ['?', 'This help'],
]);

export function openHelp() {
  const rows = SHORTCUTS.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, h('kbd', null, k)), h('td', null, v)));
  return openDialog({
    id: 'help',
    title: 'Keyboard and mouse',
    icon: 'keyboard',
    className: 'dlg-help',
    body: [h('table', { class: 'keys' }, h('tbody', null, rows)), h('p', { class: 'dlg-note' }, 'You can also tell the avatar: “camera left”, “look at the door”, “arm the camera”.')],
  });
}
