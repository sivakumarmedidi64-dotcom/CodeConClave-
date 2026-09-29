/**
 * CodeConClave — ChatMessage disclosure behavior: execution details expand
 * through an accessible button/region pair, and an external `expanded`
 * change is followed instead of going stale.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatMessage } from './ChatMessage';

const DETAILS = { what: 'Created project Corder', checked: 'Tests 12/12 passed', evidence: 'suite.log' };

describe('ChatMessage', () => {
  it('toggles execution details with an annotated disclosure button', () => {
    render(
      <ChatMessage
        message={{ key: 'a1', role: 'assistant', content: 'done' }}
        showExpandable
        executionPhase="Verifying"
        executionDetails={DETAILS}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Show details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: 'Execution details' });
    expect(region.textContent).toContain('Created project Corder');
    expect(region.textContent).toContain('Tests 12/12 passed');
    expect(region.textContent).toContain('Verifying');
  });

  it('follows an external expanded change after first render', () => {
    const { rerender } = render(
      <ChatMessage
        message={{ key: 'a1', role: 'assistant', content: 'done' }}
        showExpandable
        expanded={false}
        executionDetails={DETAILS}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Execution details' })).not.toBeInTheDocument();
    rerender(
      <ChatMessage
        message={{ key: 'a1', role: 'assistant', content: 'done' }}
        showExpandable
        expanded
        executionDetails={DETAILS}
      />,
    );
    expect(screen.getByRole('region', { name: 'Execution details' })).toBeInTheDocument();
  });

  it('renders nothing expandable when no execution details exist', () => {
    render(<ChatMessage message={{ key: 'a1', role: 'assistant', content: 'hello' }} showExpandable />);
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
  });
});
