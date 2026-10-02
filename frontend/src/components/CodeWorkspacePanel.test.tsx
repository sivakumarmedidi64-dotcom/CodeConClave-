/**
 * CodeConClave — CodeWorkspacePanel tests (PKG-22).
 * Honest workspace rendering: capabilities (feature-flag + HEURISTIC symbol +
 * git-unavailable states), file tree navigation + open tab, version-safe save,
 * project search, HEURISTIC outline, and the reviewed safe-rename flow
 * (preview → create review → accept-all → apply). Server-authoritative.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CodeWorkspacePanel } from './CodeWorkspacePanel';

const caps = {
  anchors: ['F19', 'F20', 'F34', 'F90', 'B1'],
  enabled: true,
  rootConfigured: true,
  editor: { state: 'PARTIAL', syntaxHighlighting: 'UNAVAILABLE', lineNumbers: 'VERIFIED', multiFileTabs: 'VERIFIED', splitPane: 'VERIFIED', undoRedo: 'PARTIAL', unsavedState: 'VERIFIED', persistence: 'VERIFIED' },
  search: 'VERIFIED',
  symbols: { state: 'HEURISTIC', lsp: 'UNAVAILABLE' },
  refactoring: { state: 'PARTIAL', operations: ['rename'] },
  diagnostics: { state: 'HEURISTIC', note: 'Aggregates existing analyzers; no LSP/compiler type-checking (UNAVAILABLE)' },
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

const tree = [{ name: 'src', path: 'src', type: 'dir', size: null, children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 12 }] }];
const wsState = { workspaceId: 'ws-1', projectId: 'p-1', activePath: 'src/a.ts', split: 'single', tabs: [{ path: 'src/a.ts', pinned: false, unsaved: false }] };
const fileEntry = { path: 'src/a.ts', content: 'export const foo = 1;\nfoo;\n', sha256: 'aaa', binary: false, large: false, truncated: false };
const outline = { outline: [{ name: 'foo', kind: 'const', line: 1 }] };
const searchRes = { query: 'foo', regex: false, total: 1, truncated: false, matches: [{ file: 'src/a.ts', line: 2, text: 'foo;', contextBefore: [], contextAfter: [] }] };

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

function okError(message: string): Response {
  return { ok: false, status: 400, json: async () => ({ error: { code: 'workspace_conflict', message } }) } as unknown as Response;
}

type Handler = (url: string, method: string, body?: unknown) => Response;

function baseHandler(): Handler {
  return (url: string, method: string, body?: unknown) => {
    if (url === '/api/v1/codeworkspace/capabilities') return jsonResponse(caps);
    if (url === '/api/v1/codeworkspace/tree') return jsonResponse(tree);
    if (url === '/api/v1/codeworkspace/state') return jsonResponse(wsState);
    if (url === '/api/v1/codeworkspace/git') return jsonResponse({ git: { state: 'UNAVAILABLE', hasRepo: false } });
    if (url.startsWith('/api/v1/codeworkspace/file?path=')) return jsonResponse(fileEntry);
    if (url === '/api/v1/codeworkspace/tab/open') return jsonResponse(wsState);
    if (url.startsWith('/api/v1/codeworkspace/symbols/outline')) return jsonResponse(outline);
    if (url.startsWith('/api/v1/codeworkspace/search?')) return jsonResponse(searchRes);
    if (method === 'POST' && url === '/api/v1/codeworkspace/file/save') return jsonResponse({ sha256: 'bbb' });
    if (method === 'POST' && url === '/api/v1/codeworkspace/refactor/rename/preview') {
      const b = body as { symbol: string };
      return jsonResponse({ plan: { id: 'rp-1', symbol: b.symbol, newName: 'bar', status: 'PLANNED', fileCount: 1, files: [{ path: 'src/a.ts', diff: 'x', additions: 1, deletions: 1 }], appliesTo: ['src/a.ts'] } });
    }
    if (method === 'POST' && url === '/api/v1/codeworkspace/refactor/rename') {
      return jsonResponse({ plan: { id: 'rp-1', symbol: 'foo', newName: 'bar', status: 'PLANNED', fileCount: 1, files: [], appliesTo: ['src/a.ts'] }, reviewId: 'rw-1' });
    }
    if (url.startsWith('/api/v1/codeworkspace/review?id=')) {
      return jsonResponse({ id: 'rw-1', status: 'READY_FOR_REVIEW', filesChanged: 1, additions: 1, deletions: 1, files: [{ path: 'src/a.ts', accepted: false, applied: false }] });
    }
    if (/review\/rw-1\/accept-all|review\/rw-1\/apply/.test(url)) {
      return jsonResponse({ id: 'rw-1', status: 'APPLIED', filesChanged: 1, additions: 1, deletions: 1, files: [{ path: 'src/a.ts', accepted: true, applied: true }] });
    }
    if (url.startsWith('/api/v1/codeworkspace/review/rw-1')) return jsonResponse({ id: 'rw-1', status: 'CANCELLED', filesChanged: 1, additions: 1, deletions: 1, files: [{ path: 'src/a.ts', accepted: false, applied: false }] });
    return jsonResponse({});
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
function stub(handler: Handler): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(url, method, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CodeWorkspacePanel (PKG-22)', () => {
  it('renders honest capabilities incl. HEURISTIC symbols + git-unavailable', async () => {
    stub(baseHandler());
    render(<CodeWorkspacePanel projectId="p-1" />);
    await flush();
    expect((screen.getByTestId('cw-cap-symbols').textContent ?? '').toLowerCase()).toContain('heuristic');
    expect((screen.getByTestId('cw-cap-git').textContent ?? '').toLowerCase()).toContain('unavailable');
    expect(screen.getByTestId('cw-cap-enabled').textContent).toContain('yes');
  });

  it('loads the file tree and opens a file into tabs + outline', async () => {
    stub(baseHandler());
    render(<CodeWorkspacePanel projectId="p-1" />);
    await flush();
    const fileBtn = screen.getAllByTestId('cw-file')[0]!;
    fireEvent.click(fileBtn);
    await flush();
    expect(screen.getByTestId('cw-tab').textContent).toContain('a.ts');
    const outline = screen.getByTestId('cw-outline');
    expect(outline.textContent).toContain('foo');
  });

  it('performs a version-safe save', async () => {
    stub(baseHandler());
    render(<CodeWorkspacePanel projectId="p-1" />);
    await flush();
    const fileBtn = screen.getAllByTestId('cw-file')[0]!;
    fireEvent.click(fileBtn);
    await flush();
    fireEvent.change(screen.getByTestId('cw-draft'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('cw-save'));
    await flush();
    const saveCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/file/save'));
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(String((saveCall![1] as RequestInit).body)).baseSha256).toBe('aaa');
  });

  it('runs a project search and shows matches', async () => {
    stub(baseHandler());
    render(<CodeWorkspacePanel projectId="p-1" />);
    await flush();
    fireEvent.change(screen.getByTestId('cw-search-q'), { target: { value: 'foo' } });
    fireEvent.click(screen.getByTestId('cw-search-run'));
    await flush();
    const res = screen.getByTestId('cw-search-results');
    expect(res.textContent).toContain('1 match');
    expect(res.textContent).toContain('src/a.ts');
  });

  it('runs the reviewed safe-rename flow: preview → create → accept-all → apply', async () => {
    stub(baseHandler());
    render(<CodeWorkspacePanel projectId="p-1" />);
    await flush();
    fireEvent.change(screen.getByTestId('cw-symbol'), { target: { value: 'foo' } });
    fireEvent.change(screen.getByTestId('cw-newname'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByTestId('cw-rename-preview'));
    await flush();
    expect(screen.getByTestId('cw-plan').textContent).toContain('PLANNED');
    fireEvent.click(screen.getByTestId('cw-rename-exec'));
    await flush();
    expect(screen.getByTestId('cw-review').textContent).toContain('READY_FOR_REVIEW');
    fireEvent.click(screen.getByTestId('cw-review-apply'));
    await flush();
    expect(screen.getByTestId('cw-review').textContent).toContain('APPLIED');
  });
});
