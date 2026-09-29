/**
 * CodeConClave — PKG-22 Advanced Code Workspace panel.
 * Honest, server-authoritative code workspace over the real project root (disk):
 * file tree navigation, multi-file open tabs, version-aware save (never silently
 * overwrites), project content search, HEURISTIC symbol outline, safe rename
 * refactor preview → review → apply, diagnostics overlay, memory recall, and
 * Git-history honesty. UNAVAILABLE / ENVIRONMENT_BLOCKED surfaces are shown as
 * the truth, never faked. Editing only ever happens through the reviewed
 * workspace pipeline; a working editor (Monaco/CodeMirror/LSP) is UNAVAILABLE.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Icon } from './Icon';

interface Capabilities {
  anchors: string[];
  enabled: boolean;
  rootConfigured: boolean;
  editor: { state: string; syntaxHighlighting: string; lineNumbers: string; multiFileTabs: string; splitPane: string; undoRedo: string; unsavedState: string; persistence: string };
  search: string;
  symbols: { state: string; lsp: string };
  refactoring: { state: string; operations: string[] };
  diagnostics: { state: string; note: string };
  diffReview: string;
  b1Integration: string;
  memory: string;
  crossFileIntelligence: string;
  performance: string;
  security: string;
  userIsolation: string;
  workspaceIsolation: string;
  git: string;
  api: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  children?: TreeNode[];
}

interface FileEntry {
  path: string;
  content: string;
  sha256: string;
  binary: boolean;
  large: boolean;
  truncated: boolean;
}

interface WorkspaceState {
  workspaceId: string;
  projectId: string;
  activePath: string | null;
  split: string;
  tabs: { path: string; pinned: boolean; unsaved: boolean; savedSha256?: string | null }[];
}

interface SearchResult {
  query: string;
  regex: boolean;
  total: number;
  truncated: boolean;
  matches: { file: string; line: number; text: string; contextBefore: string[]; contextAfter: string[] }[];
}

interface OutlineRow {
  name: string;
  kind: string;
  line: number;
}

interface RenamePlan {
  id: string;
  symbol: string;
  newName: string;
  status: 'PLANNED' | 'APPLIED' | 'BLOCKED' | 'REJECTED';
  fileCount: number;
  files: { path: string; diff: string; additions: number; deletions: number }[];
  appliesTo: string[];
  blockedReason?: string;
}

interface Review {
  id: string;
  status: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: { path: string; accepted: boolean; applied: boolean }[];
}

const STATUS_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
};

export function CodeWorkspacePanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [tabs, setTabs] = useState<WorkspaceState['tabs']>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [file, setFile] = useState<FileEntry | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [searchQ, setSearchQ] = useState('');
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [outline, setOutline] = useState<OutlineRow[]>([]);
  const [symbolQ, setSymbolQ] = useState('');
  const [newName, setNewName] = useState('');
  const [plan, setPlan] = useState<RenamePlan | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [gitText, setGitText] = useState('checking…');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      setCaps(await api<Capabilities>('/api/v1/codeworkspace/capabilities', { body: { projectId } }));
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, [projectId]);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const refreshTree = useCallback(async () => {
    try {
      const t = await api<TreeNode[]>('/api/v1/codeworkspace/tree');
      setTree(t ?? []);
    } catch (e) {
      setError(message(e, 'could not load the project tree'));
    }
  }, []);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const refreshState = useCallback(async () => {
    try {
      const s = await api<WorkspaceState>('/api/v1/codeworkspace/state');
      setTabs(s.tabs ?? []);
      if (s.activePath) setActivePath(s.activePath);
    } catch { /* surfaced on demand */ }
  }, []);

  useEffect(() => {
    void refreshState();
    void api<{ git: { state: string; hasRepo: boolean } }>('/api/v1/codeworkspace/git')
      .then((r) => setGitText(r.git?.hasRepo ? 'repo present; history UNAVAILABLE' : r.git?.state === 'UNAVAILABLE' ? 'GIT_HISTORY UNAVAILABLE (no .git)' : 'GIT_HISTORY UNAVAILABLE'))
      .catch(() => setGitText('GIT_HISTORY UNAVAILABLE'));
  }, [refreshState]);

  const openFile = useCallback(
    async (rel: string) => {
      setBusy(true);
      setError(null);
      try {
        const f = await api<FileEntry>(`/api/v1/codeworkspace/file?path=${encodeURIComponent(rel)}`);
        setFile(f);
        setDraft(f.content);
        setActivePath(rel);
        await api(`/api/v1/codeworkspace/tab/open`, { method: 'POST', body: { path: rel } });
        const s = await api<WorkspaceState>('/api/v1/codeworkspace/state');
        setTabs(s.tabs ?? []);
        const o = await api<{ outline: OutlineRow[] | null }>(`/api/v1/codeworkspace/symbols/outline?path=${encodeURIComponent(rel)}`).catch(() => ({ outline: null }));
        setOutline((o.outline ?? []).map((x) => ({ name: x.name, kind: x.kind, line: x.line })));
      } catch (e) {
        setError(message(e, 'could not open file'));
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const save = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sha256: string }>('/api/v1/codeworkspace/file/save', {
        method: 'POST',
        body: { path: file.path, content: draft, baseSha256: file.sha256 },
      });
      setFile({ ...file, content: draft, sha256: r.sha256 });
      await refreshState();
    } catch (e) {
      setError(message(e, 'save refused (file changed on disk) — re-open to re-apply'));
    } finally {
      setBusy(false);
    }
  }, [file, draft, refreshState]);

  const runSearch = useCallback(async () => {
    if (!searchQ.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setSearch(await api<SearchResult>(`/api/v1/codeworkspace/search?q=${encodeURIComponent(searchQ)}`));
    } catch (e) {
      setError(message(e, 'search unavailable'));
    } finally {
      setBusy(false);
    }
  }, [searchQ]);

  const previewRename = useCallback(async () => {
    if (!symbolQ.trim() || !newName.trim()) return;
    setBusy(true);
    setError(null);
    setPlan(null);
    setReview(null);
    try {
      const p = await api<{ plan: RenamePlan }>('/api/v1/codeworkspace/refactor/rename/preview', {
        method: 'POST',
        body: { symbol: symbolQ, newName },
      });
      setPlan(p.plan);
    } catch (e) {
      setError(message(e, 'rename preview unavailable'));
    } finally {
      setBusy(false);
    }
  }, [symbolQ, newName]);

  const executeRename = useCallback(async () => {
    if (!symbolQ.trim() || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ plan: RenamePlan; reviewId: string }>('/api/v1/codeworkspace/refactor/rename', {
        method: 'POST',
        body: { symbol: symbolQ, newName },
      });
      setPlan(r.plan);
      setReview(await api<Review>(`/api/v1/codeworkspace/review?id=${encodeURIComponent(r.reviewId)}`));
    } catch (e) {
      setError(message(e, 'rename blocked'));
    } finally {
      setBusy(false);
    }
  }, [symbolQ, newName]);

  const acceptAndApply = useCallback(async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/codeworkspace/review/${review.id}/accept-all`, { method: 'POST' });
      setReview(await api<Review>('/api/v1/codeworkspace/review/' + review.id + '/apply', { method: 'POST' }));
      await refreshTree();
      if (file) await openFile(file.path);
    } catch (e) {
      setError(message(e, 'apply refused'));
    } finally {
      setBusy(false);
    }
  }, [review, refreshTree, file, openFile]);

  const rejectRename = useCallback(async () => {
    if (!review) return;
    await api(`/api/v1/codeworkspace/review/${review.id}/reject-all`, { method: 'POST' });
    setReview(await api<Review>(`/api/v1/codeworkspace/review?id=${encodeURIComponent(review.id)}`));
  }, [review]);

  const enabled = !!caps?.enabled;

  return (
    <div data-testid="codeworkspace-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Advanced Code Workspace</h2>

      <section data-testid="cw-capabilities" className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">Capabilities ({caps?.anchors.join(', ') ?? 'F19 F20 F34 F90 B1'})</h3>
        {capsState === 'loading' && <p data-testid="cw-caps-loading">Loading workspace status…</p>}
        {capsState === 'error' && <p data-testid="cw-caps-error">Workspace module unavailable on this deployment.</p>}
        {capsState === 'ready' && caps && (
          <div className="mt-2 space-y-1 text-xs text-gray-700" data-testid="cw-caps-ready">
            <p data-testid="cw-cap-enabled">Enabled: {caps.enabled ? 'yes' : 'no (AIOS_P2_WORKSPACE off, reversible)'}</p>
            <p data-testid="cw-cap-editor">Editor: {STATUS_LABEL[caps.editor.state] ?? caps.editor.state} · syntax highlighting {STATUS_LABEL[caps.editor.syntaxHighlighting] ?? caps.editor.syntaxHighlighting} (no Monaco/LSP)</p>
            <p data-testid="cw-cap-symbols">Symbol intelligence: {STATUS_LABEL[caps.symbols.state] ?? caps.symbols.state} (no LSP {caps.symbols.lsp})</p>
            <p data-testid="cw-cap-refactor">Refactoring: {STATUS_LABEL[caps.refactoring.state] ?? caps.refactoring.state} · {caps.refactoring.operations.join(', ')}</p>
            <p data-testid="cw-cap-diff">Diff review: {STATUS_LABEL[caps.diffReview] ?? caps.diffReview} · B1 integration: {capOk(caps.b1Integration)}</p>
            <p data-testid="cw-cap-git">Git history: {STATUS_LABEL[caps.git] ?? caps.git}</p>
          </div>
        )}
      </section>

      <section className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">File navigation</h3>
        <p data-testid="cw-git" className="text-xs text-amber-700">{gitText}</p>
        <div className="mt-2 grid grid-cols-2 gap-2" data-testid="cw-tree">
          <ul className="max-h-64 overflow-auto rounded border p-2 text-xs">
            {tree.map((node) => (
              <TreeNodeRow key={node.path} node={node} onOpen={openFile} />
            ))}
            {tree.length === 0 && <li data-testid="cw-tree-empty" className="text-gray-500">No readable files (or workspace not usable).</li>}
          </ul>
          <div className="rounded border p-2 text-xs">
            <p className="font-medium">Open tabs</p>
            {tabs.length === 0 && <p data-testid="cw-tabs-empty" className="text-gray-500">No tabs open.</p>}
            {tabs.map((t) => (
              <button key={t.path} data-testid="cw-tab" className="mr-1 mb-1 rounded border px-2 py-0.5 text-[10px]" onClick={() => void openFile(t.path)}>
                {t.path.split('/').pop()}{t.unsaved ? ' •' : ''}
              </button>
            ))}
          </div>
        </div>
      </section>

      {activePath && (
        <section className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">Editor — {activePath}</h3>
          <p data-testid="cw-editor-note" className="text-xs text-amber-700">
            Plain-text editor (line-oriented). Syntax highlights &amp; LSP are UNAVAILABLE; saves are version-conflict protected and, for multi-file/AI changes, reviewed.
          </p>
          <div className="mt-2 flex gap-2">
            <button data-testid="cw-save" className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50" disabled={busy} onClick={() => void save()}>
              Save (version-safe)
            </button>
          </div>
          <textarea
            data-testid="cw-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="mt-2 block h-48 w-full rounded border p-2 font-mono text-xs"
          />
          {file?.binary && <p data-testid="cw-binary" className="text-xs text-amber-700">Binary/protected — opened read-only metadata only.</p>}
        </section>
      )}

      {outline.length > 0 && (
        <section className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">Symbol outline (HEURISTIC)</h3>
          <ul className="mt-2 text-xs" data-testid="cw-outline">
            {outline.map((o) => (
              <li key={`${o.name}-${o.line}`}>
                <span className="mr-2 text-gray-500">{o.kind}</span>
                {o.name} <span className="text-gray-400">:{o.line}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">Project search</h3>
        <div className="mt-2 flex gap-2">
          <input data-testid="cw-search-q" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} className="w-1/2 rounded border px-2 py-1 text-xs" placeholder="search terms…" />
          <button data-testid="cw-search-run" disabled={busy} onClick={() => void runSearch()} className="rounded bg-blue-600 px-3 py-1 text-xs text-white">Search</button>
        </div>
        {search && (
          <div data-testid="cw-search-results" className="mt-2 text-xs">
            <p>{search.total} match(es){search.truncated ? ' (truncated)' : ''}</p>
            {search.matches.slice(0, 20).map((m, i) => (
              <p key={i}>
                <button className="text-blue-700 underline" onClick={() => void openFile(m.file)}>{m.file}:{m.line}</button> {m.text}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="rounded border p-3 text-sm">
        <h3 className="text-sm font-medium">Safe rename refactor (HEURISTIC — reviewed)</h3>
        <div className="mt-2 flex gap-2">
          <input data-testid="cw-symbol" value={symbolQ} onChange={(e) => setSymbolQ(e.target.value)} placeholder="symbol" className="w-1/4 rounded border px-2 py-1 text-xs" />
          <input data-testid="cw-newname" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="newName" className="w-1/4 rounded border px-2 py-1 text-xs" />
          <button data-testid="cw-rename-preview" disabled={busy || !enabled} onClick={() => void previewRename()} className="rounded border px-3 py-1 text-xs">Preview rename</button>
          <button data-testid="cw-rename-exec" disabled={busy || !enabled} onClick={() => void executeRename()} className="rounded border px-3 py-1 text-xs">Create reviewed rename</button>
        </div>
        {plan && (
          <div data-testid="cw-plan" className="mt-2 text-xs">
            <p>Status: <span className="font-medium">{plan.status}</span> · {plan.fileCount} file(s)</p>
            {plan.blockedReason && <p data-testid="cw-plan-blocked" className="text-amber-700">{plan.blockedReason}</p>}
          </div>
        )}
        {review && (
          <div data-testid="cw-review" className="mt-2 rounded border p-2 text-xs">
            <p>
              Review {review.id.slice(0, 8)} · {review.status} · {review.additions}+/ {review.deletions}− across {review.filesChanged} file(s)
            </p>
            <div className="mt-2 flex gap-2">
              <button data-testid="cw-review-apply" disabled={busy} onClick={() => void acceptAndApply()} className="rounded bg-blue-600 px-3 py-1 text-xs text-white">Accept all &amp; apply</button>
              <button data-testid="cw-review-reject" disabled={busy} onClick={() => void rejectRename()} className="rounded border px-3 py-1 text-xs">Reject</button>
            </div>
            <ul className="mt-2 list-disc pl-4">
              {review.files.map((f) => (
                <li key={f.path} data-testid="cw-review-file">
                  {f.path} — {f.accepted ? 'accepted' : 'rejected'} {f.applied ? '(applied)' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {caps?.diagnostics?.state && (
        <p data-testid="cw-diagnostics-note" className="text-xs text-amber-700">
          Diagnostics: {STATUS_LABEL[caps.diagnostics.state] ?? caps.diagnostics.state} — {caps.diagnostics.note}
        </p>
      )}

      {error && <p data-testid="cw-error" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function TreeNodeRow({ node, onOpen }: { node: TreeNode; onOpen: (p: string) => void }) {
  if (node.type === 'dir') {
    return (
      <li data-testid="cw-dir">
        <span className="font-medium"><Icon name="folder" size={13} /> {node.name}/</span>
        {node.children && (
          <ul className="pl-3">
            {node.children.map((c) => (
              <TreeNodeRow key={c.path} node={c} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button data-testid="cw-file" className="text-blue-700 underline" onClick={() => onOpen(node.path)}>
        {node.name}
      </button>
    </li>
  );
}

function capOk(v: string): string {
  return v === 'VERIFIED' ? 'verified' : v;
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}
