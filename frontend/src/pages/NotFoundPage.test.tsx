/**
 * CodeConClave — NotFoundPage tests (PHASE 11).
 * 404 page renders inside the shell with a link home.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('renders a clear 404 message and a link back home', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('404 — page not found')).toBeInTheDocument();
    expect(screen.getByText('Back to Home').closest('a')).toHaveAttribute('href', '/home');
  });
});