import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionsPage } from './SessionsPage';
import { jsonResponse, stubFetch } from '../testutils';

const conv = (id: string, title: string, updatedAt: string) => ({
  id, projectId: null, title, mode: 'CHAT', archived: false, favorite: false, tags: [], sharing: {},
  createdAt: updatedAt, updatedAt, deletedAt: null,
});

beforeEach(() => vi.unstubAllGlobals());

describe('SessionsPage', () => {
  it('groups chats by day and links into the chat', async () => {
    const now = new Date().toISOString();
    stubFetch(async () => jsonResponse({ data: { conversations: [conv('c1', 'Landing page', now), conv('c2', 'Old idea', '2020-01-01T00:00:00.000Z')] } }));
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    expect(await screen.findByRole('region', { name: 'Today' })).toHaveTextContent('Landing page');
    expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent('Old idea');
    expect(screen.getByRole('link', { name: /Landing page/ })).toHaveAttribute('href', '/chat?c=c1');
  });

  it('searches on the server', async () => {
    const fetchFn = stubFetch(async (url) =>
      url.includes('/search') ? jsonResponse({ data: { conversations: [conv('c9', 'Postgres tuning', new Date().toISOString())] } }) : jsonResponse({ data: { conversations: [] } }),
    );
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Search your chats'), 'postgres');
    expect(await screen.findByText('Postgres tuning')).toBeInTheDocument();
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/v1/conversations/search?q=postgres'))).toBe(true);
  });
});
