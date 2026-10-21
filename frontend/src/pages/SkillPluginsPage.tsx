/**
 * CodeConClave — Plugin directory.
 * Claude-style plugins: each bundles skills (working instructions the
 * coworker applies) and slash commands (prompt templates), plus the
 * connectors it works best with. Install, enable/disable, uninstall, and
 * create custom plugins from a manifest. Plugins are data only — they never
 * grant capabilities; execution still goes through policy and approvals.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { pluginIcon } from '../lib/skillCommands';
import { PluginLogo } from '../components/PluginLogo';

export interface SkillPluginManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  icon: string;
  skills: { name: string; description: string; instructions: string }[];
  commands: { name: string; description: string; prompt: string }[];
  connectors: string[];
}

export interface SkillPluginEntry {
  manifest: SkillPluginManifest;
  source: 'builtin' | 'custom' | 'team';
  installed: boolean;
  enabled: boolean;
  installedVersion: string | null;
  /** Team plugins: active for every member; owners/admins can update or unpublish. */
  team?: { id: string; name: string; canManage: boolean };
}

interface TeamPluginVersion {
  version: string;
  action: 'PUBLISHED' | 'UNPUBLISHED';
  actorName: string | null;
  createdAt: string;
}

/** Slugs are unique per source/team, not globally: key on all three. */
function entryKey(p: SkillPluginEntry): string {
  return `${p.source}:${p.team?.id ?? ''}:${p.manifest.slug}`;
}


const CATEGORY_LABELS: Record<string, string> = {
  engineering: 'Engineering',
  quality: 'Quality',
  security: 'Security',
  docs: 'Docs',
  planning: 'Planning',
  research: 'Research',
  productivity: 'Productivity',
  team: 'Team',
};

const TEMPLATE = JSON.stringify(
  {
    slug: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    description: 'What this plugin helps the coworker do.',
    author: 'Me',
    category: 'productivity',
    icon: 'puzzle',
    skills: [
      {
        name: 'House style',
        description: 'How I like answers written.',
        instructions: 'Answer in short bullet points and always include the exact command to run.',
      },
    ],
    commands: [
      {
        name: 'summarize',
        description: 'Summarize text into key points.',
        prompt: 'Summarize the following into 5 key points: $ARGUMENTS',
      },
    ],
    connectors: [],
  },
  null,
  2,
);

type Tab = 'discover' | 'installed';

