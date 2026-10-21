/**
 * Pasted content, Claude-style: a big paste becomes a labelled chip instead
 * of flooding the composer. detectPaste guesses what it is (code + language,
 * JSON, CSV/TSV, logs, Markdown, links, text); the message carries it as a
 * ```pasted block so both the AI and the chat show it as one clear unit.
 */
export type PasteKind = 'code' | 'json' | 'csv' | 'tsv' | 'log' | 'markdown' | 'links' | 'text';

export interface PasteInfo {
  kind: PasteKind;
  language?: string;
  lines: number;
  chars: number;
  /** "TypeScript", "JSON", "CSV", "Log", "Text"… */
  label: string;
}

export interface PastedItem extends PasteInfo {
  id: string;
  text: string;
}

/** Big enough to chip: 800+ characters or 12+ lines. */
export function shouldChip(text: string): boolean {
  return text.length >= 800 || text.split('\n').length >= 12;
}

const LANGS: { language: string; label: string; tests: RegExp[] }[] = [
  { language: 'typescript', label: 'TypeScript', tests: [/\binterface \w+\s*\{/, /:\s*(string|number|boolean)\b/, /\bimport type\b/, /\bas const\b/] },
  { language: 'javascript', label: 'JavaScript', tests: [/\b(const|let) \w+ = /, /=>\s*[{(]/, /\bfunction \w+\(/, /\brequire\(['"]/, /\bexport (default |const |function )/, /\bconsole\.log\(/] },
  { language: 'python', label: 'Python', tests: [/^\s*def \w+\(.*\):/m, /^\s*import \w+|^\s*from \w+ import /m, /\bself\./, /^\s*class \w+(\(.*\))?:/m, /\bprint\(/] },
  { language: 'sql', label: 'SQL', tests: [/\bSELECT\b[\s\S]+\bFROM\b/i, /\bINSERT INTO\b/i, /\bCREATE TABLE\b/i, /\bUPDATE \w+ SET\b/i] },
  { language: 'html', label: 'HTML', tests: [/<(!doctype html|html|head|body|div|span|section)\b/i] },
  { language: 'css', label: 'CSS', tests: [/^[.#]?[\w-]+\s*\{[\s\S]*?:[^;]+;/m, /@media\s*\(/] },
  { language: 'bash', label: 'Shell', tests: [/^#!\/bin\/(ba)?sh/m, /^\s*\$ \w+/m, /\b(npm|pnpm|yarn|pip|apt-get|brew) (install|run|add)\b/, /\bsudo \w+/] },
  { language: 'go', label: 'Go', tests: [/^package \w+$/m, /\bfunc \w+\(/, /:= /] },
  { language: 'rust', label: 'Rust', tests: [/\bfn \w+\(/, /\blet mut \b/, /\bimpl \w+/] },
  { language: 'java', label: 'Java', tests: [/\bpublic (static )?(class|void)\b/, /\bSystem\.out\.println\(/] },
  { language: 'csharp', label: 'C#', tests: [/\busing System\b/, /\bnamespace \w+/, /\bpublic (async )?Task\b/] },
];

export function detectPaste(text: string): PasteInfo {
  const t = text.trim();
  const lines = text.split('\n').length;
  const chars = text.length;
  const base = { lines, chars };

  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return { ...base, kind: 'json', language: 'json', label: 'JSON' };
    } catch {
      /* not JSON */
    }
  }
  const rows = t.split('\n').filter((l) => l.trim());
  if (rows.length >= 2 && rows.every((l) => /^https?:\/\/\S+$/.test(l.trim()))) return { ...base, kind: 'links', label: 'Links' };
  for (const [kind, sep, label] of [['tsv', '\t', 'TSV'], ['csv', ',', 'CSV']] as const) {
    if (rows.length >= 2) {
      const counts = rows.slice(0, 20).map((l) => l.split(sep).length - 1);
      if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) return { ...base, kind, label };
    }
  }
  const logLines = rows.filter((l) => /^\s*(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|(ERROR|WARN|INFO|DEBUG|TRACE)\b|at \S+ \(.*:\d+:\d+\)|Traceback \(most recent call last\))/.test(l)).length;
  if (rows.length >= 3 && logLines / rows.length >= 0.4) return { ...base, kind: 'log', label: 'Log' };

  let best: { language: string; label: string; score: number } | null = null;
  for (const l of LANGS) {
    const score = l.tests.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { language: l.language, label: l.label, score };
  }
  // TypeScript is a superset of JavaScript: prefer it when its own markers show.
  if (best && best.score >= 1 && (best.score >= 2 || /[{};]\s*$/m.test(text))) return { ...base, kind: 'code', language: best.language, label: best.label };
  if (/^(#{1,6} |\s*[-*] |\d+\. |```)/m.test(text) && rows.filter((l) => /^(#{1,6} |\s*[-*] |\d+\. )/.test(l)).length >= 2) {
    return { ...base, kind: 'markdown', language: 'markdown', label: 'Markdown' };
  }
  return { ...base, kind: 'text', label: 'Text' };
}

export function pasteSummary(p: PasteInfo): string {
  return `Pasted · ${p.label} · ${p.lines.toLocaleString()} line${p.lines === 1 ? '' : 's'}`;
}

/** Serialize for the message: a ```pasted block the chat renders as a chip. */
export function serializePasted(items: PastedItem[]): string {
  return items
    .map((p) => {
      const fence = '`'.repeat(Math.max(3, ...[...p.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `${fence}pasted kind=${p.kind}${p.language ? ` lang=${p.language}` : ''} lines=${p.lines}\n${p.text}\n${fence}`;
    })
    .join('\n\n');
}

export interface MessagePart {
  type: 'text' | 'pasted';
  text: string;
  info?: PasteInfo;
}

/** Split a message into typed text and pasted blocks (for rendering). */
export function splitPasted(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /(`{3,})pasted kind=(\w+)(?: lang=([\w#+-]+))? lines=(\d+)\n([\s\S]*?)\n\1/g;
  let last = 0;
  for (const m of content.matchAll(re)) {
    if (m.index! > last) parts.push({ type: 'text', text: content.slice(last, m.index) });
    const body = m[5]!;
    const label = detectPaste(body).label;
    parts.push({ type: 'pasted', text: body, info: { kind: m[2] as PasteKind, language: m[3], lines: Number(m[4]), chars: body.length, label } });
    last = m.index! + m[0].length;
  }
  if (last < content.length) parts.push({ type: 'text', text: content.slice(last) });
  return parts.filter((p) => p.type === 'pasted' || p.text.trim());
}
