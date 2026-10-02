/**
 * CodeConClave — Agent marketplace panel (Stage 26I).
 * Browse the catalogue (search + role filter), install packages as real
 * agents (with declared permissions and plan/trust gates enforced
 * server-side), and manage installed agents (disable / enable / update /
 * uninstall). Renders server state only.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AgentRole, CataloguePackageRow, InstalledAgentPackageRow } from '../lib/types';
import { useToast } from './Toast';

export function MarketplacePanel() {
  const { toast } = useToast();
  const [packages, setPackages] = useState<CataloguePackageRow[]>([]);
  const [installed, setInstalled] = useState<InstalledAgentPackageRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (role) params.set('role', role);
      const [c, i] = await Promise.all([
        api<{ packages: CataloguePackageRow[] }>(`/api/v1/agents/marketplace?${params.toString()}`),
        api<{ installed: InstalledAgentPackageRow[] }>('/api/v1/agents/installed'),
      ]);
      setPackages(c.packages);
      setInstalled(i.installed);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [q, role]);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (pkg: CataloguePackageRow) => {
    setInstalling(pkg.id);
    try {
      await api(`/api/v1/agents/marketplace/${pkg.id}/install`, {
        method: 'POST',
        body: { agentName: pkg.name, trustLevel: String(pkg.min_trust_level) },
      });
      toast(`${pkg.name} installed as an agent`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'install failed', 'error');
    } finally {
      setInstalling(null);
    }
  };

  const setStatus = async (row: InstalledAgentPackageRow, enabled: boolean) => {
    try {
      await api(`/api/v1/agents/installed/${row.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: {} });
      toast(enabled ? 'Agent enabled' : 'Agent disabled');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const update = async (row: InstalledAgentPackageRow) => {
    try {
      await api(`/api/v1/agents/installed/${row.id}/update`, { method: 'POST', body: {} });
      toast(`${row.package?.name ?? row.catalogue_slug} updated`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const uninstall = async (row: InstalledAgentPackageRow) => {
    try {
      await api(`/api/v1/agents/installed/${row.id}`, { method: 'DELETE' });
      toast('Agent uninstalled');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'uninstall failed', 'error');
    }
  };

  const installedByCatalogue = new Map(installed.map((i) => [i.catalogue_id, i]));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input
          className="cc-input"
          placeholder="Search catalogue…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load();
          }}
          aria-label="Search marketplace"
        />
        <select className="cc-select" style={{ width: 170 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role filter">
          <option value="">All roles</option>
          {(['ARCHITECT', 'CODER', 'DEBUGGER', 'RESEARCHER', 'REVIEWER', 'TESTER', 'SECURITY', 'DEVOPS', 'UI_UX', 'DOCUMENTATION'] as AgentRole[]).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button className="cc-btn cc-btn--ghost" onClick={() => void load()}>Search</button>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading catalogue…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load the marketplace.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && packages.length === 0 && <div className="cc-card cc-empty">No packages match — try clearing the search.</div>}

      {packages.map((p) => {
        const mine = installedByCatalogue.get(p.id);
        return (
          <div className="cc-card" key={p.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <h4 style={{ margin: 0 }}>{p.name} <span className="cc-pill">{p.role}</span> <span className="cc-hint cc-mono">v{p.version}</span></h4>
                <p className="cc-hint" style={{ margin: '4px 0' }}>{p.description}</p>
                <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>
                  {p.capabilities.map((c) => c.toUpperCase()).join(' · ') || 'no capabilities'}
                </p>
                <p className="cc-hint" style={{ margin: '4px 0', fontSize: 12 }}>
                  Requires trust {p.min_trust_level}+ · plan {p.min_plan} · declared permissions:{' '}
                  {p.declared_permissions.length ? p.declared_permissions.join(', ') : 'none'}
                </p>
              </div>
              <div style={{ alignSelf: 'flex-start', display: 'flex', gap: 6 }}>
                {mine ? (
                  <>
                    <span className="cc-pill" style={{ background: mine.status === 'DISABLED' ? '#b45309' : '#0f766e', color: '#fff' }}>
                      {mine.status === 'DISABLED' ? 'Disabled' : 'Installed'}
                    </span>
                    {mine.status === 'DISABLED' ? (
                      <button className="cc-btn cc-btn--sm" onClick={() => void setStatus(mine, true)}>Enable</button>
                    ) : (
                      <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void setStatus(mine, false)}>Disable</button>
                    )}
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void update(mine)} title="Install the latest catalogue version">Update</button>
                    <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void uninstall(mine)}>Uninstall</button>
                  </>
                ) : (
                  <button className="cc-btn cc-btn--sm" disabled={installing === p.id} onClick={() => void install(p)}>
                    {installing === p.id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            </div>
            {mine && (
              <p className="cc-hint cc-mono" style={{ margin: '8px 0 0', fontSize: 12 }}>
                Agent {mine.agent?.name ?? mine.agent_id} · {mine.agent?.status ?? 'unknown'} · trust {mine.agent?.trust_level ?? '—'}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}