export function SkillPluginsPage() {
  const { toast } = useToast();
  const [plugins, setPlugins] = useState<SkillPluginEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Settings → Customize → Skills deep-links here with ?tab=installed.
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'installed' ? 'installed' : 'discover',
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(TEMPLATE);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [target, setTarget] = useState('');
  const [versions, setVersions] = useState<TeamPluginVersion[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ plugins: SkillPluginEntry[] }>('/api/v1/skill-plugins');
      setPlugins(res.plugins);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    api<{ teams: { id: string; name: string }[] }>('/api/v1/skill-plugins/teams')
      .then((res) => setTeams(Array.isArray(res?.teams) ? res.teams : []))
      .catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (tab === 'installed' && !p.installed) return false;
      if (category && p.manifest.category !== category) return false;
      if (!q) return true;
      const m = p.manifest;
      const hay = [m.name, m.description, m.author, ...m.skills.map((s) => s.name), ...m.commands.map((c) => `/${c.name}`)]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, tab, category, query]);

  const categories = useMemo(() => [...new Set(plugins.map((p) => p.manifest.category))], [plugins]);
  const installedCount = plugins.filter((p) => p.installed).length;
  const current = plugins.find((p) => entryKey(p) === selected) ?? null;

  useEffect(() => {
    setVersions(null);
  }, [selected]);

  const run = async (slug: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(slug);
    try {
      await fn();
      await load();
      toast(ok);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Request failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const install = (p: SkillPluginEntry) =>
    run(p.manifest.slug, () => api(`/api/v1/skill-plugins/${p.manifest.slug}/install`, { method: 'POST', body: {} }), `${p.manifest.name} installed`);
  const toggle = (p: SkillPluginEntry) =>
    run(
      p.manifest.slug,
      () => api(`/api/v1/skill-plugins/${p.manifest.slug}`, { method: 'PATCH', body: { enabled: !p.enabled } }),
      `${p.manifest.name} ${p.enabled ? 'disabled' : 'enabled'}`,
    );
  const uninstall = (p: SkillPluginEntry) =>
    run(p.manifest.slug, () => api(`/api/v1/skill-plugins/${p.manifest.slug}/install`, { method: 'DELETE' }), `${p.manifest.name} uninstalled`);
  const deleteCustom = (p: SkillPluginEntry) =>
    run(p.manifest.slug, () => api(`/api/v1/skill-plugins/custom/${p.manifest.slug}`, { method: 'DELETE' }), `${p.manifest.name} deleted`).then(
      () => setSelected(null),
    );
  const unpublish = (p: SkillPluginEntry) =>
    run(
      p.manifest.slug,
      () => api(`/api/v1/skill-plugins/teams/${p.team!.id}/${p.manifest.slug}`, { method: 'DELETE' }),
      `${p.manifest.name} unpublished from ${p.team!.name}`,
    ).then(() => setSelected(null));
  const loadVersions = async (p: SkillPluginEntry) => {
    try {
      const res = await api<{ versions: TeamPluginVersion[] }>(`/api/v1/skill-plugins/teams/${p.team!.id}/${p.manifest.slug}/versions`);
      setVersions(res.versions);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load history', 'error');
    }
  };

  const saveDraft = async () => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(draft);
    } catch {
      setDraftError('Manifest is not valid JSON.');
      return;
    }
    setDraftError(null);
    setBusy('__create');
    try {
      if (target) {
        const team = teams.find((t) => t.id === target);
        const res = await api<{ manifest: SkillPluginManifest }>(`/api/v1/skill-plugins/teams/${target}`, { method: 'POST', body: { manifest } });
        await load();
        setCreating(false);
        setSelected(`team:${target}:${res.manifest.slug}`);
        toast(`${res.manifest.name} published to ${team?.name ?? 'team'}`);
        return;
      }
      const res = await api<{ manifest: SkillPluginManifest }>('/api/v1/skill-plugins/custom', { method: 'POST', body: { manifest } });
      await api(`/api/v1/skill-plugins/${res.manifest.slug}/install`, { method: 'POST', body: {} });
      await load();
      setCreating(false);
      setSelected(`custom::${res.manifest.slug}`);
      toast(`${res.manifest.name} saved and installed`);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Could not save plugin');
    } finally {
      setBusy(null);
    }
  };

  const editCustom = (p: SkillPluginEntry) => {
    setTarget(p.source === 'team' ? p.team!.id : '');
    setDraft(JSON.stringify(p.manifest, null, 2));
    setDraftError(null);
    setCreating(true);
  };

  return (
    <div className="cc-page sp-page">
      <header className="sp-header">
        <div>
          <h2 className="sp-title">
            <Icon name="puzzle" size={22} className="sp-title-icon" /> Plugins
          </h2>
          <p className="cc-muted sp-subtitle">
            Add skills and slash commands to your coworker. Plugins only shape how it works — they never grant new permissions.
          </p>
        </div>
        <button
          type="button"
          className="cc-btn"
          onClick={() => {
            setDraft(TEMPLATE);
            setDraftError(null);
            setTarget('');
            setCreating(true);
          }}
        >
          <Icon name="plus" size={16} className="sp-btn-icon" /> Create plugin
        </button>
      </header>

      <div className="sp-toolbar">
        <div className="sp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'discover'} className={tab === 'discover' ? 'is-active' : ''} onClick={() => setTab('discover')}>
            Discover
          </button>
          <button type="button" role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'is-active' : ''} onClick={() => setTab('installed')}>
            Installed <span className="sp-count">{installedCount}</span>
          </button>
        </div>
        <label className="sp-search">
          <Icon name="search" size={16} className="sp-search-icon" />
          <input
            className="cc-input"
            placeholder="Search plugins, skills or /commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search plugins"
          />
        </label>
      </div>

      {categories.length > 1 && (
        <div className="sp-chips">
          <button type="button" className={`sp-chip ${category === '' ? 'is-active' : ''}`} onClick={() => setCategory('')}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" className={`sp-chip ${category === c ? 'is-active' : ''}`} onClick={() => setCategory(c)}>
              {CATEGORY_LABELS[c] ?? c}
            </button>
          ))}
        </div>
      )}

      {state === 'loading' && <div className="cc-card cc-empty">Loading plugins…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          Could not load plugins.{' '}
          <button type="button" className="cc-btn cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && visible.length === 0 && (
        <div className="cc-card cc-empty">{tab === 'installed' ? 'No plugins installed yet — browse Discover.' : 'No plugins match.'}</div>
      )}

      {state === 'ready' && visible.length > 0 && (
        <div className="sp-grid">
          {visible.map((p) => {
            const m = p.manifest;
            return (
              <article key={entryKey(p)} className={`sp-card ${p.installed && !p.enabled ? 'is-disabled' : ''}`}>
                <button type="button" className="sp-card-main" onClick={() => setSelected(entryKey(p))} aria-label={`Open ${m.name}`}>
                  <span className="sp-icon-tile">
                    <Icon name={pluginIcon(m.icon)} size={22} className="sp-icon" />
                  </span>
                  <span className="sp-card-text">
                    <span className="sp-card-name">
                      {m.name}
                      {p.source === 'custom' && <span className="cc-pill sp-pill">Custom</span>}
                      {p.team && <span className="cc-pill sp-pill">Team · {p.team.name}</span>}
                    </span>
                    <span className="sp-card-desc">{m.description}</span>
                    <span className="sp-card-meta">
                      {m.skills.length > 0 && `${m.skills.length} skill${m.skills.length === 1 ? '' : 's'}`}
                      {m.skills.length > 0 && m.commands.length > 0 && ' · '}
                      {m.commands.length > 0 && m.commands.map((c) => `/${c.name}`).join(' ')}
                    </span>
                  </span>
                </button>
                <div className="sp-card-actions">
                  {p.source === 'team' ? (
                    <span className="sp-team-badge" title={`Active for everyone in ${p.team?.name ?? 'the team'}`}>
                      <Icon name="users" size={16} className="sp-btn-icon" />
                    </span>
                  ) : !p.installed ? (
                    <button type="button" className="cc-btn cc-btn--sm" disabled={busy === m.slug} onClick={() => void install(p)}>
                      Install
                    </button>
                  ) : (
                    <label className="sp-switch" title={p.enabled ? 'Enabled' : 'Disabled'}>
                      <input
                        type="checkbox"
                        checked={p.enabled}
                        disabled={busy === m.slug}
                        onChange={() => void toggle(p)}
                        aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${m.name}`}
                      />
                      <span className="sp-switch-track" />
                    </label>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {current && (
        <div className="sp-overlay" role="dialog" aria-modal="true" aria-label={current.manifest.name} onClick={() => setSelected(null)}>
          <aside className="sp-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="sp-drawer-head">
              <span className="sp-icon-tile sp-icon-tile--lg">
                <Icon name={pluginIcon(current.manifest.icon)} size={28} className="sp-icon" />
              </span>
              <div className="sp-drawer-title">
                <h3>{current.manifest.name}</h3>
                <span className="cc-muted">
                  {current.manifest.author} · v{current.manifest.version} · {CATEGORY_LABELS[current.manifest.category] ?? current.manifest.category}
                </span>
              </div>
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setSelected(null)} aria-label="Close">
                <Icon name="close" size={16} className="sp-btn-icon" />
              </button>
            </div>
            <p>{current.manifest.description}</p>
            {current.team && (
              <p className="cc-hint">
                Published to <strong>{current.team.name}</strong> — active for every member.{' '}
                {current.team.canManage ? 'You can update or unpublish it.' : 'Only team owners and admins can change it.'}
              </p>
            )}

            <div className="sp-drawer-actions">
              {current.source === 'team' && (
                <button type="button" className="cc-btn cc-btn--ghost" onClick={() => void loadVersions(current)}>
                  Version history
                </button>
              )}
              {current.team?.canManage && (
                <>
                  <button type="button" className="cc-btn cc-btn--ghost" onClick={() => editCustom(current)}>
                    Update
                  </button>
                  <button type="button" className="cc-btn cc-btn--danger" disabled={busy === current.manifest.slug} onClick={() => void unpublish(current)}>
                    Unpublish
                  </button>
                </>
              )}
              {current.source !== 'team' && !current.installed && (
                <button type="button" className="cc-btn" disabled={busy === current.manifest.slug} onClick={() => void install(current)}>
                  Install
                </button>
              )}
              {current.source !== 'team' && current.installed && (
                <>
                  <button type="button" className="cc-btn" disabled={busy === current.manifest.slug} onClick={() => void toggle(current)}>
                    {current.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="cc-btn cc-btn--ghost" disabled={busy === current.manifest.slug} onClick={() => void uninstall(current)}>
                    Uninstall
                  </button>
                </>
              )}
              {current.source === 'custom' && (
                <>
                  <button type="button" className="cc-btn cc-btn--ghost" onClick={() => editCustom(current)}>
                    Edit
                  </button>
                  <button type="button" className="cc-btn cc-btn--danger" disabled={busy === current.manifest.slug} onClick={() => void deleteCustom(current)}>
                    Delete
                  </button>
                </>
              )}
            </div>

            {versions && (
              <section className="sp-section">
                <h4>
                  <Icon name="clock" size={16} className="sp-btn-icon" /> Version history
                </h4>
                {versions.length === 0 && <p className="cc-muted">No history recorded.</p>}
                {versions.map((v) => (
                  <div key={`${v.createdAt}-${v.action}`} className="sp-item sp-command">
                    <code className="cc-mono">v{v.version}</code>
                    <span>{v.action === 'PUBLISHED' ? 'Published' : 'Unpublished'}</span>
                    <span className="cc-muted">
                      {v.actorName ?? 'Unknown'} · {new Date(v.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {current.manifest.skills.length > 0 && (
              <section className="sp-section">
                <h4>
                  <Icon name="sparkle" size={16} className="sp-btn-icon" /> Skills
                </h4>
                {current.manifest.skills.map((s) => (
                  <details key={s.name} className="sp-item">
                    <summary>
                      <strong>{s.name}</strong>
                      <span className="cc-muted"> — {s.description}</span>
                    </summary>
                    <p className="sp-instructions">{s.instructions}</p>
                  </details>
                ))}
              </section>
            )}

            {current.manifest.commands.length > 0 && (
              <section className="sp-section">
                <h4>
                  <Icon name="command" size={16} className="sp-btn-icon" /> Slash commands
                </h4>
                {current.manifest.commands.map((c) => (
                  <div key={c.name} className="sp-item sp-command">
                    <code className="cc-mono">/{c.name}</code>
                    <span className="cc-muted">{c.description}</span>
                  </div>
                ))}
                <p className="cc-hint">Type the command at the start of a chat message, followed by your details.</p>
              </section>
            )}

            {current.manifest.connectors.length > 0 && (
              <section className="sp-section">
                <h4>
                  <Icon name="plug" size={16} className="sp-btn-icon" /> Works with connectors
                </h4>
                <div className="sp-connectors">
                  {current.manifest.connectors.map((c) => (
                    <a key={c} href="/plugins" className="sp-connector">
                      <PluginLogo type={c} size={18} />
                      <span>{c}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      )}

      {creating && (
        <div className="sp-overlay" role="dialog" aria-modal="true" aria-label="Create plugin" onClick={() => setCreating(false)}>
          <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create plugin</h3>
            <p className="cc-muted">
              A plugin is a JSON manifest: <code>skills</code> (instructions) and <code>commands</code> (prompt templates where{' '}
              <code>$ARGUMENTS</code> is replaced with what you type after the command). No code runs.
            </p>
            {teams.length > 0 && (
              <label className="cc-field">
                <span>Publish to</span>
                <select className="cc-select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Publish to">
                  <option value="">Just me (personal plugin)</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      Team: {t.name} (active for all members)
                    </option>
                  ))}
                </select>
              </label>
            )}
            <textarea
              className="cc-input sp-editor"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Plugin manifest JSON"
            />
            {draftError && <div className="cc-error">{draftError}</div>}
            <div className="sp-drawer-actions">
              <button type="button" className="cc-btn" disabled={busy === '__create'} onClick={() => void saveDraft()}>
                {target ? 'Publish to team' : 'Save and install'}
              </button>
              <button type="button" className="cc-btn cc-btn--ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
