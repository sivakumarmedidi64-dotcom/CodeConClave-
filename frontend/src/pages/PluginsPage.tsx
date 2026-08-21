/**
 * CodeConClave — Plugin Center (Stage 25.5).
 * Searchable marketplace: fuzzy search, category/capability/status filters,
 * server-authoritative connection state + health status + integration
 * classification (LIVE / CONFIGURED / NOT_CONFIGURED / BLOCKED / UNSUPPORTED).
 * Connect (token or OAuth), disconnect, reauthorize, revoke, health checks,
 * scope management and events. Credential values are only ever entered,
 * never rendered back. Nothing here claims a connector is implemented when
 * the server says it is not.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  PLUGIN_PERMISSIONS,
  type HealthHistoryRow,
  type PluginCatalogueEntry,
  type PluginConnection,
  type PluginEventRow,
  type PluginScopeRow,
  type PluginType,
  type SandboxRunRow,
} from '../lib/types';
import { useToast } from '../components/Toast';

const STATE_COLORS: Record<string, string> = {
  CONNECTED: '#16a34a',
  DEGRADED: '#f59e0b',
  FAILED: '#dc2626',
  DISCONNECTED: '#64748b',
  REAUTH_REQUIRED: '#d97706',
  CONNECTING: '#2563eb',
  ERROR: '#dc2626',
  REVOKED: '#64748b',
};

const INTEGRATION_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  LIVE: { label: 'Live', color: '#1e7d46', bg: 'rgba(30,125,70,0.12)' },
  CONFIGURED: { label: 'Configured', color: '#1d4ed8', bg: 'rgba(29,78,216,0.12)' },
  NOT_CONFIGURED: { label: 'Not configured', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
  BLOCKED: { label: 'Blocked', color: '#dc2626', bg: 'rgba(220,38,38,0.12)' },
  UNSUPPORTED: { label: 'Unsupported', color: '#8a8a8a', bg: 'rgba(0,0,0,0.06)' },
};

const HEALTH_COLORS: Record<string, string> = {
  HEALTHY: '#16a34a',
  DEGRADED: '#f59e0b',
  REAUTH_REQUIRED: '#d97706',
  UNAVAILABLE: '#dc2626',
  NOT_CONNECTED: '#64748b',
  NOT_CONFIGURED: '#8a8a8a',
};

/** Lightweight fuzzy score: subsequence match across the searchable text. */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 + t.length;
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1 + (qi === 0 ? 5 : 0);
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

interface ConnectState {
  type: PluginType;
  name: string;
  kind: string;
  value: string;
}

