import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { McpPage, toolBehaviour } from './McpPage';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const server = (over: Record<string, unknown> = {}) => ({
  id: 'mcp_1',
  name: 'notes',
  url: 'https://notes.example.com/mcp',
  authHeaderName: 'Authorization',
  hasAuth: true,
  enabled: true,
  status: 'CONNECTED',
  lastError: null,
  protocolVersion: '2025-06-18',
  serverName: 'fake-notes',
  toolsRefreshedAt: new Date().toISOString(),
  tools: [
    { name: 'echo', title: null, description: 'Echo the text back.', readOnly: true, destructive: false },
    { name: 'create_note', title: null, description: 'Create a note.', readOnly: false, destructive: false },
    { name: 'delete_all', title: null, description: 'Delete every note.', readOnly: false, destructive: true },
  ],
  ...over,
});

describe('MCP servers page (Article 8)', () => {
  it('labels each tool by how it is treated', () => {
    expect(toolBehaviour({ readOnly: true, destructive: false }).label).toMatch(/runs without asking/);
    expect(toolBehaviour({ readOnly: false, destructive: false }).label).toBe('Asks first');
    expect(toolBehaviour({ readOnly: false, destructive: true }).label).toMatch(/Always asks/);
  });

  it('connects a server (auth value sent once, never shown) and lists its tools', async () => {
    let servers: unknown[] = [];
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/mcp/servers') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          servers = [server()];
          return json({ server: servers[0] }, 201);
        }
        return json({ servers, maxServers: 20 });
      }),
    );
    render(
      <MemoryRouter>
        <McpPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('mcp-empty')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Server name'), 'notes');
    await userEvent.type(screen.getByLabelText('Server URL'), 'https://notes.example.com/mcp');
    await userEvent.type(screen.getByLabelText('Auth header value'), 'Bearer abc');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const card = await screen.findByTestId('mcp-server-notes');
    expect(posted).toEqual({ name: 'notes', url: 'https://notes.example.com/mcp', authHeaderName: 'Authorization', authHeaderValue: 'Bearer abc' });
    expect(card).toHaveTextContent('Connected');
    expect(card).toHaveTextContent('3 tools');
    expect(card).toHaveTextContent('auth header Authorization saved (encrypted)');
    expect(card).not.toHaveTextContent('Bearer abc');
    expect(card).toHaveTextContent('Read-only · runs without asking');
    expect(card).toHaveTextContent('Always asks · changes or deletes data');
  });

  it('shows a failed server with its real error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ servers: [server({ status: 'FAILED', lastError: 'Could not reach the MCP server: connect ECONNREFUSED', tools: [] })] })));
    render(
      <MemoryRouter>
        <McpPage />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId('mcp-server-notes');
    expect(card).toHaveTextContent('Failed');
    expect(card).toHaveTextContent('ECONNREFUSED');
  });

  it('Try runs a read-only tool, and a tool that asks shows the approval card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/mcp/call')) {
          const b = JSON.parse(String(init?.body));
          return b.tool === 'echo'
            ? json({ outcome: { status: 'ok', server: 'notes', tool: 'echo', text: 'echo: hi', isError: false } })
            : json({ outcome: { status: 'approval_required', server: 'notes', tool: 'create_note', approvalId: 'app_9', risk: 'MEDIUM', readOnly: false, destructive: false, arguments: {} } });
        }
        return json({ servers: [server()] });
      }),
    );
    render(
      <MemoryRouter>
        <McpPage />
      </MemoryRouter>,
    );
    await screen.findByTestId('mcp-server-notes');
    const tryButtons = screen.getAllByRole('button', { name: 'Try' });
    await userEvent.click(tryButtons[0]!);
    const box = screen.getByLabelText('Arguments for echo');
    await userEvent.clear(box);
    await userEvent.type(box, '{{"text":"hi"}');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('try-result-echo')).toHaveTextContent('echo: hi');
    await userEvent.click(screen.getAllByRole('button', { name: 'Try' })[0]!);
    await userEvent.click(screen.getAllByRole('button', { name: 'Run' })[0]!);
    await waitFor(() => expect(screen.getByTestId('tool-approval')).toHaveTextContent('notes.create_note'));
  });
});

describe('MCP page — demo server shortcut (local development only)', () => {
  it('fills the form with the local demo server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ servers: [] })));
    render(
      <MemoryRouter>
        <McpPage showDemo />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Use the demo server' }));
    expect(screen.getByLabelText('Server name')).toHaveValue('notes');
    expect(screen.getByLabelText('Server URL')).toHaveValue('http://127.0.0.1:8765/mcp');
  });

  it('is not shown in production builds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ servers: [] })));
    render(
      <MemoryRouter>
        <McpPage showDemo={false} />
      </MemoryRouter>,
    );
    await screen.findByTestId('mcp-empty');
    expect(screen.queryByRole('button', { name: 'Use the demo server' })).not.toBeInTheDocument();
  });
});
