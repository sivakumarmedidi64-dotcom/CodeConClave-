/**
 * Settings → General (personalization): what CodeConClave calls you, your standing
 * instructions (injected into every chat, beneath the safety rules) and theme.
 * There is one AI — CodeConClave AI — so there is no model switch here.
 */
import { useEffect, useState } from 'react';
import { loadPrefs, savePrefs } from '../lib/prefs';
import { applyTheme, currentTheme, type Theme } from '../lib/theme';
import { useToast } from './Toast';

const MAX_INSTRUCTIONS = 3000;

export function PersonalizationPanel() {
  const { toast } = useToast();
  const [callMe, setCallMe] = useState('');
  const [instructions, setInstructions] = useState('');
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadPrefs(true).then((p) => {
      setCallMe(typeof p.call_me === 'string' ? p.call_me : '');
      setInstructions(typeof p.personal_instructions === 'string' ? p.personal_instructions : '');
      if (p.theme === 'light' || p.theme === 'dark') setTheme(p.theme);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await savePrefs({
        call_me: callMe.trim().slice(0, 60),
        personal_instructions: instructions.slice(0, MAX_INSTRUCTIONS),
        theme,
      });
      applyTheme(theme);
      toast('Personalization saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cc-card" data-testid="personalization-panel">
      <h3 style={{ marginTop: 0 }}>Personalization</h3>
      <label className="cc-field">
        <span>What should CodeConClave call you?</span>
        <input className="cc-input" value={callMe} maxLength={60} onChange={(e) => setCallMe(e.target.value)} aria-label="What should CodeConClave call you" disabled={!loaded} />
      </label>
      <label className="cc-field">
        <span>Personal instructions</span>
        <textarea
          className="cc-textarea"
          rows={6}
          value={instructions}
          maxLength={MAX_INSTRUCTIONS}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="e.g. I work mostly in TypeScript and Postgres. Keep answers short and show exact commands."
          aria-label="Personal instructions"
          disabled={!loaded}
        />
        <span className="cc-hint">
          Used in every chat. They shape how answers are written — they never override safety rules or grant permissions. {instructions.length}/{MAX_INSTRUCTIONS}
        </span>
      </label>
      <div className="cc-field">
        <span>Appearance</span>
        <div className="cc-toggle" role="radiogroup" aria-label="Theme">
          {(['dark', 'light'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
              {t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="cc-btn cc-btn--primary" disabled={saving || !loaded} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
