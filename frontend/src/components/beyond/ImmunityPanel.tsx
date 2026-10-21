/**
 * Immunity panel — once a bug is understood, turn it into a "vaccine": a text
 * or safe-regex pattern that is searched for in every project you own, now and
 * every Night Shift. Matches show the real project, file and line.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { errMessage, SEVERITY_ORDER, type Severity, type VaccineDraft } from './shared';

export interface Vaccine {
  id: string;
  name: string;
  pattern: string;
  kind: 'literal' | 'regex';
  fileGlob: string | null;
  fixNote: string | null;
  severity: Severity;
  lastScanAt: string | null;
  lastMatchCount: number;
  lastMatches: { projectId: string; projectName: string; path: string; line: number; preview: string }[];
}

interface ScanResult {
  vaccines: Vaccine[];
  projectsScanned: number;
  filesScanned: number;
  failed?: { projectName: string; reason: string }[];
}

const EMPTY = { name: '', pattern: '', kind: 'literal' as const, fileGlob: '', fixNote: '', severity: 'MEDIUM' as Severity };

export function ImmunityPanel({ draft, onDraftUsed }: { draft?: VaccineDraft | null; onDraftUsed?: () => void }) {
  const [vaccines, setVaccines] = useState<Vaccine[] | null>(null);
  const [form, setForm] = useState<{ name: string; pattern: string; kind: 'literal' | 'regex'; fileGlob: string; fixNote: string; severity: Severity }>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<Omit<ScanResult, 'vaccines'> | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ vaccines: Vaccine[] }>('/api/v1/beyond/immunity');
      setVaccines(res.vaccines ?? []);
    } catch (err) {
      setVaccines([]);
      setError(errMessage(err, 'Could not load your vaccines.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A finding sent over from the Council fills the form (you still choose to save).
  useEffect(() => {
    if (!draft) return;
    setForm({ ...EMPTY, ...draft, fileGlob: '' });
    onDraftUsed?.();
  }, [draft, onDraftUsed]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ vaccine: Vaccine }>('/api/v1/beyond/immunity', {
        method: 'POST',
        body: { ...form, fileGlob: form.fileGlob.trim() || null, fixNote: form.fixNote.trim() || null },
      });
      setVaccines((v) => [res.vaccine, ...(v ?? [])]);
      setForm(EMPTY);
    } catch (err) {
      setError(errMessage(err, 'Could not save the vaccine.'));
    } finally {
      setSaving(false);
    }
  };

  const runScan = async (vaccineId?: string) => {
    setScanning(true);
    setError(null);
    try {
      const res = await api<ScanResult>('/api/v1/beyond/immunity/scan', { method: 'POST', body: vaccineId ? { vaccineId } : {} });
      const byId = new Map(res.vaccines.map((v) => [v.id, v]));
      setVaccines((list) => (list ?? []).map((v) => byId.get(v.id) ?? v));
      setScan({ projectsScanned: res.projectsScanned, filesScanned: res.filesScanned, failed: res.failed ?? [] });
    } catch (err) {
      setError(errMessage(err, 'The scan did not finish.'));
    } finally {
      setScanning(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api(`/api/v1/beyond/immunity/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setVaccines((list) => (list ?? []).filter((v) => v.id !== id));
    } catch (err) {
      setError(errMessage(err, 'Could not delete the vaccine.'));
    } finally {
      setConfirming(null);
    }
  };

  const valid = form.name.trim().length > 0 && form.pattern.trim().length >= (form.kind === 'literal' ? 4 : 1);

  return (
    <section className="bx-panel" aria-label="Immunity">
      <header className="bx-panel__head">
        <div>
          <h2>Immunity</h2>
          <p className="cc-hint">Turn a bug you fixed into a vaccine. It is searched for in every project you own — now, and every Night Shift — so the same mistake can&apos;t come back unnoticed.</p>
        </div>
        <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={scanning || !vaccines?.length} onClick={() => void runScan()}>
          {scanning ? 'Scanning…' : 'Scan all projects'}
        </button>
      </header>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {scan && (
        <p className="cc-hint" role="status" data-testid="immunity-scan">
          Checked {scan.filesScanned} files in {scan.projectsScanned} project{scan.projectsScanned === 1 ? '' : 's'}.
          {scan.failed && scan.failed.length > 0 && ` Could not read: ${scan.failed.map((f) => f.projectName).join(', ')}.`}
        </p>
      )}

      <form
        className="bx-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <label className="bx-field">
          <span>Name</span>
          <input className="cc-input" value={form.name} maxLength={80} placeholder="e.g. Token logged to console" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="bx-field bx-field--wide">
          <span>Pattern</span>
          <input className="cc-input" value={form.pattern} maxLength={300} placeholder={form.kind === 'literal' ? 'Exact text to find (4+ characters)' : 'Safe regular expression'} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
        </label>
        <label className="bx-field">
          <span>Kind</span>
          <select className="cc-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'literal' | 'regex' })}>
            <option value="literal">Text</option>
            <option value="regex">Regex</option>
          </select>
        </label>
        <label className="bx-field">
          <span>Severity</span>
          <select className="cc-input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="bx-field">
          <span>Only files</span>
          <input className="cc-input" value={form.fileGlob} maxLength={120} placeholder="optional, e.g. src/**/*.ts" onChange={(e) => setForm({ ...form, fileGlob: e.target.value })} />
        </label>
        <label className="bx-field bx-field--wide">
          <span>How to fix</span>
          <input className="cc-input" value={form.fixNote} maxLength={300} placeholder="optional note shown with every match" onChange={(e) => setForm({ ...form, fixNote: e.target.value })} />
        </label>
        <button type="submit" className="cc-btn cc-btn--sm" disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Add vaccine'}
        </button>
      </form>
      {form.kind === 'regex' && <p className="cc-hint">For safety, regexes with back-references, look-arounds or nested repeats are refused.</p>}

      {vaccines === null ? (
        <p className="cc-hint">Loading…</p>
      ) : vaccines.length === 0 ? (
        <p className="cc-hint" data-testid="immunity-empty">
          No vaccines yet. Add one above, or press <strong>Vaccinate</strong> on a Council finding.
        </p>
      ) : (
        <ul className="bx-list">
          {vaccines.map((v) => (
            <li key={v.id} data-testid="vaccine">
              <div className="bx-list__row">
                <span className={`cc-pill bx-sev bx-sev--${v.severity.toLowerCase()}`}>{v.severity}</span>
                <strong>{v.name}</strong>
                <code className="cc-md-code">{v.kind === 'regex' ? `/${v.pattern}/` : v.pattern}</code>
                {v.fileGlob && <span className="cc-muted">in {v.fileGlob}</span>}
                <span className="bx-spacer" />
                <span className={v.lastMatchCount > 0 ? 'cc-pill bx-up' : 'cc-pill'}>
                  {v.lastScanAt ? `${v.lastMatchCount} match${v.lastMatchCount === 1 ? '' : 'es'}` : 'not scanned'}
                </span>
                <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" disabled={scanning} onClick={() => void runScan(v.id)}>
                  Scan
                </button>
                {confirming === v.id ? (
                  <>
                    <button type="button" className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void remove(v.id)}>
                      Confirm delete
                    </button>
                    <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" aria-label={`Delete ${v.name}`} onClick={() => setConfirming(v.id)}>
                    Delete
                  </button>
                )}
              </div>
              {v.fixNote && <span className="cc-hint">Fix: {v.fixNote}</span>}
              {v.lastScanAt && <span className="cc-hint"> · last scan {new Date(v.lastScanAt).toLocaleString()}</span>}
              {v.lastMatches.length > 0 && (
                <details open={open === v.id} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open ? v.id : null)}>
                  <summary>Where it was found</summary>
                  <ul className="bx-list bx-list--tight">
                    {v.lastMatches.slice(0, 50).map((m) => (
                      <li key={`${m.projectId}:${m.path}:${m.line}`}>
                        <span className="cc-muted">{m.projectName}</span> · <code className="cc-md-code">{`${m.path}:${m.line}`}</code>
                        <code className="cc-md-code bx-evidence">{m.preview}</code>
                      </li>
                    ))}
                  </ul>
                  {v.lastMatches.length > 50 && <p className="cc-hint">Showing 50 of {v.lastMatches.length}.</p>}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
