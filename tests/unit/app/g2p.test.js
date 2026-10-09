// Grapheme-to-phoneme conversion for the system-voice lip-sync (src/audio/g2p.js).
import { describe, expect, it } from 'vitest';
import {
  DICTIONARY, expandNumber, genericPhones, letterToSound, numberWords, parsePhones, spell, textToWords, wordToPhones,
} from '../../../src/audio/g2p.js';

/** "HH AH0 L OW1" style string of a word's pronunciation. */
const pron = (w) => wordToPhones(w).map((p) => p.ph + (/^[AEIOU]/.test(p.ph) ? p.stress : '')).join(' ');
/** Phonemes without stress. */
const phs = (w) => wordToPhones(w).map((p) => p.ph);
/** True when `seq` appears in order (contiguously) in the word's phonemes. */
const has = (w, seq) => phs(w).join(' ').includes(seq);

describe('exception dictionary', () => {
  it('holds the common words, contractions and names with stress', () => {
    expect(DICTIONARY.size).toBeGreaterThan(300);
    const expected = {
      the: 'DH AH0', a: 'AH0', of: 'AH0 V', to: 'T UW0', and: 'AH0 N D', you: 'Y UW0', are: 'AA0 R', was: 'W AA0 Z',
      one: 'W AH1 N', two: 'T UW1', said: 'S EH1 D', does: 'D AH1 Z', could: 'K UH0 D', people: 'P IY1 P AH0 L',
      hello: 'HH AH0 L OW1', claude: 'K L AO1 D', anthropic: 'AE2 N TH R AA1 P IH0 K', "i'm": 'AY0 M',
      "don't": 'D OW1 N T', "it's": 'IH0 T S', today: 'T AH0 D EY1', feeling: 'F IY1 L IH0 NG', how: 'HH AW1',
      every: 'EH1 V R IY0', very: 'V EH1 R IY0', many: 'M EH1 N IY0', laugh: 'L AE1 F', food: 'F UW1 D',
      question: 'K W EH1 S CH AH0 N', thanks: 'TH AE1 NG K S', computer: 'K AH0 M P Y UW1 T ER0',
    };
    for (const [w, p] of Object.entries(expected)) expect(pron(w), w).toBe(p);
  });

  it('is case and apostrophe insensitive', () => {
    expect(pron('Claude')).toBe(pron('claude'));
    expect(pron('I’m')).toBe(pron("i'm"));
    expect(pron("'hello'")).toBe(pron('hello'));
  });

  it('parses phoneme strings and rejects garbage', () => {
    expect(parsePhones('HH AH0 L OW1')).toEqual([
      { ph: 'HH', stress: 0 }, { ph: 'AH', stress: 0 }, { ph: 'L', stress: 0 }, { ph: 'OW', stress: 1 },
    ]);
    expect(() => parsePhones('hh')).toThrow();
  });
});

