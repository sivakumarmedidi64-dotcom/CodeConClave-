/**
 * /setup — guided setup (CodeConClave's take on /setup-claude):
 *   1. What do you do?            → a role
 *   2. Install role-matched plugins (real installs via the plugin API)
 *   3. Connect your tools          (optional — links to Connectors)
 *   4. Try a skill                 → fills the composer with a starter command
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { savePrefs } from '../lib/prefs';
import { Icon, type IconName } from './Icon';

export interface SetupRole {
  id: string;
  label: string;
  icon: IconName;
  plugins: string[];
  tryPrompt: string;
}

export const SETUP_ROLES: SetupRole[] = [
  { id: 'developer', label: 'Developer', icon: 'code', plugins: ['coder', 'debugger', 'tester', 'reviewer', 'git-pr', 'safe-workflow'], tryPrompt: '/debug TypeError: Cannot read properties of undefined (reading "map")' },
  { id: 'founder', label: 'Founder or product', icon: 'rocket', plugins: ['planner', 'research', 'docs', 'team-handoff'], tryPrompt: '/plan Launch my MVP in 4 weeks with a two-person team' },
  { id: 'security', label: 'Security', icon: 'shield', plugins: ['security', 'reviewer', 'debugger', 'safe-workflow'], tryPrompt: '/threat-model A login API with email + password and JWT sessions' },
  { id: 'devops', label: 'DevOps / SRE', icon: 'terminal', plugins: ['release', 'docs', 'performance', 'debugger'], tryPrompt: '/runbook Our API returns 502s after a deploy' },
  { id: 'data', label: 'Data and analytics', icon: 'chart', plugins: ['performance', 'research', 'docs'], tryPrompt: '/explain-query SELECT * FROM orders o JOIN users u ON u.id = o.user_id WHERE o.total > 1000' },
  { id: 'student', label: 'Student or learner', icon: 'book', plugins: ['research', 'docs', 'debugger'], tryPrompt: '/compare Python vs JavaScript as a first language' },
  { id: 'writer', label: 'Writing or marketing', icon: 'edit', plugins: ['docs', 'research', 'planner'], tryPrompt: '/compare Three positioning lines for an AI coworker app' },
];

const CONNECT: { label: string; icon: IconName }[] = [
  { label: 'Gmail', icon: 'mail' },
  { label: 'GitHub', icon: 'git-branch' },
  { label: 'Google Drive', icon: 'folder' },
  { label: 'Google Calendar', icon: 'clock' },
];

/** "/setup" (alone) opens the wizard instead of being sent as a message. */
export function isSetupCommand(text: string): boolean {
  return /^\/setup(-codeconclave)?$/i.test(text.trim());
}

interface PluginEntry {
  manifest: { slug: string; name: string; description: string };
  installed: boolean;
}

export function SetupWizard({ onClose, onTry }: { onClose: () => void; onTry: (prompt: string) => void }) {
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<SetupRole | null>(null);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    api<{ plugins: PluginEntry[] }>('/api/v1/skill-plugins')
      .then((r) => {
        setPlugins(Array.isArray(r?.plugins) ? r.plugins : []);
        setLoad('ok');
      })
      .catch(() => {
        setPlugins([]);
        setLoad('error');
      });
  }, []);

  const recommended = role ? plugins.filter((p) => role.plugins.includes(p.manifest.slug)) : [];

  const chooseRole = (r: SetupRole) => {
    setRole(r);
    setPicked(new Set(r.plugins));
    setStep(2);
    void savePrefs({ setup_role: r.id }).catch(() => undefined);
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    const done: string[] = [];
    for (const p of recommended) {
      if (p.installed || !picked.has(p.manifest.slug)) continue;
      try {
        await api(`/api/v1/skill-plugins/${encodeURIComponent(p.manifest.slug)}/install`, { method: 'POST' });
        done.push(p.manifest.name);
      } catch (err) {
        setError(`Could not install ${p.manifest.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    setInstalled(done);
    setInstalling(false);
    setStep(3);
  };

  const finish = () => {
    void savePrefs({ setup_done: true }).catch(() => undefined);
    onTry(role?.tryPrompt ?? '');
    onClose();
  };

  return (
    <div className="sp-overlay lf-overlay" role="dialog" aria-modal="true" aria-label="Guided setup">
      <div className="sp-modal cc-setup">
        <div className="cc-setup__head">
          <strong>Guided setup</strong>
          <span className="cc-muted">Step {step} of 4</span>
          <button type="button" className="cc-icon-btn" aria-label="Close setup" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        {step === 1 && (
          <>
            <h2 className="cc-setup__title">What do you mostly do?</h2>
            <p className="cc-hint">CodeConClave installs the plugins that fit, then shows you one to try.</p>
            <div className="cc-setup__roles">
              {SETUP_ROLES.map((r) => (
                <button key={r.id} type="button" className="cc-capcard" onClick={() => chooseRole(r)}>
                  <Icon name={r.icon} size={16} />
                  <strong>{r.label}</strong>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && role && (
          <>
            <h2 className="cc-setup__title">Plugins for {role.label.toLowerCase()}</h2>
            <p className="cc-hint">Plugins add skills and slash commands. They are instructions only — they can't run code or change permissions.</p>
            <ul className="cc-setup__plugins">
              {recommended.map((p) => (
                <li key={p.manifest.slug}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={p.installed}
                      checked={p.installed || picked.has(p.manifest.slug)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.manifest.slug);
                          else next.delete(p.manifest.slug);
                          return next;
                        })
                      }
                    />
                    <strong>{p.manifest.name}</strong>
                    {p.installed && <span className="cc-pill">Installed</span>}
                  </label>
                  <span className="cc-muted">{p.manifest.description}</span>
                </li>
              ))}
              {recommended.length === 0 && (
                <li className="cc-hint">
                  {load === 'loading'
                    ? 'Loading plugins…'
                    : load === 'error'
                      ? "Couldn't load plugins right now — you can install them later from Plugins."
                      : 'No plugins match this role yet.'}
                </li>
              )}
            </ul>
            <div className="cc-setup__actions">
              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={installing || load === 'loading'} onClick={() => void install()}>
                {installing ? 'Installing…' : recommended.length ? 'Install and continue' : 'Continue'}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="cc-setup__title">Connect your tools</h2>
            {installed.length > 0 && <p className="pv3-ok">✓ Installed: {installed.join(', ')}</p>}
            {error && <p className="cc-error">{error}</p>}
            <p className="cc-hint">Optional. Connected tools let CodeConClave read and draft for you — anything that sends or changes data still asks first.</p>
            <div className="cc-setup__roles">
              {CONNECT.map((c) => (
                <Link key={c.label} to="/plugins" className="cc-capcard" onClick={onClose}>
                  <Icon name={c.icon} size={16} />
                  <strong>{c.label}</strong>
                  <span>Connect in Connectors</span>
                </Link>
              ))}
            </div>
            <div className="cc-setup__actions">
              <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" onClick={() => setStep(4)}>
                Skip for now
              </button>
            </div>
          </>
        )}

        {step === 4 && role && (
          <>
            <h2 className="cc-setup__title">Try a skill</h2>
            <p className="cc-hint">Slash commands come from your plugins. Here's one picked for you:</p>
            <pre className="cc-setup__try">{role.tryPrompt}</pre>
            <div className="cc-setup__actions">
              <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" onClick={finish}>
                Try it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
