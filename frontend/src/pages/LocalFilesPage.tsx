/**
 * Local files — the web app working directly on a folder on your computer
 * (File System Access API, Chromium browsers). Browse, read, edit by hand or
 * ask CodeConClave to change a file. Every write shows the diff and asks
 * first, Claude-style: Yes / Yes, don't ask again for this folder / No —
 * unless your permission mode already auto-accepts edits. Secret files are
 * never opened or written. Nothing leaves your machine except the file
 * content you choose to send to the AI.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { streamChat } from '../lib/sse';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import {
  diffStats,
  extractCodeBlock,
  folderAccessSupported,
  lineDiff,
  listDir,
  pickFolder,
  readText,
  writeText,
  type DiffLine,
  type DirHandle,
  type TreeNode,
} from '../lib/localfs';

type Mode = 'ask' | 'accept_edits' | 'full_access';

interface Pending {
  node: TreeNode;
  before: string;
  after: string;
  source: 'you' | 'ai';
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  // Collapse long unchanged runs to keep the review focused on changes.
  const rows: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    if (run.length > 6) {
      rows.push(...run.slice(0, 3), { kind: 'gap', count: run.length - 6 }, ...run.slice(-3));
    } else rows.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.kind === 'same') run.push(l);
    else {
      flush();
      rows.push(l);
    }
  }
  flush();
  return (
    <pre className="lf-diff" aria-label="Proposed changes">
      {rows.map((r, i) =>
        r.kind === 'gap' ? (
          <div key={i} className="lf-diff__gap">
            ⋯ {r.count} unchanged lines
          </div>
        ) : (
          <div key={i} className={`lf-diff__line lf-diff__line--${r.kind}`}>
            <span className="lf-diff__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            {r.text || ' '}
          </div>
        ),
      )}
    </pre>
  );
}

export function LocalFilesPage() {
  const { toast } = useToast();
  const supported = folderAccessSupported();
  const [root, setRoot] = useState<DirHandle | null>(null);
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<TreeNode | null>(null);
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mode, setMode] = useState<Mode>('ask');
  const [allowFolder, setAllowFolder] = useState(false);

  useEffect(() => {
    api<{ mode: Mode }>('/api/v1/control/permission-mode')
      .then((r) => setMode(r.mode))
      .catch(() => setMode('ask'));
  }, []);

  const expand = useCallback(async (dir: DirHandle, path: string) => {
    const list = await listDir(dir, path);
    setChildren((prev) => ({ ...prev, [path]: list }));
  }, []);

  const openFolder = async () => {
    try {
      const dir = await pickFolder();
      setRoot(dir);
      setChildren({});
      setOpen(new Set());
      setFile(null);
      setAllowFolder(false);
      await expand(dir, '');
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') toast(err instanceof Error ? err.message : 'Could not open folder', 'error');
    }
  };

  const toggleDir = async (node: TreeNode) => {
    const next = new Set(open);
    if (next.has(node.path)) next.delete(node.path);
    else {
      next.add(node.path);
      if (!children[node.path]) await expand(node.handle as DirHandle, node.path);
    }
    setOpen(next);
  };

  const openFile = async (node: TreeNode) => {
    setFile(node);
    setFileError(null);
    const res = await readText(node);
    if ('error' in res) {
      setFileError(res.error);
      setSaved('');
      setDraft('');
      return;
    }
    setSaved(res.text);
    setDraft(res.text);
  };

  const autoAccept = allowFolder || mode === 'accept_edits' || mode === 'full_access';

  const apply = async (p: Pending) => {
    await writeText(p.node, p.after);
    setSaved(p.after);
    setDraft(p.after);
    setPending(null);
    const s = diffStats(lineDiff(p.before, p.after));
    toast(`Saved ${p.node.name} (+${s.added} −${s.removed})`);
  };

  const propose = async (p: Pending) => {
    if (p.before === p.after) {
      toast('No changes to save');
      return;
    }
    if (autoAccept) {
      try {
        await apply(p);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Write failed', 'error');
      }
      return;
    }
    setPending(p);
  };

  const askAi = async () => {
    if (!file || !instruction.trim()) return;
    setAiBusy(true);
    let answer = '';
    try {
      const prompt =
        `You are editing the file \`${file.path}\` in the user's local project.\n` +
        `Change requested: ${instruction.trim()}\n\n` +
        'Reply with ONLY the complete updated file inside one fenced code block. Do not omit unchanged parts.\n\n' +
        `Current file:\n\`\`\`\n${draft}\n\`\`\``;
      await streamChat({ content: prompt, mode: 'CHAT' }, (ev) => {
        if (ev.type === 'delta') answer += ev.data.delta;
        if (ev.type === 'error') throw new Error(ev.data.message);
      });
      const proposed = extractCodeBlock(answer);
      if (!proposed) {
        toast('CodeConClave did not return a file — try rephrasing the change.', 'error');
        return;
      }
      setInstruction('');
      await propose({ node: file, before: saved, after: proposed, source: 'ai' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'AI edit failed', 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const pendingDiff = useMemo(() => (pending ? lineDiff(pending.before, pending.after) : []), [pending]);
  const pendingStats = diffStats(pendingDiff);

  const renderTree = (path: string, depth: number): React.ReactNode =>
    (children[path] ?? []).map((n) => (
      <div key={n.path}>
        <button
          type="button"
          className={`lf-node${file?.path === n.path ? ' is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => void (n.kind === 'directory' ? toggleDir(n) : openFile(n))}
          aria-expanded={n.kind === 'directory' ? open.has(n.path) : undefined}
        >
          <Icon name={n.kind === 'directory' ? 'folder' : 'file'} size={14} className="lf-node__icon" />
          <span className="lf-node__name">{n.name}</span>
        </button>
        {n.kind === 'directory' && open.has(n.path) && renderTree(n.path, depth + 1)}
      </div>
    ));

  if (!supported) {
    return (
      <div className="cc-page">
        <h2 className="sp-title">
          <Icon name="folder" size={22} className="sp-title-icon" /> Local files
        </h2>
        <div className="cc-card">
          <p>This browser can&apos;t open local folders. Use Chrome or Edge on a computer, or the CodeConClave desktop app.</p>
          <p className="cc-hint">
            Prefer your coworker to work your files and terminal for you? <Link to="/remote">Pair the desktop agent</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-page lf-page">
      <header className="sp-header">
        <div>
          <h2 className="sp-title">
            <Icon name="folder" size={22} className="sp-title-icon" /> Local files
          </h2>
          <p className="cc-muted sp-subtitle">
            Work on a folder on this computer, right from the browser. Every edit shows you the diff first. Secret files (.env, keys) are never opened.
          </p>
        </div>
        <button type="button" className="cc-btn cc-btn--primary" onClick={() => void openFolder()}>
          <Icon name="folder" size={15} className="sp-btn-icon" /> {root ? 'Open another folder' : 'Open folder'}
        </button>
      </header>

      {!root && <div className="cc-card cc-empty">Choose a folder to start. Your browser will ask for permission.</div>}

      {root && (
        <div className="lf-layout">
          <nav className="cc-card lf-tree" aria-label="Folder tree">
            <div className="lf-root">
              <Icon name="folder" size={14} className="lf-node__icon" /> {root.name}
            </div>
            {renderTree('', 0)}
          </nav>
          <section className="lf-editor">
            {!file && <div className="cc-card cc-empty">Pick a file from the tree.</div>}
            {file && (
              <div className="cc-card lf-file">
                <div className="lf-file__head">
                  <code className="cc-mono">{file.path}</code>
                  {draft !== saved && <span className="cc-pill">unsaved</span>}
                  <span className={`pm-chip pm-chip--${autoAccept ? 'full_access' : 'ask'}`} title="How edits are confirmed">
                    {autoAccept ? 'Edits apply without asking' : 'Asks before every edit'}
                  </span>
                </div>
                {fileError ? (
                  <p className="cc-hint">{fileError}</p>
                ) : (
                  <>
                    <textarea
                      className="cc-textarea cc-mono lf-text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      aria-label={`Contents of ${file.path}`}
                    />
                    <div className="lf-actions">
                      <button
                        type="button"
                        className="cc-btn"
                        disabled={draft === saved}
                        onClick={() => void propose({ node: file, before: saved, after: draft, source: 'you' })}
                      >
                        Save
                      </button>
                      <button type="button" className="cc-btn cc-btn--ghost" disabled={draft === saved} onClick={() => setDraft(saved)}>
                        Revert
                      </button>
                    </div>
                    <div className="lf-ai">
                      <input
                        className="cc-input"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void askAi();
                        }}
                        placeholder="Ask CodeConClave to change this file…"
                        aria-label="Describe the change"
                        disabled={aiBusy}
                      />
                      <button type="button" className="cc-btn cc-btn--primary" disabled={aiBusy || !instruction.trim()} onClick={() => void askAi()}>
                        {aiBusy ? 'Writing…' : 'Propose edit'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {pending && (
        <div className="sp-overlay lf-overlay" role="dialog" aria-modal="true" aria-label={`Allow edit to ${pending.node.path}?`}>
          <div className="sp-modal lf-permission">
            <h3>
              Allow {pending.source === 'ai' ? 'CodeConClave' : 'this save'} to edit <code className="cc-mono">{pending.node.path}</code>?
            </h3>
            <p className="cc-hint">
              +{pendingStats.added} −{pendingStats.removed} lines · written straight to your folder
            </p>
            <DiffView lines={pendingDiff} />
            <div className="lf-permission__actions">
              <button type="button" className="cc-btn cc-btn--primary" onClick={() => void apply(pending).catch((err: Error) => toast(err.message, 'error'))}>
                Yes
              </button>
              <button
                type="button"
                className="cc-btn"
                onClick={() => {
                  setAllowFolder(true);
                  void apply(pending).catch((err: Error) => toast(err.message, 'error'));
                }}
              >
                Yes, don&apos;t ask again for this folder
              </button>
              <button type="button" className="cc-btn cc-btn--ghost" onClick={() => setPending(null)}>
                No
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
