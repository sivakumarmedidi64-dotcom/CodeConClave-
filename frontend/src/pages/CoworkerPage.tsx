/**
 * CodeConClave — Coworker page: the visible home of the agentic engines.
 *
 * Three honest cards, each backed by a real API and real state — never demo
 * data, never fabricated progress:
 *   - Email triage (needs a connected Gmail account via Connectors; drafts
 *     are data only, sending stays approval-gated and happens elsewhere).
 *   - Project scan (needs a paired device; runs the real import-graph scan
 *     on the device and reports nodes/edges/cycles/dead files).
 *   - Digest (the latest server-delivered digest; empty until the scheduler
 *     delivers one — stated, not faked).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

interface TriageDecision {
  thread: { id: string; from: string; subject: string };
  verdict: string;
  reasons: string[];
}

interface ReplyDraft {
  to: string[];
  subject: string;
  bodyTemplate: string;
  sendPolicy: string;
  sourceThreadId: string;
}

interface DeviceRow {
  id: string;
  name: string;
  presence: string;
}

interface DigestView {
  id: string;
  frequency: string;
  periodKey: string;
  summaryText: string;
  aiGenerated: boolean;
  deliveredAt: string;
  evidence: Record<string, unknown>;
}

export function CoworkerPage() {
  // Email triage
  const [projectId, setProjectId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [triaging, setTriaging] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<TriageDecision[]>([]);
  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  // Project scan
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [scanPath, setScanPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<Record<string, unknown> | null>(null);

  // Digest
  const [digest, setDigest] = useState<DigestView | null>(null);
  const [digestState, setDigestState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadDevices = useCallback(async () => {
    try {
      const d = await api<{ devices: DeviceRow[] }>('/api/v1/local-workspace/devices');
      const list = d.devices ?? [];
      setDevices(list);
      if (!deviceId && list[0]) setDeviceId(list[0].id);
    } catch {
      /* device list is optional until a scan runs */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDigest = useCallback(async () => {
    setDigestState('loading');
    try {
      const res = await api<{ digest: DigestView | null }>('/api/v1/digests/latest');
      setDigest(res.digest);
      setDigestState('ready');
    } catch {
      setDigest(null);
      setDigestState('error');
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadDigest();
  }, [loadDevices, loadDigest]);

  const triage = async () => {
    if (!projectId.trim() || !connectionId.trim() || triaging) return;
    setTriaging(true);
    setTriageError(null);
    try {
      const res = await api<{ summary: { decisions: TriageDecision[]; counts: Record<string, number> }; drafts: ReplyDraft[] }>(
        '/api/v1/comms/email/triage',
        { method: 'POST', body: { projectId: projectId.trim(), connectionId: connectionId.trim() } },
      );
      setDecisions(res.summary?.decisions ?? []);
      setCounts(res.summary?.counts ?? null);
      setDrafts(res.drafts ?? []);
    } catch (e) {
      setTriageError(msg(e, 'Triage failed'));
    } finally {
      setTriaging(false);
    }
  };

  const runScan = async () => {
    if (!deviceId || scanning) return;
    setScanning(true);
    setScanError(null);
    try {
      const res = await api<Record<string, unknown>>('/api/v1/local-workspace/scan', {
        method: 'POST',
        body: { deviceId, path: scanPath.trim() || '/' },
      });
      setScan(res);
    } catch (e) {
      setScanError(msg(e, 'Scan failed'));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div data-testid="coworker-page" className="space-y-4 p-1">
      <h2 className="text-lg font-semibold">Coworker</h2>
      <p className="cc-hint">
        Agentic engines with real state. Nothing here is demo data: every card reads live APIs and says plainly when its
        prerequisite (connected mail, paired device, delivered digest) is missing.
      </p>

      <section className="rounded border p-3" data-testid="coworker-email">
        <h3 className="text-sm font-medium">Email triage</h3>
        <p className="cc-hint">Reads unread mail through your connected Gmail account, classifies each thread with reasons, and builds reply drafts. Drafts never send themselves.</p>
        <div className="mt-2 grid gap-2">
          <label className="block text-xs text-gray-600">
            Project ID
            <input data-testid="coworker-email-project" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="prj_..." />
          </label>
          <label className="block text-xs text-gray-600">
            Gmail connection ID <span className="text-gray-400">(Connectors → Google — connect mail first)</span>
            <input data-testid="coworker-email-connection" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} placeholder="conn_..." />
          </label>
          <div>
            <button data-testid="coworker-email-run" className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50" disabled={!projectId.trim() || !connectionId.trim() || triaging} onClick={() => void triage()}>
              {triaging ? 'Triaging…' : 'Triage inbox'}
            </button>{' '}
            <Link className="cc-hint" to="/plugins">Connect mail</Link>
          </div>
        </div>
        {triageError && <p data-testid="coworker-email-error" className="mt-2 text-sm text-red-600">{triageError}</p>}
        {counts && (
          <p data-testid="coworker-email-counts" className="mt-2 text-xs">
            Draft candidates: {counts.DRAFT_CANDIDATE ?? 0} · Needs review: {counts.NEEDS_REVIEW ?? 0} · Noise: {counts.NOISE ?? 0}
          </p>
        )}
        {decisions.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs" data-testid="coworker-email-decisions">
            {decisions.map((d) => (
              <li key={d.thread.id}>
                <strong>{d.verdict}</strong> — {d.thread.subject || '(no subject)'} <span className="text-gray-500">({d.thread.from})</span>
                <div className="text-gray-500">{d.reasons.join('; ')}</div>
              </li>
            ))}
          </ul>
        )}
        {drafts.length > 0 && (
          <div className="mt-2 text-xs" data-testid="coworker-email-drafts">
            <strong>{drafts.length} draft(s) ready — sending stays approval-gated and happens outside triage.</strong>
            {drafts.map((d) => (
              <div key={d.sourceThreadId} className="mt-1 rounded bg-slate-50 p-2">
                To: {d.to.join(', ')} · {d.subject}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded border p-3" data-testid="coworker-scan">
        <h3 className="text-sm font-medium">Project scan</h3>
        <p className="cc-hint">Real import-graph scan on a paired device: nodes, edges, dependency cycles, dead files.</p>
        <div className="mt-2 grid gap-2">
          <label className="block text-xs text-gray-600">
            Paired device
            <select data-testid="coworker-scan-device" className="mt-1 w-full rounded border px-2 py-1 text-xs" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Select a device…</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.presence})</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-gray-600">
            Workspace path (granted root or subfolder)
            <input data-testid="coworker-scan-path" className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs" value={scanPath} onChange={(e) => setScanPath(e.target.value)} placeholder="/home/you/project" />
          </label>
          <div>
            <button data-testid="coworker-scan-run" className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50" disabled={!deviceId || scanning} onClick={() => void runScan()}>
              {scanning ? 'Scanning…' : 'Scan project'}
            </button>
          </div>
        </div>
        {scanError && <p data-testid="coworker-scan-error" className="mt-2 text-sm text-red-600">{scanError}</p>}
        {scan && (
          <div data-testid="coworker-scan-result" className="mt-2 text-xs">
            Files: {String(scan.fileCount ?? '?')} · Nodes: {Array.isArray(scan.nodes) ? scan.nodes.length : '?'} · Edges:{' '}
            {Array.isArray(scan.edges) ? scan.edges.length : '?'} · Cycles: {Array.isArray(scan.cycles) ? scan.cycles.length : '?'} · Dead files:{' '}
            {Array.isArray(scan.deadFiles) ? scan.deadFiles.length : '?'}
            {Array.isArray(scan.cycles) && scan.cycles.length > 0 && (
              <ul className="mt-1 space-y-1">
                {(scan.cycles as unknown[][]).slice(0, 5).map((c, i) => (
                  <li key={i} className="font-mono">cycle: {c.join(' → ')}</li>
                ))}
              </ul>
            )}
            {Array.isArray(scan.deadFiles) && scan.deadFiles.length > 0 && (
              <p className="mt-1 font-mono">dead: {(scan.deadFiles as unknown[]).slice(0, 10).join(', ')}</p>
            )}
          </div>
        )}
      </section>

      <section className="rounded border p-3" data-testid="coworker-digest">
        <h3 className="text-sm font-medium">Latest digest</h3>
        {digestState === 'loading' && <p className="cc-hint">Loading latest digest…</p>}
        {digestState === 'error' && <p className="cc-hint">Could not load digests.</p>}
        {digestState === 'ready' && !digest && (
          <p className="cc-hint">No digest delivered yet. The scheduler delivers daily/weekly digests; nothing is fabricated in the meantime.</p>
        )}
        {digestState === 'ready' && digest && (
          <div className="text-xs" data-testid="coworker-digest-result">
            <p><strong>{digest.frequency}</strong> · {digest.periodKey} · delivered {digest.deliveredAt}{digest.aiGenerated ? ' · AI narrative' : ' · deterministic'}</p>
            <pre className="mt-2 overflow-auto rounded bg-slate-50 p-2">{digest.summaryText}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
