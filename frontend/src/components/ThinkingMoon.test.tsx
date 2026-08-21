/**
 * CodeConClave — ThinkingMoon tests (PHASE 12).
 * Rendered only while a generation is active; crescent + sr-only status;
 * reduced intensity while streaming; animation paused while the tab is
 * hidden; static variant under prefers-reduced-motion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ThinkingMoon } from './ThinkingMoon';

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }));
}

function stubVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('ThinkingMoon', () => {
  it('renders nothing when inactive', () => {
    stubReducedMotion(false);
    const { container } = render(<ThinkingMoon active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the crescent and sr-only status while active', () => {
    stubReducedMotion(false);
    const { container } = render(<ThinkingMoon active />);
    expect(container.querySelector('.cc-moon--think')).not.toBeNull();
    expect(screen.getByText('CodeConClave is thinking')).toBeInTheDocument();
  });

  it('uses the static variant when the user prefers reduced motion', () => {
    stubReducedMotion(true);
    const { container } = render(<ThinkingMoon active />);
    expect(container.querySelector('.cc-moon--think--static')).not.toBeNull();
  });

  it('reduces intensity once the response is streaming', () => {
    stubReducedMotion(false);
    const { container } = render(<ThinkingMoon active streaming />);
    expect(container.querySelector('.cc-moon--think--streaming')).not.toBeNull();
  });

  it('pauses the animation while the tab is hidden and resumes when visible', () => {
    stubReducedMotion(false);
    const { container } = render(<ThinkingMoon active />);
    stubVisibility('hidden');
    expect(container.querySelector('.cc-moon--think--paused')).not.toBeNull();
    stubVisibility('visible');
    expect(container.querySelector('.cc-moon--think--paused')).toBeNull();
  });

  it('exposes the status to assistive tech via aria-live', () => {
    stubReducedMotion(false);
    render(<ThinkingMoon active label="Working" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Working')).toBeInTheDocument();
  });
});