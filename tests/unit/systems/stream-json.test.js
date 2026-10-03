import { describe, it, expect } from 'vitest';
import { JsonLineParser, encodeJsonLine } from '../../../electron/stream-json.js';

function collect(opts = {}) {
  const messages = [];
  const errors = [];
  const parser = new JsonLineParser({
    onMessage: (m) => messages.push(m),
    onError: (e, line) => errors.push({ message: e.message, line }),
    ...opts,
  });
  return { parser, messages, errors };
}

describe('JsonLineParser', () => {
  it('parses complete lines', () => {
    const { parser, messages, errors } = collect();
    parser.push('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual([]);
  });

  it('reassembles lines split across chunks at every position', () => {
    const text = '{"type":"x","text":"héllo wörld ✓"}\n{"n":2}\n';
    const bytes = Buffer.from(text, 'utf8');
    for (let cut = 1; cut < bytes.length; cut++) {
      const { parser, messages } = collect();
      parser.push(bytes.subarray(0, cut)); // may split a multi-byte UTF-8 character
      parser.push(bytes.subarray(cut));
      expect(messages).toEqual([{ type: 'x', text: 'héllo wörld ✓' }, { n: 2 }]);
    }
  });

  it('handles one byte at a time', () => {
    const { parser, messages } = collect();
    for (const b of Buffer.from('{"k":"v"}\r\n{"k":"w"}\n')) parser.push(Buffer.from([b]));
    expect(messages).toEqual([{ k: 'v' }, { k: 'w' }]);
  });

  it('strips CRLF and a UTF-8 BOM, skips blank lines', () => {
    const { parser, messages, errors } = collect();
    parser.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\r\n\r\n   \n{"b":2}\r\n')]));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual([]);
  });

  it('reports invalid JSON and non-objects without stopping', () => {
    const { parser, messages, errors } = collect();
    parser.push('not json\n[1,2]\n42\n{"ok":true}\n');
    expect(messages).toEqual([{ ok: true }]);
    expect(errors).toHaveLength(3);
    expect(errors[0].line).toBe('not json');
  });

  it('flushes a final unterminated line on end()', () => {
    const { parser, messages } = collect();
    parser.push('{"a":1}\n{"b":');
    expect(messages).toEqual([{ a: 1 }]);
    parser.push('2}');
    parser.end();
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    parser.push('{"c":3}\n'); // ignored after end
    expect(messages).toHaveLength(2);
  });

  it('parses huge lines delivered in many chunks', () => {
    const { parser, messages } = collect();
    const big = 'x'.repeat(5 * 1024 * 1024);
    const line = JSON.stringify({ text: big }) + '\n';
    for (let i = 0; i < line.length; i += 65536) parser.push(line.slice(i, i + 65536));
    expect(messages).toHaveLength(1);
    expect(messages[0].text.length).toBe(big.length);
  });

  it('drops lines over the limit and recovers', () => {
    const { parser, messages, errors } = collect({ maxLineLength: 1000 });
    parser.push(`{"t":"${'y'.repeat(600)}`);
    parser.push(`${'y'.repeat(600)}"}\n{"after":1}\n`);
    expect(messages).toEqual([{ after: 1 }]);
    expect(errors[0].message).toMatch(/too long/);
  });

  it('routes consumer exceptions to onError', () => {
    const errors = [];
    const parser = new JsonLineParser({
      onMessage: (m) => {
        if (m.boom) throw new Error('consumer failed');
      },
      onError: (e) => errors.push(e.message),
    });
    parser.push('{"boom":true}\n{"fine":true}\n');
    expect(errors).toEqual(['consumer failed']);
  });

  it('encodeJsonLine always produces exactly one line', () => {
    const s = encodeJsonLine({ text: 'a\nb\r\nc d' });
    expect(s.endsWith('\n')).toBe(true);
    expect(s.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(s)).toEqual({ text: 'a\nb\r\nc d' });
  });
});
