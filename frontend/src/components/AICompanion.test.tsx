/**
 * CodeConClave — AICompanion behavior: the presence must announce the REAL
 * state (never animate work that is not happening) and stay cheap (no rAF
 * loop) while respecting prefers-reduced-motion.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AICompanion, type CompanionState } from './AICompanion';

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const EXPECTED_TEXT: Record<CompanionState, string> = {
  idle: 'AI companion idle',
  thinking: 'AI is thinking',
  working: 'AI is working',
  waiting: 'AI is waiting for input',
  approval: 'AI is waiting for approval',
  done: 'AI completed the task',
  error: 'AI encountered an error',
};

describe('AICompanion', () => {
  it('announces every state as a live status with a text equivalent', () => {
    mockMatchMedia(false);
    for (const [state, text] of Object.entries(EXPECTED_TEXT) as [CompanionState, string][]) {
      const { unmount } = render(<AICompanion state={state} />);
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-label', text);
      expect(status).toHaveAttribute('data-state', state);
      expect(status.textContent).toContain(text);
      unmount();
    }
  });

  it('exposes state on the element so animation is never the only signal', () => {
    mockMatchMedia(false);
    render(<AICompanion state="approval" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'approval');
  });

  it('renders no perpetual JS motion handles (CSS-only float)', () => {
    mockMatchMedia(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { unmount } = render(<AICompanion state="working" />);
    expect(raf).not.toHaveBeenCalled();
    unmount();
  });

  it('disables motion under prefers-reduced-motion', () => {
    mockMatchMedia(true);
    render(<AICompanion state="working" />);
    expect(screen.getByRole('status').className).toContain('cc-ai-companion--static');
  });
});
