/**
 * CodeConClave — PKG-24 AI Developer Copilot panel.
 * Context-aware coding assistance that is honest about provider availability:
 * deterministic/heuristic analysis (evidence, memory, suggestions, diagnosis,
 * safe B1 proposals) always works; AI-synthesized modes report PROVIDER_REQUIRED
 * / UNAVAILABLE when no real model can serve them. The copilot never auto-applies
 * source changes — it only drafts B1 reviews.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface ProviderReport {
  state: string;
  providersConfigured: number;
  localModelConfigured: boolean;
  note: string;
}

interface Capabilities {
  featureGateEnabled: boolean;
  featureGateKey: string;
  provider: ProviderReport;
  modes: Array<{ mode: string; available: string; needsProvider: boolean; note: string }>;
  bounds: Record<string, number>;
  notes: string[];
}

interface Suggestion {
  suggestion: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  relatedFiles: string[];
  source: 'MODEL' | 'HEURISTIC' | 'MEMORY';
}

interface ExplanationPoint {
  source: string;
  text: string;
  ref?: string | null;
}

interface TestProposal {
  id: string;
  title: string;
  kind: string;
  target: string;
  body: string;
  source: 'MODEL' | 'HEURISTIC';
  confidence: number;
  rationale: string;
}

interface DiagnosisClue {
  symptom: string;
  probableCause: string;
  candidateFiles: string[];
  remediation: string;
  confidence: number;
  evidenceKind: string;
}

interface ReviewView {
  id: string;
  status: string;
}

type Mode = 'EXPLAIN' | 'SUGGEST' | 'ASK' | 'TEST' | 'DEBUG' | 'PROPOSE';

const MODES: Mode[] = ['EXPLAIN', 'SUGGEST', 'ASK', 'TEST', 'DEBUG', 'PROPOSE'];

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function CopilotPanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);

  const [file, setFile] = useState('');
  const [errorText, setErrorText] = useState('');
  const [question, setQuestion] = useState('');
  const [taskId, setTaskId] = useState('task-copilot');

  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPoint[] | null>(null);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askEvidence, setAskEvidence] = useState<Array<{ kind: string; ref: string; detail: string }>>([]);
  const [proposals, setProposals] = useState<TestProposal[] | null>(null);
  const [clues, setClues] = useState<DiagnosisClue[] | null>(null);
  const [verifyPlan, setVerifyPlan] = useState<string[]>([]);
  const [review, setReview] = useState<ReviewView | null>(null);

  const [resultNote, setResultNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const caps = await api<Capabilities>('/api/v1/copilot/capabilities');
      if (!caps.featureGateEnabled) {
        setCaps(null);
        setState('disabled');
        return;
      }
      setCaps(caps);
      setState('ready');
    } catch (e) {
      setCaps(null);
      setState('error');
      setError(message(e, 'Copilot capabilities unavailable'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runMode = async (mode: Mode) => {
    setBusy(mode);
    setError(null);
    setResultNote(null);
    setReview(null);
    try {
      const base: Record<string, unknown> = { projectId, file: file || null };
      if (mode === 'EXPLAIN') {
        const r = await api<{ whatItDoes: ExplanationPoint[] }>('/api/v1/copilot/explain', { method: 'POST', body: base });
        setExplanation(r.whatItDoes);
      } else if (mode === 'SUGGEST') {
        const r = await api<{ suggestions: Suggestion[]; generatedWithModel: boolean }>('/api/v1/copilot/suggest', { method: 'POST', body: base });
        setSuggestions(r.suggestions);
        setResultNote(r.generatedWithModel ? 'AI-synthesized suggestions.' : 'Evidence-based suggestions (no live model).');
      } else if (mode === 'ASK') {
        const r = await api<{ answer: string; synthesizedWithModel: boolean; evidence: Array<{ kind: string; ref: string; detail: string }> }>('/api/v1/copilot/ask', { method: 'POST', body: { ...base, question } });
        setAskAnswer(r.answer);
        setAskEvidence(r.evidence);
        setResultNote(r.synthesizedWithModel ? 'Answer synthesized by a model.' : 'Evidence-based answer (no live model).');
      } else if (mode === 'TEST') {
        const r = await api<{ proposals: TestProposal[]; measuredCoverage: null }>('/api/v1/copilot/testgen', { method: 'POST', body: base });
        setProposals(r.proposals);
        setResultNote('Proposals only — coverage is never claimed until a real run.');
      } else if (mode === 'DEBUG') {
        const r = await api<{ clues: DiagnosisClue[]; verificationPlan: string[]; synthesizedWithModel: boolean }>('/api/v1/copilot/diagnose', { method: 'POST', body: { ...base, error: errorText } });
        setClues(r.clues);
        setVerifyPlan(r.verificationPlan);
        setResultNote(r.synthesizedWithModel ? 'Diagnosis refined by a model.' : 'Heuristic diagnosis (no live model).');
      } else if (mode === 'PROPOSE') {
        if (!taskId.trim()) throw new Error('A taskId is required to create a B1 review.');
        const r = await api<{ review: ReviewView }>('/api/v1/copilot/propose', {
          method: 'POST',
          body: { ...base, taskId, edits: [{ path: file || 'src/change.ts', proposedContent: '// draft from copilot', summary: 'copilot draft' }], title: 'Copilot proposal' },
        });
        setReview(r.review);
        setResultNote('Draft B1 review created for human + CI review. Nothing was auto-applied.');
      }
    } catch (e) {
      setError(message(e, 'Copilot operation failed'));
    } finally {
      setBusy(null);
    }
  };

  const capFor = (mode: Mode) => caps?.modes.find((m) => m.mode === mode);

  return (
    <div data-testid="copilot-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">AI Developer Copilot</h2>

      {state === 'disabled' && (
        <p data-testid="copilot-disabled" className="text-sm text-amber-700">
          Copilot is feature-gated OFF (AIOS_P2_COPILOT).
        </p>
      )}
      {state === 'loading' && <p data-testid="copilot-loading">Loading copilot…</p>}
      {state === 'error' && <p data-testid="copilot-error" className="text-sm text-red-600">{error ?? 'Copilot unavailable'}</p>}

      {state === 'ready' && caps && (
        <>
          <section className="rounded border p-3 text-sm">
            <p data-testid="copilot-provider" className="font-medium">Provider: {caps.provider.state}</p>
            <p className="text-xs text-gray-500">{caps.provider.note}</p>
          </section>

          <section className="rounded border p-3 text-sm">
            <label className="block text-xs font-medium text-gray-600">File (optional)</label>
            <input
              data-testid="copilot-file"
              value={file}
              onChange={(e) => setFile(e.target.value)}
              placeholder="src/example.ts"
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <label className="mt-2 block text-xs font-medium text-gray-600">Ask a project question</label>
            <input
              data-testid="copilot-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Where is authentication handled?"
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <label className="mt-2 block text-xs font-medium text-gray-600">Error/failure text (Debug)</label>
            <textarea
              data-testid="copilot-error-text"
              value={errorText}
              onChange={(e) => setErrorText(e.target.value)}
              rows={2}
              className="w-full rounded border px-2 py-1 text-sm"
            />
          </section>

          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => {
              const cap = capFor(mode);
              return (
                <button
                  key={mode}
                  data-testid={`copilot-run-${mode.toLowerCase()}`}
                  onClick={() => void runMode(mode)}
                  disabled={busy !== null}
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                >
                  {mode}
                  {cap ? <span className="ml-1 text-xs text-gray-400">({cap.available})</span> : null}
                </button>
              );
            })}
          </div>

          {busy && <p data-testid="copilot-busy" className="text-xs text-gray-500">Running {busy}…</p>}
          {error && <p data-testid="copilot-operation-error" className="text-sm text-red-600">{error}</p>}
          {resultNote && <p data-testid="copilot-note" className="text-xs text-gray-500">{resultNote}</p>}
          {review && <p data-testid="copilot-review" className="text-sm font-medium text-green-700">B1 review {review.id} · {review.status}</p>}

          {suggestions && suggestions.length > 0 && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Suggestions</h3>
              <ul data-testid="copilot-suggestions" className="mt-1 space-y-2">
                {suggestions.map((s, i) => (
                  <li key={i} data-testid="copilot-suggestion" className="rounded bg-gray-50 p-2">
                    <p data-testid="copilot-suggestion-title">{s.suggestion}</p>
                    <p className="text-xs text-gray-500">[{s.source}] conf {Math.round(s.confidence * 100)}% — {s.rationale}</p>
                    {s.relatedFiles.length > 0 && (
                      <p className="text-xs text-gray-400">related: {s.relatedFiles.join(', ')}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {explanation && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Explanation (observed vs heuristic vs model)</h3>
              <ul data-testid="copilot-explanation" className="mt-1 list-disc pl-4 text-xs text-gray-700">
                {explanation.map((p, i) => (
                  <li key={i} data-testid="copilot-explanation-point">
                    <span className="text-gray-400">[{p.source}]</span> {p.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {askAnswer && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Ask CodeConClave</h3>
              <p data-testid="copilot-answer" className="text-xs text-gray-700">{askAnswer}</p>
              {askEvidence.length > 0 && (
                <ul data-testid="copilot-ask-evidence" className="mt-1 list-disc pl-4 text-xs text-gray-500">
                  {askEvidence.map((e, i) => (
                    <li key={i} data-testid="copilot-ask-evidence-item">[{e.kind}] {e.detail}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {proposals && proposals.length > 0 && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Test generation proposals</h3>
              <ul data-testid="copilot-testgen" className="mt-1 space-y-2">
                {proposals.map((p) => (
                  <li key={p.id} data-testid="copilot-testproposal" className="rounded bg-gray-50 p-2">
                    <p className="font-medium">{p.title}</p>
                    <p className="text-xs text-gray-500">[{p.kind}] target {p.target} · [{p.source}]</p>
                    <pre className="mt-1 overflow-x-auto rounded bg-black p-2 text-xs text-green-400">{p.body}</pre>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {clues && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Failure diagnosis</h3>
              <ul data-testid="copilot-diagnosis" className="mt-1 space-y-2">
                {clues.map((c, i) => (
                  <li key={i} data-testid="copilot-clue" className="rounded bg-gray-50 p-2">
                    <p className="font-medium">{c.symptom}</p>
                    <p className="text-xs text-gray-600">cause: {c.probableCause}</p>
                    <p className="text-xs text-gray-500">files: {c.candidateFiles.join(', ')} · remedy: {c.remediation}</p>
                  </li>
                ))}
              </ul>
              {verifyPlan.length > 0 && (
                <ul data-testid="copilot-verify-plan" className="mt-2 list-disc pl-4 text-xs text-gray-500">
                  {verifyPlan.map((v, i) => <li key={i}>{v}</li>)}
                </ul>
              )}
            </section>
          )}

          <section className="rounded border p-3 text-xs text-gray-500">
            <p data-testid="copilot-honest">The copilot reuses the AI Gateway, PKG-23 memory, PKG-22 workspace, and B1 reviews. It never auto-applies source changes and never claims coverage it did not measure.</p>
          </section>
        </>
      )}
    </div>
  );
}
