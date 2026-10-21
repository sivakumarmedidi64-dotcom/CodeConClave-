/** "Copy chat": the visible conversation as clean Markdown. */
export interface ExportRow {
  role: string;
  content: string;
}

export function chatAsMarkdown(rows: ExportRow[], title?: string): string {
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`, '');
  for (const r of rows) {
    const text = r.content.trim();
    if (!text) continue;
    if (r.role === 'user') parts.push('**You**', '', text, '');
    else if (r.role === 'system') parts.push(...text.split('\n').map((l) => `> ${l}`), '');
    else parts.push('**CodeConClave AI**', '', text, '');
  }
  return parts.join('\n').trimEnd() + '\n';
}

/** Rough token estimate for the composer (≈4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}
