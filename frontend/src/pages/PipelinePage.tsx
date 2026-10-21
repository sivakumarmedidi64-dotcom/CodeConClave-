/**
 * Pipeline — CodeConClave's execution engine, made visible:
 *   · the specialist registry (13 roles on 5 own models, contract versions)
 *   · recent runs with their status; "Escalated" is the operator console
 *   · one run's hash-linked ledger, re-verified on open
 *   · a Verify box that runs the Scientific Verification Kernel (0 tokens)
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { CopyButton } from '../components/CopyButton';

interface RoleRow {
  role: string;
  lane: string;
  science: boolean;
  contractVersion: string;
  driver: string;
  residentReady: boolean;
  residentNote: string | null;
  claimKinds: string[];
}

interface RunRow {
  id: string;
  status: string;
  role: string | null;
  risk: string | null;
  attempts: number;
  tokensUsed: number;
  budgetTokens: number;
  proofHash: string | null;
  createdAt: string;
}

interface RunDetail {
  run: { id: string; status: string; role: string | null; receipt: Record<string, unknown> | null };
  events: { seq: number; stage: string; payload: Record<string, unknown>; event_hash: string; created_at: string }[];
  chain: { ok: boolean; checked: number; brokenAt: number | null };
}

interface KernelProof {
  index: number;
  kind: string;
  verifier: string;
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  method: string;
  detail: string;
  proofHash: string;
}

const EXAMPLE = JSON.stringify(
  [
    { kind: 'identity', lhs: '(x+y)^2', rhs: 'x^2 + 2*x*y + y^2' },
    { kind: 'units', lhs: 'm*a', rhs: 'F', symbols: { m: 'kg', a: 'm/s^2', F: 'N' } },
    { kind: 'circuit', qubits: 2, gates: [['H', 0], ['CNOT', 0, 1]], expect: { probs: { '00': 0.5, '11': 0.5 } } },
  ],
  null,
  2,
);

const STATUS_TONE: Record<string, string> = {
  VERIFIED: 'ok',
  CACHED: 'ok',
  UNVERIFIED: 'muted',
  ESCALATED: 'warn',
  NEEDS_BUDGET: 'warn',
  DENIED: 'bad',
  FAILED: 'bad',
  HALTED: 'muted',
  RUNNING: 'muted',
};

export function PipelinePage() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [claimsText, setClaimsText] = useState(EXAMPLE);
  const [proofs, setProofs] = useState<KernelProof[] | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ roles: RoleRow[] }>('/api/v1/pipeline/registry')
      .then((r) => setRoles(r.roles ?? []))
      .catch(() => setError('Could not load the specialist registry.'));
  }, []);

  const loadRuns = useCallback(() => {
    api<{ runs: RunRow[] }>(`/api/v1/pipeline/runs${filter ? `?status=${filter}` : ''}`)
      .then((r) => setRuns(r.runs ?? []))
      .catch(() => setError('Could not load runs.'));
  }, [filter]);
  useEffect(loadRuns, [loadRuns]);

  const openRun = async (id: string) => {
    try {
      setDetail(await api<RunDetail>(`/api/v1/pipeline/runs/${encodeURIComponent(id)}`));
    } catch {
      setError('Could not open that run.');
    }
  };

  const verify = async () => {
    setVerifyError(null);
    setProofs(null);
    let claims: unknown;
    try {
      claims = JSON.parse(claimsText);
    } catch (err) {
      setVerifyError(`Not valid JSON: ${(err as Error).message}`);
      return;
    }
    try {
      const r = await api<{ kernel: { proofs: KernelProof[] } }>('/api/v1/pipeline/verify', { method: 'POST', body: { claims } });
      setProofs(r.kernel.proofs);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
    }
  };

  return (
    <div className="cc-page pv3-page">
      <h1>Pipeline</h1>
      <p className="cc-hint" style={{ marginTop: 0 }}>
        Objective in → verified outcome out. Every answer runs Intake → Route → Dispatch (one role) → Gate → Specialist →
        Scientific Verification Kernel → Judge (up to 2 repairs, then you decide) → Seal, and every stage is a hash-linked
        ledger event.
      </p>
      {error && <p className="cc-error">{error}</p>}

      <section className="cc-card">
        <h3 style={{ marginTop: 0 }}>Specialist registry · 13 roles · 1 active per task</h3>
        <div className="pv3-roles">
          {roles.map((r) => (
            <div key={r.role} className={`pv3-role${r.science ? ' is-science' : ''}`} title={r.residentNote ?? 'Own model ready'}>
              <strong>{r.role}</strong>
              <span className="cc-muted">
                {r.driver} · {r.residentReady ? 'own model ready' : 'own model offline (cloud fallback)'}
              </span>
              <code className="cc-mono">{r.contractVersion}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="cc-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Runs</h3>
          <select className="cc-select cc-select--sm" aria-label="Filter runs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="ESCALATED">Escalated (needs you)</option>
            <option value="VERIFIED">Verified</option>
            <option value="DENIED">Denied</option>
            <option value="CACHED">Cached</option>
          </select>
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={loadRuns}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>
        {runs.length === 0 ? (
          <p className="cc-hint">No runs yet — ask CodeConClave something in chat.</p>
        ) : (
          <table className="us-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Role</th>
                <th>Attempts</th>
                <th>Tokens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`pv3-badge tone-${STATUS_TONE[r.status] ?? 'muted'}`}>{r.status.toLowerCase().replace('_', ' ')}</span>
                  </td>
                  <td>{r.role ?? '—'}</td>
                  <td>{r.attempts}</td>
                  <td>
                    {r.tokensUsed.toLocaleString()} / {r.budgetTokens.toLocaleString()}
                  </td>
                  <td>
                    <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openRun(r.id)}>
                      Ledger
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {detail && (
          <div className="pv3-run" data-testid="run-detail">
            <h4 style={{ margin: '12px 0 4px' }}>
              Run {detail.run.id} · {detail.run.status.toLowerCase()}
            </h4>
            <p className={detail.chain.ok ? 'pv3-ok' : 'cc-error'} role="status">
              {detail.chain.ok ? `✓ Ledger verified · ${detail.chain.checked} hash-linked events` : `✗ Ledger broken at event #${detail.chain.brokenAt}`}
            </p>
            <ol className="pv3-events">
              {detail.events.map((e) => (
                <li key={e.seq}>
                  <strong>
                    {e.seq}. {e.stage}
                  </strong>{' '}
                  <code className="cc-mono">{e.event_hash.slice(0, 12)}…</code>
                  <div className="cc-muted pv3-event-payload">{summarize(e.stage, e.payload)}</div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="cc-card">
        <h3 style={{ marginTop: 0 }}>Verify claims · Scientific Verification Kernel</h3>
        <p className="cc-hint" style={{ marginTop: 0 }}>
          Pure software, 0 tokens: algebra and calculus (exact symbolic residual + seeded points), units, statistics
          (plan hashed first), quantum circuits (state-vector) and civil reactor physics. Every proof is hashed.
        </p>
        <textarea className="cc-textarea cc-mono" rows={10} aria-label="Claims JSON" value={claimsText} onChange={(e) => setClaimsText(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" onClick={() => void verify()}>
            <Icon name="shield-check" size={13} /> Verify
          </button>
        </div>
        {verifyError && <p className="cc-error">{verifyError}</p>}
        {proofs && (
          <ul className="pv3-proofs" style={{ marginTop: 10 }} aria-label="Kernel results">
            {proofs.map((p) => (
              <li key={p.index} className={`pv3-proof is-${p.verdict.toLowerCase()}`}>
                <strong>
                  {p.verdict === 'PASS' ? '✓' : p.verdict === 'FAIL' ? '✗' : '!'} {p.kind}
                </strong>
                <span className="cc-muted"> · {p.verifier} · {p.method}</span>
                <div className="pv3-proof__detail">{p.detail}</div>
                <div className="pv3-hash">
                  <code className="cc-mono">{p.proofHash.slice(0, 16)}…</code>
                  <CopyButton text={p.proofHash} label="Copy proof hash" size={12} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function summarize(stage: string, p: Record<string, unknown>): string {
  switch (stage) {
    case 'route':
      return `shortlist ${(p.shortlist as string[] | undefined)?.join(', ') ?? '?'} · risk ${String(p.risk)} · by ${String(p.by)}`;
    case 'dispatch':
      return `${String(p.role)} on ${String(p.driver).split('/').pop()} · ${String(p.contractVersion)}`;
    case 'gate':
      return p.allowed ? `passed (${(p.checks as unknown[] | undefined)?.length ?? 0} checks)` : 'denied';
    case 'verify':
      return `attempt ${String(p.attempt)} · ${String(p.passed)}/${String(p.claims)} pass · ${String(p.verdict)}`;
    case 'seal':
      return `${String(p.status)} · proof ${String(p.proofHash).slice(0, 12)}…`;
    case 'denied':
      return String(p.reason ?? '');
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 140) : '';
  }
}
