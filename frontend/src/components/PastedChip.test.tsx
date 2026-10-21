import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PastedChip, UserMessageContent } from './PastedChip';
import { detectPaste, serializePasted } from '../lib/paste';

const csv = Array.from({ length: 20 }, (_, i) => `row${i},${i * 2}`).join('\n');

describe('PastedChip', () => {
  it('labels the paste and expands to show it', async () => {
    const onRemove = vi.fn();
    render(<PastedChip info={detectPaste(csv)} text={csv} onRemove={onRemove} />);
    expect(screen.getByText('Pasted · CSV · 20 lines')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/row19,38/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove pasted content' }));
    expect(onRemove).toHaveBeenCalled();
  });
  it('a sent message shows typed text and the paste as a chip', () => {
    render(<UserMessageContent content={`What is the trend?\n\n${serializePasted([{ id: 'p', text: csv, ...detectPaste(csv) }])}`} />);
    expect(screen.getByText('What is the trend?')).toBeInTheDocument();
    expect(screen.getByText('Pasted · CSV · 20 lines')).toBeInTheDocument();
  });
});
