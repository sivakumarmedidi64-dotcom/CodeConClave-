/**
 * CodeConClave — IntegratedTerminalPanel tests (PKG-20).
 * Environment indicator + status, production guard with explicit confirm,
 * command-risk preflight badge, run/cancel/clear, and execution history with
 * env+cwd. Uses a persistent fetch stub branching on method + URL so
 * sequencing is deterministic (one-shot mockImplementationOnce is avoided).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IntegratedTerminalPanel } from './IntegratedTerminalPanel';

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

const envStatus = {
  environment: 'development' as const,
  status: 'VERIFIED' as const,
  requiredVars: [],
  declaredEnv: null,
  blockEnvironmentSensitive: false,
  checkedAt: new Date().toISOString(),
};

const preflightExecute = {
  environment: 'development' as const,
  commandRisk: { command: 'npm test', risk: 'CAUTION' as const, reason: 'MEDIUM-risk command — review before executing', requiresConfirmation: true },
  configuration: 'valid',
  databaseTarget: 'none',
  action: 'confirmation_required',
  mismatch: { detected: false, detail: '' },
};

const execution = {
  id: 'rte-1',
  projectId: 'prj-1',
  kind: 'RUN',
  command: 'npm test',
  status: 'COMPLETED',
  exitCode: 0,
  blocked: false,
  timedOut: false,
  cancelled: false,
  output: 'ok\n',
  error: null,
  durationMs: 12,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  environment: 'development',
  cwd: 'prj-1',
};

type Handler = (url: string, method: string) => Response;

function baseHandler(): Handler {
  return (url: string, method: string) => {
    if (url.startsWith('/api/v1/environment/status')) return jsonResponse(envStatus);
    if (method === 'POST' && url === '/api/v1/environment/preflight') return jsonResponse(preflightExecute);
    if (method === 'POST' && url === '/api/v1/environment/select') return jsonResponse({ switched: true });
    if (method === 'POST' && url === '/api/v1/runtime/executions') return jsonResponse(execution);
    if (url.startsWith('/api/v1/runtime/executions')) return jsonResponse([execution]);
    if (url.startsWith('/api/v1/runtime/background/')) return jsonResponse({});
    return jsonResponse({});
  };
}

function stub(handler: Handler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init?.method ?? 'GET'));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function renderPanel() {
  await act(async () => {
    render(<IntegratedTerminalPanel projectId="prj-1" />);
  });
}

describe('IntegratedTerminalPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the environment indicator and status', async () => {
    stub(baseHandler());
    await renderPanel();
    expect(screen.getByTestId('it-env-indicator').textContent).toContain('DEVELOPMENT');
    expect(screen.getByTestId('it-env-status').textContent).toContain('VERIFIED');
  });

  it('shows the command-risk badge and action for a CAUTION command', async () => {
    stub(baseHandler());
    await renderPanel();
    await act(async () => {
      fireEvent.change(screen.getByTestId('it-command'), { target: { value: 'npm test' } });
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(screen.getByTestId('it-risk').textContent).toContain('caution');
    expect(screen.getByTestId('it-action').textContent).toContain('confirmation_required');
  });

  it('runs a command through the runtime executions endpoint with env + cwd', async () => {
    const fetchMock = stub(baseHandler());
    await renderPanel();
    fireEvent.change(screen.getByTestId('it-command'), { target: { value: 'npm test' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('it-run'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/executions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId: 'prj-1', command: 'npm test', environment: 'development', cwd: 'prj-1' }),
      }),
    );
    expect(screen.getByTestId('it-state').textContent).toContain('COMPLETED');
    expect(screen.getByTestId('it-output').textContent).toContain('ok');
  });

  it('renders execution history with env + cwd and rerun', async () => {
    stub(baseHandler());
    await renderPanel();
    expect(screen.getByTestId('it-history')).toBeTruthy();
    expect(screen.getByTestId('it-history').textContent).toContain('npm test');
    await act(async () => {
      fireEvent.click(screen.getByTestId('it-rerun'));
    });
    expect((screen.getByTestId('it-command') as HTMLInputElement).value).toBe('npm test');
  });

  it('requires explicit confirmation to switch into production (guarded UI)', async () => {
    const fetchMock = stub(baseHandler());
    await renderPanel();
    fireEvent.change(screen.getByTestId('it-env-select'), { target: { value: 'production' } });
    await act(async () => {
      await Promise.resolve();
    });
    // No select POST fired yet; the explicit-confirm barrier appears.
    expect(screen.getByTestId('it-prod-warning').textContent).toContain('explicit confirmation');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/v1/environment/select',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('production') }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('it-prod-arm'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('it-prod-switch'));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/environment/select',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"confirmed":true') }),
    );
  });

  it('honestly reports that it runs through the sandboxed allow-list', async () => {
    stub(baseHandler());
    await renderPanel();
    expect(screen.getByTestId('it-honest-note').textContent).toContain('sandbox allow-list');
    expect(screen.getByTestId('it-honest-note').textContent).toContain('not an unrestricted real shell');
  });
});
