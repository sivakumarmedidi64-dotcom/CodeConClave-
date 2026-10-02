/**
 * CodeConClave — DataPage tests (PHASE 13).
 * Persisted counts, retention, honest backup state, cleanup recommendations
 * (explicit resolve/dismiss only — never auto-applied) and activity feed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { DataPage } from './DataPage';
import { jsonResponse, stubFetch } from '../testutils';

const REPORT = {
  provider: { mode: 'LOCAL_STORAGE', encryptionAtRest: true, healthy: true, lastHealthCheckAt: null },
  quota: { plan: 'free', limitBytes: 2e9, usedBytes: 1e8, usedMb: 95.4, limitMb: 1907, percent: 5, overLimit: false },
  storage: { fileCount: 3, trashedCount: 1, versionCount: 4, folderCount: 1, totalBytes: 1e8, encryptionEnabled: true },
  projectAllocation: [],
  memories: { count: 0 },
  tasks: { count: 0 },
  artifacts: { count: 0, bytes: 0 },
  activity: [],
  cleanupCandidates: [],
  retentionDays: 30,
  counts: {
    conversations: 2,
    messages: 10,
    memories: 0,
    dna: 1,
    dnaVersions: 2,
    tasks: 0,
    artifacts: 0,
    projects: 1,
    teams: 0,
    notifications: 3,
    auditEvents: 40,
    ideas: 5,
    brainstormSessions: 1,
  },
  retention: { trashDays: 30, ideaRetentionDays: 365, notificationDays: 90 },
  recommendations: [
    {
      id: 'cln_1',
      candidateType: 'duplicate_files',
      reason: '2 file(s) share content',
      storageImpactBytes: 2048,
      affected: [{ id: 'fil_2', name: '/b.txt' }],
      reversible: false,
      authorizationLevel: 'owner',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
    },
  ],
  recommendationsByStatus: { active: 1, resolved: 0, dismissed: 0 },
  backup: { available: false, note: 'No backup provider is configured in this environment; nothing claims otherwise.' },
};

const ACTIVITY = [
  { id: 'pa:p1', source: 'project_activity', action: 'project.created', actorUserId: 'u1', projectId: 'prj_1', teamId: null, resourceType: 'project', resourceId: 'prj_1', summary: 'project.created', createdAt: '2026-01-01T00:00:00.000Z' },
];

function renderData() {
  return render(
    <ToastProvider>
      <DataPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('DataPage', () => {
  it('shows entity counts, retention and honest backup state', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/data-centre')) return jsonResponse({ data: REPORT });
      if (url.includes('/api/v1/activity')) return jsonResponse({ data: { events: ACTIVITY } });
      return jsonResponse({ data: {} });
    });
    renderData();
    await waitFor(() => expect(screen.getByText('Ideas')).toBeInTheDocument());
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText(/not configured/)).toBeInTheDocument();
  });

  it('resolves a recommendation explicitly and never auto-applies', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/cleanup/cln_1/resolve') && init?.method === 'POST') {
        return jsonResponse({
          data: { recommendation: { ...REPORT.recommendations[0]!, status: 'RESOLVED', resolvedAt: '2026-01-02T00:00:00.000Z' } },
        });
      }
      if (url.includes('/api/v1/data-centre')) return jsonResponse({ data: REPORT });
      if (url.includes('/api/v1/activity')) return jsonResponse({ data: { events: ACTIVITY } });
      return jsonResponse({ data: {} });
    });
    renderData();
    await userEvent.click(await screen.findByText('Mark resolved'));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/cln_1/resolve') && i?.method === 'POST')).toBe(true));
    expect(screen.getByText(/never applied automatically/)).toBeInTheDocument();
  });

  it('regenerates recommendations on demand', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/cleanup/generate') && init?.method === 'POST') {
        return jsonResponse({ data: { recommendations: [], generated: 0 } });
      }
      if (url.includes('/api/v1/data-centre')) return jsonResponse({ data: REPORT });
      if (url.includes('/api/v1/activity')) return jsonResponse({ data: { events: ACTIVITY } });
      return jsonResponse({ data: {} });
    });
    renderData();
    await userEvent.click(await screen.findByText('Re-scan for cleanup candidates'));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/cleanup/generate') && i?.method === 'POST')).toBe(true));
  });

  it('renders the recent activity feed', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/data-centre')) return jsonResponse({ data: REPORT });
      if (url.includes('/api/v1/activity')) return jsonResponse({ data: { events: ACTIVITY } });
      return jsonResponse({ data: {} });
    });
    renderData();
    await waitFor(() => expect(screen.getByText('project.created')).toBeInTheDocument());
  });
});