/**
 * CodeConClave — MemoryPage explorer tab tests (Stage 26I).
 * Decision replay + record, conflict detect + resolve, continuity
 * (opt-in, handoff generate/save, timeline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { MemoryPage } from './MemoryPage';
import { jsonResponse, stubFetch } from '../testutils';

const DECISION = {
  id: 'dec_1', owner_id: 'u1', project_id: null, title: 'Postgres for billing',
  decision: 'Use Postgres for the billing service.', context: null, alternatives: ['MySQL', 'DynamoDB'],
  rationale: 'Transactions and ACID guarantees.', consequences: [], source_conversation_id: null,
  source_task_id: null, evidence_ref: null, impact: 'HIGH', status: 'ACTIVE',
  source_message_ids: ['m1'], scope: 'PROJECT', superseded_by_id: null,
  deleted_at: null, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
};

const CONFLICT = {
  id: 'cf_1', owner_id: 'u1', decision_id: 'dec_1', request_text: 'move billing to DynamoDB',
  status: 'OPEN', resolution: null, note: null, new_decision_id: null, resolved_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
};

const HANDOFF = {
  id: 'hd_1', owner_id: 'u1', project_id: null, title: 'Main app — handoff',
  content: '# Main app — handoff\nGenerated 2026-08-20T00:00:00.000Z — state is read from live records.',
  created_at: '2026-08-20T00:00:00.000Z',
};

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/memory') && init?.method === 'POST') {
      if (url.includes('/handoffs')) return jsonResponse({ data: { handoff: HANDOFF } }, 201);
      if (url.includes('/decisions/replay')) return jsonResponse({ data: { outcome: 'FOUND', decision: DECISION } });
      if (url.includes('/conflicts/detect')) return jsonResponse({ data: { conflicts: [] } });
      if (url.includes('/conflicts/')) return jsonResponse({ data: { conflict: { ...CONFLICT, status: 'RESOLVED', resolution: 'KEEP' } } });
      return jsonResponse({ data: { decision: DECISION } }, 201);
    }
    if (url.includes('/api/v1/memory/decisions') && url.includes('/status') && init?.method === 'PATCH') {
      return jsonResponse({ data: { decision: { ...DECISION, status: 'REJECTED' } } });
    }
    if (url.includes('/api/v1/memory/decisions') && url.includes('/sources')) {
      return jsonResponse({ data: { sources: [{ id: 'm1', content: 'let us use postgres', createdAt: '2026-08-19T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/memory/decisions/conflicts')) return jsonResponse({ data: { conflicts: [CONFLICT] } });
    if (url.includes('/api/v1/memory/decisions')) return jsonResponse({ data: { decisions: [DECISION] } });
    if (url.includes('/api/v1/memory/cross-project/opt-in')) return jsonResponse({ data: { optIn: false } });
    if (url.includes('/api/v1/memory/cross-project/patterns/suggest')) {
      return jsonResponse({ data: { suggestions: [], optIn: false } });
    }
    if (url.includes('/api/v1/memory/handoffs/generate')) {
      return jsonResponse({ data: { title: 'Main app — handoff', content: '# Main app — handoff\nGenerated from live state.' } });
    }
    if (url.includes('/api/v1/memory/handoffs')) return jsonResponse({ data: { handoffs: [HANDOFF] } });
    if (url.includes('/api/v1/memory/timeline')) {
      return jsonResponse({ data: { items: [{ type: 'task', id: 'tsk_1', title: 'Ship checkout', detail: 'status COMPLETED', at: '2026-08-20T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'Main app' }] } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <MemoryPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('MemoryPage — explorer: decisions', () => {
  it('lists recorded decisions with impact and rationale', async () => {
    stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    expect(await screen.findByText('Postgres for billing')).toBeInTheDocument();
    expect(screen.getByText('Use Postgres for the billing service.')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('replays a decision query', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.type(await screen.findByLabelText('Replay query'), 'why postgres billing');
    await userEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions/replay'), expect.objectContaining({ method: 'POST' })));
  });

  it('records a decision', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.type(await screen.findByLabelText('Title'), 'Redis for cache');
    await userEvent.type(await screen.findByLabelText('What was decided and why'), 'Use Redis as the shared cache.');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions'), expect.objectContaining({ method: 'POST' })));
  });
});

describe('MemoryPage — explorer: decision lifecycle (continuity)', () => {
  it('shows status + scope pills and filters by status through the API', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    expect(await screen.findByText('Postgres for billing')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('PROJECT')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'active' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions?status=ACTIVE'), expect.anything()),
    );
  });

  it('rejects a decision via the status endpoint and reloads', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/memory/decisions/dec_1/status'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const call = fetchFn.mock.calls.find(([u]) => String(u).includes('/dec_1/status'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ status: 'REJECTED' });
  });

  it('loads and shows the exact source messages behind a decision', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('button', { name: /Show source messages \(1\)/ }));
    expect(await screen.findByText(/let us use postgres/)).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions/dec_1/sources'), expect.anything());
  });

  it('exports the recorded decisions as CodeConClave decision.md', async () => {
    const createObjectURL = vi.fn(() => 'blob:decision');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export decision.md' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    const firstCall = createObjectURL.mock.calls[0] as unknown as [Blob];
    expect(firstCall[0].type).toContain('markdown');
    click.mockRestore();
  });
});

describe('MemoryPage — explorer: conflicts', () => {
  it('lists open conflicts and resolves them', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Conflicts' }));
    expect(await screen.findByText(/move billing to DynamoDB/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep decision' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions/conflicts/cf_1/resolve'), expect.objectContaining({ method: 'POST' })));
  });

  it('detects conflicts for a request text', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Conflicts' }));
    await userEvent.type(await screen.findByLabelText('Request to check'), 'rewrite billing');
    await userEvent.click(screen.getByRole('button', { name: 'Detect' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/decisions/conflicts/detect'), expect.objectContaining({ method: 'POST' })));
  });
});

describe('MemoryPage — explorer: continuity', () => {
  it('generates and saves a handoff, and shows the timeline', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Continuity' }));
    expect(await screen.findByText('Main app — handoff')).toBeInTheDocument();
    expect(screen.getByText('task')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+ Generate handoff' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/memory/handoffs/generate'), expect.objectContaining({ method: 'GET' })));
  });

  it('never renders a saved handoff twice when the list already contains it', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      stubFetch(handler());
      renderPage();
      await userEvent.click(await screen.findByRole('tab', { name: 'Explorer' }));
      await userEvent.click(await screen.findByRole('tab', { name: 'Continuity' }));
      // The fixture list already contains hd_1, and the save endpoint echoes
      // the same hd_1 back — the UI must replace by id, not duplicate.
      await userEvent.click(screen.getByRole('button', { name: '+ Generate handoff' }));
      await waitFor(() =>
        expect(screen.getAllByText('Main app — handoff').length).toBeGreaterThan(0),
      );
      await waitFor(() => {
        expect(screen.getAllByText('Main app — handoff')).toHaveLength(1);
      });
      expect(errors.some((a) => String((a as unknown[])[0] ?? '').includes('same key'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});