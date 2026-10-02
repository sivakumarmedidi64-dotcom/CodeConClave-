/**
 * CodeConClave — ThemeToggle tests (PHASE 11, reassigned for the single
 * premium dark theme). The app ships one dark theme only; the control is a
 * status indicator communicating the locked dark identity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('renders the single premium dark theme indicator', async () => {
    render(<ThemeToggle />);
    expect(screen.getByLabelText('Dark theme')).toBeInTheDocument();
    expect(screen.getByText('Dark')).toBeInTheDocument();
  });
});