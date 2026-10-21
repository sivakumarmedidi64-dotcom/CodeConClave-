import { describe, expect, it } from 'vitest';
import { chatAsMarkdown, estimateTokens } from './chatExport';

describe('chatAsMarkdown', () => {
  it('exports the visible chat as Markdown with speakers', () => {
    const md = chatAsMarkdown(
      [
        { role: 'user', content: 'Fix the login bug' },
        { role: 'assistant', content: 'Done.\n\n```ts\nconst ok = true;\n```' },
        { role: 'system', content: 'Usage limit reached' },
        { role: 'assistant', content: '   ' },
      ],
      'Login bug',
    );
    expect(md).toBe(
      '# Login bug\n\n**You**\n\nFix the login bug\n\n**CodeConClave AI**\n\nDone.\n\n```ts\nconst ok = true;\n```\n\n> Usage limit reached\n',
    );
  });

  it('estimates tokens at about four characters each', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});
