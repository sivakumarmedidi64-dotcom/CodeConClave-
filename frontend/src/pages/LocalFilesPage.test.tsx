import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { LocalFilesPage } from './LocalFilesPage';
import { diffStats, extractCodeBlock, isSecretPath, lineDiff } from '../lib/localfs';
import { jsonResponse, stubFetch } from '../testutils';

/** In-memory stand-in for a picked folder (File System Access API shape). */
function fakeFolder(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const fileHandle = (name: string) => ({
    kind: 'file' as const,
    name,
    getFile: async () => ({ size: (written[name] ?? files[name] ?? '').length, text: async () => written[name] ?? files[name] ?? '' }),
    createWritable: async () => {
      let buf = '';
      return { write: async (t: string) => void (buf = t), close: async () => void (written[name] = buf) };
    },
  });
  const dir = {
    kind: 'directory' as const,
    name: 'my-app',
    async *entries() {
      for (const name of Object.keys(files)) yield [name, fileHandle(name)];
      yield ['node_modules', { kind: 'directory', name: 'node_modules' }];
    },
  };
  return { dir, written };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <LocalFilesPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('localfs helpers', () => {
  it('blocks secret files', () => {
    for (const p of ['.env', 'app/.env.local', '.ssh/id_rsa', 'certs/server.pem', 'deploy.key', '.npmrc']) expect(isSecretPath(p)).toBe(true);
    for (const p of ['src/env.ts', 'README.md', 'keys.ts']) expect(isSecretPath(p)).toBe(false);
  });

  it('diffs lines and counts changes', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(d[0]).toEqual({ kind: 'same', text: 'a' });
  });

  it('extracts the proposed file from a fenced answer', () => {
    expect(extractCodeBlock('Here you go:\n```ts\nconst x = 2;\n```\nDone')).toBe('const x = 2;');
    expect(extractCodeBlock('no code here')).toBeNull();
  });
});

describe('LocalFilesPage', () => {
  let folder: ReturnType<typeof fakeFolder>;
  beforeEach(() => {
    vi.unstubAllGlobals();
    folder = fakeFolder({ 'index.html': '<h1>Old</h1>', '.env': 'SECRET=1' });
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => folder.dir;
  });
  afterEach(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('asks before writing, shows the diff, and hides secret and heavy folders', async () => {
    stubFetch(async () => jsonResponse({ data: { mode: 'ask' } }));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Open folder/ }));
    const tree = await screen.findByRole('navigation', { name: 'Folder tree' });
    expect(within(tree).queryByText('.env')).not.toBeInTheDocument();
    expect(within(tree).queryByText('node_modules')).not.toBeInTheDocument();
    await userEvent.click(within(tree).getByText('index.html'));
    const editor = await screen.findByLabelText('Contents of index.html');
    await userEvent.clear(editor);
    await userEvent.type(editor, '<h1>New</h1>');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Allow edit to index.html?' });
    expect(within(dialog).getByText('+1 −1 lines · written straight to your folder')).toBeInTheDocument();
    expect(folder.written['index.html']).toBeUndefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(folder.written['index.html']).toBe('<h1>New</h1>'));
  });

  it('declining leaves the file untouched', async () => {
    stubFetch(async () => jsonResponse({ data: { mode: 'ask' } }));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Open folder/ }));
    await userEvent.click(await screen.findByText('index.html'));
    const editor = await screen.findByLabelText('Contents of index.html');
    await userEvent.type(editor, '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'No' }));
    expect(folder.written['index.html']).toBeUndefined();
  });

  it('auto-accept edits mode writes without the prompt', async () => {
    stubFetch(async () => jsonResponse({ data: { mode: 'accept_edits' } }));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Open folder/ }));
    await userEvent.click(await screen.findByText('index.html'));
    const editor = await screen.findByLabelText('Contents of index.html');
    await waitFor(() => expect(screen.getByText('Edits apply without asking')).toBeInTheDocument());
    await userEvent.type(editor, '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(folder.written['index.html']).toBe('<h1>Old</h1>!'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
