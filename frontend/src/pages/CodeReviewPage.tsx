/**
 * CodeConClave — Live code review.
 * Paste a diff or add files and four specialists (Architect, Reviewer,
 * Security, Tester) review them independently through the PR Review Swarm
 * (/api/v1/engineering/pr-reviews). Findings stream in as each role finishes;
 * file/line locations are only shown when the server verified them against
 * the submitted files. A role that cannot run reports that honestly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon, type IconName } from '../components/Icon';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
type SwarmStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

interface Swarm {
  id: string;
  title: string;
  pr_ref: string;
  status: SwarmStatus;
  roles: string[];
  verdict: { rolesDone?: number; rolesFailed?: number; findings?: number; severityCounts?: Record<string, number> } | null;
  created_at: string;
}

interface Finding {
  id: string;
  role: string;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  confidence: number;
  recommendation: string | null;
  status: 'OPEN' | 'ACCEPTED' | 'DISMISSED';
}

interface DraftFile {
  path: string;
  content: string;
}

const ROLES: { id: string; label: string; icon: IconName }[] = [
  { id: 'ARCHITECT', label: 'Architect', icon: 'compass' },
  { id: 'REVIEWER', label: 'Reviewer', icon: 'eye' },
  { id: 'SECURITY', label: 'Security', icon: 'shield' },
  { id: 'TESTER', label: 'Tester', icon: 'flask' },
];

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 200_000;
const POLL_MS = 1500;

function isDone(status: SwarmStatus | undefined): boolean {
  return status === 'COMPLETED' || status === 'PARTIAL' || status === 'FAILED';
}

export function CodeReviewPage() {
  const { toast } = useToast();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [diff, setDiff] = useState('');
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [history, setHistory] = useState<Swarm[]>([]);
  const [swarm, setSwarm] = useState<Swarm | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api<{ swarms: Swarm[] }>('/api/v1/engineering/pr-reviews');
      setHistory(res.swarms ?? []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    api<{ projects: { id: string; name: string; deleted_at?: string | null; status?: string }[] }>('/api/v1/projects')
      .then((res) => {
        const live = (res.projects ?? []).filter((p) => !p.deleted_at && p.status !== 'ARCHIVED');
        setProjects(live);
        if (live[0]) setProjectId((cur) => cur || live[0]!.id);
      })
      .catch(() => setProjects([]));
    void loadHistory();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [loadHistory]);

  const refresh = useCallback(async (id: string) => {
    const [s, f] = await Promise.all([
      api<{ swarm: Swarm }>(`/api/v1/engineering/pr-reviews/${id}`),
      api<{ findings: Finding[] }>(`/api/v1/engineering/pr-reviews/${id}/findings`),
    ]);
    setSwarm(s.swarm);
    setFindings(f.findings ?? []);
    return s.swarm;
  }, []);

  const poll = useCallback(
    (id: string) => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      const tick = async () => {
        try {
          const s = await refresh(id);
          if (isDone(s.status)) {
            setRunning(false);
            void loadHistory();
            return;
          }
        } catch {
          /* transient — keep polling */
        }
        pollRef.current = window.setTimeout(() => void tick(), POLL_MS);
      };
      void tick();
    },
    [refresh, loadHistory],
  );

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: DraftFile[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) {
        toast(`${f.name} is larger than 200 KB and was skipped`, 'error');
        continue;
      }
      next.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() });
    }
    setFiles((prev) => {
      const merged = [...prev.filter((p) => !next.some((n) => n.path === p.path)), ...next];
      return merged.slice(0, MAX_FILES);
    });
  };

  const submission = useMemo<DraftFile[]>(() => {
    const out = [...files];
    if (diff.trim()) out.unshift({ path: 'changes.diff', content: diff });
    return out;
  }, [files, diff]);

  const start = async () => {
    setError(null);
    if (!projectId) {
      setError('Pick a project first — reviews are filed as a task in that project.');
      return;
    }
    if (submission.length === 0) {
      setError('Paste a diff or add at least one file to review.');
      return;
    }
    setRunning(true);
    setFindings([]);
    try {
      const prRef = title.trim() || `local-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const res = await api<{ swarm: Swarm }>('/api/v1/engineering/pr-reviews', {
        method: 'POST',
        body: { projectId, prRef, title: title.trim() || undefined, files: submission },
      });
      setSwarm(res.swarm);
      // The run call holds until all four roles finish; findings land per
      // role, so poll in parallel to show them live.
      void api(`/api/v1/engineering/pr-reviews/${res.swarm.id}/run`, { method: 'POST', body: {} }).catch((err) => {
        setError(err instanceof Error ? err.message : 'Review run failed');
      });
      poll(res.swarm.id);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : 'Could not start the review');
    }
  };

  const open = async (s: Swarm) => {
    setError(null);
    try {
      const latest = await refresh(s.id);
      if (!isDone(latest.status)) {
        setRunning(true);
        poll(s.id);
      } else {
        setRunning(false);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open review', 'error');
    }
  };

  const decide = async (f: Finding, decision: 'ACCEPTED' | 'DISMISSED') => {
    try {
      await api(`/api/v1/engineering/findings/${f.id}/decide`, { method: 'POST', body: { decision } });
      setFindings((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: decision } : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update finding', 'error');
    }
  };

  const sorted = useMemo(
    () => [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
    [findings],
  );
  const rolesReported = new Set(findings.map((f) => f.role));
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s && f.category !== 'review_failed').length] as const);

  return (
    <div className="cc-page cr-page">
      <header className="sp-header">
        <div>
          <h2 className="sp-title">
            <Icon name="eye" size={22} className="sp-title-icon" /> Code review
          </h2>
          <p className="cc-muted sp-subtitle">
            Four specialists review your changes independently. Locations are shown only when verified against what you submitted.
          </p>
        </div>
      </header>

      <div className="cr-layout">
        <section className="cc-card cr-input" aria-label="Changes to review">
          {projects && projects.length === 0 ? (
            <p className="cc-hint">
              Reviews are filed as a task in a project. <Link to="/projects">Create a project</Link> first.
            </p>
          ) : (
            <label className="cc-field">
              <span>Project</span>
              <select className="cc-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="cc-field">
            <span>Title (optional)</span>
            <input className="cc-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fix session refresh race" aria-label="Review title" />
          </label>
          <label className="cc-field">
            <span>Diff or code</span>
            <textarea
              className="cc-textarea cc-mono cr-diff"
              value={diff}
              onChange={(e) => setDiff(e.target.value)}
              placeholder={'Paste `git diff` output or a code snippet…'}
              spellCheck={false}
              aria-label="Diff or code to review"
            />
          </label>
          <div className="cr-files">
            <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => fileInput.current?.click()}>
              <Icon name="paperclip" size={14} className="sp-btn-icon" /> Add files
            </button>
            <input ref={fileInput} type="file" multiple className="cc-sr-only" aria-label="Files to review" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            {files.map((f) => (
              <span key={f.path} className="cc-pill cr-file">
                {f.path}
                <button type="button" aria-label={`Remove ${f.path}`} onClick={() => setFiles((prev) => prev.filter((x) => x.path !== f.path))}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {error && <div className="cc-error">{error}</div>}
          <button type="button" className="cc-btn cc-btn--primary cr-start" disabled={running} onClick={() => void start()}>
            {running ? 'Reviewing…' : 'Start review'}
          </button>

          {history.length > 0 && (
            <div className="cr-history">
              <h4>Recent reviews</h4>
              {history.slice(0, 8).map((s) => (
                <button key={s.id} type="button" className={`cr-history-item${swarm?.id === s.id ? ' is-active' : ''}`} onClick={() => void open(s)}>
                  <span className="cr-history-title">{s.title}</span>
                  <span className={`cr-status cr-status--${s.status.toLowerCase()}`}>{s.status}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="cr-results" aria-label="Review results" aria-live="polite">
          {!swarm && <div className="cc-card cc-empty">Results appear here as each specialist finishes.</div>}
          {swarm && (
            <>
              <div className="cc-card cr-summary">
                <div className="cr-summary-head">
                  <strong>{swarm.title}</strong>
                  <span className={`cr-status cr-status--${swarm.status.toLowerCase()}`}>{swarm.status}</span>
                </div>
                <div className="cr-roles">
                  {ROLES.map((r) => {
                    const done = rolesReported.has(r.id);
                    const failed = findings.some((f) => f.role === r.id && f.category === 'review_failed');
                    return (
                      <span key={r.id} className={`cr-role${done ? ' is-done' : ''}${failed ? ' is-failed' : ''}`}>
                        <Icon name={r.icon} size={14} className="sp-btn-icon" />
                        {r.label}
                        <span className="cr-role-state">{failed ? 'failed' : done ? 'done' : running ? 'reviewing…' : 'waiting'}</span>
                      </span>
                    );
                  })}
                </div>
                <div className="cr-counts">
                  {counts.map(([s, n]) => (
                    <span key={s} className={`cr-sev cr-sev--${s.toLowerCase()}`}>
                      {n} {s.toLowerCase()}
                    </span>
                  ))}
                </div>
              </div>

              {sorted.map((f) => (
                <article key={f.id} className={`cc-card cr-finding cr-finding--${f.severity.toLowerCase()}${f.status !== 'OPEN' ? ' is-decided' : ''}`}>
                  <div className="cr-finding-head">
                    <span className={`cr-sev cr-sev--${f.severity.toLowerCase()}`}>{f.severity}</span>
                    <span className="cc-pill">{f.role.toLowerCase()}</span>
                    {f.file_path && (
                      <code className="cc-mono cr-loc">
                        {f.file_path}
                        {f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ''}` : ''}
                      </code>
                    )}
                    <span className="cc-muted cr-conf">{Math.round(f.confidence * 100)}% confidence</span>
                  </div>
                  <h4 className="cr-finding-title">{f.title}</h4>
                  <p className="cr-finding-desc">{f.description}</p>
                  {f.recommendation && (
                    <p className="cr-finding-fix">
                      <strong>Suggested fix:</strong> {f.recommendation}
                    </p>
                  )}
                  {f.category !== 'review_failed' && f.category !== 'review_unavailable' && (
                    <div className="cr-finding-actions">
                      {f.status === 'OPEN' ? (
                        <>
                          <button type="button" className="cc-btn cc-btn--sm" onClick={() => void decide(f, 'ACCEPTED')}>
                            Accept
                          </button>
                          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void decide(f, 'DISMISSED')}>
                            Dismiss
                          </button>
                        </>
                      ) : (
                        <span className="cc-muted">{f.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'}</span>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
