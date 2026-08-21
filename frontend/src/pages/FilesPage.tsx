/**
 * CodeConClave — Files: upload (multipart), folder tree, search, metadata
 * (tags/category/favorite), honest preview status, versions + rollback,
 * references, activity and trash lifecycle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { uploadForm } from '../lib/api';
import {
  displayNameOf,
  type FileActivityItem,
  type FileRef,
  type FileReference,
  type FileTreeNode,
  type FileVersionInfo,
} from '../lib/types';
import { useToast } from '../components/Toast';
import { PreviewPanel } from '../components/PreviewPanel';

interface LoadedFile {
  file: FileRef;
  versions?: FileVersionInfo[];
  references?: FileReference[];
  activity?: FileActivityItem[];
}

export function FilesPage() {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, LoadedFile>>({});
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const [categoryDraft, setCategoryDraft] = useState<Record<string, string>>({});

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
      setFiles([]);
      setTree([]);
      return;
    }
    try {
      const [list, treeRes] = await Promise.all([
        api<{ files: FileRef[] }>(`/api/v1/files?projectId=${encodeURIComponent(projectId)}`),
        api<{ tree: FileTreeNode[] }>(`/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}`),
      ]);
      setFiles(list.files);
      setTree(treeRes.tree);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const search = async () => {
    const q = query.trim();
    if (!q || !projectId) {
      await load();
      return;
    }
    try {
      const res = await api<{ files: FileRef[] }>(
        `/api/v1/files/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`,
      );
      setFiles(res.files);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'search failed', 'error');
    }
  };

  const upload = async (list: FileList) => {
    setBusy(true);
    try {
      await api('/api/v1/files/upload', {
        method: 'POST',
        body: uploadForm(Array.from(list), { projectId }),
      });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'upload failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    if (loaded[id]) {
      setLoaded((prev) => ({ ...prev, [id]: { file: prev[id]!.file } }));
      return;
    }
    try {
      const [v, r, a] = await Promise.all([
        api<{ versions: FileVersionInfo[] }>(`/api/v1/files/${id}/versions?projectId=${encodeURIComponent(projectId)}`),
        api<{ references: FileReference[] }>(`/api/v1/files/${id}/references?projectId=${encodeURIComponent(projectId)}`),
        api<{ activity: FileActivityItem[] }>(`/api/v1/files/${id}/activity?projectId=${encodeURIComponent(projectId)}`),
      ]);
      setLoaded((prev) => ({ ...prev, [id]: { file: prev[id]!.file, versions: v.versions, references: r.references, activity: a.activity } }));
    } catch {
      /* ignore */
    }
  };

  const toggleFavorite = async (f: FileRef) => {
    try {
      const res = await api<{ file: FileRef }>(`/api/v1/files/${f.id}/favorite`, {
        method: 'POST',
        body: { projectId, favorite: !f.is_favorite },
      });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? res.file : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'favorite failed', 'error');
    }
  };

  const saveTags = async (f: FileRef) => {
    const tags = (tagDraft[f.id] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const res = await api<{ file: FileRef }>(`/api/v1/files/${f.id}/tags`, {
        method: 'POST',
        body: { projectId, tags },
      });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? res.file : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'tags failed', 'error');
    }
  };

  const saveCategory = async (f: FileRef) => {
    try {
      const res = await api<{ file: FileRef }>(`/api/v1/files/${f.id}/category`, {
        method: 'POST',
        body: { projectId, category: categoryDraft[f.id] ?? '' },
      });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? res.file : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'category failed', 'error');
    }
  };

  const rollback = async (f: FileRef, version: number) => {
    try {
      const res = await api<{ file: FileRef }>(`/api/v1/files/${f.id}/restore-version`, {
        method: 'POST',
        body: { projectId, version },
      });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? res.file : x)));
      await open(f.id);
      toast(`Restored v${version}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'rollback failed', 'error');
    }
  };

  const trash = async (id: string) => {
    try {
      await api(`/api/v1/files/${id}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'trash failed', 'error');
    }
  };

  const Tree = ({ nodes, depth }: { nodes: FileTreeNode[]; depth: number }) => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, paddingLeft: depth * 14 }}>
      {nodes.map((node) => (
        <li key={node.path}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <span className={node.type === 'folder' ? '' : 'cc-hint'} style={{ minWidth: 0 }}>
              {node.type === 'folder' ? '📁' : '📄'} {node.name}
            </span>
            {node.file && (
              <span className="cc-hint cc-mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {(node.file.size_bytes / 1024).toFixed(1)} KB · v{node.file.preview_status === 'AVAILABLE' ? 'preview' : '—'}
              </span>
            )}
          </div>
          {node.children && node.children.length > 0 && <Tree nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );

  const visible = useMemo(
    () =>
      files.map((f) => ({
        file: f,
        versions: loaded[f.id]?.versions,
        references: loaded[f.id]?.references,
        activity: loaded[f.id]?.activity,
      })),
    [files, loaded],
  );

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1>Files</h1>
        <select className="cc-select" style={{ width: 260 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          className="cc-input"
          placeholder="Search files in this project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        <button className="cc-btn cc-btn--ghost" onClick={() => void search()}>Search</button>
      </div>
      {projectId && <PreviewPanel projectId={projectId} />}
      {projectId && (
        <label className="cc-card" style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
          <span className="cc-btn">Upload files</span>
          <span className="cc-hint">Max 16 files at once</span>
          <input
            type="file"
            multiple
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      )}
      <div className="cc-grid cc-grid-2" style={{ marginTop: 8 }}>
        <div className="cc-card">
          <h3>Folder tree</h3>
          {tree.length === 0 ? <div className="cc-empty">Empty project.</div> : <Tree nodes={tree} depth={0} />}
        </div>
        <div>
          {visible.length === 0 && <div className="cc-card cc-empty">No files.</div>}
          {visible.map(({ file: f, versions, references, activity }) => (
            <div className="cc-card" key={f.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <strong>{displayNameOf(f.path)}</strong>
                  <div className="cc-hint cc-mono">{f.path}</div>
                  <div className="cc-hint">
                    {(f.size_bytes / 1024).toFixed(1)} KB · {f.mime_type ?? 'unknown'} ·{' '}
                    {f.encrypted ? 'encrypted at rest' : 'plain'} ·{' '}
                    {f.is_favorite ? '★ favorite' : 'not favorite'}
                  </div>
                  {f.tags.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {f.tags.map((t) => (
                        <span key={t} className="cc-pill" style={{ fontSize: 11 }}>{t}</span>
                      ))}
                    </div>
                  )}
                  {f.category && <div className="cc-hint" style={{ marginTop: 2 }}>category: {f.category}</div>}
                  <div className="cc-hint" style={{ marginTop: 2 }}>
                    preview: {f.preview_kind ?? 'unknown'} ({f.preview_status}) · OCR: {f.ocr_status}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 260 }}>
                  <button
                    className="cc-btn cc-btn--ghost cc-btn--sm"
                    onClick={() => window.open(`/api/v1/files/${f.id}/content?projectId=${encodeURIComponent(projectId)}`, '_blank')}
                  >
                    Download
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void open(f.id)}>
                    Details
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleFavorite(f)}>
                    {f.is_favorite ? 'Unfavorite' : 'Favorite'}
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void trash(f.id)}>
                    Trash
                  </button>
                </div>
              </div>
              {loaded[f.id] && (
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="cc-input"
                      style={{ width: 200 }}
                      placeholder="tags (comma separated)"
                      defaultValue={f.tags.join(', ')}
                      onChange={(e) => setTagDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    />
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void saveTags(f)}>Save tags</button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="cc-input"
                      style={{ width: 200 }}
                      placeholder="category"
                      defaultValue={f.category ?? ''}
                      onChange={(e) => setCategoryDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    />
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void saveCategory(f)}>Save category</button>
                  </div>
                  {versions && versions.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {versions.map((v) => (
                        <li key={v.version} className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span>v{v.version} · {(v.size_bytes / 1024).toFixed(1)} KB · {v.reason} · {new Date(v.created_at).toLocaleString()}</span>
                          {v.version < (versions[0]?.version ?? v.version) && (
                            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void rollback(f, v.version)}>
                              Restore
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {references && references.length > 0 && (
                    <div className="cc-hint">
                      references: {references.map((r) => `${r.ref_type}${r.ref_id ? `:${r.ref_id}` : ''}`).join(', ')}
                    </div>
                  )}
                  {activity && activity.length > 0 && (
                    <div className="cc-hint">
                      activity: {activity.map((a) => a.action).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
