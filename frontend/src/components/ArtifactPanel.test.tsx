import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatMarkdown } from './ChatMarkdown';
import { ArtifactPanel } from './ArtifactPanel';
import { artifactStore, isPreviewable, previewDocument } from '../lib/artifacts';

afterEach(() => act(() => artifactStore.close()));

const doc = (body: string) => '```html\n<!doctype html><html><head><title>Coffee</title></head><body>' + body + '</body></html>\n```';

describe('artifacts', () => {
  it('offers Preview only for renderable code', () => {
    expect(isPreviewable('html', '<p>x</p>')).toBe(true);
    expect(isPreviewable('', '<svg viewBox="0 0 1 1"></svg>')).toBe(true);
    expect(isPreviewable('ts', 'const x = 1')).toBe(false);
    render(<ChatMarkdown text={'```ts\nconst x = 1\n```'} />);
    expect(screen.queryByRole('button', { name: 'Open live preview' })).not.toBeInTheDocument();
  });

  it('auto-opens a full HTML document in a sandbox without same-origin access', () => {
    render(
      <>
        <ChatMarkdown text={doc('<h1>Hello coffee lovers</h1><p>' + 'x'.repeat(80) + '</p>')} />
        <ArtifactPanel />
      </>,
    );
    expect(screen.getByRole('complementary', { name: 'Artifact: Coffee' })).toBeInTheDocument();
    const frame = screen.getByTitle('Coffee preview');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('updates the open artifact live as the block grows, and closes', async () => {
    const { rerender } = render(
      <>
        <ChatMarkdown text={'```html\n<p>first</p>\n```'} />
        <ArtifactPanel />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open live preview' }));
    rerender(
      <>
        <ChatMarkdown text={'```html\n<p>first</p><p>second</p>\n```'} />
        <ArtifactPanel />
      </>,
    );
    expect(artifactStore.get()?.code).toBe('<p>first</p><p>second</p>');
    await userEvent.click(screen.getByRole('tab', { name: 'Code' }));
    expect(within(screen.getByRole('complementary')).getByText('<p>first</p><p>second</p>')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close artifact' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('centres bare SVG on a page', () => {
    expect(previewDocument('svg', '<svg></svg>')).toContain('<body');
    expect(previewDocument('html', '<p>x</p>')).toBe('<p>x</p>');
  });
});
