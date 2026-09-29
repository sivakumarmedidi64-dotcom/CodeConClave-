/**
 * CodeConClave — ShortcutsHelp tests: renders the canonical shortcuts,
 * closes on Close and on backdrop click.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShortcutsHelp } from './ShortcutsHelp';

describe('ShortcutsHelp', () => {
  it('renders the shortcut list and closes on the Close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShortcutsHelp onClose={onClose} />);
    expect(screen.getByLabelText('Keyboard shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Open command palette')).toBeInTheDocument();
    expect(screen.getByText('Stop the active stream')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the dimmed backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<ShortcutsHelp onClose={onClose} />);
    await user.click(container.querySelector('.cc-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });
});