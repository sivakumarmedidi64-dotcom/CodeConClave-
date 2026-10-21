import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatMarkdown } from './ChatMarkdown';
import { mailtoHref, parseChart, parseEmail, safeFileName } from './RichBlocks';

const chart = JSON.stringify({ type: 'bar', title: 'Revenue by quarter', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: '2026', values: [120, 180, 240] }], unit: 'k' });

describe('rich answer blocks', () => {
  it('draws a chart from a ```chart block, with a data table on demand', async () => {
    render(<ChatMarkdown text={'Here you go:\n```chart\n' + chart + '\n```'} />);
    expect(screen.getByText('Revenue by quarter')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /bar chart of 2026/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByText('240k')).toBeInTheDocument();
  });
  it('falls back to code for an invalid chart spec', () => {
    expect(parseChart('{"type":"bar","labels":["a"],"series":[{"name":"x","values":[1,2]}]}')).toBeNull();
    render(<ChatMarkdown text={'```chart\nnot json\n```'} />);
    expect(screen.queryByTestId('chart-block')).toBeNull();
    expect(screen.getByText('not json')).toBeInTheDocument();
  });
  it('turns ```file:name into a downloadable file card', () => {
    render(<ChatMarkdown text={'```file:report.md\n# Q3 report\nAll good.\n```'} />);
    const card = screen.getByTestId('file-card');
    expect(card).toHaveTextContent('report.md');
    expect(card).toHaveTextContent('MD · ');
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });
  it('never lets a file name escape (paths, odd characters)', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName(String.raw`C:\Windows\evil.bat`)).toBe('evil.bat');
    expect(safeFileName('my <report>.md')).toBe('my -report-.md');
  });
  it('shows an email draft card — never sends', () => {
    render(<ChatMarkdown text={'```email\nTo: asha@example.com\nSubject: Launch moved to Friday\n\nHi Asha,\n\nThe launch moved to Friday.\n\nThanks\n```'} />);
    const card = screen.getByTestId('email-draft');
    expect(card).toHaveTextContent('Launch moved to Friday');
    expect(card).toHaveTextContent('not sent');
    const link = screen.getByRole('link', { name: /Open in mail app/ });
    expect(link.getAttribute('href')).toMatch(/^mailto:asha%40example\.com\?subject=Launch%20moved%20to%20Friday/);
  });
  it('parses drafts and keeps very long ones within mailto limits', () => {
    expect(parseEmail('Subject: Hi\n\nBody')).toEqual({ to: undefined, cc: undefined, subject: 'Hi', body: 'Body' });
    const long = mailtoHref({ subject: 'S', body: 'x'.repeat(5000) });
    expect(long.truncated).toBe(true);
    expect(long.href.length).toBeLessThan(400);
  });
});
