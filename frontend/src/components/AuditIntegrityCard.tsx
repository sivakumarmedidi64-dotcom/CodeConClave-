/**
 * Settings → Privacy: tamper check for your activity log. The server
 * recomputes every link of your audit hash chain (GET /api/v1/audit/verify)
 * and reports exactly where it breaks, if it does.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { CopyButton } from './CopyButton';

interface ChainReport {
  ok: boolean;
  checked: number;
  brokenAt: { seq: number; id: string; reason: 'gap' | 'link' | 'hash' | 'truncated' } | null;
  lastHash: string | null;
  legacyRows: number;
  checkedAt: string;
}

const REASON: Record<NonNullable<ChainReport['brokenAt']>['reason'], string> = {
  hash: 'a record was changed after it was written',
  link: 'a record was re-linked to a different predecessor',
  gap: 'a record is missing from the middle',
  truncated: 'the newest records were removed',
};

export function AuditIntegrityCard() {
  const [report, setReport] = useState<ChainReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const check = useCallback(async () => {
    setState('loading');
    try {
      const r = await api<{ chain: ChainReport }>('/api/v1/audit/verify');
      setReport(r.chain);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="cc-card" data-testid="audit-integrity">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="shield-check" size={18} /> Activity log tamper check
      </h3>
      <p className="cc-hint" style={{ marginTop: 0 }}>
        Every action on your account is chained to the one before it with a SHA-256 fingerprint, so an edited, deleted or
        reordered record can&apos;t go unnoticed.
      </p>
      {state === 'loading' && <p className="cc-hint">Checking every record…</p>}
      {state === 'error' && <p className="cc-error">Could not run the check right now.</p>}
      {state === 'ready' && report && (
        <>
          {report.ok ? (
            <p className="cc-audit-ok" role="status">
              <Icon name="check" size={16} /> Verified — {report.checked.toLocaleString()} record{report.checked === 1 ? '' : 's'}, no tampering found.
            </p>
          ) : (
            <p className="cc-error" role="alert">
              Tampering detected at record #{report.brokenAt?.seq}: {report.brokenAt ? REASON[report.brokenAt.reason] : 'unknown'}.
            </p>
          )}
          {report.lastHash && (
            <p className="cc-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              Latest fingerprint <code className="cc-mono">{report.lastHash.slice(0, 16)}…</code>
              <CopyButton text={report.lastHash} label="Copy fingerprint" size={13} />
              <span>— save it anywhere to prove later that nothing before it changed.</span>
            </p>
          )}
          {report.legacyRows > 0 && (
            <p className="cc-hint">
              {report.legacyRows.toLocaleString()} older record{report.legacyRows === 1 ? '' : 's'} from before the tamper check are kept but not
              verifiable.
            </p>
          )}
        </>
      )}
      <button type="button" className="cc-btn cc-btn--sm" onClick={() => void check()} disabled={state === 'loading'}>
        <Icon name="refresh" size={13} /> Check again
      </button>
    </div>
  );
}
