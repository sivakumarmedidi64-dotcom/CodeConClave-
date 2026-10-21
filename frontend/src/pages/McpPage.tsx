/**
 * CodeConClave — MCP servers (constitution Article 8). Connect remote MCP
 * servers (Streamable HTTP), see the tools they offer and how each one is
 * treated (runs / asks first / always asks), and try a tool. Everything here
 * is the real server state from /api/v1/mcp — status, errors and tool lists
 * are whatever the server actually answered.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { ToolApprovalCard, type ToolApproval } from '../components/ToolApprovalCard';

export interface McpToolView {
  name: string;
  title: string | null;
  description: string;
  readOnly: boolean;
  destructive: boolean;
}

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  authHeaderName: string | null;
  hasAuth: boolean;
  enabled: boolean;
  status: 'UNKNOWN' | 'CONNECTED' | 'FAILED';
  lastError: string | null;
  protocolVersion: string | null;
  serverName: string | null;
  tools: McpToolView[];
  toolsRefreshedAt: string | null;
}

type Outcome =
  | { status: 'ok'; server: string; tool: string; text: string; isError: boolean }
  | ({ status: 'approval_required'; readOnly: boolean } & ToolApproval);

/** The local demo MCP server (`node scripts/dev-all.mjs` or `npm run mcp:demo`). */
export const DEMO_MCP_URL = 'http://127.0.0.1:8765/mcp';

export function toolBehaviour(t: Pick<McpToolView, 'readOnly' | 'destructive'>): { label: string; tone: 'ok' | 'ask' | 'danger' } {
  if (t.destructive) return { label: 'Always asks · changes or deletes data', tone: 'danger' };
  if (t.readOnly) return { label: 'Read-only · runs without asking', tone: 'ok' };
  return { label: 'Asks first', tone: 'ask' };
}

function TryTool({ server, tool }: { server: string; tool: McpToolView }) {
  const [args, setArgs] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOutcome(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || '{}');
    } catch {
      setError('Arguments must be valid JSON, e.g. {"text": "hi"}');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ outcome: Outcome }>('/api/v1/mcp/call', { method: 'POST', body: { server, tool: tool.name, arguments: parsed } });
      setOutcome(res?.outcome ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The tool call failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mcp-try" onSubmit={(e) => void run(e)}>
      <textarea className="cc-input" aria-label={`Arguments for ${tool.name}`} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
      <button type="submit" className="cc-btn cc-btn--sm" disabled={busy}>
        {busy ? 'Running…' : 'Run'}
      </button>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {outcome?.status === 'ok' && (
        <pre className="cc-toolcall__result" data-testid={`try-result-${tool.name}`}>
          {outcome.isError ? '(the tool reported an error)\n' : ''}
          {outcome.text}
        </pre>
      )}
      {outcome?.status === 'approval_required' && <ToolApprovalCard call={outcome} />}
    </form>
  );
}

