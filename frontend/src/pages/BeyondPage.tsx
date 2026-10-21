/**
 * Beyond — the systems that keep working on your code when you are not
 * chatting (Constitution Part VI). Every number on this page is measured from
 * your real project files; nothing is sample data.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Project } from '../lib/types';
import { Icon, type IconName } from '../components/Icon';
import { ThermostatPanel } from '../components/beyond/ThermostatPanel';
import { GravityPanel } from '../components/beyond/GravityPanel';
import { CouncilPanel } from '../components/beyond/CouncilPanel';
import { ImmunityPanel } from '../components/beyond/ImmunityPanel';
import { NightShiftPanel } from '../components/beyond/NightShiftPanel';
import { TeleportPanel } from '../components/beyond/TeleportPanel';
import { errMessage, type VaccineDraft } from '../components/beyond/shared';

type TabId = 'thermostat' | 'gravity' | 'council' | 'immunity' | 'night' | 'teleport';

const TABS: { id: TabId; label: string; icon: IconName; blurb: string; needsProject: boolean }[] = [
  { id: 'thermostat', label: 'Thermostat', icon: 'gauge', blurb: 'Code health as a temperature', needsProject: true },
  { id: 'gravity', label: 'Gravity Map', icon: 'compass', blurb: 'Which files belong together', needsProject: true },
  { id: 'council', label: 'Council', icon: 'users', blurb: 'Four reviewers, one verdict', needsProject: true },
  { id: 'immunity', label: 'Immunity', icon: 'shield', blurb: 'Bugs that never come back', needsProject: false },
  { id: 'night', label: 'Night Shift', icon: 'moon', blurb: 'Works while you sleep', needsProject: false },
  { id: 'teleport', label: 'Teleport', icon: 'rocket', blurb: 'A project in one sealed file', needsProject: true },
];

const isTab = (v: string | null): v is TabId => TABS.some((t) => t.id === v);

export function BeyondPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = isTab(params.get('tab')) ? (params.get('tab') as TabId) : 'thermostat';
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<VaccineDraft | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>('/api/v1/projects');
      setProjects((res.projects ?? []).filter((p) => !p.deleted_at));
    } catch (err) {
      setProjects([]);
      setError(errMessage(err, 'Could not load your projects.'));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const projectId = params.get('project') && projects?.some((p) => p.id === params.get('project')) ? params.get('project')! : (projects?.[0]?.id ?? '');
  const project = projects?.find((p) => p.id === projectId) ?? null;

  const set = (next: { tab?: TabId; project?: string }) => {
    const p = new URLSearchParams(params);
    if (next.tab) p.set('tab', next.tab);
    if (next.project) p.set('project', next.project);
    setParams(p, { replace: true });
  };

  const current = TABS.find((t) => t.id === tab)!;

  const vaccinate = useCallback(
    (d: VaccineDraft) => {
      setDraft(d);
      const p = new URLSearchParams(params);
      p.set('tab', 'immunity');
      setParams(p, { replace: true });
    },
    [params, setParams],
  );
  const draftUsed = useCallback(() => setDraft(null), []);

  return (
    <div className="cc-page bx-page">
      <header className="bx-hero">
        <div>
          <h1>Beyond</h1>
          <p className="cc-hint">Systems that keep working on your code when you are not chatting. Every number here is measured from your real files — no sample data.</p>
        </div>
        {current.needsProject && projects && projects.length > 0 && (
          <label className="bx-field">
            <span>Project</span>
            <select className="cc-input" value={projectId} onChange={(e) => set({ project: e.target.value })} aria-label="Project">
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <nav className="bx-tabs" role="tablist" aria-label="Beyond systems">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`bx-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => set({ tab: t.id })}
          >
            <Icon name={t.icon} size={14} />
            <span>
              <strong>{t.label}</strong>
              <small>{t.blurb}</small>
            </span>
          </button>
        ))}
      </nav>

      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}

      <div role="tabpanel" aria-label={current.label}>
        {current.needsProject && projects === null ? (
          <p className="cc-hint">Loading projects…</p>
        ) : current.needsProject && !project ? (
          <div className="bx-panel" data-testid="beyond-no-project">
            <p>
              {current.label} works on a project&apos;s files. <Link to="/projects?new=1">Create a project</Link> and add some files first.
            </p>
          </div>
        ) : tab === 'thermostat' ? (
          <ThermostatPanel key={projectId} projectId={projectId} />
        ) : tab === 'gravity' ? (
          <GravityPanel key={projectId} projectId={projectId} />
        ) : tab === 'council' ? (
          <CouncilPanel key={projectId} projectId={projectId} onVaccinate={vaccinate} />
        ) : tab === 'immunity' ? (
          <ImmunityPanel draft={draft} onDraftUsed={draftUsed} />
        ) : tab === 'night' ? (
          <NightShiftPanel />
        ) : (
          <TeleportPanel
            key={projectId}
            projectId={projectId}
            projectName={project?.name ?? ''}
            onImported={() => void loadProjects()}
          />
        )}
      </div>

      <p className="cc-hint bx-foot">
        Also part of Beyond: <strong>Focus Morph</strong> (the Home composer adapts to what you type) and <strong>Limit Guard</strong> (a clear pop-up with the exact reset time when a usage window is full).
      </p>
    </div>
  );
}
