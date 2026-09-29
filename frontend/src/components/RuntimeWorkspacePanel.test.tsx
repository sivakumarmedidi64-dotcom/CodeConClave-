/**
 * CodeConClave — RuntimeWorkspacePanel tests (PKG-19).
 * Honest runtime loop rendering: capabilities, run command, background tasks,
 * evidence-only console/network capture (honest empty when UNAVAILABLE),
 * verification, smoke, and correlation. Uses a persistent fetch stub that
 * branches on method + URL so sequencing is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RuntimeWorkspacePanel } from './RuntimeWorkspacePanel';

const caps = {
  anchors: ['F34', 'F90', 'F38', 'F49'],
  capabilities: {
    executionEnabled: true,
    backgroundEnabled: true,
    consoleCapture: 'UNAVAILABLE' as const,
    networkCapture: 'UNAVAILABLE' as const,
    verificationEnabled: false,
    smokeEnabled: false,
    browserRuntime: 'NONE' as const,
  },
  limitations: [
    'There is no headless browser on this deployment; console/network capture is evidence-only and stays empty until a live preview iframe forwards real events.',
  ],
};

const smokeRun = {
  summary: { status: 'UNAVAILABLE' as const, total: 0, passed: 0, failed: 0, unavailable: 0 },
  results: [],
};
const verifyResults = { results: [{ id: 'rtv-1', label: 'Backend health', status: 'NOT_RUN', detail: 'disabled', ranAt: new Date().toISOString() }] };
const correlationEmpty = { findings: [], state: 'UNAVAILABLE' as const };

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

function okError(message: string): Response {
  return { ok: false, status: 400, json: async () => ({ error: { code: 'runtime_command_denied', message } }) } as unknown as Response;
}

type Handler = (url: string, method: string) => Response;

function baseHandler(): Handler {
  return (url: string, method: string) => {
    if (method === 'POST' && url === '/api/v1/runtime/executions') {
      return jsonResponse({ id: 'rte-1', status: 'COMPLETED', blocked: false, output: 'ok', command: 'npm test' });
    }
    if (method === 'POST' && url.startsWith('/api/v1/runtime/background/')) {
      return jsonResponse({ id: 'rtb-1', status: 'RUNNING', label: 'bg-1' });
    }
    if (url === '/api/v1/runtime/capabilities') return jsonResponse(caps);
    if (url.startsWith('/api/v1/runtime/executions')) return jsonResponse([]);
    if (url.startsWith('/api/v1/runtime/background')) return jsonResponse([]);
    if (url.startsWith('/api/v1/runtime/console')) return jsonResponse([]);
    if (url.startsWith('/api/v1/runtime/network')) return jsonResponse([]);
    if (method === 'POST' && url === '/api/v1/runtime/verify') return jsonResponse(verifyResults);
    if (method === 'POST' && url === '/api/v1/runtime/smoke/run') return jsonResponse(smokeRun);
    if (method === 'POST' && url === '/api/v1/runtime/correlate') return jsonResponse(correlationEmpty);
    return jsonResponse({});
  };
}

function stub(handler: Handler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init?.method ?? 'GET'),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('RuntimeWorkspacePanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the honest runtime capability report', async () => {
    stub(baseHandler());
    await act(async () => {
      render(<RuntimeWorkspacePanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('runtime-capabilities').textContent).toContain('F34');
    expect(screen.getByTestId('runtime-cap-execution').textContent).toContain('sandbox allow-list');
    expect(screen.getByTestId('runtime-cap-browser').textContent).toContain('none (no headless browser)');
  });

  it('shows honest empty console/network capture when no browser evidence exists', async () => {
    stub(baseHandler());
    await act(async () => {
      render(<RuntimeWorkspacePanel projectId="prj-1" />);
    });
    expect(screen.getByTestId('runtime-cap-console').textContent).toContain('unavailable');
    expect(screen.getByTestId('runtime-cap-network').textContent).toContain('unavailable');
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-tab-observe'));
    });
    expect(screen.getByTestId('runtime-console-empty').textContent).toContain('No console events captured');
    expect(screen.getByTestId('runtime-network-empty').textContent).toContain('No network events captured');
  });

  it('runs a command via the executions endpoint', async () => {
    const fetchMock = stub(baseHandler());
    await act(async () => {
      render(<RuntimeWorkspacePanel projectId="prj-1" />);
    });
    fireEvent.change(screen.getByTestId('runtime-command'), { target: { value: 'npm test' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-run'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/executions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'prj-1', command: 'npm test' }) }),
    );
  });

  it('surfaces a blocked-command error message', async () => {
    stub((url, method) => {
      if (method === 'POST' && url === '/api/v1/runtime/executions') {
        return okError('command is not allow-listed in the sandbox');
      }
      return baseHandler()(url, method);
    });
    await act(async () => {
      render(<RuntimeWorkspacePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-run'));
    });
    expect(screen.getByTestId('runtime-error').textContent).toContain('not allow-listed');
  });

  it('runs verification, smoke and correlation buttons', async () => {
    const fetchMock = stub(baseHandler());
    await act(async () => {
      render(<RuntimeWorkspacePanel projectId="prj-1" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-tab-verify'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-verify'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/verify',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'prj-1' }) }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-smoke'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/smoke/run',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'prj-1' }) }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-tab-observe'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-correlate'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/correlate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'prj-1' }) }),
    );
  });
});
