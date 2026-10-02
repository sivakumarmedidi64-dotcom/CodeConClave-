/**
 * CodeConClave — Memory-coding panels tests (PKG-23).
 * MemoryInspector (bounded, category-filtered records + honest summary),
 * ProjectContinuityPanel (RESTORED status + evidence + deployments), and
 * MemoryContextPanel (tagged EVIDENCE/MEMORY/INFERENCE items + disabled state).
 * Server-authoritative; feature-gate-disabled state shown honestly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryInspector } from './MemoryInspector';
import { ProjectContinuityPanel } from './ProjectContinuityPanel';
import { MemoryContextPanel } from './MemoryContextPanel';

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

type Handler = (url: string, method: string, body?: unknown) => Response;

let fetchMock: ReturnType<typeof vi.fn>;
function stub(handler: Handler): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(url, method, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const capsOn = jsonResponse({ featureGateEnabled: true });

const inspectorData = {
  stats: { preferences: 2, patterns: 1, activePatterns: 1, bugIncidents: 1, openIncidents: 1, links: 0 },
  preferences: [
    { id: 'p1', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT', confidence: 0.9, source: 'user.declared' },
    { id: 'p2', category: 'style', key: 'indent', value: { value: '2' }, classification: 'INFERRED', confidence: 0.5, source: 'inferred' },
  ],
  patterns: [
    { id: 'pt1', name: 'retry', description: 'retry on 503', evidence_count: 6, confirm_count: 0, reject_count: 0, confidence: 0.7, status: 'ACTIVE' },
  ],
  bugs: [
    { id: 'b1', title: 'flaky auth', symptom_key: 'auth-401-timing', occurrences: 2, status: 'OPEN', diagnosis: null, fix_summary: null },
  ],
  links: [],
  summary: { activePatterns: 1, openBugs: 1, explicitPreferences: 1, inferredPreferences: 1 },
};

const continuityData = {
  status: 'RESTORED',
  projectId: 'p-1',
  lastActiveProject: 'p-1',
  branch: 'main',
  currentTaskId: 't1',
  recentSearches: [],
  recentCommands: [],
  activeFile: 'src/a.ts',
  split: 'row',
  files: [{ path: 'src/a.ts', active: true, unsaved: false }],
  memories: ['remembered note'],
  decisions: [{ title: 'Use postgres', impact: 'LOW' }],
  evidence: { testFailures: ['test/flaky.spec.ts'], timedOutCommands: [], serverErrors: ['GET /x 500'], openTrials: [], failedTasks: [] },
  deployments: [{ version: 'v1', environment: 'production', status: 'VERIFIED', verification: 'VERIFIED' }],
  lastActivityAt: null,
};

const contextItems = [
  { kind: 'CURRENT_CODE_EVIDENCE', source: 'runtime', label: 'Endpoint returned 500: GET /x', detail: 'HTTP 500', confidence: 0.8, ref: 'r1' },
  { kind: 'MEMORY', source: 'OBSERVED', label: 'Memory (DETERMINISTIC)', detail: 'fileA uses pool', confidence: 0.8, ref: 'mem1' },
  { kind: 'INFERENCE', source: 'OBSERVED', label: 'Pattern: retry', detail: 'retry on 503', confidence: 0.2, ref: null },
];

function baseHandler(): Handler {
  return (url: string) => {
    if (url === '/api/v1/memorycoding/capabilities') return capsOn;
    if (url.startsWith('/api/v1/memorycoding/inspector')) return jsonResponse(inspectorData);
    if (url.startsWith('/api/v1/memorycoding/continuity')) return jsonResponse({ continuity: continuityData });
    if (url.startsWith('/api/v1/memorycoding/context')) return jsonResponse({ items: contextItems });
    return jsonResponse({});
  };
}

describe('MemoryInspector (PKG-23)', () => {
  it('renders bounded records with honest summary', async () => {
    stub(baseHandler());
    render(<MemoryInspector projectId="p-1" />);
    await flush();
    expect(screen.getByTestId('mi-stats').textContent).toContain('Open bug incidents: 1');
    expect(screen.getAllByTestId('mi-pref').length).toBe(2);
    expect(screen.getAllByTestId('mi-pattern').length).toBe(1);
    expect(screen.getByTestId('mi-summary').textContent).toContain('explicit: 1');
  });

  it('filters to a category', async () => {
    stub(baseHandler());
    render(<MemoryInspector projectId="p-1" />);
    await flush();
    fireEvent.click(screen.getByTestId('mi-cat-patterns'));
    await flush();
    expect(screen.queryAllByTestId('mi-pref').length).toBe(0);
    expect(screen.getAllByTestId('mi-pattern').length).toBe(1);
  });

  it('shows feature-disabled state honestly (no fake data)', async () => {
    stub(() => jsonResponse({ featureGateEnabled: false }));
    render(<MemoryInspector projectId="p-1" />);
    await flush();
    expect(screen.getByTestId('mi-disabled').textContent).toContain('feature-gated OFF');
  });
});

describe('ProjectContinuityPanel (PKG-23)', () => {
  it('shows RESTORED status, open files, and evidence', async () => {
    stub(baseHandler());
    render(<ProjectContinuityPanel projectId="p-1" />);
    await flush();
    expect(screen.getByTestId('cont-status').textContent).toContain('RESTORED');
    expect(screen.getByTestId('cont-active-file').textContent).toContain('src/a.ts');
    expect(screen.getByTestId('cont-files').textContent).toContain('src/a.ts');
    expect(screen.getByTestId('cont-evidence').textContent).toContain('failed test: test/flaky.spec.ts');
    expect(screen.getByTestId('cont-deployments').textContent).toContain('VERIFIED');
  });

  it('shows remembered context and decisions', async () => {
    stub(baseHandler());
    render(<ProjectContinuityPanel projectId="p-1" />);
    await flush();
    expect(screen.getByTestId('cont-memories').textContent).toContain('remembered note');
    expect(screen.getByTestId('cont-decisions').textContent).toContain('Use postgres');
  });
});

describe('MemoryContextPanel (PKG-23)', () => {
  it('renders tagged EVIDENCE/MEMORY/INFERENCE items', async () => {
    stub(baseHandler());
    render(<MemoryContextPanel projectId="p-1" file="src/a.ts" />);
    await flush();
    const kinds = screen.getAllByTestId('mc-item-kind').map((e) => e.textContent);
    expect(kinds).toContain('EVIDENCE');
    expect(kinds).toContain('MEMORY');
    expect(kinds).toContain('INFERENCE');
  });

  it('shows feature-disabled state honestly', async () => {
    stub(() => jsonResponse({ featureGateEnabled: false }));
    render(<MemoryContextPanel projectId="p-1" />);
    await flush();
    expect(screen.getByTestId('mc-disabled').textContent).toContain('feature-gated OFF');
  });
});
