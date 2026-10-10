/**
 * CodeConClave — Unified Action Runtime cockpit tests.
 *
 * Pin the real contract: server-derived surface availability, honest disabled
 * states, and the exact localInstruction each surface posts (LOCAL terminal,
 * BROWSER within an origin, DESKTOP allow-listed op). Nothing is fabricated.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionRuntimePanel } from './ActionRuntimePanel';

function json(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

type Route = (url: string, init: RequestInit) => Response | null;

function setup(route: Route) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return route(url, init ?? {}) ?? json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<ActionRuntimePanel projectId="p1" />);
  return fetchMock;
}

const SURFACES = {
  enabled: true,
  surfaces: [
    { surface: 'CLOUD', title: 'Cloud execution', description: 'cloud', executionMode: 'CLOUD', enabled: true, reason: 'always available' },
    { surface: 'LOCAL', title: 'Local terminal', description: 'shell', executionMode: 'LOCAL', enabled: true, reason: 'LOCAL_EXECUTION_ENABLED is enabled' },
    { surface: 'BROWSER', title: 'Browser automation', description: 'browser', executionMode: 'LOCAL', enabled: true, reason: 'BROWSER_CONTROL_ENABLED is enabled' },
    { surface: 'DESKTOP', title: 'Desktop control', description: 'desktop', executionMode: 'LOCAL', enabled: true, reason: 'DESKTOP_CONTROL_ENABLED is enabled' },
  ],
};

const DEVICES = { devices: [{ id: 'd1', name: 'Workstation', state: 'PAIRED', presence: 'ONLINE', capabilities: [] }] };

describe('ActionRuntimePanel', () => {
  it('renders the server-derived surface availability and disabled reason', async () => {
    setup((url) => {
      if (url.includes('/actions/surfaces'))
        return json({
          data: {
            enabled: true,
            surfaces: [
              SURFACES.surfaces[0],
              { ...SURFACES.surfaces[1], enabled: false, reason: 'LOCAL_EXECUTION_ENABLED is disabled on this deployment' },
            ],
          },
        });
      if (url.includes('/local-workspace/devices')) return json({ data: { devices: [] } });
      return null;
    });
    await waitFor(() => expect(screen.getByTestId('action-surface-LOCAL-state')).toHaveTextContent('disabled'));
    expect(screen.getByTestId('action-surface-CLOUD-state')).toHaveTextContent('enabled');
    expect(screen.getByTestId('action-surface-reason')).toHaveTextContent('LOCAL_EXECUTION_ENABLED');
  });

  it('disables submit when the runtime is off and explains why', async () => {
    setup((url) => {
      if (url.includes('/actions/surfaces')) return json({ data: { enabled: false, surfaces: SURFACES.surfaces } });
      if (url.includes('/local-workspace/devices')) return json({ data: { devices: [] } });
      return null;
    });
    await waitFor(() => expect(screen.getByTestId('action-runtime-disabled')).toBeInTheDocument());
    expect(screen.getByTestId('action-runtime-flag')).toHaveTextContent('runtime disabled');
    await waitFor(() => expect(screen.getByTestId('action-submit')).toBeDisabled());
  });

  it('routes a CLOUD action and shows the created task', async () => {
    let posted: Record<string, unknown> = {};
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: SURFACES });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions') && init.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ data: { surface: 'CLOUD', executionMode: 'CLOUD', task: { id: 'task-42' } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-title')).toBeInTheDocument());
    await user.type(screen.getByTestId('action-title'), 'Summarize the repo');
    await user.click(screen.getByTestId('action-submit'));
    await waitFor(() => expect(screen.getByTestId('action-result')).toBeInTheDocument());
    expect(screen.getByTestId('action-result-task')).toHaveTextContent('task-42');
    expect(posted.surface).toBe('CLOUD');
    expect(posted.localInstruction).toBeUndefined();
  });

  it('builds a LOCAL terminal instruction with the command and pinned device', async () => {
    let posted: Record<string, unknown> = {};
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: SURFACES });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions') && init.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ data: { surface: 'LOCAL', executionMode: 'LOCAL', task: { id: 'task-local' } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-surface-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('action-surface-select'), 'LOCAL');
    await user.type(screen.getByTestId('action-title'), 'Run tests');
    await user.type(screen.getByTestId('action-command'), 'npm test');
    await user.click(screen.getByTestId('action-submit'));
    await waitFor(() => expect(screen.getByTestId('action-result')).toBeInTheDocument());
    expect(posted.surface).toBe('LOCAL');
    expect(posted.deviceId).toBe('d1');
    expect(posted.localInstruction).toEqual({ command: 'npm test' });
  });

  it('builds a BROWSER instruction scoped to the granted origin', async () => {
    let posted: Record<string, unknown> = {};
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: SURFACES });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions') && init.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ data: { surface: 'BROWSER', executionMode: 'LOCAL', task: { id: 'task-browser' } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-surface-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('action-surface-select'), 'BROWSER');
    await user.type(screen.getByTestId('action-title'), 'Open homepage');
    await user.type(screen.getByTestId('action-browser-origin'), 'https://example.com');
    await user.type(screen.getByTestId('action-browser-value'), 'https://example.com/');
    await user.click(screen.getByTestId('action-submit'));
    await waitFor(() => expect(screen.getByTestId('action-result')).toBeInTheDocument());
    const li = posted.localInstruction as { type: string; grants: { capabilities: string[]; allowedOrigins: string[] }; actions: unknown[] };
    expect(posted.surface).toBe('BROWSER');
    expect(posted.deviceId).toBe('d1');
    expect(posted.localInstruction).toMatchObject({ type: 'browser', grants: { capabilities: ['browser.navigate'], allowedOrigins: ['https://example.com'] } });
  });

  it('surfaces a server refusal honestly when the runtime is disabled', async () => {
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) {
        return json({ data: { enabled: true, surfaces: SURFACES.surfaces } });
      }
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions') && init.method === 'POST') {
        return json({ error: { code: 'unified_action_runtime_disabled', message: 'The unified action runtime is disabled on this deployment' } }, 503);
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-title')).toBeInTheDocument());
    await user.type(screen.getByTestId('action-title'), 'Do a thing');
    await user.click(screen.getByTestId('action-submit'));
    await waitFor(() => expect(screen.getByTestId('action-error')).toBeInTheDocument());
    expect(screen.getByTestId('action-error')).toHaveTextContent('disabled on this deployment');
  });

  it('disables submit for a disabled surface and exposes the honest reason', async () => {
    setup((url) => {
      if (url.includes('/actions/surfaces')) {
        return json({
          data: {
            enabled: true,
            surfaces: SURFACES.surfaces.map((s) => (s.surface === 'LOCAL' ? { ...s, enabled: false, reason: 'LOCAL_EXECUTION_ENABLED is disabled on this deployment' } : s)),
          },
        });
      }
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-surface-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('action-surface-select'), 'LOCAL');
    await user.type(screen.getByTestId('action-title'), 'blocked');
    expect(screen.getByTestId('action-submit')).toBeDisabled();
    expect(screen.getByTestId('action-surface-reason')).toHaveTextContent('LOCAL_EXECUTION_ENABLED is disabled');
  });

  it('routes a PREVIEW action with no instruction and shows the build session', async () => {
    let posted: Record<string, unknown> = {};
    const withPreview = {
      enabled: true,
      surfaces: [
        ...SURFACES.surfaces,
        { surface: 'PREVIEW', title: 'Live preview', description: 'preview', executionMode: 'PREVIEW', enabled: true, reason: 'LIVE_PREVIEW_ENABLED is enabled' },
      ],
    };
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: withPreview });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions') && init.method === 'POST' && !url.includes('stop-all')) {
        posted = JSON.parse(String(init.body));
        return json({ data: { surface: 'PREVIEW', executionMode: 'PREVIEW', session: { id: 'pvw-7', state: 'BUILDING', version: 3 } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-surface-select')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('action-surface-select'), 'PREVIEW');
    await user.type(screen.getByTestId('action-title'), 'Show me the app');
    await user.click(screen.getByTestId('action-submit'));
    await waitFor(() => expect(screen.getByTestId('action-result')).toBeInTheDocument());
    expect(posted.surface).toBe('PREVIEW');
    expect(posted.localInstruction).toBeUndefined();
    expect(posted.deviceId).toBeUndefined();
    expect(screen.getByTestId('action-result-session')).toHaveTextContent('BUILDING');
  });

  it('stop-all posts the project scope and reports honest counts', async () => {
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: SURFACES });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions/stop-all') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.projectId).toBe('p1');
        return json({ data: { stopped: { assignmentsCancelled: ['a1'], assignmentsFailed: [], tasksCancelled: ['t1'], tasksSkipped: ['t9'] } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-stop-all')).toBeInTheDocument());
    await user.click(screen.getByTestId('action-stop-all'));
    await waitFor(() => expect(screen.getByTestId('action-stop-all-result')).toBeInTheDocument());
    expect(screen.getByTestId('action-stop-all-result')).toHaveTextContent('Stopped 1 assignment(s) and t1 task(s)');
  });

  it('stop-all refusal is shown verbatim when the runtime is disabled', async () => {
    setup((url, init) => {
      if (url.includes('/actions/surfaces')) return json({ data: { enabled: false, surfaces: SURFACES.surfaces } });
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/api/v1/actions/stop-all') && init.method === 'POST') {
        return json({ error: { code: 'unified_action_runtime_disabled', message: 'The unified action runtime is disabled on this deployment' } }, 503);
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('action-stop-all')).toBeInTheDocument());
    await user.click(screen.getByTestId('action-stop-all'));
    await waitFor(() => expect(screen.getByTestId('action-stop-all-error')).toBeInTheDocument());
    expect(screen.getByTestId('action-stop-all-error')).toHaveTextContent('disabled on this deployment');
  });
});
