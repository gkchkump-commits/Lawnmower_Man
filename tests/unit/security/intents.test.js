// Local Home camera commands (src/tapo/intents.js): what is a camera command, and — just as
// important — what must still go to Claude.
import { describe, expect, it } from 'vitest';
import {
  armedLine, levenshtein, matchPreset, normalizePresetName, numberWords, parseCameraIntent, spokenPresetName,
} from '../../../src/tapo/intents.js';

const PRESETS = ['Door', 'Window', 'Desk', 'Front gate'];
const parse = (t, o = {}) => parseCameraIntent(t, { presets: PRESETS, name: 'camera', ...o });
const nudge = (dir, amount = 'medium') => ({ op: 'nudge', dir, amount });

describe('parseCameraIntent: movement', () => {
  it.each([
    ['camera left', nudge('left')],
    ['Camera right.', nudge('right')],
    ['cam up', nudge('up')],
    ['camera down please', nudge('down')],
    ['turn the camera left', nudge('left')],
    ['pan right', nudge('right')],
    ['look left', nudge('left')],
    ['move the camera right', nudge('right')],
    ['turn the camera a bit to the left', nudge('left', 'small')],
    ['camera left a little', nudge('left', 'small')],
    ['pan right slightly', nudge('right', 'small')],
    ['camera all the way right', nudge('right', 'large')],
    ['turn left a lot', nudge('left', 'large')],
    ['tilt up', nudge('up')],
    ['tilt the camera down a bit', nudge('down', 'small')],
    ['move the camera up', nudge('up')],
    ['Hey, can you turn the camera to the right?', nudge('right')],
    ['please camera left', nudge('left')],
  ])('%s', (text, cmd) => {
    const r = parse(text);
    expect(r?.kind).toBe('ptz');
    expect(r?.cmd).toEqual(cmd);
    expect(r?.say).toMatch(/^(Turning|Tilting) (left|right|up|down)/);
  });

  it('confirms with a short spoken line', () => {
    expect(parse('camera left').say).toBe('Turning left.');
    expect(parse('tilt up a bit').say).toBe('Tilting up a little.');
    expect(parse('camera all the way right').say).toBe('Turning right all the way.');
  });

  it('uses the camera’s own name too', () => {
    expect(parse('turn the front door camera left', { name: 'front door camera' })?.cmd).toEqual(nudge('left'));
    expect(parse('arm the front door camera', { name: 'Front door camera' })).toMatchObject({ kind: 'arm', armed: true });
  });
});

describe('parseCameraIntent: presets, home, arm, open', () => {
  it('goes to a preset by name', () => {
    expect(parse('look at the door')).toEqual({ kind: 'ptz', cmd: { op: 'preset-name', name: 'Door' }, say: 'Looking at the door.' });
    expect(parse('show me the window')?.cmd).toEqual({ op: 'preset-name', name: 'Window' });
    expect(parse('go to desk')?.cmd).toEqual({ op: 'preset-name', name: 'Desk' });
    expect(parse('check the front gate')?.cmd).toEqual({ op: 'preset-name', name: 'Front gate' });
    expect(parse('check on the front')?.cmd).toEqual({ op: 'preset-name', name: 'Front gate' }); // prefix
    expect(parse('look at the windo')?.cmd).toEqual({ op: 'preset-name', name: 'Window' }); // typo
  });

  it('goes home', () => {
    for (const t of ['camera home', 'look home', 'center the camera', 'centre the camera', 'camera back home']) {
      expect(parse(t)?.cmd, t).toEqual({ op: 'home' });
    }
  });

  it('arms and disarms; turn on/off the camera means arm/disarm', () => {
    for (const t of ['arm the camera', 'turn on the camera', 'arm security', 'switch on the alarm', 'turn the camera on', 'arm the camera now']) {
      expect(parse(t), t).toMatchObject({ kind: 'arm', armed: true });
    }
    for (const t of ['disarm the camera', 'turn off the camera', 'disarm the alarm', 'turn the security off']) {
      expect(parse(t), t).toMatchObject({ kind: 'arm', armed: false, say: 'Disarmed.' });
    }
  });

  it('opens the camera window', () => {
    for (const t of ['show me the camera', 'open the camera', 'show the camera window', 'open camera view']) {
      expect(parse(t), t).toEqual({ kind: 'open', say: 'Here is the camera.' });
    }
  });
});

describe('parseCameraIntent: everything else goes to Claude', () => {
  it.each([
    'look at this code',
    'check the weather',
    'turn off the lights',
    'turn on the radio',
    'look up the word camera',
    'look up',
    'what does the camera see',
    'is anyone at the door',
    'show me a picture of a camera',
    'can you explain how a camera works',
    'camera',
    'left',
    'tell me about the window',
    'camera left and then right and then left again please now', // too long
    'look at the', // no preset
    '',
  ])('%s', (text) => {
    expect(parse(text)).toBeNull();
  });

  it('an ambiguous preset name is not guessed', () => {
    expect(parseCameraIntent('look at the door', { presets: ['Front door', 'Back door'] })).toBeNull();
    expect(parseCameraIntent('check the front', { presets: ['Front door', 'Front gate'] })).toBeNull();
  });

  it('no presets → no preset commands', () => {
    expect(parseCameraIntent('look at the door', { presets: [] })).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes preset names like main', () => {
    expect(normalizePresetName('The Front-Door!')).toBe('front door');
    expect(normalizePresetName("  my  Kid's room ")).toBe('kids room');
  });

  it('matchPreset: exact, prefix, Levenshtein ≤ 2 for 4+ characters, ambiguity', () => {
    expect(matchPreset('door', ['Door', 'Doorway'])).toEqual({ name: 'Door' });
    expect(matchPreset('door', ['Doorway'])).toEqual({ name: 'Doorway' });
    expect(matchPreset('dor', ['Door'])).toBeNull(); // too short for fuzzy
    expect(matchPreset('wndow', ['Window'])).toEqual({ name: 'Window' });
    expect(matchPreset('garden', ['Window'])).toBeNull();
    expect(matchPreset('front', ['Front door', 'Front gate'])).toEqual({ ambiguous: ['Front door', 'Front gate'] });
  });

  it('levenshtein', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('spoken confirmations', () => {
    expect(numberWords(30)).toBe('thirty');
    expect(numberWords(45)).toBe('forty-five');
    expect(armedLine(30)).toBe('Armed. You have thirty seconds.');
    expect(armedLine(1)).toBe('Armed. You have one second.');
    expect(armedLine(120)).toBe('Armed. You have two minutes.');
    expect(armedLine(0)).toBe('Armed.');
    expect(spokenPresetName('Door')).toBe('the door');
    expect(spokenPresetName('TV')).toBe('the TV');
    expect(spokenPresetName("Mum's room")).toBe("Mum's room");
  });
});