export function PluginsPage() {
  const { toast } = useToast();
  const [catalogue, setCatalogue] = useState<PluginCatalogueEntry[]>([]);
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [capability, setCapability] = useState('');
  const [integration, setIntegration] = useState('');
  const [popularOnly, setPopularOnly] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [connecting, setConnecting] = useState<PluginType | null>(null);
  const [connectForm, setConnectForm] = useState<ConnectState>({ type: 'github', name: '', kind: 'token', value: '' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, PluginEventRow[]>>({});
  const [scopes, setScopes] = useState<Record<string, string[]>>({});
  const [health, setHealth] = useState<Record<string, { ok: boolean; state: string; latencyMs: number }>>({});
  const [healthHistory, setHealthHistory] = useState<Record<string, HealthHistoryRow[]>>({});
  const [busy, setBusy] = useState(false);

  const [sbType, setSbType] = useState('github');
  const [sbAction, setSbAction] = useState('repos.list');
  const [sbInput, setSbInput] = useState('{}');
  const [sandboxRuns, setSandboxRuns] = useState<SandboxRunRow[]>([]);

  const loadSandbox = useCallback(async () => {
    try {
      const res = await api<{ runs: SandboxRunRow[] }>('/api/v1/control/plugins/sandbox/runs');
      setSandboxRuns(res.runs);
    } catch {
      setSandboxRuns([]);
    }
  }, []);

  useEffect(() => {
    void loadSandbox();
  }, [loadSandbox]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (category) params.set('category', category);
      if (capability) params.set('capability', capability);
      if (integration) params.set('integration', integration);
      if (popularOnly) params.set('popular', 'true');
      const qs = params.toString();
      const [cat, conn] = await Promise.all([
        api<{ plugins: PluginCatalogueEntry[] }>(`/api/v1/plugins/catalogue${qs ? `?${qs}` : ''}`),
        api<{ connections: PluginConnection[] }>('/api/v1/plugins/connections'),
      ]);
      setCatalogue(cat.plugins);
      setConnections(conn.connections);
      setState('ready');
    } catch (err) {
      setState('error');
    }
  }, [query, category, capability, integration, popularOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // Client-side fuzzy re-rank of server results (server filtering is
  // authoritative; ranking only changes display order).
  const ranked = useMemo(() => {
    if (!query.trim()) return catalogue;
    const q = query.trim();
    return [...catalogue]
      .map((p) => {
        const haystack = [p.name, p.description ?? '', p.category ?? '', p.plugin_type, ...p.capabilities].join(' ');
        return { p, score: fuzzyScore(q, haystack) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.p);
  }, [catalogue, query]);

  const categories = useMemo(() => [...new Set(catalogue.map((c) => c.category).filter(Boolean))] as string[], [catalogue]);
  const capabilities = useMemo(() => [...new Set(catalogue.flatMap((c) => c.capabilities))].sort(), [catalogue]);

  const connectionFor = (type: PluginType) => connections.find((c) => c.plugin_type === type) ?? null;

  const isOAuth = (type: PluginType) => type === 'google';

  const connect = async (type: PluginType, name: string, credential?: { kind: string; value: string }) => {
    setBusy(true);
    try {
      const body = credential && credential.value ? { pluginType: type, name, credential } : { pluginType: type, name };
      const res = await api<{ connection: PluginConnection }>('/api/v1/plugins/connections', { method: 'POST', body });
      setConnectForm({ type, name: '', kind: 'token', value: '' });
      setConnecting(null);
      await load();
      if (isOAuth(type)) {
        const { authUrl } = await api<{ authUrl: string }>(`/api/v1/plugins/oauth/${res.connection.id}/authorize`);
        window.location.href = authUrl;
        return;
      }
      toast(`Connected ${name} (${type})`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'connect failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    try {
      await api(`/api/v1/plugins/connections/${id}/disconnect`, { method: 'POST' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'disconnect failed', 'error');
    }
  };

  const reauthorize = async (id: string) => {
    try {
      const res = await api<{ authUrl?: string; oauth?: boolean }>(`/api/v1/plugins/connections/${id}/reauthorize`, { method: 'POST' });
      if (res.oauth && res.authUrl) {
        window.location.href = res.authUrl;
        return;
      }
      await load();
      toast('Reauthorized');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'reauthorize failed', 'error');
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/v1/plugins/connections/${id}/revoke`, { method: 'POST' });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'revoke failed', 'error');
    }
  };

  const healthCheck = async (id: string) => {
    try {
      const res = await api<{ ok: boolean; state: string; latencyMs: number }>(`/api/v1/plugins/connections/${id}/health-check`, {
        method: 'POST',
      });
      setHealth((prev) => ({ ...prev, [id]: res }));
      await load();
      toast(res.ok ? `Healthy (${res.latencyMs}ms)` : `Unhealthy: ${res.state}`, res.ok ? 'info' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'health check failed', 'error');
    }
  };

  const saveScopes = async (id: string, scopesList: string[]) => {
    try {
      const res = await api<{ scopes: string[] }>(`/api/v1/plugins/connections/${id}/scopes`, {
        method: 'PATCH',
        body: { scopes: scopesList },
      });
      setScopes((prev) => ({ ...prev, [id]: res.scopes }));
      await load();
      toast('Scopes updated');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'scope update failed', 'error');
    }
  };

  const runSandbox = async () => {
    setBusy(true);
    try {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(sbInput || '{}') as Record<string, unknown>;
      } catch {
        toast('Input must be valid JSON', 'error');
        return;
      }
      const res = await api<{ result: SandboxRunRow }>('/api/v1/control/plugins/sandbox/run', {
        method: 'POST',
        body: { pluginType: sbType, action: sbAction, input },
      });
      await loadSandbox();
      toast(`Sandbox ${res.result.status}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'sandbox run failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleExpand = async (conn: PluginConnection) => {
    const next = expanded === conn.id ? null : conn.id;
    setExpanded(next);
    if (next) {
      try {
        const [ev, sc, hh] = await Promise.all([
          api<{ events: PluginEventRow[] }>(`/api/v1/plugins/connections/${conn.id}/events`),
          api<{ scopes: PluginScopeRow[] }>(`/api/v1/plugins/connections/${conn.id}/scopes`),
          api<{ history: HealthHistoryRow[] }>(`/api/v1/plugins/connections/${conn.id}/health-history`),
        ]);
        setEvents((prev) => ({ ...prev, [conn.id]: ev.events }));
        setScopes((prev) => ({ ...prev, [conn.id]: sc.scopes.map((s) => s.scope) }));
        setHealthHistory((prev) => ({ ...prev, [conn.id]: hh.history }));
      } catch (err) {
        toast(err instanceof Error ? err.message : 'load failed', 'error');
      }
    }
  };

  const badge = (state: string) => ({
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
    background: STATE_COLORS[state] ?? '#334155',
  });

  const connectName = (type: PluginType) => catalogue.find((c) => c.plugin_type === type)?.name ?? type;

  if (state === 'loading') return <div className="cc-page"><div className="cc-card cc-empty">Loading plugin center…</div></div>;
  if (state === 'error') {
    return (
      <div className="cc-page">
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load the plugin center.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-page">
      <h1>Plugin Center</h1>
      <p className="cc-hint">
        External integrations run behind the plugin isolation boundary: typed actions, scope checks, rate limits, circuit
        breakers, approvals, and health tracking. Integration status is server-derived — Live means a usable connection,
        Configured means this deployment can connect, Unsupported means no adapter is implemented in this build.
      </p>

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          className="cc-input"
          placeholder="Search plugins (fuzzy)…"
          aria-label="Search plugins"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="cc-select" aria-label="Category filter" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select className="cc-select" aria-label="Capability filter" value={capability} onChange={(e) => setCapability(e.target.value)}>
            <option value="">All capabilities</option>
            {capabilities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select className="cc-select" aria-label="Integration status filter" value={integration} onChange={(e) => setIntegration(e.target.value)}>
            <option value="">All integration statuses</option>
            {Object.entries(INTEGRATION_STYLES).map(([key, s]) => (
              <option key={key} value={key}>{s.label}</option>
            ))}
          </select>
          <label className="cc-hint" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={popularOnly} onChange={(e) => setPopularOnly(e.target.checked)} />
            Popular only
          </label>
          <span className="cc-hint cc-mono">{ranked.length} plugins</span>
        </div>
      </div>

      <div className="cc-grid cc-grid-2">
        {ranked.map((p) => {
          const existing = connectionFor(p.plugin_type);
          const intStyle = (INTEGRATION_STYLES[p.integration] ?? INTEGRATION_STYLES.UNSUPPORTED)!;
          return (
            <div className="cc-card" key={p.plugin_type} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <h3 style={{ margin: 0 }}>{p.name} {p.popular && <span className="cc-pill">popular</span>}</h3>
                <span
                  className="cc-pill"
                  style={{ background: intStyle.bg, color: intStyle.color, fontWeight: 700 }}
                  title={p.integration === 'UNSUPPORTED' ? 'No adapter implemented in this build' : undefined}
                >
                  {intStyle.label}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="cc-hint cc-mono">{p.plugin_type}</span>
                {p.category && <span className="cc-pill" style={{ fontSize: 11 }}>{p.category}</span>}
                {existing && <span style={badge(existing.state)}>{existing.state}</span>}
                <span className="cc-pill" style={{ fontSize: 11, background: HEALTH_COLORS[p.status] ?? '#334155', color: '#fff' }}>
                  {p.status}
                </span>
              </div>
              <p style={{ margin: 0 }}>{p.description}</p>
              {p.capabilities.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.capabilities.map((cap) => (
                    <span key={cap} className="cc-hint cc-mono" style={{ background: 'rgba(0,0,0,0.05)', padding: '0 6px', borderRadius: 4 }}>
                      {cap}
                    </span>
                  ))}
                </div>
              )}
              {p.required_permissions.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.required_permissions.map((perm) => (
                    <span key={perm} className="cc-hint cc-mono" style={{ background: 'rgba(0,0,0,0.03)', padding: '0 6px', borderRadius: 4, fontSize: 10 }}>
                      perm:{perm}
                    </span>
                  ))}
                </div>
              )}
              {p.integration === 'UNSUPPORTED' && (
                <p className="cc-hint" style={{ margin: 0 }}>Adapter not implemented in this build — additional integrations use the extensible connector architecture.</p>
              )}
              {p.integration === 'NOT_CONFIGURED' && !existing && (
                <p className="cc-hint" style={{ margin: 0 }}>Required server configuration is missing on this deployment.</p>
              )}
              {existing ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="cc-btn cc-btn--sm" onClick={() => void toggleExpand(existing)}>
                    {expanded === existing.id ? 'Close' : 'Manage'}
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void healthCheck(existing.id)}>
                    Health check
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void reauthorize(existing.id)}>
                    Reauthorize
                  </button>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void disconnect(existing.id)}>
                    Disconnect
                  </button>
                  <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void revoke(existing.id)}>
                    Revoke
                  </button>
                </div>
              ) : p.integration !== 'UNSUPPORTED' ? (
                <div>
                  {connecting !== p.plugin_type ? (
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setConnecting(p.plugin_type)}>
                      + Connect
                    </button>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input
                        className="cc-input"
                        placeholder="Name (optional)"
                        value={connectForm.type === p.plugin_type ? connectForm.name : ''}
                        onChange={(e) => setConnectForm({ ...connectForm, type: p.plugin_type, name: e.target.value })}
                      />
                      {!isOAuth(p.plugin_type) && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <select
                            className="cc-input"
                            style={{ flex: 1 }}
                            value={connectForm.type === p.plugin_type ? connectForm.kind : 'token'}
                            onChange={(e) => setConnectForm({ ...connectForm, type: p.plugin_type, kind: e.target.value })}
                          >
                            <option value="token">token</option>
                            <option value="api_key">api_key</option>
                            <option value="secret">secret</option>
                          </select>
                          <input
                            className="cc-input"
                            style={{ flex: 2 }}
                            type="password"
                            placeholder={p.plugin_type === 'resend' ? 'Resend API key (optional)' : 'Credential value (optional)'}
                            value={connectForm.type === p.plugin_type ? connectForm.value : ''}
                            onChange={(e) => setConnectForm({ ...connectForm, type: p.plugin_type, value: e.target.value })}
                          />
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="cc-btn cc-btn--sm"
                          disabled={busy}
                          onClick={() => {
                            const name = connectForm.name.trim() || connectName(p.plugin_type);
                            const credential =
                              connectForm.type === p.plugin_type && !isOAuth(p.plugin_type) && connectForm.value
                                ? { kind: connectForm.kind, value: connectForm.value }
                                : undefined;
                            void connect(p.plugin_type, name, credential);
                          }}
                        >
                          {isOAuth(p.plugin_type) ? 'Connect + Authorize' : 'Connect'}
                        </button>
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setConnecting(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {ranked.length === 0 && <div className="cc-card cc-empty">No plugins match the current filters.</div>}

      <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }} data-testid="plugin-sandbox">
        <h3 style={{ margin: 0 }}>Action sandbox</h3>
        <p className="cc-hint" style={{ margin: 0 }}>
          Validates a typed plugin action against the adapter registry without calling the provider — output is{' '}
          <strong>simulated</strong> and clearly labelled as such, and policy requirements still apply.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="cc-select" aria-label="Sandbox plugin type" value={sbType} onChange={(e) => setSbType(e.target.value)}>
            {['github', 'cloudflare', 'discord', 'google', 'resend'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            aria-label="Sandbox action"
            placeholder="Action (e.g. repos.list, zones.list, messages.send)"
            value={sbAction}
            onChange={(e) => setSbAction(e.target.value)}
          />
        </div>
        <textarea
          className="cc-input"
          aria-label="Sandbox input JSON"
          rows={3}
          placeholder='Input JSON (e.g. {"per_page": 5})'
          value={sbInput}
          onChange={(e) => setSbInput(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="cc-btn cc-btn--sm" disabled={busy || !sbType || !sbAction.trim()} onClick={() => void runSandbox()}>
            Run in sandbox
          </button>
          <span className="cc-hint">Simulated output — never claims a real provider call.</span>
        </div>
        {sandboxRuns.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sandboxRuns.slice(0, 8).map((r) => (
              <li key={r.id} className="cc-mono" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="cc-pill" style={{ fontSize: 10, background: r.status === 'SUCCESS' ? '#16a34a' : '#dc2626', color: '#fff' }}>{r.status}</span>
                <span>{r.plugin_type} · {r.action}</span>
                {r.error && <span className="cc-hint">{r.error}</span>}
                {r.output && <span className="cc-hint">{JSON.stringify(r.output).slice(0, 160)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {expanded && connectionFor(expanded as PluginType) && (
        <div className="cc-card" style={{ marginTop: 20 }}>
          {(() => {
            const conn = connectionFor(expanded as PluginType)!;
            const current = scopes[conn.id] ?? [];
            return (
              <>
                <h3 style={{ margin: '0 0 12px' }}>
                  {conn.name} <span className="cc-hint cc-mono">({conn.plugin_type})</span>
                </h3>
                {health[conn.id] && (
                  <p className="cc-hint">
                    Last health check: {health[conn.id]!.ok ? 'ok' : 'not ok'} ({health[conn.id]!.state},{' '}
                    {health[conn.id]!.latencyMs}ms)
                  </p>
                )}
                {conn.last_error && <p className="cc-hint">Last error: {conn.last_error}</p>}
                <h4 style={{ margin: '12px 0 6px' }}>Scopes</h4>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  {PLUGIN_PERMISSIONS.map((perm) => {
                    const checked = current.includes(perm);
                    return (
                      <label key={perm} className="cc-hint" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...current, perm]
                              : current.filter((s) => s !== perm);
                            setScopes((prev) => ({ ...prev, [conn.id]: next }));
                          }}
                        />
                        {perm}
                      </label>
                    );
                  })}
                </div>
                <button className="cc-btn cc-btn--sm" onClick={() => void saveScopes(conn.id, current)}>
                  Save scopes
                </button>
                <h4 style={{ margin: '16px 0 6px' }}>Events</h4>
                {events[conn.id]?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflowY: 'auto' }}>
                    {events[conn.id]!.map((ev) => (
                      <li key={ev.id} className="cc-hint cc-mono" style={{ marginBottom: 4 }}>
                        {ev.created_at} — {ev.event_type} [{ev.state}]
                        {ev.payload ? ` ${JSON.stringify(ev.payload)}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cc-hint">No events recorded yet.</p>
                )}
                <h4 style={{ margin: '16px 0 6px' }}>Health history (server-recorded checks)</h4>
                {healthHistory[conn.id]?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflowY: 'auto' }}>
                    {healthHistory[conn.id]!.map((h, i) => (
                      <li key={`${h.checked_at}-${i}`} className="cc-hint cc-mono" style={{ marginBottom: 4 }}>
                        {h.checked_at} — {h.ok ? 'ok' : 'failed'} · {h.latency_ms}ms · streak {h.consecutive_failures}
                        {h.last_error ? ` · ${h.last_error}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cc-hint">No health checks recorded yet (checks run on plugin activity).</p>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}