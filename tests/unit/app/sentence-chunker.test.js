import { describe, expect, it } from 'vitest';
import { SentenceChunker, findBoundary } from '../../../src/app/sentence-chunker.js';

/** Feed `text` in pieces of `step` characters (0 = all at once), then flush. */
function chunk(text, step = 0, opts) {
  const c = new SentenceChunker(opts);
  const out = [];
  if (!step) out.push(...c.push(text));
  else for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)));
  out.push(...c.flush());
  return out;
}

/** Feed char-by-char and record after how many characters each chunk appeared. */
function timeline(text, opts) {
  const c = new SentenceChunker(opts);
  const out = [];
  for (let i = 0; i < text.length; i++) for (const s of c.push(text[i])) out.push({ s, at: i + 1 });
  for (const s of c.flush()) out.push({ s, at: Infinity });
  return out;
}

const words = (arr) => arr.join(' ').replace(/\s+/g, ' ').trim();
/** Boundary tests: no merging of short chunks. */
const split = (text, step = 0) => chunk(text, step, { minChars: 0 });

describe('SentenceChunker: sentence boundaries', () => {
  it('splits plain sentences', () => {
    expect(split('Hello there. How are you? I am fine!')).toEqual(['Hello there.', 'How are you?', 'I am fine!']);
  });

  it('only emits a sentence once its end is certain (needs the following whitespace)', () => {
    const c = new SentenceChunker();
    expect(c.push('It costs 3.')).toEqual([]);
    expect(c.push('14 dollars. And')).toEqual(['It costs 3.14 dollars.']);
    expect(c.flush()).toEqual(['And']);
  });

  it('keeps abbreviations, initials and titles inside the sentence', () => {
    expect(split('Dr. Smith met Mr. Jones vs. Mrs. Brown today. Then they left.'))
      .toEqual(['Dr. Smith met Mr. Jones vs. Mrs. Brown today.', 'Then they left.']);
    expect(split('J. R. R. Tolkien wrote it. So did I. Really.'))
      .toEqual(['J. R. R. Tolkien wrote it.', 'So did I.', 'Really.']);
  });

  it('handles e.g. / i.e. / etc.', () => {
    expect(split('Use a tool, e.g. a hammer, i.e. something heavy. Okay.'))
      .toEqual(['Use a tool, e.g. a hammer, i.e. something heavy.', 'Okay.']);
    expect(split('Apples, pears, etc. are fruit. Bananas, etc. Next topic.'))
      .toEqual(['Apples, pears, etc. are fruit.', 'Bananas, etc.', 'Next topic.']);
  });

  it('handles "No. 5" style abbreviations before numbers', () => {
    expect(split('See fig. 3 and No. 5 for details. I said no. Then I left.'))
      .toEqual(['See fig. 3 and No. 5 for details.', 'I said no.', 'Then I left.']);
  });

  it('a period before a lower-case word does not end the sentence', () => {
    expect(split('The U.S. economy grew at 3 p.m. today. Fine.')).toEqual(['The U.S. economy grew at 3 p.m. today.', 'Fine.']);
  });

  it('does not split decimals, versions, URLs or e-mail addresses', () => {
    expect(split('Pi is 3.14159 and v2.1.0 is out. Visit https://example.com/a.b?x=1. Mail me at jo.doe@example.co.uk. Bye.'))
      .toEqual(['Pi is 3.14159 and v2.1.0 is out.', 'Visit https://example.com/a.b?x=1.', 'Mail me at jo.doe@example.co.uk.', 'Bye.']);
  });

  it('treats an ellipsis as a boundary only before a capitalised word', () => {
    expect(split('Well... maybe not. Wait... What was that?'))
      .toEqual(['Well... maybe not.', 'Wait...', 'What was that?']);
    expect(split('Hmm… Let me think.')).toEqual(['Hmm…', 'Let me think.']);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(split('She said "stop." Then (quietly.) he did! "Really?" Yes.'))
      .toEqual(['She said "stop."', 'Then (quietly.) he did!', '"Really?"', 'Yes.']);
  });

  it('handles runs of terminators and bold text', () => {
    expect(split('What?! No way!!! **Note.** It works.'))
      .toEqual(['What?!', 'No way!!!', '**Note.**', 'It works.']);
  });
});

describe('SentenceChunker: lines, lists, headings', () => {
  it('splits paragraphs and joins soft-wrapped lines', () => {
    expect(chunk('First paragraph without a dot\n\nSecond line\ncontinues here.'))
      .toEqual(['First paragraph without a dot', 'Second line continues here.']);
  });

  it('speaks list items without their markers, merging very short ones', () => {
    expect(chunk('Here are the options to consider:\n- Use the first approach for speed\n- Or the second one\n1. Yes\n2. No\n'))
      .toEqual(['Here are the options to consider:', 'Use the first approach for speed', 'Or the second one', 'Yes, No']);
  });

  it('a numbered list marker is not a sentence end', () => {
    expect(chunk('Steps to follow now:\n1. Open the file.\n2. Save it.'))
      .toEqual(['Steps to follow now:', 'Open the file.', 'Save it.']);
  });

  it('removes heading and quote markers', () => {
    expect(chunk('## Summary of results\nAll tests pass.\n> Quoted wisdom here.'))
      .toEqual(['Summary of results', 'All tests pass.', 'Quoted wisdom here.']);
  });

  it('drops fragments without letters or digits', () => {
    expect(chunk('Hello there.\n\n---\n\n***\n\nBye now.')).toEqual(['Hello there.', 'Bye now.']);
  });
});

