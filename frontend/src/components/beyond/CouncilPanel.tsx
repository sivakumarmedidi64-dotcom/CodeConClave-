/**
 * Council panel — four CodeConClave reviewers (Sentry, Turbo, Rhea, Tess) look
 * at one real file through different lenses and reach a consensus. Their checks
 * are fixed, open rules (same file → same answer). The optional AI round adds
 * opinions and can only raise a verdict, never lower it.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { FileRef } from '../../lib/types';
import { errMessage, SEVERITY_ORDER, type Severity, type VaccineDraft } from './shared';

type Verdict = 'PASS' | 'CONCERNS' | 'BLOCK';

export interface CouncilFinding {
  lens: string;
  rule: string;
  severity: Severity;
  line: number | null;
  title: string;
  evidence: string;
  fix: string;
}

export interface CouncilResult {
  path: string;
  lines: number;
  lenses: { lens: string; bot: string; role: string; verdict: Verdict; findings: CouncilFinding[]; ai?: { verdict: Verdict; points: string[] } | null }[];
  consensus: { verdict: 'SHIP' | 'SHIP_WITH_CARE' | 'FIX_FIRST' | 'DO_NOT_SHIP'; summary: string };
  ai: { requested: boolean; available: boolean; reason?: string };
}

const CONSENSUS_TEXT: Record<CouncilResult['consensus']['verdict'], string> = {
  SHIP: 'Ship it',
  SHIP_WITH_CARE: 'Ship with care',
  FIX_FIRST: 'Fix first',
  DO_NOT_SHIP: 'Do not ship',
};

const CODE_EXT = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|scala|sql|sh|vue|svelte)$/i;

/**
 * A Council finding as an Immunity vaccine, or null when its evidence is not a
 * line of code (whole-file findings like "no tests") or is hidden. Pure.
 */
export function draftFromFinding(f: CouncilFinding): VaccineDraft | null {
  const evidence = f.evidence.trim();
  if (f.line === null || evidence.length < 4 || evidence === '[value hidden]') return null;
  return { name: f.title.slice(0, 80), pattern: evidence.slice(0, 300), kind: 'literal', fixNote: f.fix.slice(0, 300), severity: f.severity };
}

export function CouncilPanel({ projectId, onVaccinate }: { projectId: string; onVaccinate: (draft: VaccineDraft) => void }) {
  const [files, setFiles] = useState<FileRef[] | null>(null);
  const [fileId, setFileId] = useState('');
  const [withAi, setWithAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CouncilResult | null>(null);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setResult(null);
    setFileId('');
    api<{ files: FileRef[] }>(`/api/v1/files?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => alive && setFiles((r.files ?? []).filter((f) => !f.is_directory)))
      .catch((err) => {
        if (!alive) return;
        setFiles([]);
        setError(errMessage(err, 'Could not list the project files.'));
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Code files first, then everything else, each alphabetical.
  const choices = useMemo(() => {
    const list = [...(files ?? [])];
    list.sort((a, b) => Number(CODE_EXT.test(b.path)) - Number(CODE_EXT.test(a.path)) || a.path.localeCompare(b.path));
    return list;
  }, [files]);

  const convene = async () => {
    if (!fileId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<{ result: CouncilResult }>('/api/v1/beyond/council', { method: 'POST', body: { projectId, fileId, withAi } });
      setResult(res.result);
    } catch (err) {
      setError(errMessage(err, 'The Council could not meet.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bx-panel" aria-label="Council">
      <header className="bx-panel__head">
        <div>
          <h2>Council</h2>
          <p className="cc-hint">Four CodeConClave reviewers check one file through different lenses and agree on a verdict. Their rules are fixed and open, so the same file always gets the same answer.</p>
        </div>
      </header>
      <div className="bx-row">
        <label className="bx-field">
          <span>File</span>
          <select className="cc-input" value={fileId} onChange={(e) => setFileId(e.target.value)} disabled={!files || files.length === 0}>
            <option value="">{files === null ? 'Loading files…' : files.length === 0 ? 'No files in this project' : 'Pick a file…'}</option>
            {choices.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        </label>
        <label className="bx-check">
          <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
          Add CodeConClave AI opinions <span className="cc-muted">(uses your plan&apos;s usage)</span>
        </label>
        <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={!fileId || busy} onClick={() => void convene()}>
          {busy ? 'Reviewing…' : 'Convene the Council'}
        </button>
      </div>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="bx-council" data-testid="council-result">
          <div className={`bx-consensus bx-consensus--${result.consensus.verdict.toLowerCase()}`}>
            <strong>{CONSENSUS_TEXT[result.consensus.verdict]}</strong>
            <span>{result.consensus.summary}</span>
            <span className="cc-muted">
              {result.path} · {result.lines} lines
            </span>
          </div>
          {result.ai.requested && !result.ai.available && (
            <p className="cc-hint" role="status">
              AI opinions were not added: {(result.ai.reason ?? 'CodeConClave AI is not available right now').replace(/[.\s]+$/, '')}. The fixed checks below are complete.
            </p>
          )}
          <div className="bx-lenses">
            {result.lenses.map((l) => {
              const findings = [...l.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
              return (
                <article key={l.lens} className={`bx-lens bx-lens--${l.verdict.toLowerCase()}`}>
                  <header>
                    <strong>{l.bot}</strong> <span className="cc-muted">{l.role}</span>
                    <span className={`cc-pill bx-verdict bx-verdict--${l.verdict.toLowerCase()}`}>{l.verdict}</span>
                  </header>
                  {findings.length === 0 ? (
                    <p className="cc-hint">Nothing found.</p>
                  ) : (
                    <ul className="bx-findings">
                      {findings.map((f, i) => {
                        const draft = draftFromFinding(f);
                        return (
                          <li key={`${f.rule}-${f.line}-${i}`}>
                            <div className="bx-list__row">
                              <span className={`cc-pill bx-sev bx-sev--${f.severity.toLowerCase()}`}>{f.severity}</span>
                              <span>
                                {f.title}
                                {f.line ? <span className="cc-muted"> · line {f.line}</span> : null}
                              </span>
                            </div>
                            {f.evidence && <code className="cc-md-code bx-evidence">{f.evidence}</code>}
                            <span className="cc-hint">{f.fix}</span>
                            {draft && (
                              <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm bx-vaccinate" onClick={() => onVaccinate(draft)} title="Make this a vaccine so it is caught in every project">
                                Vaccinate
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {l.ai && (
                    <div className="bx-ai">
                      <span className="cc-muted">CodeConClave AI: {l.ai.verdict}</span>
                      <ul>
                        {l.ai.points.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
