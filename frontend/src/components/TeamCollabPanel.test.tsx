/**
 * CodeConClave — PKG-11 TeamCollabPanel component tests.
 * Verifies the panel renders only server-confirmed collaboration state
 * (presence, queue, shared context, visible skills) and never fabricates
 * realtime or private data. Loading/error/empty states covered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TeamCollabPanel } from './TeamCollabPanel';
import { jsonResponse, stubFetch } from '../testutils';

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('TeamCollabPanel', () => {
  it('renders honest presence state and online count from the backend', async () => {
    stubFetch((url) => {
      if (url.includes('/presence'))
        return Promise.resolve(
          jsonResponse({
            data: {
              presence: [
                { userId: 'u1', state: 'ONLINE', at: 1 },
                { userId: 'u2', state: 'BUSY', at: 2 },
                { userId: 'u3', state: 'OFFLINE', at: 3 },
              ],
              onlineCount: 2,
            },
          }),
        );
      if (url.includes('/queue')) return Promise.resolve(jsonResponse({ data: { items: [{ id: 'q1', title: 'ship x', status: 'IN_PROGRESS', assigneeId: 'u2', createdAt: 1, updatedAt: 2 }] } }));
      if (url.includes('/context')) return Promise.resolve(jsonResponse({ data: { entries: [{ id: 'c1', title: 'Decision', body: 'go green', authorUserId: 'u1', createdAt: 1, scope: 'SHARED' }] } }));
      if (url.includes('/skills')) return Promise.resolve(jsonResponse({ data: { skills: [{ id: 's1', name: 'Rust', visible: true }] } }));
      return Promise.resolve(jsonResponse({ data: {} }));
    });
    render(<TeamCollabPanel teamId="team1" />);
    await waitFor(() => expect(screen.getByText('Rust')).toBeTruthy());
    expect(screen.getByText(/u1/)).toBeTruthy();
    expect(screen.getByText('online')).toBeTruthy();
    expect(screen.getByText('Online: 2')).toBeTruthy();
    expect(screen.getByText('ship x')).toBeTruthy();
    expect(screen.getByText('IN_PROGRESS')).toBeTruthy();
    expect(screen.getByText('Decision')).toBeTruthy();
  });

  it('reflects empty state honestly (no members, no work)', async () => {
    stubFetch((url) => {
      if (url.includes('/presence')) return Promise.resolve(jsonResponse({ data: { presence: [], onlineCount: 0 } }));
      if (url.includes('/queue')) return Promise.resolve(jsonResponse({ data: { items: [] } }));
      if (url.includes('/context')) return Promise.resolve(jsonResponse({ data: { entries: [] } }));
      if (url.includes('/skills')) return Promise.resolve(jsonResponse({ data: { skills: [] } }));
      return Promise.resolve(jsonResponse({ data: {} }));
    });
    render(<TeamCollabPanel teamId="team1" />);
    await waitFor(() => expect(screen.getByText('No members online.')).toBeTruthy());
    expect(screen.getByText('No queued work.')).toBeTruthy();
    expect(screen.getByText('No shared context.')).toBeTruthy();
    expect(screen.getByText('No visible skills.')).toBeTruthy();
  });

  it('shows an error state when the backend cannot be reached', async () => {
    stubFetch(() => Promise.reject(new Error('network down')));
    render(<TeamCollabPanel teamId="team1" />);
    await waitFor(() => expect(screen.getByText('Could not load collaboration state.')).toBeTruthy());
  });

  it('queries all four server-confirmed endpoints for the selected team', async () => {
    const fn = stubFetch((url) => {
      if (url.includes('/presence')) return Promise.resolve(jsonResponse({ data: { presence: [], onlineCount: 0 } }));
      if (url.includes('/queue')) return Promise.resolve(jsonResponse({ data: { items: [] } }));
      if (url.includes('/context')) return Promise.resolve(jsonResponse({ data: { entries: [] } }));
      if (url.includes('/skills')) return Promise.resolve(jsonResponse({ data: { skills: [] } }));
      return Promise.resolve(jsonResponse({ data: {} }));
    });
    render(<TeamCollabPanel teamId="team-9" />);
    await waitFor(() => expect(screen.getByText('No members online.')).toBeTruthy());
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/v1/teamcollab/team-9/presence'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v1/teamcollab/team-9/queue'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v1/teamcollab/team-9/context'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v1/teamcollab/team-9/skills'))).toBe(true);
  });
});