describe('letter-to-sound rules (words not in the dictionary)', () => {
  it('get the consonants the lips show right', () => {
    // bilabials (m b p) → a lip closure
    for (const w of ['mumble', 'bubble', 'baby', 'happen', 'jumps', 'problem', 'maple', 'basket']) {
      expect(phs(w).some((p) => p === 'M' || p === 'B' || p === 'P'), w).toBe(true);
    }
    // labiodentals, including ph → f
    for (const [w, ph] of [['phone', 'F'], ['photo', 'F'], ['graph', 'F'], ['vivid', 'V'], ['wave', 'V'], ['fluffy', 'F']]) {
      expect(phs(w).includes(ph), w).toBe(true);
    }
    expect(phs('phone')[0]).toBe('F');
    expect(phs('fluffy').filter((p) => p === 'F')).toHaveLength(2);
  });

  it('handle silent letters and digraphs', () => {
    expect(phs('knight')[0]).toBe('N');            // silent k, gh
    expect(phs('knight')).not.toContain('G');
    expect(phs('wrinkle')[0]).toBe('R');           // silent w
    expect(phs('write')[0]).toBe('R');
    expect(has('thinking', 'TH IH NG K IH NG')).toBe(true);
    expect(phs('cheese')).toEqual(['CH', 'IY', 'Z']);
    expect(phs('church')[0]).toBe('CH');
    expect(phs('judge')[0]).toBe('JH');
    expect(phs('ship')).toEqual(['SH', 'IH', 'P']);
    expect(phs('fish')).toEqual(['F', 'IH', 'SH']);
    expect(phs('quick').slice(0, 2)).toEqual(['K', 'W']);
    expect(phs('queen').slice(0, 2)).toEqual(['K', 'W']);
    expect(phs('xylophone').slice(0, 2)).toEqual(['K', 'S']);
  });

  it('soften c and g before e, i, y', () => {
    expect(phs('city')[0]).toBe('S');
    expect(phs('cell')[0]).toBe('S');
    expect(phs('gem')[0]).toBe('JH');
    expect(phs('germ')[0]).toBe('JH');
    expect(phs('cat')[0]).toBe('K');
    expect(phs('goat')[0]).toBe('G');
    expect(phs('gift')[0]).toBe('G');
  });

  it('produce the -tion / -sion / -sure endings', () => {
    expect(has('nation', 'SH AH N')).toBe(true);
    expect(has('station', 'SH AH N')).toBe(true);
    expect(has('vision', 'ZH AH N')).toBe(true);
    expect(has('measure', 'ZH ER')).toBe(true);
  });

  it('give long vowels for a silent final e and vowel teams', () => {
    expect(phs('late')).toEqual(['L', 'EY', 'T']);
    expect(phs('kite')).toEqual(['K', 'AY', 'T']);
    expect(phs('note')).toEqual(['N', 'OW', 'T']);
    expect(phs('cute')).toEqual(['K', 'Y', 'UW', 'T']);
    expect(phs('tube')).toEqual(['T', 'UW', 'B']);
    expect(phs('team')).toEqual(['T', 'IY', 'M']);
    expect(phs('boat')).toEqual(['B', 'OW', 'T']);
    expect(phs('book')).toEqual(['B', 'UH', 'K']);
    expect(phs('mouth')).toEqual(['M', 'AW', 'TH']);
    expect(phs('mouse')).toEqual(['M', 'AW', 'S']);
    expect(phs('flower').slice(0, 3)).toEqual(['F', 'L', 'OW']);
  });

  it('give short vowels in closed syllables', () => {
    expect(phs('cat')).toEqual(['K', 'AE', 'T']);
    expect(phs('bed')).toEqual(['B', 'EH', 'D']);
    expect(phs('sit')).toEqual(['S', 'IH', 'T']);
    expect(phs('hot')).toEqual(['HH', 'AA', 'T']);
    expect(phs('cup')).toEqual(['K', 'AH', 'P']);
    expect(phs('kick')).toEqual(['K', 'IH', 'K']);
    expect(phs('shop')).toEqual(['SH', 'AA', 'P']);
    expect(phs('sing')).toEqual(['S', 'IH', 'NG']);
  });

  it('merge doubled consonants and mark exactly one primary stress', () => {
    expect(phs('happy')).toEqual(['HH', 'AE', 'P', 'IY']);
    expect(phs('coffee')).toEqual(['K', 'AO', 'F', 'IY']);
    for (const w of ['hologram', 'realistic', 'avatar', 'electricity', 'banana', 'magic', 'nation', 'wonderful', 'unhappy']) {
      const stressed = wordToPhones(w).filter((p) => p.stress === 1);
      expect(stressed, w).toHaveLength(1);
    }
    // -ic / -ity / -tion pull the stress onto the syllable before them
    expect(pron('magic')).toMatch(/^M AE1/);
    expect(pron('electricity')).toMatch(/K T R AY1/);
    expect(pron('realistic')).toMatch(/L IH1 S/);
    // a short prefix leaves the stress on the root
    expect(pron('unhappy')).toMatch(/HH AE1/);
    expect(pron('repeat')).toMatch(/P IY1 T$/);
  });

  it('never throw and return phonemes for any letters', () => {
    for (const w of ['zzz', 'qwerty', 'aaaa', 'rhythm', 'strength', "o'clock", 'xyz']) {
      expect(() => letterToSound(w)).not.toThrow();
      expect(wordToPhones(w).length, w).toBeGreaterThan(0);
    }
    expect(wordToPhones('')).toEqual([]);
  });

  it('handle possessives and contractions of unknown words', () => {
    expect(pron("Claude's")).toBe('K L AO1 D Z');
    expect(phs("Python's").at(-1)).toBe('Z');
    expect(phs("cat's").at(-1)).toBe('S');
    expect(phs("Rose's").slice(-2)).toEqual(['IH', 'Z']);
  });
});