describe('SentenceChunker: code and tables', () => {
  const reply = 'Here is the function you asked for:\n```js\nfunction add(a, b) {\n  return a + b; // sum. Done.\n}\n```\nIt adds two numbers. Another example:\n~~~\nmore();\n~~~\nThat is all.';

  it('skips fenced code and says a placeholder once', () => {
    expect(chunk(reply)).toEqual([
      'Here is the function you asked for:',
      "I've put the code in the chat.",
      'It adds two numbers.',
      'Another example:',
      'That is all.',
    ]);
  });

  it('gives the same result for any delta size', () => {
    const expected = words(chunk(reply));
    for (const step of [1, 2, 3, 5, 7, 13]) expect(words(chunk(reply, step))).toBe(expected);
  });

  it('never leaks code even when streamed one character at a time', () => {
    const out = chunk(reply, 1).join(' ');
    expect(out).not.toMatch(/add\(|return|sum\.|more\(\)|```|~~~/);
  });

  it('drops an unterminated fence at flush', () => {
    expect(chunk('Look at this:\n```python\nprint("hi")\n')).toEqual(['Look at this:', "I've put the code in the chat."]);
  });

  it('skips table rows with a placeholder', () => {
    const t = 'Comparison below.\n| Name | Speed |\n|---|---|\n| A | 1. fast |\n| B | slow |\nA wins.';
    expect(chunk(t)).toEqual(['Comparison below.', "I've put a table in the chat.", 'A wins.']);
    expect(words(chunk(t, 1))).toBe(words(chunk(t)));
  });

  it('inline code at the start of a line is spoken', () => {
    expect(chunk('`npm test` runs the suite. Done.')).toEqual(['`npm test` runs the suite.', 'Done.']);
  });

  it('custom placeholders (or none)', () => {
    expect(chunk('A:\n```\nx\n```\nB.', 0, { codePlaceholder: '' })).toEqual(['A:', 'B.']);
  });
});

describe('SentenceChunker: latency and length', () => {
  it('cuts the first chunk early at a clause boundary after ~40 characters', () => {
    const text = 'Sure thing, I can definitely help you with that request, and here is how it will work in practice. Second sentence.';
    const tl = timeline(text);
    expect(tl[0].s).toBe('Sure thing, I can definitely help you with that request,');
    expect(tl[0].at).toBeLessThan(62);
    expect(tl.map((x) => x.s).slice(1)).toEqual(['and here is how it will work in practice.', 'Second sentence.']);
  });

  it('does not cut the first chunk at a comma before 40 characters', () => {
    const tl = timeline('Yes, of course. Next.');
    expect(tl.map((x) => x.s)).toEqual(['Yes, of course.', 'Next.']);
  });

  it('emits the first sentence as soon as the next character confirms it', () => {
    const tl = timeline('Hi! How are you?');
    expect(tl[0]).toEqual({ s: 'Hi!', at: 4 });
  });

  it('splits over-long sentences at clauses or words (max length)', () => {
    const long = `${'word '.repeat(30)}and then, ${'more words '.repeat(30)}end.`;
    const out = chunk(long, 0, { maxChars: 120 });
    for (const s of out) expect(s.length).toBeLessThanOrEqual(120);
    expect(words(out)).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('first chunk without any clause mark is cut at a word boundary', () => {
    const out = chunk(`${'lorem ipsum '.repeat(20)}.`, 1, { firstMaxChars: 80 });
    expect(out[0].length).toBeLessThanOrEqual(80);
    expect(out[0].endsWith(' ')).toBe(false);
  });

  it('merges short later sentences into the next chunk (fewer, more natural TTS requests)', () => {
    expect(chunk('Hello there, friend. How are you? I am fine, thanks for asking.'))
      .toEqual(['Hello there, friend.', 'How are you? I am fine, thanks for asking.']);
    expect(chunk('Hi! Ok. Sure.')).toEqual(['Hi!', 'Ok. Sure.']);
  });

  it('flush emits a held short fragment', () => {
    const c = new SentenceChunker();
    expect(c.push('This is the first sentence. ')).toEqual([]); // is the next word lower-case?
    expect(c.push('Ok. ')).toEqual(['This is the first sentence.']);
    expect(c.flush()).toEqual(['Ok.']);
  });

  it('reset() starts over (placeholders can be said again)', () => {
    const c = new SentenceChunker();
    expect([...c.push('```\nx\n```\n'), ...c.flush()]).toEqual(["I've put the code in the chat."]);
    expect([...c.push('```\ny\n```\n'), ...c.flush()]).toEqual([]);
    c.reset();
    expect([...c.push('```\ny\n```\n'), ...c.flush()]).toEqual(["I've put the code in the chat."]);
  });

  it('normalises CRLF', () => {
    expect(chunk('One line.\r\n\r\nTwo line.')).toEqual(['One line.', 'Two line.']);
  });
});

describe('findBoundary', () => {
  it('waits when the character after a period is unknown', () => {
    expect(findBoundary('Hello.', false)).toBeNull();
    expect(findBoundary('Hello.', true)).toEqual({ end: 6, skip: 0 });
    expect(findBoundary('Hello. W', false)).toEqual({ end: 6, skip: 0 });
  });
});
