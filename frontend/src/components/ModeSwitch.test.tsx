import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AGENT_MODE, CHAT_MODE, ModeSwitch } from './ModeSwitch';

describe('ModeSwitch', () => {
  it('marks the selected mode, switches on click and shows its hint', async () => {
    const onChange = vi.fn();
    render(<ModeSwitch label="Mode" value="AGENT" options={[CHAT_MODE, AGENT_MODE]} onChange={onChange} showHint />);
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/Local Agent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(onChange).toHaveBeenCalledWith('CHAT');
  });

  it('moves with arrow keys and wraps around', async () => {
    const onChange = vi.fn();
    render(<ModeSwitch label="Mode" value="CHAT" options={[CHAT_MODE, AGENT_MODE]} onChange={onChange} />);
    screen.getByRole('button', { name: 'Chat' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('AGENT');
    // Left from the first mode wraps around to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('AGENT');
  });
});
