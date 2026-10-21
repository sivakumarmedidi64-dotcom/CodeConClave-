import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton';

afterEach(() => vi.unstubAllGlobals());

describe('CopyButton', () => {
  it('copies the text and confirms with "Copied"', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyButton text={() => 'hello world'} label="Copy answer" showLabel />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    expect(writeText).toHaveBeenCalledWith('hello world');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(screen.getByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    document.execCommand = vi.fn(() => false);
    render(<CopyButton text="x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument());
  });
});
