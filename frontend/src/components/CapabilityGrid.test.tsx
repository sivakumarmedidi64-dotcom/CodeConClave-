import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CAPABILITIES, CapabilityGrid, MistakesNote } from './CapabilityGrid';

describe('CapabilityGrid', () => {
  it('lists what CodeConClave can do and fills the composer on click', async () => {
    const onPick = vi.fn();
    render(<CapabilityGrid onPick={onPick} />);
    expect(screen.getAllByRole('button')).toHaveLength(CAPABILITIES.length);
    await userEvent.click(screen.getByRole('button', { name: /Writing and editing/ }));
    expect(onPick).toHaveBeenCalledWith(expect.stringMatching(/Draft a short, friendly email/));
  });
  it('says it can make mistakes and that risky actions ask first', () => {
    render(<MistakesNote />);
    expect(screen.getByTestId('mistakes-note')).toHaveTextContent(/can make mistakes.*always asks you first/);
  });
});
