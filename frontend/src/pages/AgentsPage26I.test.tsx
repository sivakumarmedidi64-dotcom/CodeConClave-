/**
 * CodeConClave — AgentsPage 26I tabs tests (Stage 26I).
 * Debate tab: list, create (agents + judge), proposals detail, approve/reject.
 * Marketplace tab: browse, install, disable/enable/update/uninstall.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { AgentsPage } from './AgentsPage';
import { jsonResponse, stubFetch } from '../testutils';

const ROLES = [
  { role: 'ARCHITECT', label: 'Architect', description: 'System design', computeClass: 'C', coding: false },
  { role: 'CODER', label: 'Coder', description: 'Implements changes', computeClass: 'B', coding: true },
];
const MODELS = [{ id: 'claude-sonnet-4', providerId: 'anthropic', label: 'Claude Sonnet', available: true, locked: false, computeClass: 'B' }];
const AGENTS = [
  { id: 'agt_1', name: 'Ship It', role: 'CODER', status: 'IDLE', trust_level: 'L2' },
  { id: 'agt_2', name: 'Guard Dog', role: 'SECURITY', status: 'IDLE', trust_level: 'L3' },
  { id: 'agt_3', name: 'Review Bot', role: 'REVIEWER', status: 'IDLE', trust_level: 'L1' },
];

const DEBATE = {
  id: 'deb_1', owner_id: 'u1', prompt: 'Should we adopt magic links?', status: 'COMPLETED',
  proposer_agent_ids: ['agt_1', 'agt_2'], judge_agent_id: 'agt_3', winner_agent_id: 'agt_1',
  rationale: 'Magic links remove password reset complexity.', max_rounds: 2, round_count: 2,
  budget_usd: 1, spent_usd: 0.2, deadline_at: '2026-08-21T00:00:00.000Z', require_approval: true,
  run_id: null, user_decision: null, error: null, completed_at: null,
  created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
};

const PENDING = { ...DEBATE, id: 'deb_2', prompt: 'Should we keep the monolith?', status: 'WAITING_FOR_APPROVAL', winner_agent_id: null, rationale: null, round_count: 1 };

const PROPOSALS = [
  {
    id: 'prp_1', debate_id: 'deb_1', owner_id: 'u1', agent_id: 'agt_1', agent_name: 'Ship It', role: 'CODER',
    model_id: null, provider_id: null, round: 1, proposal: 'Yes — fewer password flows to maintain.',
    evidence: null, risks: null, tradeoffs: null, status: 'PROPOSED', error: null, cost_usd: 0.1,
    duration_ms: 1200, created_at: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'prp_2', debate_id: 'deb_1', owner_id: 'u1', agent_id: 'agt_2', agent_name: 'Guard Dog', role: 'SECURITY',
    model_id: null, provider_id: null, round: 1, proposal: 'Risky without MFA fallback.', evidence: null,
    risks: 'Account takeover', tradeoffs: null, status: 'PROPOSED', error: null, cost_usd: 0.1,
    duration_ms: 1100, created_at: '2026-08-20T00:00:00.000Z',
  },
];

const CATALOGUE = [
  {
    id: 'cat_1', slug: 'test-driver', name: 'Test Driver', description: 'Writes and runs tests.',
    role: 'TESTER', capabilities: ['test'], declared_permissions: ['read', 'execute'],
    min_trust_level: 2, min_plan: 'free', version: '1.0.0', enabled: true,
  },
];

const INSTALLED = [
  {
    id: 'ins_1', owner_id: 'u1', catalogue_id: 'cat_1', catalogue_slug: 'test-driver', agent_id: 'agt_3',
    version: '1.0.0', status: 'INSTALLED', created_at: '2026-08-20T00:00:00.000Z',
    agent: { id: 'agt_3', name: 'Test Driver', role: 'TESTER', status: 'IDLE', trust_level: 'L2' },
    package: { name: 'Test Driver', description: 'Writes and runs tests.', capabilities: ['test'], declared_permissions: ['read'], min_trust_level: 2, min_plan: 'free', version: '1.0.0' },
  },
];

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/agents/roles')) return jsonResponse({ data: { roles: ROLES } });
    if (url.includes('/api/v1/ai/models')) return jsonResponse({ data: { models: MODELS } });
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
    if (url.includes('/api/v1/agents/debates/') && init?.method === 'POST' && url.endsWith('/decide')) {
      return jsonResponse({ data: { debate: { ...DEBATE, status: 'APPROVED', user_decision: 'APPROVED' } } });
    }
    if (url.includes('/api/v1/agents/debates/')) {
      return jsonResponse({ data: { debate: DEBATE, proposals: PROPOSALS } });
    }
    if (url.includes('/api/v1/agents/debates') && init?.method === 'POST') {
      return jsonResponse({ data: { debate: DEBATE } }, 201);
    }
    if (url.includes('/api/v1/agents/debates')) {
      return jsonResponse({ data: { debates: [DEBATE] } });
    }
    if (url.includes('/api/v1/agents/marketplace/') && init?.method === 'POST') {
      return jsonResponse({ data: { installed: INSTALLED[0] } }, 201);
    }
    if (url.includes('/api/v1/agents/marketplace')) {
      return jsonResponse({ data: { packages: CATALOGUE } });
    }
    if (url.includes('/api/v1/agents/installed/') && init?.method === 'DELETE') {
      return jsonResponse({ data: { deleted: true } });
    }
    if (url.includes('/api/v1/agents/installed/')) {
      return jsonResponse({ data: { enabled: true } });
    }
    if (url.includes('/api/v1/agents/installed')) {
      return jsonResponse({ data: { installed: INSTALLED } });
    }
    if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AgentsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentsPage — debate tab', () => {
  it('lists debates and opens proposals', async () => {
    stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Debate' }));
    expect(await screen.findByText('Should we adopt magic links?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Proposals' }));
    expect(await screen.findByText(/Yes — fewer password flows/)).toBeInTheDocument();
    expect(screen.getByText(/Risky without MFA fallback/)).toBeInTheDocument();
  });

  it('creates a debate with proposers and a judge', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Debate' }));
    await userEvent.click(await screen.findByRole('button', { name: '+ New debate' }));
    await userEvent.type(await screen.findByLabelText('Question / decision to debate'), 'Monolith or microservices?');
    await userEvent.click(screen.getByRole('button', { name: 'Ship It' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guard Dog' }));
    await userEvent.selectOptions(await screen.findByLabelText('Judge agent'), 'agt_3');
    await userEvent.click(screen.getByRole('button', { name: 'Start debate' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents/debates'), expect.objectContaining({ method: 'POST' })));
  });

  it('approves a debate waiting for approval', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/agents/roles')) return jsonResponse({ data: { roles: ROLES } });
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ data: { models: MODELS } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/agents/debates/') && init?.method === 'POST' && url.endsWith('/decide')) {
        return jsonResponse({ data: { debate: { ...PENDING, status: 'APPROVED', user_decision: 'APPROVED' } } });
      }
      if (url.includes('/api/v1/agents/debates/')) {
        return jsonResponse({ data: { debate: PENDING, proposals: PROPOSALS } });
      }
      if (url.includes('/api/v1/agents/debates')) {
        return jsonResponse({ data: { debates: [PENDING] } });
      }
      if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Debate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents/debates/deb_2/decide'), expect.objectContaining({ method: 'POST' })));
  });
});

describe('AgentsPage — marketplace tab', () => {
  it('browses catalogue and shows declared permissions', async () => {
    stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Marketplace' }));
    expect(await screen.findByText('Test Driver')).toBeInTheDocument();
    expect(screen.getByText(/Requires trust 2/)).toBeInTheDocument();
  });

  it('installs a package as an agent', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/agents/roles')) return jsonResponse({ data: { roles: ROLES } });
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ data: { models: MODELS } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/agents/marketplace/') && init?.method === 'POST') {
        return jsonResponse({ data: { installed: INSTALLED[0] } }, 201);
      }
      if (url.includes('/api/v1/agents/marketplace')) return jsonResponse({ data: { packages: CATALOGUE } });
      if (url.includes('/api/v1/agents/installed')) return jsonResponse({ data: { installed: [] } });
      if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Marketplace' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents/marketplace/cat_1/install'), expect.objectContaining({ method: 'POST' })));
  });

  it('disables and uninstalls an installed agent', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Marketplace' }));
    expect(await screen.findByText('Installed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents/installed/ins_1/disable'), expect.objectContaining({ method: 'POST' })));
    await userEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents/installed/ins_1'), expect.objectContaining({ method: 'DELETE' })));
  });
});