/**
 * CodeConClave — PreviewPanel tests (Stage 25.5).
 * Honest state rendering: NOT_CONFIGURED shows the server reason with no
 * fake build controls, READY renders the sandboxed iframe, ERROR shows the
 * failure. Live updates arrive over the SSE stream (no polling).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel';

interface Session {
  state: string;
  version: number;
  task_id: string | null;
  error: string | null;
  build_log: string[];
}

const session = (over: Partial<Session> = {}): Session => ({
  state: 'NOT_CONFIGURED',
  version: 1,
  task_id: null,
  error: null,
  build_log: [],
  ...over,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, ev?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

let esCtor: typeof EventSource;
beforeEach(() => {
  esCtor = globalThis.EventSource;
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  Object.defineProperty(globalThis, 'EventSource', { value: esCtor, configurable: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe('PreviewPanel honest states', () => {
  it('shows NOT_CONFIGURED with the server reason and no build controls', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: session({ error: 'Preview tooling is not configured on this deployment' }), configured: false }),
    );
    await act(async () => {
      render(<PreviewPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('preview-state')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('preview-honest').textContent).toContain('not configured');
    expect(screen.queryByTestId('preview-build')).toBeNull();
    expect(screen.queryByTestId('preview-frame')).toBeNull();
    expect(screen.queryByText(/PREVIEW_BUILD_ENABLED/)).toBeTruthy();
  });

  it('renders the sandboxed iframe only for READY builds', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: session({ state: 'READY', version: 3 }), configured: true }));
    await act(async () => {
      render(<PreviewPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('preview-state')).toHaveTextContent('Ready');
    const frame = screen.getByTestId('preview-frame') as HTMLIFrameElement;
    expect(frame.src).toContain('/api/v1/preview/prj-1/content');
    expect(screen.queryByTestId('preview-honest')).toBeNull();
  });

  it('shows the honest error for a failed build (never a fake preview)', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: session({ state: 'ERROR', error: 'build failed (exit 1)' }), configured: true }),
    );
    await act(async () => {
      render(<PreviewPanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('preview-state')).toHaveTextContent('Error');
    expect(screen.getByTestId('preview-honest').textContent).toContain('build failed');
    expect(screen.queryByTestId('preview-frame')).toBeNull();
  });

  it('posts a build request when tooling is configured', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session: session({ state: 'OFFLINE' }), configured: true }))
      .mockResolvedValueOnce(jsonResponse({ session: session({ state: 'BUILDING' }), configured: true }));
    await act(async () => {
      render(<PreviewPanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-build'));
    });
    const calls = fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit | undefined)?.method ?? 'GET']);
    expect(calls).toContainEqual(['/api/v1/preview/prj-1/build', 'POST']);
    expect(screen.getByTestId('preview-state')).toHaveTextContent('Building');
  });

  it('applies live state from the SSE stream without polling', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: session({ state: 'BUILDING' }), configured: true }));
    await act(async () => {
      render(<PreviewPanel projectId="prj-1" />);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toContain('/api/v1/preview/prj-1/stream');
    await act(async () => {
      FakeEventSource.instances[0]!.emit('message', { data: JSON.stringify({ state: 'READY', version: 2, taskId: null, error: null }) });
    });
    expect(screen.getByTestId('preview-state')).toHaveTextContent('Ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});