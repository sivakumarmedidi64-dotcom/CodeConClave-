/**
 * CodeConClave — DNA Load: blocks, save (MAIN/BRANCH), versions, compare,
 * restore-version, branch, export. Explicit loading / error states.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import type { DnaBlock, DnaCompare, DnaKind, DnaScope, DnaVersion } from '../lib/types';
import { useToast } from '../components/Toast';

const KINDS: DnaKind[] = ['DECISION', 'UNRESOLVED_WORK', 'NEXT_ACTIONS', 'DISCOVERY', 'BLOCKER', 'PROJECT_CONTEXT', 'RELEVANT_FILES', 'ENVIRONMENT_STATE', 'VERIFICATION_RESULT'];

function DnaLoader({ label = 'Loading DNA…' }: { label?: string }) {
  return (
    <div className="cc-card cc-empty" data-testid="dna-loader">
      <div className="cc-dna-loader">
        <div className="cc-dna-loader__helix" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => (
            <span
              key={i}
              className="cc-dna-loader__rung"
              style={{ top: `${i * 10}%`, '--cc-dna-delay': `${i * 120}ms` } as CSSProperties}
            />
          ))}
        </div>
        <div className="cc-dna-loader__label">{label}</div>
      </div>
    </div>
  );
}

export function DnaPage() {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [blocks, setBlocks] = useState<DnaBlock[]>([]);
  const [kind, setKind] = useState<DnaKind>('DECISION');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<DnaScope>('MAIN');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [versions, setVersions] = useState<Record<string, DnaVersion[]>>({});
  const [compare, setCompare] = useState<Record<string, DnaCompare | null>>({});
  const [loadingBlock, setLoadingBlock] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void api<{ projects: { id: string; name: string }[] }>('/api/v1/projects')
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) setProjectId(res.projects[0]!.id);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setBlocks([]);
      setState('ready');
      return;
    }
    setState('loading');
    try {
      const res = await api<{ blocks: DnaBlock[] }>(`/api/v1/dna?projectId=${encodeURIComponent(projectId)}`);
      setBlocks(res.blocks);
      setState('ready');
    } catch {
      setBlocks([]);
      setState('error');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      await api('/api/v1/dna', {
        method: 'POST',
        body: { projectId, kind, title: title.trim(), content, scope, auto: false },
      });
      setTitle('');
      setContent('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'save failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const exportDna = () => {
    window.location.href = `/api/v1/dna/export?projectId=${encodeURIComponent(projectId)}`;
  };

  const toggleBlock = async (id: string) => {
    const isOpen = Boolean(open[id]);
    setOpen((prev) => ({ ...prev, [id]: !isOpen }));
    if (!isOpen) {
      setLoadingBlock((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await api<{ versions: DnaVersion[] }>(`/api/v1/dna/${id}/versions`);
        setVersions((prev) => ({ ...prev, [id]: res.versions }));
      } catch {
        setVersions((prev) => ({ ...prev, [id]: [] }));
      } finally {
        setLoadingBlock((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const compareBlock = async (id: string, from: number, to: number) => {
    try {
      const res = await api<DnaCompare>(`/api/v1/dna/${id}/compare?from=${from}&to=${to}`);
      setCompare((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'compare failed', 'error');
    }
  };

  const restoreVersion = async (id: string, version: number) => {
    try {
      await api(`/api/v1/dna/${id}/restore-version`, { method: 'POST', body: { version } });
      toast(`Restored v${version}`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'restore failed', 'error');
    }
  };

  const branchBlock = async (id: string) => {
    try {
      await api(`/api/v1/dna/${id}/branch`, {
        method: 'POST',
        body: { projectId, title: `Branch of ${title || 'block'}`, content: '' },
      });
      toast('Branch created');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'branch failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1>DNA Load</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="cc-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="cc-btn cc-btn--ghost" onClick={exportDna} disabled={!projectId}>
            Export .jsonl
          </button>
        </div>
      </div>
      {projectId && (
        <div className="cc-card">
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '150px 1fr auto', marginBottom: 8 }}>
            <select className="cc-select" value={kind} onChange={(e) => setKind(e.target.value as DnaKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <select className="cc-select" value={scope} onChange={(e) => setScope(e.target.value as DnaScope)}>
              <option value="MAIN">MAIN</option>
              <option value="BRANCH">BRANCH</option>
            </select>
            <button className="cc-btn" disabled={busy || !title.trim()} onClick={() => void save()}>
              Save block
            </button>
          </div>
          <input className="cc-input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className="cc-textarea"
            style={{ marginTop: 8, minHeight: 120 }}
            placeholder="Content (directives, constraints, decisions…)"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
      )}
      {state === 'loading' && <DnaLoader />}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load DNA blocks.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && blocks.length === 0 && <div className="cc-card cc-empty">No DNA blocks yet.</div>}
      {state === 'ready' &&
        blocks.map((b) => (
          <div className="cc-card" key={b.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="cc-pill cc-pill--accent">{b.kind}</span>
              <span className="cc-pill">{b.scope}</span>
              {b.auto && <span className="cc-pill">auto</span>}
              <span className="cc-hint">v{b.version}</span>
            </div>
            <h3 style={{ margin: '8px 0 4px' }}>{b.title}</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{b.content}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleBlock(b.id)}>
                {open[b.id] ? 'Hide versions' : 'Versions'}
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void branchBlock(b.id)}>
                Branch
              </button>
            </div>
            {open[b.id] && (
              <div style={{ marginTop: 10 }}>
                {loadingBlock[b.id] && <p className="cc-hint">Loading versions…</p>}
                {!loadingBlock[b.id] && (
                  <>
                    {versions[b.id] && versions[b.id]!.length === 0 && <p className="cc-hint">No versions recorded.</p>}
                    {versions[b.id]?.map((v) => (
                      <div key={v.version} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                        <span className="cc-pill">v{v.version}</span>
                        <span className="cc-hint" style={{ flex: 1 }}>{v.title} — {new Date(v.created).toLocaleString()}</span>
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void compareBlock(b.id, v.version, b.version)}>
                          Compare → v{b.version}
                        </button>
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void restoreVersion(b.id, v.version)}>
                          Restore
                        </button>
                      </div>
                    ))}
                    {compare[b.id] && (
                      <div className="cc-hint" style={{ marginTop: 8 }}>
                        <strong style={{ fontSize: 13, color: 'var(--cc-text)' }}>
                          v{compare[b.id]!.from.version} → v{compare[b.id]!.to.version}
                        </strong>
                        {compare[b.id]!.added.length > 0 && (
                          <div>added: {compare[b.id]!.added.map((a) => a.title).join(', ')}</div>
                        )}
                        {compare[b.id]!.removed.length > 0 && (
                          <div>removed: {compare[b.id]!.removed.map((r) => r.title).join(', ')}</div>
                        )}
                        {compare[b.id]!.changed.length > 0 && (
                          <div>changed: {compare[b.id]!.changed.map((c) => c.title).join(', ')}</div>
                        )}
                        {compare[b.id]!.added.length === 0 &&
                          compare[b.id]!.removed.length === 0 &&
                          compare[b.id]!.changed.length === 0 && <div>no differences</div>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}