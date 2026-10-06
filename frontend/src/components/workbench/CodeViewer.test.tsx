/**
 * CodeConClave — CodeViewer tests.
 * Real content renders with line numbers and highlight spans; binary payloads
 * get an honest refusal; in-file search reports a real match count.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeViewer } from './CodeViewer';

describe('CodeViewer', () => {
  it('renders the file name and numbered source lines', () => {
    render(<CodeViewer path="src/app.ts" content={'const x = 1;\nreturn x;'} />);
    expect(screen.getByTestId('code-filename')).toHaveTextContent('app.ts');
    expect(screen.getByText(/2 lines/)).toBeInTheDocument();
    const body = screen.getByTestId('code-body');
    expect(body.textContent).toContain('const');
    expect(body.querySelectorAll('.wb-code__line')).toHaveLength(2);
    expect(body.querySelectorAll('.wb-hl--keyword').length).toBeGreaterThan(0);
  });

  it('refuses binary content honestly', () => {
    render(<CodeViewer path="logo.png" content={null} binary />);
    expect(screen.getByTestId('code-binary')).toHaveTextContent('not text');
  });

  it('counts in-file search matches', () => {
    render(<CodeViewer path="a.ts" content={'foo\nbar\nfoo bar'} />);
    fireEvent.change(screen.getByLabelText('Search in file'), { target: { value: 'foo' } });
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });
});