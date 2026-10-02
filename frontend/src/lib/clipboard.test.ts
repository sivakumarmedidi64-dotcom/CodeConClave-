/**
 * CodeConClave — clipboard helper tests: copyText (Clipboard API + fallback)
 * and the fenced-code splitter used to render message content with copyable
 * code blocks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText, splitCodeBlocks } from './clipboard';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('prefers the async Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyText('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.unstubAllGlobals();
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const execCommand = vi.fn((cmd: string) => cmd === 'copy');
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    const ok = await copyText('fallback');
    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });

  it('reports failure when nothing could copy', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    expect(await copyText('nope')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('splitCodeBlocks', () => {
  it('keeps a plain message as a single text segment', () => {
    expect(splitCodeBlocks('plain text')).toEqual([{ kind: 'text', content: 'plain text' }]);
  });

  it('splits fenced blocks into text/code segments without fence markers', () => {
    const segments = splitCodeBlocks('before\n```ts\nconst x = 1;\n```\nafter');
    expect(segments).toEqual([
      { kind: 'text', content: 'before' },
      { kind: 'code', content: 'const x = 1;' },
      { kind: 'text', content: 'after' },
    ]);
  });

  it('tolerates an unclosed fence', () => {
    const segments = splitCodeBlocks('```\ndangling');
    expect(segments).toContainEqual({ kind: 'code', content: 'dangling' });
  });
});