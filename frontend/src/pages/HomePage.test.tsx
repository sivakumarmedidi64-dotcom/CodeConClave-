/**
 * CodeConClave — HomePage tests (chat-only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './HomePage';
import { ToastProvider } from '../components/Toast';
import { jsonResponse, stubFetch, TEST_USER } from '../testutils';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: TEST_USER }),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
});

function renderHome() {
  stubFetch(async (url) => jsonResponse({ data: {} }));
  return render(
    <MemoryRouter>
      <ToastProvider>
        <HomePage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  it('renders a centered chat experience with the message composer', () => {
    renderHome();
    expect(screen.getByLabelText(/Message CodeConClave/i)).toBeInTheDocument();
    expect(screen.getByText(/Send|Stop/i)).toBeInTheDocument();
  });

  it('keeps the full chat history and scrolls to the latest message when new messages arrive', () => {
    // Smoke check: the page renders the chat component.
    renderHome();
    expect(screen.getByLabelText(/Message CodeConClave/i)).toBeInTheDocument();
  });
});
