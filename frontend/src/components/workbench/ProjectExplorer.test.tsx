/**
 * CodeConClave — ProjectExplorer tests.
 * Renders the real tree payload, expands folders, selects files and overlays
 * change status derived from real review data.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectExplorer, type FileChangeStatus } from './ProjectExplorer';
import type { FileTreeNode } from '../../lib/types';

const TREE: FileTreeNode[] = [
  {
    path: 'src',
    name: 'src',
    type: 'folder',
    children: [
      { path: 'src/app.ts', name: 'app.ts', type: 'file', file: { id: 'f1', path: 'src/app.ts' } } as unknown as FileTreeNode,
    ],
  },
  { path: 'README.md', name: 'README.md', type: 'file', file: { id: 'f2', path: 'README.md' } } as unknown as FileTreeNode,
];

function setup(overrides: Partial<Parameters<typeof ProjectExplorer>[0]> = {}) {
  const onSelect = vi.fn();
  const onReload = vi.fn();
  const onFilterChange = vi.fn();
  render(
    <ProjectExplorer
      projectId="project-12345678"
      tree={TREE}
      selectedPath={null}
      statuses={new Map<string, FileChangeStatus>()}
      loading={false}
      error={null}
      filter=""
      onFilterChange={onFilterChange}
      onSelect={onSelect}
      onReload={onReload}
      {...overrides}
    />,
  );
  return { onSelect, onReload, onFilterChange };
}

describe('ProjectExplorer', () => {
  it('expands folders by default and selects a file', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText('app.ts'));
    expect(onSelect).toHaveBeenCalledWith({ id: 'f1', path: 'src/app.ts' });
  });

  it('draws a change chip only when status data is present', () => {
    setup({ statuses: new Map([['src/app.ts', 'modified']]) });
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('shows the empty state for projects with no files', () => {
    setup({ tree: [] });
    expect(screen.getByText(/No files in this project/)).toBeInTheDocument();
  });

  it('surfaces load errors honestly', () => {
    setup({ tree: [], error: 'boom' });
    expect(screen.getByTestId('explorer-error')).toHaveTextContent('boom');
  });

  it('invokes reload from the toolbar', () => {
    const { onReload } = setup();
    fireEvent.click(screen.getByLabelText('Reload files'));
    expect(onReload).toHaveBeenCalled();
  });
});