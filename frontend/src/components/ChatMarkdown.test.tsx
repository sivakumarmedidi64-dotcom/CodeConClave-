/**
 * CodeConclave — ChatMarkdown tests.
 *
 * Pins: structure renders (code fence stays unparsed, headings/lists/bold/
 * links appear), hostile input is escaped (script never executes, non-http
 * links stay text), and unrecognized input stays readable.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMarkdown } from './ChatMarkdown';

describe('ChatMarkdown', () => {
  it('renders headings, bold, lists and links', () => {
    render(
      <ChatMarkdown
        text={'## Plan\n**Bold step** and *italic*\n- one\n- two\n1. first\n[docs](https://example.com/x)'}
      />,
    );
    expect(screen.getByText('Plan').tagName).toBe('H5');
    expect(screen.getByText('Bold step').tagName).toBe('STRONG');
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('docs')).toHaveAttribute('href', 'https://example.com/x');
  });

  it('keeps fenced code unparsed with a copy affordance', () => {
    render(<ChatMarkdown text={'run this:\n```ts\nconst **x** = 1;\n```\ndone'} />);
    expect(screen.getByText('const **x** = 1;')).toBeInTheDocument();
    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.getByText('ts')).toBeInTheDocument();
  });

  it('escapes hostile input and refuses non-http links', () => {
    const { container } = render(
      <ChatMarkdown text={'<script>alert(1)</script>\n[evil](javascript:alert(1))'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('[evil](javascript:alert(1))');
  });

  it('renders quotes and inline code', () => {
    render(<ChatMarkdown text={'> remember this\nuse `npm test` here'} />);
    expect(screen.getByText('remember this').tagName).toBe('BLOCKQUOTE');
    expect(screen.getByText('npm test').tagName).toBe('CODE');
  });
});