export function McpPage({ showDemo = import.meta.env.DEV }: { showDemo?: boolean } = {}) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [maxServers, setMaxServers] = useState(20);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTry, setOpenTry] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ servers: McpServerView[]; maxServers?: number }>('/api/v1/mcp/servers');
      setServers(Array.isArray(res?.servers) ? res.servers : []);
      if (typeof res?.maxServers === 'number') setMaxServers(res.maxServers);
    } catch (err) {
      setServers([]);
      setError(err instanceof Error ? err.message : 'Could not load your MCP servers.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await api('/api/v1/mcp/servers', {
        method: 'POST',
        body: { name: name.trim(), url: url.trim(), ...(headerValue.trim() ? { authHeaderName: headerName.trim() || 'Authorization', authHeaderValue: headerValue.trim() } : {}) },
      });
      setName('');
      setUrl('');
      setHeaderValue('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server.');
    } finally {
      setAdding(false);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="cc-page mcp-page">
      <h1>MCP servers</h1>
      <p className="cc-hint">
        Connect tools that speak the Model Context Protocol (MCP), the standard used by Claude Code, Codex, Gemini CLI and others. Turn
        on <strong>Tools</strong> in Chat and CodeConClave AI can use them. Read-only tools run straight away; other tools ask you first
        (or follow your <Link to="/control">permission rules</Link>); tools that change or delete data always ask.
      </p>

      <form className="cc-card mcp-add" onSubmit={(e) => void add(e)} aria-label="Connect an MCP server">
        <h3 style={{ margin: 0 }}>Connect a server</h3>
        <div className="mcp-add__row">
          <input className="cc-input" aria-label="Server name" placeholder="Name, e.g. github" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          <input className="cc-input" aria-label="Server URL" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="mcp-add__row">
          <input className="cc-input" aria-label="Auth header name" placeholder="Authorization" value={headerName} onChange={(e) => setHeaderName(e.target.value)} maxLength={64} />
          <input
            className="cc-input"
            aria-label="Auth header value"
            type="password"
            autoComplete="off"
            placeholder="Optional, e.g. Bearer <token> — stored encrypted, never shown again"
            value={headerValue}
            onChange={(e) => setHeaderValue(e.target.value)}
          />
        </div>
        <div className="mcp-server__actions">
          <button type="submit" className="cc-btn cc-btn--primary cc-btn--sm" disabled={adding || !name.trim() || !url.trim()}>
            {adding ? 'Connecting…' : 'Connect'}
          </button>
          {showDemo && (
            // Local development only: the demo server started by scripts/dev-all.mjs (or mcp:demo).
            <button
              type="button"
              className="cc-btn cc-btn--ghost cc-btn--sm"
              onClick={() => {
                setName('notes');
                setUrl(DEMO_MCP_URL);
                setHeaderValue('');
              }}
            >
              Use the demo server
            </button>
          )}
        </div>
        <p className="cc-hint" style={{ margin: 0 }}>
          Remote servers over HTTPS (Streamable HTTP). Private network addresses are blocked. Up to {maxServers} servers.
        </p>
      </form>

      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}

      {servers === null ? (
        <p className="cc-hint">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="cc-hint" data-testid="mcp-empty">
          No MCP servers yet.
        </p>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => (
            <section key={s.id} className="cc-card mcp-server" data-testid={`mcp-server-${s.name}`}>
              <header className="mcp-server__head">
                <Icon name="plug" size={16} />
                <strong>{s.name}</strong>
                <span className={`cc-pill mcp-status mcp-status--${s.status.toLowerCase()}`}>{s.status === 'CONNECTED' ? 'Connected' : s.status === 'FAILED' ? 'Failed' : 'Not checked'}</span>
                {!s.enabled && <span className="cc-pill">Off</span>}
                <span className="cc-muted mcp-server__url">{s.url}</span>
              </header>
              {s.lastError && <p className="cc-error">{s.lastError}</p>}
              <p className="cc-hint" style={{ margin: 0 }}>
                {s.serverName ? `${s.serverName} · ` : ''}
                {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}
                {s.hasAuth ? ` · auth header ${s.authHeaderName} saved (encrypted)` : ''}
                {s.toolsRefreshedAt ? ` · checked ${new Date(s.toolsRefreshedAt).toLocaleString()}` : ''}
              </p>
              {s.tools.length > 0 && (
                <ul className="mcp-tools">
                  {s.tools.map((t) => {
                    const b = toolBehaviour(t);
                    const key = `${s.id}:${t.name}`;
                    return (
                      <li key={t.name}>
                        <div className="mcp-tool__row">
                          <code className="cc-md-code">{t.name}</code>
                          <span className={`cc-pill mcp-tone--${b.tone}`}>{b.label}</span>
                          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setOpenTry(openTry === key ? null : key)} disabled={!s.enabled || s.status !== 'CONNECTED'}>
                            {openTry === key ? 'Close' : 'Try'}
                          </button>
                        </div>
                        {t.description && <span className="cc-hint">{t.description}</span>}
                        {openTry === key && <TryTool server={s.name} tool={t} />}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mcp-server__actions">
                <button type="button" className="cc-btn cc-btn--sm" disabled={busyId === s.id} onClick={() => void act(s.id, () => api(`/api/v1/mcp/servers/${s.id}/refresh`, { method: 'POST' }))}>
                  {busyId === s.id ? 'Working…' : 'Refresh tools'}
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  disabled={busyId === s.id}
                  onClick={() => void act(s.id, () => api(`/api/v1/mcp/servers/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }))}
                >
                  {s.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button
                  type="button"
                  className="cc-btn cc-btn--danger cc-btn--sm"
                  disabled={busyId === s.id}
                  onClick={() => void act(s.id, () => api(`/api/v1/mcp/servers/${s.id}`, { method: 'DELETE' }))}
                >
                  Remove
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
