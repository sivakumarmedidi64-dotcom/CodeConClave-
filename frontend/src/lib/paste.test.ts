import { describe, expect, it } from 'vitest';
import { detectPaste, serializePasted, shouldChip, splitPasted } from './paste';

const ts = `import type { User } from './types';\ninterface Props {\n  name: string;\n  age: number;\n}\nexport const greet = (p: Props) => \`Hi \${p.name}\`;\n`;

describe('paste detection', () => {
  it('chips only big pastes', () => {
    expect(shouldChip('short')).toBe(false);
    expect(shouldChip('x'.repeat(800))).toBe(true);
    expect(shouldChip(Array(12).fill('a').join('\n'))).toBe(true);
  });
  it('recognises code with its language', () => {
    expect(detectPaste(ts)).toMatchObject({ kind: 'code', language: 'typescript', label: 'TypeScript' });
    expect(detectPaste('def add(a, b):\n    return a + b\n\nprint(add(1, 2))\n')).toMatchObject({ kind: 'code', label: 'Python' });
    expect(detectPaste('SELECT id, name FROM users WHERE active = true;')).toMatchObject({ label: 'SQL' });
  });
  it('recognises data, logs, links and prose', () => {
    expect(detectPaste('{"a": 1, "b": [2, 3]}')).toMatchObject({ kind: 'json', label: 'JSON' });
    expect(detectPaste('name,age\nAsha,31\nRavi,28')).toMatchObject({ kind: 'csv' });
    expect(detectPaste('2026-10-21 10:00:01 INFO start\n2026-10-21 10:00:02 ERROR boom\n2026-10-21 10:00:03 WARN retry')).toMatchObject({ kind: 'log' });
    expect(detectPaste('https://a.com/x\nhttps://b.org/y')).toMatchObject({ kind: 'links' });
    expect(detectPaste('Dear team, the meeting moved to Friday. Please confirm.')).toMatchObject({ kind: 'text', label: 'Text' });
  });
  it('round-trips through the message so the chat can show it as a chip', () => {
    const block = serializePasted([{ id: 'p1', text: ts, ...detectPaste(ts) }]);
    const parts = splitPasted(`Please review this\n\n${block}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'Please review this\n\n' });
    expect(parts[1]).toMatchObject({ type: 'pasted', text: ts, info: { kind: 'code', language: 'typescript', label: 'TypeScript' } });
  });
  it('a paste that contains code fences cannot break out of its block', () => {
    const tricky = 'before\n```\ninner\n```\nafter';
    const block = serializePasted([{ id: 'p', text: tricky, ...detectPaste(tricky) }]);
    expect(splitPasted(block)[0]!.text).toBe(tricky);
  });
});
