/**
 * CodeConClave — DiffViewer tests.
 * Parses the REAL unified-diff format and renders per-file stats + hunks.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffViewer } from './DiffViewer';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1..2 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
].join('\n');

describe('DiffViewer', () => {
  it('shows the empty label when there is no diff', () => {
    render(<DiffViewer diffText="" emptyLabel="No review diff for this task yet." />);
    expect(screen.getByTestId('diff-empty')).toHaveTextContent('No review diff');
  });

  it('renders file path and add/del stats from real content', () => {
    render(<DiffViewer diffText={DIFF} />);
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('renders hunk lines (first hunk expanded by default)', () => {
    render(<DiffViewer diffText={DIFF} />);
    expect(screen.getByTestId('diff-line-add')).toHaveTextContent('const y = 3;');
    expect(screen.getByTestId('diff-line-del')).toHaveTextContent('const y = 2;');
  });
});