describe('numbers and acronyms', () => {
  it('reads numbers the way a voice does', () => {
    expect(numberWords(0)).toEqual(['zero']);
    expect(numberWords(42)).toEqual(['forty', 'two']);
    expect(numberWords(115)).toEqual(['one', 'hundred', 'fifteen']);
    expect(numberWords(2026)).toEqual(['two', 'thousand', 'twenty', 'six']);
    expect(numberWords(3000000)).toEqual(['three', 'million']);
    expect(expandNumber('1999')).toEqual(['nineteen', 'ninety', 'nine']);
    expect(expandNumber('1905')).toEqual(['nineteen', 'oh', 'five']);
    expect(expandNumber('2005')).toEqual(['two', 'thousand', 'five']);
    expect(expandNumber('3.14')).toEqual(['three', 'point', 'one', 'four']);
    expect(expandNumber('21st')).toEqual(['twenty', 'first']);
    expect(expandNumber('4th')).toEqual(['fourth']);
    expect(expandNumber('1,000')).toEqual(['one', 'thousand']);
    expect(expandNumber('007')).toEqual(['zero', 'zero', 'seven']);
    expect(phs('42')).toEqual([...phs('forty'), ...phs('two')]);
  });

  it('spells acronyms but reads capitalised words', () => {
    expect(spell('GPU').map((p) => p.ph)).toEqual(['JH', 'IY', 'P', 'IY', 'Y', 'UW']);
    const words = textToWords('The GPU and the API are FAST, said NASA.');
    const by = Object.fromEntries(words.map((w) => [w.text, w.phones.map((p) => p.ph).join(' ')]));
    expect(by.GPU).toBe('JH IY P IY Y UW');
    expect(by.API).toBe('EY P IY AY');
    expect(by.FAST).toBe(phs('fast').join(' '));
    expect(by.NASA.startsWith('N')).toBe(true);
    expect(words.find((w) => w.text === 'FAST').emphasis).toBe(true);
  });
});

describe('textToWords', () => {
  const text = "Hello! I'm Claude. How are you feeling today?";
  const words = textToWords(text);

  it('keeps character offsets for word boundary events', () => {
    expect(words.map((w) => w.text)).toEqual(['Hello', "I'm", 'Claude', 'How', 'are', 'you', 'feeling', 'today']);
    for (const w of words) expect(text.slice(w.start, w.end)).toBe(w.text);
  });

  it('attaches the following punctuation and classifies content words', () => {
    expect(words.map((w) => w.punct)).toEqual(['!', '', '.', '', '', '', '', '?']);
    expect(words.filter((w) => w.content).map((w) => w.text)).toEqual(['Hello', 'Claude', 'feeling', 'today']);
    expect(textToWords('Well, wait; then: go — now... done').map((w) => w.punct)).toEqual([',', ';', ';', '—', '.', '']);
  });

  it('reads marks inside a token straight through: no pause, and "dot" where the voice says it', () => {
    const w = textToWords('Open package.json at 10:30 on github.com, v2.1.3 now.');
    expect(w.map((x) => x.text)).toEqual(['Open', 'package', 'dot', 'json', 'at', '10', '30', 'on', 'github', 'dot', 'com', 'v', '2.1', '3', 'now']);
    expect(w.map((x) => x.punct)).toEqual(['', '', '', '', '', '', '', '', '', '', ',', '', '', '', '.']);
    expect(w.filter((x) => x.text === 'dot').map((x) => x.content)).toEqual([false, false]);
    expect(textToWords('Use Node.js and main.js.').map((x) => x.text + x.punct).join(' ')).toBe('Use Node dot js and main dot js.');
    // abbreviations keep their (spoken) pauses and get no "dot"
    expect(textToWords('See e.g. this, at 10 a.m. in the U.S. today.').map((x) => x.text + x.punct).join(' ')).toBe('See e g. this, at 10 a m. in the U S. today.');
    // closing quotes and brackets still end a sentence; dashes pause without spaces too
    expect(textToWords('"Done." (Yes.) Wait—what?').map((x) => x.punct)).toEqual(['.', '.', '—', '?']);
  });

  it('splits hyphenated words, expands percentages and skips symbols', () => {
    expect(textToWords('well-known').map((w) => w.text)).toEqual(['well', 'known']);
    const pct = textToWords('50% off');
    expect(pct[0].phones.map((p) => p.ph).join(' ')).toBe([...phs('fifty'), ...phs('percent')].join(' '));
    expect(textToWords('→ ★ :) #')).toEqual([]);
    expect(textToWords('')).toEqual([]);
    expect(textToWords('Café naïve').map((w) => w.phones.length > 0)).toEqual([true, true]);
  });

  it('gives words in other scripts a generic syllable rhythm (never a still mouth)', () => {
    const ru = textToWords('Привет, как дела?');
    expect(ru.map((w) => w.text)).toEqual(['Привет', 'как', 'дела']);
    expect(ru[0].punct).toBe(',');
    for (const w of ru) expect(w.phones.length).toBeGreaterThanOrEqual(2);
    const ja = textToWords('こんにちは');
    expect(ja[0].phones.filter((p) => p.stress === 1)).toHaveLength(1);
    expect(ja[0].phones.length).toBe(10);               // one syllable per kana
    expect(genericPhones('дела')).toEqual(genericPhones('дела'));   // deterministic
    expect(genericPhones('')).toEqual([]);
  });

  it('marks intensifiers as emphasis', () => {
    const w = textToWords('That is really very good');
    expect(w.filter((x) => x.emphasis).map((x) => x.text)).toEqual(['really', 'very']);
  });
});
