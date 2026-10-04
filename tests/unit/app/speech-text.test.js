import { describe, expect, it } from 'vitest';
import { SPEECH_PHRASES, toSpeechText } from '../../../src/app/speech-text.js';

const t = toSpeechText;

describe('toSpeechText', () => {
  it('returns plain text unchanged', () => {
    expect(t('Hello there, how are you?')).toBe('Hello there, how are you?');
  });

  it('strips emphasis, strikethrough and inline code markers', () => {
    expect(t('This is **bold**, *italic*, __strong__, _em_ and ~~gone~~.')).toBe('This is bold, italic, strong, em and gone.');
    expect(t('Run `npm test` now.')).toBe('Run npm test now.');
    expect(t('Use `snake_case_name` and keep 2*3*4.')).toBe('Use snake case name and keep 2 times 3 times 4.');
  });

  it('keeps underscores out of identifiers but not words', () => {
    expect(t('the max_tokens setting')).toBe('the max tokens setting');
  });

  it('headings, quotes and list markers become sentences', () => {
    expect(t('# Title\nSome text\n> quoted\n- item one\n- item two\n1. first\n- [x] done task'))
      .toBe('Title. Some text. quoted. item one. item two. first. done task');
  });

  it('links become their text, images their alt text, bare URLs their host', () => {
    expect(t('See [the docs](https://example.com/docs "Docs") and ![a cat](cat.png).')).toBe('See the docs and a cat.');
    expect(t('Go to https://www.github.com/anthropics/claude-code.')).toBe('Go to github.com.');
    expect(t('Visit <https://example.org/x>')).toBe('Visit example.org');
    expect(t('or www.python.org/downloads today')).toBe('or python.org today');
  });

  it('reads e-mail addresses', () => {
    expect(t('Write to jo.doe@example.com')).toBe('Write to jo.doe at example.com');
  });

  it('replaces code blocks and tables with a short phrase', () => {
    expect(t('Here:\n```js\nconst x = 1;\n```\nDone.')).toBe(`Here: ${SPEECH_PHRASES.code} Done.`);
    expect(t('Data:\n| a | b |\n|---|---|\n| 1 | 2 |\nEnd.')).toBe(`Data: ${SPEECH_PHRASES.table} End.`);
    expect(t('```\nonly code\n```')).toBe(SPEECH_PHRASES.code);
    expect(t('```\ncode\n```', { codePhrase: '' })).toBe('');
  });

  it('removes emoji and decorative symbols', () => {
    expect(t('Great job! 🎉🚀 ✅ Done 👍🏽.')).toBe('Great job! Done.');
    expect(t('Family: 👨‍👩‍👧 flag 🇺🇸 keycap 1️⃣')).toBe('Family: flag keycap 1');
    expect(t('• one ▪ two ─── three')).toBe('one two three');
  });

  it('expands symbols TTS reads badly', () => {
    expect(t('Tom & Jerry')).toBe('Tom and Jerry');
    expect(t('A -> B → C')).toBe('A to B to C');
    expect(t('about ~5 minutes, ≈ 3 days')).toBe('about about 5 minutes, about 3 days');
    expect(t('1920x1080 screen, 3 × 4')).toBe('1920 by 1080 screen, 3 by 4');
    expect(t('x = 3 and y < 4')).toBe('x equals 3 and y less than 4');
    expect(t('It is 21°C, #1 in C# and C++')).toBe('It is 21 degrees Celsius, number 1 in C sharp and C plus plus');
    expect(t('and/or')).toBe('and or');
    expect(t('e.g. this, i.e. that, etc. and vs. them')).toBe('for example this, that is that, et cetera and versus them');
  });

  it('turns dashes into pauses and tidies punctuation', () => {
    expect(t('Well — maybe – not - really')).toBe('Well, maybe, not, really');
    expect(t('Wow!!! Really??')).toBe('Wow! Really?');
    expect(t('Wait…')).toBe('Wait...');
  });

  it('strips HTML tags', () => {
    expect(t('Press <kbd>Ctrl</kbd>+C<br>now')).toBe('Press Ctrl+C now');
  });

  it('returns empty string when nothing is speakable', () => {
    expect(t('')).toBe('');
    expect(t('---')).toBe('');
    expect(t('🎉🎉')).toBe('');
    expect(t('***')).toBe('');
    expect(t(/** @type {any} */ (null))).toBe('');
  });
});
