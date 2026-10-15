import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { FilesPage } from './FilesPage';

vi.mock('../components/PreviewPanel', () => ({ PreviewPanel: () => null }));

const capabilities = {
  anchors: [],
  enabled: true,
  rootConfigured: true,
  editor: { state: 'PARTIAL', syntaxHighlighting: 'UNAVAILABLE', lineNumbers: 'VERIFIED', multiFileTabs: 'VERIFIED', splitPane: 'VERIFIED', undoRedo: 'PARTIAL', unsavedState: 'VERIFIED', persistence: 'VERIFIED' },
  search: 'VERIFIED',
  symbols: { state: 'HEURISTIC', lsp: 'UNAVAILABLE' },
  refactoring: { state: 'PARTIAL', operations: ['rename'] },
  diagnostics: { state: 'HEURISTIC', note: 'No language server configured.' },
  diffReview: 'VERIFIED',
  b1Integration: 'VERIFIED',
  memory: 'PARTIAL',
  crossFileIntelligence: 'PARTIAL',
  performance: 'PARTIAL',
  security: 'VERIFIED',
  userIsolation: 'VERIFIED',
  workspaceIsolation: 'VERIFIED',
  git: 'UNAVAILABLE',
  api: 'VERIFIED',
};

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/projects') return jsonResponse({ projects: [{ id: 'p-1', name: 'Demo project' }] });
    if (url.startsWith('/api/v1/files/tree?')) return jsonResponse({ tree: [] });
    if (url.startsWith('/api/v1/files?')) return jsonResponse({ files: [] });
    if (url === '/api/v1/local-workspace/devices') {
      return jsonResponse({ devices: [{ id: 'device-1', state: 'PAIRED', presence: 'ONLINE' }] });
    }
    if (url === '/api/v1/codeworkspace/capabilities') return jsonResponse(capabilities);
    if (url === '/api/v1/codeworkspace/tree') return jsonResponse([]);
    if (url === '/api/v1/codeworkspace/state') {
      return jsonResponse({ workspaceId: 'ws-1', projectId: 'p-1', activePath: null, split: 'single', tabs: [] });
    }
    if (url === '/api/v1/codeworkspace/git') return jsonResponse({ git: { state: 'UNAVAILABLE', hasRepo: false } });
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FilesPage Code Workspace split', () => {
  it('loads Code Workspace on demand and shows live paired-device presence', async () => {
    const user = userEvent.setup();
    render(<ToastProvider><FilesPage /></ToastProvider>);

    const openWorkspace = await screen.findByRole('button', { name: 'Open Code Workspace' });
    expect(openWorkspace).toBeEnabled();
    await user.click(openWorkspace);

    expect(await screen.findByText(/ONLINE — 1 of 1 paired device currently connected\./)).toBeInTheDocument();
    expect(screen.getByTestId('paired-device-status')).toHaveAttribute('data-state', 'online');
  });
});
