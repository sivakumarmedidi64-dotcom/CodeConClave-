/**
 * CodeConClave — Workbench shared primitives.
 * Pure, dependency-free helpers the Workbench surface runs on top of the REAL
 * backend endpoints. Nothing here fabricates data: every panel either renders
 * server payloads or an honest unavailable/loading state.
 */
import { api, ApiError } from './api';
import type {
  ArtifactInfo,
  FileTreeNode,
  Memory,
  Project,
  Task,
  TaskTimeline,
} from './types';

export interface ActivityEvent {
  id: string;
  source: string;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  summary: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actor_user_id: string | null;
  tenant_scope: string | null;
  tenant_id: string | null;
  action: string | null;
  resource_type: string | null;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface CoworkerHandoff {
  id: string;
  from_run_id: string | null;
  to_run_id: string | null;
  handoff_title: string | null;
  handoff_summary: string | null;
  content: string | null;
  created_at: string | null;
  updated_at?: string | null;
}

export interface ReviewDiff {
  id: string;
  title: string | null;
  diffText: string;
  [k: string]: unknown;
}

/* ---------------------------------------------------------------- fetchers */

export async function fetchProjects(): Promise<Project[]> {
  const res = await api<{ projects: Project[] }>('/api/v1/projects');
  return res.projects ?? [];
}

export async function fetchFileTree(projectId: string): Promise<FileTreeNode[]> {
  const res = await api<{ tree: FileTreeNode[] }>(`/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}`);
  return res.tree ?? [];
}

export async function fetchTasks(projectId: string): Promise<Task[]> {
  const res = await api<{ tasks: Task[] }>(`/api/v1/execution/tasks?projectId=${encodeURIComponent(projectId)}`);
  return res.tasks ?? [];
}

export async function fetchTimeline(taskId: string): Promise<TaskTimeline> {
  return api<TaskTimeline>(`/api/v1/execution/tasks/${encodeURIComponent(taskId)}`);
}

export async function fetchArtifacts(taskId: string): Promise<ArtifactInfo[]> {
  const res = await api<{ artifacts: ArtifactInfo[] }>(`/api/v1/execution/tasks/${encodeURIComponent(taskId)}/artifacts`);
  return res.artifacts ?? [];
}

export async function fetchMemories(projectId: string): Promise<Memory[]> {
  const res = await api<{ memories: Memory[] }>(`/api/v1/memory?projectId=${encodeURIComponent(projectId)}`);
  return res.memories ?? [];
}

export async function fetchHandoffs(projectId: string): Promise<CoworkerHandoff[]> {
  const res = await api<{ handoffs: CoworkerHandoff[] }>(`/api/v1/memory/handoffs?projectId=${encodeURIComponent(projectId)}`);
  return res.handoffs ?? [];
}

export async function fetchReviews(projectId: string): Promise<ReviewDiff[]> {
  const res = await api<{ reviews: ReviewDiff[] }>(`/api/v1/reviews?projectId=${encodeURIComponent(projectId)}`);
  return res.reviews ?? [];
}

export async function fetchActivity(projectId: string): Promise<ActivityEvent[]> {
  const res = await api<{ events: ActivityEvent[] }>(
    `/api/v1/activity?scope=project&projectId=${encodeURIComponent(projectId)}&limit=40`,
  );
  return res.events ?? [];
}

export async function fetchAudit(): Promise<AuditEvent[]> {
  const res = await api<{ events: AuditEvent[] }>('/api/v1/audit?limit=40');
  return res.events ?? [];
}

const TEXT_MIME = /^text\//i;
const CODE_MIME = /^(application\/(?:json|javascript|xml|x-)?)/i;

/** Raw file bytes -> text, or null for binary payloads the viewer must not open. */
export async function fileContentText(projectId: string, fileId: string): Promise<string | null> {
  const res = await fetch(
    `/api/v1/files/${encodeURIComponent(fileId)}/content?projectId=${encodeURIComponent(projectId)}`,
    { credentials: 'same-origin' },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Request failed (${res.status})`);
  }
  const mime = res.headers.get('content-type') ?? '';
  if (!TEXT_MIME.test(mime) && !CODE_MIME.test(mime)) return null;
  return res.text();
}

/* ---------------------------------------------------------------- SSE stream */
export type WorkbenchEvent =
  | { type: 'task'; id: string; projectId: string; status: string; ts: string }
  | { type: 'coworker'; id: string; runId: string; projectId: string; state: string; ts: string }
  | { type: 'execution'; id: string; projectId: string; status: string; ts: string }
  | { type: 'background'; id: string; projectId: string; status: string; ts: string }
  | { type: 'verification'; id: string; projectId: string; status: string; ts: string }
  | { type: 'capture'; projectId: string; channel: 'console' | 'network'; ts: string }
  | { type: 'preview'; projectId: string; state: string; ts: string };

export interface WorkbenchStream {
  close: () => void;
  connected: () => boolean;
}

/**
 * Project-scoped event stream (/api/v1/runtime/events). Reconnects with
 * exponential backoff and reports connection state honestly. When EventSource
 * is unavailable (or the stream cannot open) callers fall back to short
 * polling — the UI shows which transport is live.
 */
export function workbenchStream(
  projectId: string,
  handlers: { onEvent: (e: WorkbenchEvent) => void; onState: (connected: boolean) => void },
): WorkbenchStream {
  if (!projectId || typeof EventSource === 'undefined') {
    handlers.onState(false);
    return { close: () => {}, connected: () => false };
  }
  let disposed = false;
  let es: EventSource | null = null;
  let retry = 0;
  let connectedNow = false;

  const setConnected = (v: boolean) => {
    if (connectedNow !== v) {
      connectedNow = v;
      handlers.onState(v);
    }
  };

  const connect = () => {
    if (disposed) return;
    es = new EventSource(`/api/v1/runtime/events?projectId=${encodeURIComponent(projectId)}`);
    const onMsg = (ev: MessageEvent<string>) => {
      retry = 0;
      setConnected(true);
      try {
        const data = JSON.parse(ev.data) as WorkbenchEvent;
        if (data && typeof data.type === 'string') handlers.onEvent(data);
      } catch {
        /* malformed frame: ignore, keep the stream */
      }
    };
    const onOpen = () => {
      retry = 0;
      setConnected(true);
    };
    const onErr = () => {
      es?.close();
      setConnected(false);
      if (disposed) return;
      retry += 1;
      const delay = Math.min(1000 * 2 ** Math.min(retry, 5), 30_000);
      setTimeout(connect, delay);
    };
    es.addEventListener('message', onMsg as EventListener);
    es.addEventListener('open', onOpen as EventListener);
    es.addEventListener('error', onErr as EventListener);
    const current = es;
    void current; // captured for closure cleanup
  };

  connect();
  return {
    close: () => {
      disposed = true;
      es?.close();
      setConnected(false);
    },
    connected: () => connectedNow,
  };
}

/* ---------------------------------------------------------------- status */

const TASK_STATUS_META: Record<string, { label: string; color: string }> = {
  CREATED: { label: 'Created', color: '#64748b' },
  PENDING: { label: 'Pending', color: '#64748b' },
  PLANNED: { label: 'Planned', color: '#2f6fb2' },
  PLANNING: { label: 'Planning', color: '#2f6fb2' },
  WAITING_APPROVAL: { label: 'Waiting approval', color: '#b45309' },
  QUEUED: { label: 'Queued', color: '#64748b' },
  RUNNING: { label: 'Running', color: '#8A3FFC' },
  STALLED: { label: 'Stalled', color: '#b45309' },
  PAUSED: { label: 'Paused', color: '#8a8a8a' },
  REQUIRES_REVIEW: { label: 'Needs review', color: '#ca8a04' },
  VERIFYING: { label: 'Verifying', color: '#8A3FFC' },
  COMPLETED: { label: 'Completed', color: '#1e7d46' },
  FAILED: { label: 'Failed', color: '#dc2626' },
  CANCELLED: { label: 'Cancelled', color: '#8a8a8a' },
  TIMED_OUT: { label: 'Timed out', color: '#dc2626' },
  BLOCKED: { label: 'Blocked', color: '#dc2626' },
  DEAD_LETTERED: { label: 'Dead lettered', color: '#dc2626' },
};

export function statusMeta(status: string): { label: string; color: string } {
  return TASK_STATUS_META[status] ?? { label: status ?? 'Unknown', color: '#334155' };
}

const ACTIVE_TASK_STATUS = new Set(['CREATED', 'PENDING', 'PLANNED', 'PLANNING', 'WAITING_APPROVAL', 'QUEUED', 'RUNNING', 'STALLED', 'PAUSED', 'REQUIRES_REVIEW', 'VERIFYING']);

export function isActiveTaskStatus(status: string | null | undefined): boolean {
  return Boolean(status && ACTIVE_TASK_STATUS.has(status));
}

/* ---------------------------------------------------------------- layout */

export interface WorkbenchLayout {
  leftPx: number;
  rightPx: number;
  bottomPx: number;
}

const LAYOUT_KEY = 'cc.workbench.layout.v1';
const DEFAULT_LAYOUT: WorkbenchLayout = { leftPx: 260, rightPx: 320, bottomPx: 220 };

export function loadWorkbenchLayout(projectId: string): WorkbenchLayout {
  try {
    const raw = globalThis.localStorage.getItem(`${LAYOUT_KEY}.${projectId}`);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<WorkbenchLayout>;
    return {
      leftPx: typeof parsed.leftPx === 'number' && parsed.leftPx >= 120 ? parsed.leftPx : DEFAULT_LAYOUT.leftPx,
      rightPx: typeof parsed.rightPx === 'number' && parsed.rightPx >= 180 ? parsed.rightPx : DEFAULT_LAYOUT.rightPx,
      bottomPx: typeof parsed.bottomPx === 'number' && parsed.bottomPx >= 60 ? parsed.bottomPx : DEFAULT_LAYOUT.bottomPx,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveWorkbenchLayout(projectId: string, layout: WorkbenchLayout): void {
  try {
    globalThis.localStorage.setItem(`${LAYOUT_KEY}.${projectId}`, JSON.stringify(layout));
  } catch {
    /* best-effort persistence */
  }
}

/* ---------------------------------------------------------------- diff */

export type DiffOp = { type: 'equal' | 'add' | 'del'; text: string };

/**
 * Line-level LCS diff used by the Workbench BEFORE/AFTER viewer. Inputs larger
 * than the guard degrade honestly to whole-file change markers rather than
 * blocking the paint.
 */
export function lineDiff(aLines: string[], bLines: string[], maxLen = 2000): DiffOp[] {
  const a = aLines ?? [];
  const b = bLines ?? [];
  if (a.length === 0) return b.map((text) => ({ type: 'add' as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: 'del' as const, text }));
  if (a.length > maxLen || b.length > maxLen) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1]!) + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i]! });
      i++;
      j++;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      ops.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j]! });
    j++;
  }
  return ops;
}

export interface ParsedDiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: { header: string; lines: DiffOp[] }[];
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse "diff --git a/x b/x ... @@ ..." output (the REAL persisted format of
 *  review.diffText) into renderable files/hunks. */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  const lines = (raw ?? '').split('\n');
  let current: ParsedDiffFile | null = null;
  let hunkLines: DiffOp[] = [];
  let header = '';

  const flushHunk = () => {
    if (current && hunkLines.length > 0) {
      current.hunks.push({ header, lines: hunkLines });
      hunkLines = [];
      header = '';
    }
  };

  const flushFile = () => {
    flushHunk();
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      const match = /diff --git a\/(?:.+?) b\/(.+)$/.exec(line);
      const path = match?.[1] ?? line.slice('diff --git '.length);
      current = { path: path.replace(/\s+$/, ''), additions: 0, deletions: 0, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith('@@ ')) {
        current = { path: '(no file)', additions: 0, deletions: 0, hunks: [] };
        files.push(current);
      } else {
        continue;
      }
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      flushHunk();
      header = line;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
      continue;
    }
    if (line.startsWith('+')) {
      hunkLines.push({ type: 'add', text: line.slice(1) });
      current.additions += 1;
    } else if (line.startsWith('-')) {
      hunkLines.push({ type: 'del', text: line.slice(1) });
      current.deletions += 1;
    } else {
      hunkLines.push({ type: 'equal', text: line });
    }
  }
  flushFile();
  return { files };
}

/* ---------------------------------------------------------------- highlight */

export interface HighlightToken {
  type: 'comment' | 'string' | 'number' | 'keyword' | 'function' | 'tag' | 'attribute' | 'operator' | 'plain';
  text: string;
}

const KEYWORDS_TS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'import', 'export', 'from', 'default', 'class', 'extends', 'interface', 'type', 'enum', 'extends', 'implements', 'public', 'private', 'protected', 'readonly', 'static', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'null', 'undefined', 'true', 'false', 'this', 'super', 'yield', 'void', 'delete', 'as', 'satisfies', 'keyof', 'unknown', 'never', 'string', 'number', 'boolean', 'object', 'Promise', 'any']);
const KEYWORDS_HTML = new Set(['<', '>', '</', '/>']);
const KEYWORDS_JSON = new Set(['true', 'false', 'null']);

export function highlightLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'ts';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
      return 'md';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
      return 'sh';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'plain';
  }
}

export function highlightRange(text: string, language: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let rest = text;
  const push = (type: HighlightToken['type'], value: string) => {
    if (value) tokens.push({ type, text: value });
  };
  const wordRe = /^[A-Za-z_$][\w$]*/;
  const rules: { type: HighlightToken['type']; re: RegExp }[] = [
    { type: 'comment', re: language === 'sh' || language === 'sql' || language === 'yaml' ? /^#.*/ : /^\/\/.*/ },
    { type: 'comment', re: /^\/\*[\s\S]*?(?:\*\/|$)/ },
    { type: 'string', re: /^`(?:\\.|[^`\\])*`?/ },
    { type: 'string', re: /^"(?:\\.|[^"\\])*"?/ },
    { type: 'string', re: /^'(?:\\.|[^'\\])*'?/ },
    { type: 'number', re: /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/ },
    { type: 'operator', re: /^(===|!==|==|!=|<=|>=|=>|\+\+|--|\|\||&&|\||->|[+\-*/%<>&|^~=:?()\[\]{}.,;])/ },
  ];
  while (rest.length > 0) {
    const indent = rest.length - rest.trimStart().length;
    if (indent > 0) {
      push('plain', rest.slice(0, indent));
      rest = rest.slice(indent);
      continue;
    }
    let matched = false;
    for (const rule of rules) {
      const m = rule.re.exec(rest);
      if (m && m[0].length > 0) {
        push(rule.type, m[0]);
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (language === 'html') {
      const tag = /^<\/?[A-Za-z][\w-]*/.exec(rest);
      if (tag) {
        push('tag', tag[0]);
        rest = rest.slice(tag[0].length);
        continue;
      }
      const attr = /^[A-Za-z_:][\w:.-]*(?==)/.exec(rest);
      if (attr) {
        push('attribute', attr[0]);
        rest = rest.slice(attr[0].length);
        continue;
      }
    }
    const word = wordRe.exec(rest);
    if (word) {
      const value = word[0];
      if (isKeywordFor(language, value)) {
        push('keyword', value);
      } else {
        const fn = /^[A-Za-z_$][\w$]*(?=\s*\()/.exec(rest);
        push(fn && isFunctionVisible(language, value) ? 'function' : 'plain', value);
      }
      rest = rest.slice(value.length);
      continue;
    }
    push('plain', rest[0]!);
    rest = rest.slice(1);
  }
  return tokens;
}

function isKeywordFor(language: string, value: string): boolean {
  if (language === 'json') return KEYWORDS_JSON.has(value);
  if (language === 'ts') return KEYWORDS_TS.has(value);
  return false;
}

function isFunctionVisible(language: string, value: string): boolean {
  return language === 'ts' || language === 'css' || language === 'sql';
}

/** Full-text line tokens (one entry per input line). */
export function highlightLines(text: string, language: string): HighlightToken[][] {
  return (text ?? '').split('\n').map((line) => highlightRange(line, language));
}

export function languageFromExtension(filePath: string): string {
  return highlightLanguage(filePath);
}

/* ---------------------------------------------------------------- normalize */

/** Coworker runs come back as raw (snake_case) rows; normalize for display. */
export interface WorkbenchCoworkerRun {
  id: string;
  coworkerType: string;
  state: string;
  verification: 'PASS' | 'FAIL' | 'SKIPPED' | null;
  error: string | null;
  output: string | null;
  orderIndex: number;
  createdAt: string;
}

export function normalizeCoworkerRun(raw: Record<string, unknown>): WorkbenchCoworkerRun {
  const output = raw.output;
  const outputText =
    output == null
      ? null
      : typeof output === 'string'
        ? output
        : JSON.stringify(output);
  return {
    id: String(raw.id ?? raw.run_id ?? ''),
    coworkerType: String(raw.coworker_type ?? raw.coworkerType ?? ''),
    state: String(raw.state ?? ''),
    verification: (raw.verification_result ?? null) as 'PASS' | 'FAIL' | 'SKIPPED' | null,
    error: String(raw.error_code ?? raw.error ?? '') || null,
    output: outputText,
    orderIndex: Number(raw.order_index ?? 0),
    createdAt: String(raw.created_at ?? ''),
  };
}

export function normalizeCoworkerRuns(raw: unknown[]): WorkbenchCoworkerRun[] {
  return (raw ?? []).map((r) => normalizeCoworkerRun((r ?? {}) as Record<string, unknown>));
}

/** Artifact rows arrive snake_case + a `run` label; read both shapes. */
export function artifactValue<T>(a: Record<string, unknown>, keys: string[], fallback: T): T {
  for (const k of keys) {
    const v = a[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return fallback;
}

export function normalizeArtifacts(raw: unknown[]): Record<string, unknown>[] {
  return (raw ?? []).filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'));
}