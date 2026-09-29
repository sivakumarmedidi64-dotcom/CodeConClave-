/**
 * CodeConClave — CopilotPanel tests (PKG-24).
 * Honest capability rendering, provider-unavailable state, per-mode wiring, and
 * the guarantee that changes are only proposed (B1 review), never auto-applied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CopilotPanel } from './CopilotPanel';

const provider = (state: string) => ({
  state,
  providersConfigured: state === 'LIVE_PROVIDER' ? 1 : 0,
  localModelConfigured: false,
  note: `note: ${state}`,
});

const caps = (state: string) => ({
  featureGateEnabled: true,
  featureGateKey: 'AIOS_P2_COPILOT',
  provider: provider(state),
  modes: [
    { mode: 'EXPLAIN', available: state === 'LIVE_PROVIDER' ? 'VERIFIED' : 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'SUGGEST', available: state === 'LIVE_PROVIDER' ? 'VERIFIED' : 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'ASK', available: state === 'LIVE_PROVIDER' ? 'VERIFIED' : 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'DEBUG', available: 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'TEST', available: state === 'LIVE_PROVIDER' ? 'VERIFIED' : 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'REFACTOR', available: 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'REVIEW', available: 'HEURISTIC', needsProvider: false, note: 'n' },
    { mode: 'GENERATE', available: state === 'LIVE_PROVIDER' ? 'VERIFIED' : 'PROVIDER_REQUIRED', needsProvider: true, note: 'n' },
    { mode: 'MEMORY', available: 'VERIFIED', needsProvider: false, note: 'n' },
  ],
  bounds: { maxContextBytes: 65536, maxOutputBytes: 32768, maxMemoryItems: 10, maxEvidenceItems: 12, maxTestProposals: 12, maxDiagnosisClues: 10 },
  notes: ['honest'],
});

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

const providerNone = { state: 'UNAVAILABLE', providersConfigured: 0, localModelConfigured: false, note: 'No AI provider configured.' };

describe('CopilotPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the disabled state when the feature gate is off', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ featureGateEnabled: false, featureGateKey: 'AIOS_P2_COPILOT', provider: providerNone, modes: [], bounds: {}, notes: [] }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    expect(screen.getByTestId('copilot-disabled').textContent).toContain('AIOS_P2_COPILOT');
  });

  it('renders the honest provider + capabilities when ready', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    expect(screen.getByTestId('copilot-provider').textContent).toContain('UNAVAILABLE');
    expect(screen.getByTestId('copilot-honest').textContent).toContain('never auto-applies');
    expect(screen.getByTestId('copilot-run-explain').textContent).toContain('EXPLAIN');
  });

  it('runs suggestions and shows evidence-based suggestions without a live provider', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({
        provider: providerNone,
        generatedWithModel: false,
        suggestions: [
          { suggestion: 'Add retry to network call', confidence: 0.7, rationale: 'runtime 500 seen', evidence: ['r1'], relatedFiles: ['src/api.ts'], source: 'MEMORY' },
        ],
      }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => fireEvent.click(screen.getByTestId('copilot-run-suggest')));
    expect(screen.getByTestId('copilot-note').textContent).toContain('Evidence-based');
    expect(screen.getByTestId('copilot-suggestion-title').textContent).toContain('Add retry');
    expect(screen.getByTestId('copilot-suggestion').textContent).toContain('[MEMORY]');
  });

  it('runs an explanation and separates sources', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({
        provider: providerNone,
        generatedWithModel: false,
        whatItDoes: [{ source: 'OBSERVED', text: 'File src/api.ts contains the selected source.', ref: 'src/api.ts' }],
      }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => fireEvent.click(screen.getByTestId('copilot-run-explain')));
    expect(screen.getByTestId('copilot-explanation-point').textContent).toContain('[OBSERVED]');
  });

  it('runs Ask and shows an evidence-based answer with citations', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({
        provider: providerNone,
        synthesizedWithModel: false,
        answer: 'Evidence-based answer: auth uses JWT.',
        evidence: [{ kind: 'memory', ref: 'mem1', detail: 'auth uses JWT', confidence: 0.7 }],
      }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => {
      fireEvent.change(screen.getByTestId('copilot-question'), { target: { value: 'auth?' } });
      fireEvent.click(screen.getByTestId('copilot-run-ask'));
    });
    expect(screen.getByTestId('copilot-answer').textContent).toContain('JWT');
    expect(screen.getByTestId('copilot-ask-evidence-item').textContent).toContain('[memory]');
  });

  it('runs test generation and never claims coverage', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({
        provider: providerNone,
        measuredCoverage: null,
        proposals: [{ id: 'tp1', title: 'add happy-path', kind: 'happy-path', target: 'add', body: 'it(...)', source: 'HEURISTIC', confidence: 0.6, rationale: 'r' }],
      }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => fireEvent.click(screen.getByTestId('copilot-run-test')));
    expect(screen.getByTestId('copilot-note').textContent).toContain('coverag');
    expect(screen.getByTestId('copilot-testproposal').textContent).toContain('happy-path');
  });

  it('runs failure diagnosis and shows clues + verification plan', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({
        provider: providerNone,
        synthesizedWithModel: false,
        observedError: 'JWT expired',
        evidence: ['r1'],
        clues: [{ symptom: '401 on /login', probableCause: 'JWT expired', candidateFiles: ['src/auth.ts'], remediation: 'refresh', confidence: 0.7, evidenceKind: 'runtime' }],
        verificationPlan: ['Run auth tests'],
      }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => {
      fireEvent.change(screen.getByTestId('copilot-error-text'), { target: { value: 'JWT expired' } });
      fireEvent.click(screen.getByTestId('copilot-run-debug'));
    });
    expect(screen.getByTestId('copilot-clue').textContent).toContain('JWT expired');
    expect(screen.getByTestId('copilot-verify-plan').textContent).toContain('Run auth tests');
  });

  it('creates a B1 review through propose (never auto-applies)', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(caps('UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse({ review: { id: 'rev-1', status: 'READY_FOR_REVIEW' } }));
    await act(async () => render(<CopilotPanel projectId="prj-1" />));
    await act(async () => fireEvent.click(screen.getByTestId('copilot-run-propose')));
    const proposeCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/v1/copilot/propose');
    expect(proposeCall).toBeDefined();
    const body = JSON.parse(String((proposeCall![1] as RequestInit).body));
    expect(body.taskId).toBe('task-copilot');
    expect(screen.getByTestId('copilot-review').textContent).toContain('rev-1');
    expect(screen.getByTestId('copilot-note').textContent).toContain('auto-applied');
  });
});
