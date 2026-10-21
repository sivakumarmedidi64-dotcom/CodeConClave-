/**
 * MCP tool call waiting for approval (constitution Article 8). Like Claude's
 * "Allow once / Always allow": nothing runs until the user decides.
 *   Allow once   → approve this exact call, then run it (once)
 *   Always allow → also save an allow rule for server/tool (never offered for
 *                  tools the server marks destructive — those always ask)
 *   Deny         → reject; nothing runs
 * Every step goes through the real API (approvals, permission rules, MCP run).
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface ToolApproval {
  approvalId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  risk: string;
  destructive: boolean;
}

type State = 'idle' | 'working' | 'ran' | 'denied' | 'error';

export function ToolApprovalCard({ call, onResult }: { call: ToolApproval; onResult?: (text: string) => void }) {
  const [state, setState] = useState<State>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const args = JSON.stringify(call.arguments ?? {}, null, 2);

  const approveAndRun = async (always: boolean) => {
    setState('working');
    setError(null);
    try {
      if (always) {
        await api('/api/v1/control/permission-rules', {
          method: 'POST',
          body: { effect: 'allow', tool: 'mcp_call', pattern: `${call.server}/${call.tool}`, note: 'Always allow (from chat)' },
        });
      }
      await api(`/api/v1/execution/approvals/${encodeURIComponent(call.approvalId)}/decide`, { method: 'POST', body: { decision: 'APPROVE' } });
      const res = await api<{ result: { text: string; isError: boolean } }>(`/api/v1/mcp/approvals/${encodeURIComponent(call.approvalId)}/run`, { method: 'POST' });
      const text = res?.result?.text ?? '';
      setResult(text);
      setState('ran');
      onResult?.(text);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not run the tool.');
    }
  };

  const deny = async () => {
    setState('working');
    setError(null);
    try {
      await api(`/api/v1/execution/approvals/${encodeURIComponent(call.approvalId)}/decide`, { method: 'POST', body: { decision: 'REJECT' } });
      setState('denied');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not record your decision.');
    }
  };

  return (
    <section className="cc-toolcall" data-testid="tool-approval" aria-label={`Tool ${call.server}.${call.tool} waiting for approval`}>
      <header className="cc-toolcall__head">
        <Icon name="plug" size={15} />
        <strong>
          {call.server}.{call.tool}
        </strong>
        <span className={`cc-pill${call.destructive ? ' cc-pill--danger' : ''}`}>{call.destructive ? 'changes or deletes data' : `${call.risk.toLowerCase()} risk`}</span>
      </header>
      <p className="cc-hint" style={{ margin: 0 }}>
        This call to a tool on your MCP server needs your approval. Nothing has run yet.
      </p>
      <pre className="cc-toolcall__args">{args}</pre>
      {state === 'ran' ? (
        <>
          <p className="pv3-ok" role="status">
            ✓ Ran once. Ask CodeConClave to continue with the result.
          </p>
          {result && <pre className="cc-toolcall__result">{result.slice(0, 4_000)}</pre>}
        </>
      ) : state === 'denied' ? (
        <p className="cc-hint" role="status">
          Denied — the tool did not run.
        </p>
      ) : (
        <div className="cc-toolcall__actions">
          <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={state === 'working'} onClick={() => void approveAndRun(false)}>
            Allow once
          </button>
          {!call.destructive && (
            <button type="button" className="cc-btn cc-btn--sm" disabled={state === 'working'} onClick={() => void approveAndRun(true)} title={`Saves an allow rule for ${call.server}/${call.tool}`}>
              Always allow
            </button>
          )}
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" disabled={state === 'working'} onClick={() => void deny()}>
            Deny
          </button>
        </div>
      )}
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
