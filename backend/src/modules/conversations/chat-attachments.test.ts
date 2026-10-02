/**
 * CodeConClave — chat attachment prompt-block tests (pure builder).
 * The ownership + size enforcement lives in resolveChatAttachments (storage-
 * gated); the block shape is verified here hermetically.
 */
import { describe, it, expect } from 'vitest';
import { buildAttachmentBlock } from './chat.js';

describe('buildAttachmentBlock', () => {
  it('returns an empty string for no parts', () => {
    expect(buildAttachmentBlock([])).toBe('');
  });

  it('inlines text content inside a fenced text block', () => {
    const block = buildAttachmentBlock([{ name: 'notes.md', text: 'line1\nline2' }]);
    expect(block).toContain('- notes.md');
    expect(block).toContain('```text\nline1\nline2\n```');
  });

  it('marks binary parts without inlining content', () => {
    const block = buildAttachmentBlock([{ name: 'photo.png', binaryBytes: 2048 }]);
    expect(block).toContain('[binary content — 2048 bytes; not inlined]');
    expect(block).not.toContain('photo.png\nphoto.png');
  });

  it('orders multiple parts and closes the block', () => {
    const block = buildAttachmentBlock([
      { name: 'a.md', text: 'A' },
      { name: 'b.bin', binaryBytes: 1 },
    ]);
    expect(block.startsWith('\n----- attached files -----')).toBe(true);
    expect(block.endsWith('----- end attached files -----')).toBe(true);
  });
});