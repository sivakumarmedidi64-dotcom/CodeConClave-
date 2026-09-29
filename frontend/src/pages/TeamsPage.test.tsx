/**
 * CodeConClave — TeamsPage tests.
 * The 30-person team limit is server-enforced (team_member_limit), so the UI
 * must state it where invites happen — users should never discover the cap
 * by hitting a surprise error on invite #31.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { TeamsPage } from './TeamsPage';
import { jsonResponse, stubFetch, authed } from '../testutils';

const TEAM = {
  id: 't1',
  owner_id: 'u1',
  name: 'Acme',
  description: null,
  archived_at: null,
  settings: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function teamsHandler() {
  return authed(async (url: string) => {
    if (url === '/api/v1/teams') return jsonResponse({ data: { teams: [TEAM] } });
    if (url === '/api/v1/teams/t1/members') {
      return jsonResponse({
        data: {
          members: [
            {
              id: 'm1', team_id: 't1', user_id: 'u1', role: 'owner', status: 'ACTIVE',
              invited_by: null, joined_at: '2026-01-01T00:00:00.000Z',
              email: 'alice@example.com', display_name: 'Alice',
            },
          ],
        },
      });
    }
    if (url === '/api/v1/teams/t1/invitations') return jsonResponse({ data: { invitations: [] } });
    if (url === '/api/v1/teams/t1/projects') return jsonResponse({ data: { projects: [] } });
    if (url === '/api/v1/teams/t1/conversations') return jsonResponse({ data: { conversations: [] } });
    if (url === '/api/v1/teams/t1/activity') return jsonResponse({ data: { activity: [] } });
    if (url === '/api/v1/dna/team/t1') return jsonResponse({ data: { blocks: [] } });
    if (url === '/api/v1/teams/t1/stats') {
      return jsonResponse({ data: { members: 1, projects: 0, pendingInvitations: 0, activities: 0 } });
    }
    if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [] } });
    if (url.includes('/api/v1/teamcollab/')) {
      return jsonResponse({ data: { presence: [], onlineCount: 0, items: [], entries: [], skills: [] } });
    }
    return jsonResponse({ data: {} });
  });
}

function renderTeams() {
  return render(
    <MemoryRouter initialEntries={['/teams']}>
      <AuthProvider>
        <ToastProvider>
          <TeamsPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('TeamsPage — member limit disclosure', () => {
  it('states the 30-person cap next to the invite controls', async () => {
    stubFetch(teamsHandler());
    renderTeams();
    await waitFor(() => expect(screen.getByPlaceholderText('member@email.com')).toBeInTheDocument());
    expect(screen.getByText(/up to 30 people \(members \+ pending invites\)/)).toBeInTheDocument();
  });
});
