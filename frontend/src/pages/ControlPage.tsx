/**
 * CodeConClave — Control plane (Stage 26G).
 * Kill switch, risk policies, undo log, secret guard, and usage analytics
 * (cost per feature, ROI estimate, transparency log, rollups). Every value is
 * server-derived: the kill switch shows real suspended scopes, policies show
 * real stored rules, ROI is labelled as an estimate, and secret guard never
 * returns stored secret values.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import type {
  ControlPolicyRow,
  KillSwitchRow,
  RoiEstimate,
  SecretGuardFinding,
  SecretGuardScanRow,
  TransparencyCall,
  UndoLogRow,
  UsageFeatureCost,
  UsageRollupRow,
} from '../lib/types';

function scanFindings(s: SecretGuardScanRow): SecretGuardFinding[] {
  if (Array.isArray(s.findings)) return s.findings;
  if (typeof s.findings === 'string') {
    try {
      const parsed: unknown = JSON.parse(s.findings);
      return Array.isArray(parsed) ? (parsed as SecretGuardFinding[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const KILL_SWITCH_SCOPES = ['GLOBAL', 'AGENTS', 'TASKS', 'SCHEDULES', 'AUTONOMY'] as const;

const POLICY_SCOPES = ['task', 'plugin', 'schedule', 'automation', 'agent', 'global'] as const;
const POLICY_ACTIONS = ['create', 'run', 'execute', 'deploy', 'modify', 'delete'] as const;
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const REQUIREMENTS = ['require_approval', 'block'] as const;

const SECRET_GUARD_TARGETS = ['agent_output', 'file', 'commit', 'memory', 'task_payload'] as const;

const SCOPES_UI = ['chat', 'tasks', 'agents', 'preview', 'plugins', 'engineering', 'scheduling', 'automation', 'brainstorming', 'digests', 'general'] as const;

export function ControlPage() {
  const { toast } = useToast();

  const [killSwitches, setKillSwitches] = useState<KillSwitchRow[]>([]);
  const [policies, setPolicies] = useState<ControlPolicyRow[]>([]);
  const [undo, setUndo] = useState<UndoLogRow[]>([]);
  const [scans, setScans] = useState<SecretGuardScanRow[]>([]);
  const [featureCosts, setFeatureCosts] = useState<UsageFeatureCost[]>([]);
  const [roi, setRoi] = useState<RoiEstimate | null>(null);
  const [transparency, setTransparency] = useState<TransparencyCall[]>([]);
  const [rollups, setRollups] = useState<UsageRollupRow[]>([]);
  const [busy, setBusy] = useState(false);

  const [ksScope, setKsScope] = useState<(typeof KILL_SWITCH_SCOPES)[number]>('GLOBAL');
  const [ksReason, setKsReason] = useState('');

  const [polScope, setPolScope] = useState<(typeof POLICY_SCOPES)[number]>('task');
  const [polAction, setPolAction] = useState('create');
  const [polRisk, setPolRisk] = useState<(typeof RISK_LEVELS)[number]>('HIGH');
  const [polReq, setPolReq] = useState<(typeof REQUIREMENTS)[number]>('require_approval');

  const [scanTarget, setScanTarget] = useState<(typeof SECRET_GUARD_TARGETS)[number]>('agent_output');
  const [scanRef, setScanRef] = useState('');
  const [scanContent, setScanContent] = useState('');

const [taskCostId, setTaskCostId] = useState('');
const [taskCost, setTaskCost] = useState<UsageFeatureCost | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    const [ks, pol, un, sc, fc, ri, tr, rol] = await Promise.all([
      api<{ scopes: KillSwitchRow[] }>('/api/v1/control/kill-switch'),
      api<{ policies: ControlPolicyRow[] }>('/api/v1/control/policies'),
      api<{ entries: UndoLogRow[] }>('/api/v1/control/undo'),
      api<{ scans: SecretGuardScanRow[] }>('/api/v1/control/secret-guard/scans'),
      api<{ features: UsageFeatureCost[] }>(`/api/v1/control/usage/cost-per-feature?days=${days}`),
      api<RoiEstimate>(`/api/v1/control/usage/roi?days=${days}`),
      api<{ calls: TransparencyCall[] }>(`/api/v1/control/usage/transparency?days=7`),
      api<{ rollups: UsageRollupRow[] }>(`/api/v1/control/usage/rollups?days=${days}`),
    ]);
    setKillSwitches(ks.scopes);
    setPolicies(pol.policies);
    setUndo(un.entries);
    setScans(sc.scans);
    setFeatureCosts(fc.features);
    setRoi(ri);
    setTransparency(tr.calls);
    setRollups(rol.rollups);
  }, [days]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const setKillSwitch = async (scope: string, active: boolean) => {
    try {
      await api<{ killSwitch: KillSwitchRow }>('/api/v1/control/kill-switch', {
        method: 'PUT',
        body: { scope, active, reason: active ? (ksReason.trim() || 'Set from control plane') : undefined },
      });
      setKsReason('');
      await load();
      toast(active ? `${scope} autonomy suspended` : `${scope} autonomy resumed`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'kill switch update failed', 'error');
    }
  };

  const savePolicy = async () => {
    try {
      await api<{ policy: ControlPolicyRow }>('/api/v1/control/policies', {
        method: 'POST',
        body: { scope: polScope, action: polAction, riskLevel: polRisk, requirement: polReq, enabled: true },
      });
      await load();
      toast('Policy saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'policy save failed', 'error');
    }
  };

  const deletePolicy = async (id: string) => {
    try {
      await api(`/api/v1/control/policies/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'policy delete failed', 'error');
    }
  };

  const runScan = async () => {
    if (!scanContent.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ scan: SecretGuardScanRow }>('/api/v1/control/secret-guard/scan', {
        method: 'POST',
        body: { targetType: scanTarget, targetRef: scanRef.trim() || undefined, content: scanContent },
      });
      await load();
      toast(res.scan.result === 'FINDINGS' ? `${res.scan.findings.length} secret(s) detected` : 'No secrets detected');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'scan failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const undoEntry = async (id: string) => {
    try {
      const res = await api<{ entry: UndoLogRow }>(`/api/v1/control/undo/${id}`, { method: 'POST' });
      await load();
      toast(`Undo ${res.entry.status}${res.entry.result ? `: ${res.entry.result}` : ''}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'undo failed', 'error');
    }
  };

  const lookupTaskCost = async () => {
    if (!taskCostId.trim()) return;
    try {
      const res = await api<{ cost: UsageFeatureCost }>(
        `/api/v1/control/usage/cost-per-task/${encodeURIComponent(taskCostId.trim())}`,
      );
      setTaskCost(res.cost);
    } catch (err) {
      setTaskCost(null);
      toast(err instanceof Error ? err.message : 'cost lookup failed', 'error');
    }
  };

  const refreshRollups = async () => {
    try {
      await api('/api/v1/control/usage/rollup', { method: 'POST', body: { days } });
      await load();
      toast('Rollups refreshed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'rollup failed', 'error');
    }
  };

  const suspended = (scope: string) => killSwitches.find((k) => k.scope === scope)?.suspended ?? false;

  return (
    <div className="cc-page">
      <h1>Control Plane</h1>
      <p className="cc-hint">
        Autonomy limits, risk policies, reversible-action undo, secret scanning and usage accounting. The kill switch only
        stops <em>new</em> work — in-flight work keeps running. Policies are evaluated server-side on every gated action.
      </p>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="control-kill-switch">
        <h3 style={{ margin: 0 }}>Kill switch</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {KILL_SWITCH_SCOPES.map((scope) => {
            const on = suspended(scope);
            return (
              <label key={scope} className="cc-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => void setKillSwitch(scope, e.target.checked)}
                  aria-label={`${scope} kill switch`}
                />
                <span style={{ color: on ? '#dc2626' : undefined, fontWeight: on ? 700 : 400 }}>{scope}</span>
                {on ? ' (suspended)' : ''}
              </label>
            );
          })}
        </div>
        <input
          className="cc-input"
          aria-label="Kill switch reason"
          placeholder="Reason for suspension (recorded in the undo log)"
          value={ksReason}
          onChange={(e) => setKsReason(e.target.value)}
        />
      </div>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="control-policies">
        <h3 style={{ margin: 0 }}>Risk policies</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="cc-select" aria-label="Policy scope" value={polScope} onChange={(e) => setPolScope(e.target.value as typeof polScope)}>
            {POLICY_SCOPES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select className="cc-select" aria-label="Policy action" value={polAction} onChange={(e) => setPolAction(e.target.value)}>
            {POLICY_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select className="cc-select" aria-label="Policy risk level" value={polRisk} onChange={(e) => setPolRisk(e.target.value as typeof polRisk)}>
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select className="cc-select" aria-label="Policy requirement" value={polReq} onChange={(e) => setPolReq(e.target.value as typeof polReq)}>
            {REQUIREMENTS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button className="cc-btn cc-btn--sm" onClick={() => void savePolicy()}>Save policy</button>
        </div>
        {policies.length === 0 ? (
          <p className="cc-hint" style={{ margin: 0 }}>No policies defined — default behaviour is permissive with risk-based approvals.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {policies.map((p) => (
              <li key={p.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="cc-pill" style={{ fontSize: 10 }}>{p.scope}:{p.action}</span>
                <span className="cc-pill" style={{ fontSize: 10, background: p.risk_level === 'CRITICAL' ? '#dc2626' : '#334155', color: '#fff' }}>{p.risk_level}</span>
                <span>{p.requirement}{p.enabled ? '' : ' (disabled)'}</span>
                <span className="cc-hint">{p.id}</span>
                <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void deletePolicy(p.id)}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="control-undo">
        <h3 style={{ margin: 0 }}>Undo log</h3>
        <p className="cc-hint" style={{ margin: 0 }}>
          Only genuinely reversible actions are recorded — irreversible actions are rejected at record time.
        </p>
        {undo.length === 0 ? (
          <p className="cc-hint" style={{ margin: 0 }}>No reversible actions recorded yet.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {undo.slice(0, 15).map((u) => (
              <li key={u.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="cc-pill" style={{ fontSize: 10 }}>{u.status}</span>
                <span>{u.description}</span>
                <span className="cc-hint">{u.action_type}</span>
                {u.status === 'PENDING' && (
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void undoEntry(u.id)}>Undo</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="control-secret-guard">
        <h3 style={{ margin: 0 }}>Secret guard</h3>
        <p className="cc-hint" style={{ margin: 0 }}>
          Scans content for credential patterns. Findings store kind/location/confidence only — never the secret value.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="cc-select" aria-label="Scan target" value={scanTarget} onChange={(e) => setScanTarget(e.target.value as typeof scanTarget)}>
            {SECRET_GUARD_TARGETS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            aria-label="Scan target reference"
            placeholder="Target reference (e.g. file path, commit id)"
            value={scanRef}
            onChange={(e) => setScanRef(e.target.value)}
          />
        </div>
        <textarea
          className="cc-input"
          aria-label="Content to scan"
          rows={4}
          placeholder="Paste content to scan for secrets…"
          value={scanContent}
          onChange={(e) => setScanContent(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="cc-btn cc-btn--sm" disabled={busy || !scanContent.trim()} onClick={() => void runScan()}>
            Scan
          </button>
        </div>
        {scans.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {scans.slice(0, 10).map((s) => (
              <li key={s.id} className="cc-mono" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="cc-pill" style={{ fontSize: 10, background: s.result === 'FINDINGS' ? '#dc2626' : '#334155', color: '#fff' }}>
                  {s.result === 'FINDINGS' ? `${scanFindings(s).length} finding(s)` : 'clean'}
                </span>
                <span>{s.target_type}{s.target_ref ? ` · ${s.target_ref}` : ''}</span>
                <span className="cc-hint">{new Date(s.scanned_at).toLocaleString()}</span>
                {scanFindings(s).map((f, i) => (
                  <span key={i} className="cc-hint">[{f.kind} @ {f.location} · {(f.confidence * 100).toFixed(0)}%]</span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="control-usage">
        <h3 style={{ margin: 0 }}>Usage &amp; cost</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="cc-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Days
            <select className="cc-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void refreshRollups()}>Refresh rollups</button>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load().catch(() => undefined)}>Reload</button>
        </div>
        <h4 style={{ margin: '10px 0 6px' }}>Cost per feature</h4>
        {featureCosts.length === 0 ? (
          <p className="cc-hint" style={{ margin: 0 }}>No billed usage yet.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {featureCosts.map((f) => (
              <li key={f.feature} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                <span style={{ width: 120 }}>{f.feature}</span>
                <span>{f.calls} call(s)</span>
                <span>{f.inputTokens}+{f.outputTokens} tok</span>
                <span>${f.costUsd.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        )}
        <h4 style={{ margin: '10px 0 6px' }}>Cost per task</h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            aria-label="Task id"
            placeholder="Task id"
            value={taskCostId}
            onChange={(e) => setTaskCostId(e.target.value)}
          />
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void lookupTaskCost()}>Look up</button>
        </div>
        {taskCost && (
          <p className="cc-mono" style={{ margin: 0, fontSize: 12 }}>
            ${taskCost.costUsd.toFixed(4)} total · {taskCost.calls} call(s) · {taskCost.inputTokens}+{taskCost.outputTokens} tok
          </p>
        )}
        <h4 style={{ margin: '10px 0 6px' }}>ROI estimate</h4>
        {roi && roi.rows.length > 0 ? (
          <>
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {roi.rows.slice(0, 10).map((r) => (
                <li key={`${r.feature}-${r.tasksCompleted}-${r.valueUsd}`} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ width: 120 }}>{r.feature}</span>
                  <span>${r.valueUsd.toFixed(2)} value</span>
                  <span>{r.tasksCompleted} task(s)</span>
                  <span>{r.calls} call(s) · ${r.costUsd.toFixed(4)} AI</span>
                  <span>ROI {r.roi}×</span>
                </li>
              ))}
            </ul>
            <p className="cc-hint" style={{ margin: 0 }}>{roi.label}</p>
          </>
        ) : (
          <p className="cc-hint" style={{ margin: 0 }}>No billed usage in this window.</p>
        )}
        <h4 style={{ margin: '10px 0 6px' }}>Transparency log (last 7 days)</h4>
        {transparency.length === 0 ? (
          <p className="cc-hint" style={{ margin: 0 }}>No AI calls recorded in this window.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {transparency.map((c) => (
              <li key={`${c.createdAt}-${c.providerId}-${c.modelId ?? 'anon'}-${c.inputTokens}`} className="cc-mono" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
                <span>{c.agent ?? 'ai'}</span>
                <span>{c.providerId}/{c.modelId}</span>
                <span className="cc-hint">{c.inputTokens}+{c.outputTokens} tok · ${c.costUsd.toFixed(4)}{c.usedFallback ? ` · fallback${c.fallbackReason ? `: ${c.fallbackReason}` : ''}` : ''}{c.outcome !== 'ok' ? ` · ${c.outcome}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        <h4 style={{ margin: '10px 0 6px' }}>Rollups</h4>
        {rollups.length === 0 ? (
          <p className="cc-hint" style={{ margin: 0 }}>No rollups yet — refresh to aggregate the ledger.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {rollups.slice(0, 25).map((r) => (
              <li key={`${r.bucket}-${r.feature}-${r.task_id ?? ''}-${r.calls}`} className="cc-mono" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="cc-pill" style={{ fontSize: 10 }}>{r.bucket}</span>
                <span>{r.feature}{r.task_id ? ` · ${r.task_id}` : ''}</span>
                <span>{r.calls} call(s) · {r.input_tokens}+{r.output_tokens} tok · ${r.cost_usd.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}