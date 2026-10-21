/**
 * Pipeline v3 in the chat: the live stage trace while an answer is built, and
 * the receipt under the finished answer (status, role, kernel proofs, proof
 * hash, and a one-click check of the run's hash-linked ledger).
 */
import { useState } from 'react';
import { api } from '../lib/api';
import type { PipelineStage } from '../lib/sse';
import { Icon, type IconName } from './Icon';
import { CopyButton } from './CopyButton';

export interface PipelineProof {
  kind: string;
  verifier: string;
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  method: string;
  detail: string;
  proofHash: string;
}

export interface PipelineReceipt {
  runId: string;
  status: 'RUNNING' | 'VERIFIED' | 'UNVERIFIED' | 'CACHED' | 'DENIED' | 'ESCALATED' | 'NEEDS_BUDGET' | 'HALTED' | 'FAILED';
  role: string | null;
  lane?: string | null;
  risk?: string | null;
  contractVersion: string | null;
  engine: string | null;
  cached: boolean;
  attempts: number;
  tokens: { used: number; budget: number };
  proofs: PipelineProof[];
  verdict: { passed: number; failed: number; errors: number };
  proofHash: string | null;
  kernelVersion?: string;
  gate?: { check: string; ok: boolean; note?: string }[];
  notes?: string[];
}

/** Narrow an unknown done-payload value to a receipt (or undefined). */
export function asReceipt(v: unknown): PipelineReceipt | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<PipelineReceipt>;
  return typeof r.runId === 'string' && typeof r.status === 'string' ? (r as PipelineReceipt) : undefined;
}

const STAGE_ICON: Record<string, IconName> = {
  intake: 'file',
  cache: 'bolt',
  route: 'compass',
  dispatch: 'users',
  gate: 'shield',
  specialist: 'spark',
  verify: 'shield-check',
  repair: 'refresh',
  act: 'play',
  seal: 'lock',
  escalate: 'alert',
  denied: 'shield',
  budget: 'gauge',
  halted: 'stop-circle',
};

/** Live trace: one chip per stage as it happens. */
export function PipelineTrace({ stages }: { stages: PipelineStage[] }) {
  if (!stages.length) return null;
  return (
    <ol className="pv3-trace" aria-label="How CodeConClave is working on this" data-testid="pipeline-trace">
      {stages.map((s, i) => (
        <li key={`${s.stage}-${i}`} className={`pv3-step is-${s.status}${i === stages.length - 1 && s.status === 'start' ? ' is-live' : ''}`} title={s.label}>
          <Icon name={STAGE_ICON[s.stage] ?? 'dot'} size={12} />
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

const STATUS_VIEW: Record<PipelineReceipt['status'], { label: (r: PipelineReceipt) => string; tone: 'ok' | 'muted' | 'warn' | 'bad'; icon: IconName }> = {
  VERIFIED: { label: (r) => `Verified · ${r.verdict.passed}/${r.proofs.length} proof${r.proofs.length === 1 ? '' : 's'} pass`, tone: 'ok', icon: 'shield-check' },
  UNVERIFIED: { label: () => 'Not machine-checked · no checkable claims', tone: 'muted', icon: 'info' },
  CACHED: { label: () => 'From cache · 0 tokens', tone: 'ok', icon: 'bolt' },
  DENIED: { label: () => 'Denied at the Gate', tone: 'bad', icon: 'shield' },
  ESCALATED: { label: () => 'Escalated · verification failed 3 times', tone: 'warn', icon: 'alert' },
  NEEDS_BUDGET: { label: () => 'Stopped · needs more budget', tone: 'warn', icon: 'gauge' },
  HALTED: { label: () => 'Stopped · state saved', tone: 'muted', icon: 'stop-circle' },
  FAILED: { label: () => 'Failed', tone: 'bad', icon: 'alert' },
  RUNNING: { label: () => 'Running', tone: 'muted', icon: 'spark' },
};

interface LedgerCheck {
  ok: boolean;
  checked: number;
  brokenAt: number | null;
}

export function ReceiptChip({ receipt }: { receipt: PipelineReceipt }) {
  const [open, setOpen] = useState(false);
  const [ledger, setLedger] = useState<LedgerCheck | 'loading' | 'error' | null>(null);
  const view = STATUS_VIEW[receipt.status] ?? STATUS_VIEW.RUNNING;

  const checkLedger = async () => {
    setLedger('loading');
    try {
      const r = await api<{ chain: LedgerCheck }>(`/api/v1/pipeline/runs/${encodeURIComponent(receipt.runId)}`);
      setLedger(r.chain);
    } catch {
      setLedger('error');
    }
  };

  return (
    <div className={`pv3-receipt tone-${view.tone}`} data-testid="pipeline-receipt">
      <button type="button" className="pv3-receipt__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={view.icon} size={13} />
        <span className="pv3-receipt__status">{view.label(receipt)}</span>
        {receipt.role && <span className="pv3-receipt__role">{receipt.role}</span>}
        <Icon name="chevronDown" size={12} className="pv3-receipt__chev" />
      </button>
      {open && (
        <div className="pv3-receipt__body">
          {receipt.proofs.length > 0 && (
            <ul className="pv3-proofs" aria-label="Kernel proofs">
              {receipt.proofs.map((p, i) => (
                <li key={p.proofHash || i} className={`pv3-proof is-${p.verdict.toLowerCase()}`}>
                  <strong>{p.verdict === 'PASS' ? '✓' : p.verdict === 'FAIL' ? '✗' : '!'} {p.kind}</strong>
                  <span className="cc-muted"> · {p.method}</span>
                  <div className="pv3-proof__detail">{p.detail}</div>
                </li>
              ))}
            </ul>
          )}
          {receipt.notes && receipt.notes.length > 0 && (
            <ul className="pv3-notes">
              {receipt.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <dl className="pv3-facts">
            <dt>Engine</dt>
            <dd>{receipt.engine ?? 'CodeConClave AI'}</dd>
            {receipt.contractVersion && (
              <>
                <dt>Contract</dt>
                <dd className="cc-mono">{receipt.contractVersion}</dd>
              </>
            )}
            <dt>Attempts</dt>
            <dd>{receipt.attempts}</dd>
            <dt>Tokens</dt>
            <dd>
              {receipt.tokens.used.toLocaleString()} / {receipt.tokens.budget.toLocaleString()} budget
            </dd>
            {receipt.gate && receipt.gate.length > 0 && (
              <>
                <dt>Gate</dt>
                <dd>{receipt.gate.map((g) => `${g.ok ? '✓' : '✗'} ${g.check}`).join(' · ')}</dd>
              </>
            )}
            {receipt.proofHash && (
              <>
                <dt>Proof</dt>
                <dd className="pv3-hash">
                  <code className="cc-mono">{receipt.proofHash.slice(0, 16)}…</code>
                  <CopyButton text={receipt.proofHash} label="Copy proof hash" size={12} />
                </dd>
              </>
            )}
          </dl>
          <div className="pv3-ledger">
            <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void checkLedger()} disabled={ledger === 'loading'}>
              <Icon name="link" size={12} /> Check the run ledger
            </button>
            {ledger === 'loading' && <span className="cc-muted">Checking…</span>}
            {ledger === 'error' && <span className="cc-error">Could not load the ledger.</span>}
            {ledger && typeof ledger === 'object' && (
              <span className={ledger.ok ? 'pv3-ok' : 'cc-error'} role="status">
                {ledger.ok ? `✓ ${ledger.checked} hash-linked events, unbroken` : `✗ broken at event #${ledger.brokenAt}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
