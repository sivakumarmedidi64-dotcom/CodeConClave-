/**
 * CodeConClave — Local Workspace cockpit tests.
 *
 * Pin the real bridge contract: device presence, workspace selection, real
 * tree/file browsing, diff-on-save, authorized command output, and honest
 * policy-denial / offline states. Nothing here is fabricated by the component.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalWorkspacePanel } from './LocalWorkspacePanel';

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
  render(<LocalWorkspacePanel projectId="p1" />);
  return fetchMock;
}

const DEVICES = { devices: [{ id: 'd1', name: 'Workstation', state: 'PAIRED', presence: 'ONLINE', capabilities: [] }] };
const WORKSPACES = { workspaces: [{ root: 'C:/ws', name: 'ws', capabilities: ['file_read', 'file_write', 'terminal_exec'] }] };
const TREE = {
  root: 'C:/ws',
  entries: [
    { name: 'a.ts', path: 'C:/ws/a.ts', type: 'file', sizeBytes: 3, modifiedAt: '' },
    { name: 'src', path: 'C:/ws/src', type: 'dir', sizeBytes: 0, modifiedAt: '' },
  ],
};

describe('LocalWorkspacePanel', () => {
  it('lists paired devices and shows ONLINE presence', async () => {
    setup((url) => (url.includes('/local-workspace/devices') ? json({ data: DEVICES }) : null));
    await waitFor(() => expect(screen.getByTestId('lws-presence')).toHaveTextContent('ONLINE'));
    expect(screen.getByTestId('lws-device')).toBeInTheDocument();
  });

  it('shows an honest offline state when the device is not online', async () => {
    setup((url) =>
      url.includes('/local-workspace/devices')
        ? json({ data: { devices: [{ id: 'd1', name: 'Laptop', state: 'PAIRED', presence: 'OFFLINE', capabilities: [] }] } })
        : null,
    );
    await waitFor(() => expect(screen.getByTestId('lws-offline')).toBeInTheDocument());
    expect(screen.getByTestId('lws-presence')).toHaveTextContent('OFFLINE');
  });

  it('browses a workspace, opens a file, edits and saves with a real diff', async () => {
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/local-workspace/workspaces')) return json({ data: WORKSPACES });
      if (url.includes('/local-workspace/tree')) return json({ data: TREE });
      if (url.includes('/local-workspace/file') && (init.method ?? 'GET') === 'GET') {
        return json({ data: { metadata: {}, file: { content: 'abc', sha256: 'hash1', sizeBytes: 3 } } });
      }
      if (url.includes('/local-workspace/file') && init.method === 'PUT') {
        return json({ data: { diff: '-abc\n+abcd', path: 'C:/ws/a.ts', beforeHash: 'hash1', afterHash: 'hash2' } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByTestId('lws-workspace').querySelector('option[value="C:/ws"]')).not.toBeNull(),
    );
    await user.selectOptions(screen.getByTestId('lws-workspace'), 'C:/ws');
    await waitFor(() => expect(screen.getAllByTestId('lws-entry').length).toBe(2));
    await user.click(screen.getByText(/a\.ts/));
    await waitFor(() => expect(screen.getByTestId('lws-editor')).toHaveValue('abc'));
    await user.clear(screen.getByTestId('lws-editor'));
    await user.type(screen.getByTestId('lws-editor'), 'abcd');
    await user.click(screen.getByTestId('lws-save'));
    await waitFor(() => expect(screen.getByTestId('lws-diff')).toHaveTextContent('-abc'));
  });

  it('runs an authorized command and shows real output + exit code', async () => {
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/local-workspace/workspaces')) return json({ data: WORKSPACES });
      if (url.includes('/local-workspace/exec') && init.method === 'POST') {
        return json({ data: { output: 'tests passed\n', payload: { exitCode: 0, status: 'COMPLETED' } } });
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('lws-command')).toBeInTheDocument());
    await user.type(screen.getByTestId('lws-command'), 'npm test');
    await user.click(screen.getByTestId('lws-run'));
    await waitFor(() => expect(screen.getByTestId('lws-output')).toHaveTextContent('tests passed'));
    expect(screen.getByTestId('lws-exec-meta')).toHaveTextContent('exit 0');
  });

  it('surfaces a device policy denial honestly (no fabricated success)', async () => {
    setup((url, init) => {
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/local-workspace/workspaces')) return json({ data: WORKSPACES });
      if (url.includes('/local-workspace/exec') && init.method === 'POST') {
        return json({ error: { code: 'local_action_denied', message: 'policy_denied: rm -rf' } }, 403);
      }
      return null;
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('lws-command')).toBeInTheDocument());
    await user.type(screen.getByTestId('lws-command'), 'rm -rf /');
    await user.click(screen.getByTestId('lws-run'));
    await waitFor(() => expect(screen.getByTestId('lws-denied')).toBeInTheDocument());
    expect(screen.getByTestId('lws-denied')).toHaveTextContent('Denied by policy');
  });

  it('shows a useful error when the agent is offline mid-action', async () => {
    setup((url) => {
      if (url.includes('/local-workspace/devices')) return json({ data: DEVICES });
      if (url.includes('/local-workspace/workspaces')) {
        return json({ error: { code: 'local_agent_offline', message: 'Local Agent is offline' } }, 503);
      }
      return null;
    });
    await waitFor(() => expect(screen.getByTestId('lws-error')).toBeInTheDocument());
    expect(screen.getByTestId('lws-error')).toHaveTextContent('offline');
  });
});
