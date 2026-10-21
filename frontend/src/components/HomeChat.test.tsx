/**
 * CodeConClave — HomeChat tests. The all-in-one Cursor-style composer on Home:
 * streams a reply through the real SSE chat endpoint against a stub fetch and
 * renders user/assistant/system rows without leaving dead state behind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { HomeChat, parseNavCommand, voiceErrorMessage } from './HomeChat';

const SSE_BODY =
  'event: thinking_start\ndata: {}\n\n' +
  'event: delta\ndata: {"delta":"Hello from the home chat."}\n\n' +
  'event: done\ndata: {}\n\n';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/ai/models')) {
      return jsonResponse({ models: [], defaultModel: null });
    }
    if (url.includes('/api/v1/conversations/chat')) {
      return sseResponse(SSE_BODY);
    }
    return jsonResponse({ data: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HomeChat', () => {
  it('shows the composer with a model picker and full-chat link', () => {
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    // The home composer stands alone: no "open full chat" escape hatch.
    expect(screen.queryByText('Open full chat')).not.toBeInTheDocument();
  });

  it('streams a reply and renders the assistant bubble', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/conversations/chat'));
    expect(chatCalls).toHaveLength(1);
    const init = chatCalls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? '')) as { content: string; mode: string };
    expect(body.content).toBe('hi');
    expect(body.mode).toBe('COWORK');
  });

  it('surfaces an interrupted stream as a system row', async () => {    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
      if (url.includes('/api/v1/conversations/chat')) return sseResponse('event: thinking_start\ndata: {}\n\n');
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'ping');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/interrupted/i)).toBeInTheDocument();
  });

  it('starts centered and empty, then flows upward in chronological order', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(container.querySelector('.cc-homechat--empty')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    // Centered hero is gone once the conversation exists...
    expect(container.querySelector('.cc-homechat--empty')).not.toBeInTheDocument();
    // ...and the user message precedes the assistant reply in DOM order
    // (oldest at top, newest appended at the bottom, auto-scrolled into view).
    const userRow = screen.getByText('hi');
    const asstRow = screen.getByText('Hello from the home chat.');
    expect(userRow.compareDocumentPosition(asstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the 3D thinking indicator only while a real generation runs', async () => {    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
      if (url.includes('/api/v1/conversations/chat')) return gate;
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'think hard');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByTestId('homechat-thinking-moon')).toBeInTheDocument();
    release(sseResponse(SSE_BODY));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('homechat-thinking-moon')).not.toBeInTheDocument());
  });

  it('greets by name with a system line and Chat/Cowork only (Agent lives in sidebar)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/local-workspace/devices')) return jsonResponse({ devices: [] });
        if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
        return jsonResponse({ data: {} });
      }),
    );
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('homechat-hero')).toHaveTextContent(/Hi/);
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cowork' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull();
    // Driving lives in the sidebar now — home carries no agent pointers.
    expect(screen.queryByTestId('homechat-agent-hint')).toBeNull();
  });

  it('never sends AGENT from home: Cowork stays Cowork, Chat stays Chat', async () => {    let posted: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/local-workspace/devices')) {
          return jsonResponse({ devices: [{ id: 'd1', name: 'laptop', presence: 'ONLINE' }] });
        }
        if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(SSE_BODY);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    // No Agent tab on home even when a device is online — driving lives in sidebar.
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull();
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'list my project files');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    expect(posted.mode).toBe('COWORK');
  });

  it('sends mode COWORK when the Cowork tab opens the specialist pipeline', async () => {
    let posted: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/local-workspace/devices')) return jsonResponse({ devices: [] });
        if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(SSE_BODY);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Cowork' }));
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'rebuild auth with tests');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    expect(posted.mode).toBe('COWORK');
  });

  it('travels on "go to X": navigates without spending a generation', async () => {
    const user = userEvent.setup();
    function Where() {
      const loc = useLocation();
      return <p data-testid="where">{loc.pathname}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route path="/home" element={<HomeChat />} />
          <Route path="/ideas" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'go to ideas tab');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/ideas');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/conversations/chat'))).toBe(false);
  });

  it('navigates and still sends the remainder after "and"', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/home']}>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'go to ideas and draft a login page');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/conversations/chat'));
    expect(chatCalls).toHaveLength(1);
    expect(JSON.parse(String(chatCalls[0]?.[1]?.body ?? '')) as { content: string }).toMatchObject({
      content: 'draft a login page',
    });
  });

  it('attaches a text file so it travels with the next message', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    const file = new File(['project context here'], 'notes.txt', { type: 'text/plain' });
    await user.upload(screen.getByTestId('homechat-file'), file);
    expect(await screen.findByTestId('homechat-attachments')).toHaveTextContent('notes.txt');
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'use this');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/conversations/chat'));
    const body = JSON.parse(String(chatCalls[0]?.[1]?.body ?? '')) as { content: string };
    expect(body.content).toContain('[Attached file: notes.txt]');
    expect(body.content).toContain('project context here');
  });

  it('hides the voice button where speech recognition is unavailable', () => {
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('homechat-voice')).toBeNull();
  });
});

describe('parseNavCommand', () => {
  it('maps destinations, hashes and remainders; rejects the rest', () => {
    expect(parseNavCommand('go to ideas tab')).toMatchObject({ path: '/ideas', label: 'Ideas', rest: '' });
    expect(parseNavCommand('open my mail')).toMatchObject({ path: '/coworker', hash: '#email' });
    expect(parseNavCommand('go to code map')).toMatchObject({ hash: '#scan' });
    expect(parseNavCommand('take me to approvals')).toMatchObject({ path: '/approvals' });
    expect(parseNavCommand('go to ideas and draft x')).toMatchObject({ path: '/ideas', rest: 'draft x' });
    expect(parseNavCommand('hello there')).toBeNull();
    expect(parseNavCommand('go to mars')).toBeNull();
  });
});
describe('HomeChat — incognito + follow-ups', () => {
  const DONE_WITH_CONV =
    'event: delta\ndata: {"delta":"ok"}\n\n' +
    'event: done\ndata: {"messageId":"msg_1","conversationId":"conv_home_1"}\n\n';

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/conversations/chat')) return sseResponse(DONE_WITH_CONV);
      return jsonResponse({ data: {} });
    });
  });

  const chatBodies = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).includes('/api/v1/conversations/chat'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  it('starts an incognito chat and continues the same conversation on follow-ups', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await user.click(screen.getByTestId('incognito-toggle'));
    expect(screen.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('incognito-banner')).toHaveTextContent(/Not saved to your history, not used for memory/);

    await user.type(screen.getByPlaceholderText('Ask anything…'), 'first');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(chatBodies()).toHaveLength(1));
    expect(chatBodies()[0]).toMatchObject({ content: 'first', mode: 'CHAT', incognito: true });
    expect(chatBodies()[0]!.conversationId).toBeUndefined();

    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'second');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(chatBodies()).toHaveLength(2));
    // Follow-up continues the (already incognito) conversation.
    expect(chatBodies()[1]).toMatchObject({ content: 'second', conversationId: 'conv_home_1' });
    expect(chatBodies()[1]!.incognito).toBeUndefined();
  });

  it('incognito is unavailable for Cowork runs', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Cowork' }));
    expect(screen.getByTestId('incognito-toggle')).toBeDisabled();
  });
});

describe('HomeChat — pipeline v3 trace + receipt', () => {
  const receipt = {
    runId: 'run_9',
    status: 'VERIFIED',
    role: 'Computational Math',
    contractVersion: 'computational-math@abc',
    engine: 'CodeConClave AI · cloud engine',
    cached: false,
    attempts: 2,
    tokens: { used: 500, budget: 12588 },
    proofs: [{ kind: 'identity', verifier: 'cas', verdict: 'PASS', method: 'symbolic+numeric', detail: 'symbolic residual = 0', proofHash: 'b'.repeat(64) }],
    verdict: { passed: 1, failed: 0, errors: 0 },
    proofHash: 'c'.repeat(64),
  };
  const SSE =
    'event: stage\ndata: {"stage":"intake","status":"done","label":"Intake · budget locked"}\n\n' +
    'event: delta\ndata: {"delta":"WRONG first try"}\n\n' +
    'event: stage\ndata: {"stage":"repair","status":"start","label":"Repair · attempt 1 of 2","reset":true}\n\n' +
    'event: delta\ndata: {"delta":"Correct answer."}\n\n' +
    `event: done\ndata: ${JSON.stringify({ messageId: 'msg_9', conversationId: 'conv_9', pipeline: receipt })}\n\n`;

  it('clears the first attempt on repair and shows the sealed receipt', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('/api/v1/conversations/chat') ? sseResponse(SSE) : jsonResponse({ data: {} }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'expand (x+1)^2');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText('Verified · 1/1 proof pass')).toBeInTheDocument();
    expect(screen.getByText('Correct answer.')).toBeInTheDocument();
    expect(screen.queryByText(/WRONG first try/)).not.toBeInTheDocument();
  });
});

import { looksLikeImageRequest } from './HomeChat';

describe('HomeChat — image generation', () => {
  it('recognises image requests in plain words', () => {
    expect(looksLikeImageRequest('Draw an image of a gold robot on a dark desk')).toBe(true);
    expect(looksLikeImageRequest('generate a logo for CodeConClave')).toBe(true);
    expect(looksLikeImageRequest('create a react component')).toBe(false);
    expect(looksLikeImageRequest('what is an image sensor?')).toBe(false);
  });

  it('sends an image request into a project and shows the picture inline', async () => {
    const IMG_SSE = 'event: image\ndata: {"fileId":"file_1","mimeType":"image/png"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n';
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/conversations/chat')) return sseResponse(IMG_SSE);
      if (url.endsWith('/api/v1/projects')) return jsonResponse({ data: { projects: [{ id: 'prj_7', updated_at: new Date().toISOString() }] } });
      return jsonResponse({ data: {} });
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'draw an image of a lighthouse at dusk');
    await user.click(screen.getByRole('button', { name: /send/i }));
    const img = await screen.findByAltText('Generated image');
    expect(img.getAttribute('src')).toBe('/api/v1/files/file_1/content?projectId=prj_7');
    const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/conversations/chat'))![1].body));
    expect(body).toMatchObject({ imageRequest: true, projectId: 'prj_7', mode: 'CHAT' });
  });
});

describe('HomeChat — /setup', () => {
  it('opens the guided setup instead of sending /setup as a message', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), '/setup');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/conversations/chat'))).toBe(false);
  });

  it('opens from Settings via ?setup=1', async () => {
    render(
      <MemoryRouter initialEntries={['/home?setup=1']}>
        <HomeChat hero={false} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeInTheDocument();
  });
});

describe('HomeChat — plan first (Cowork)', () => {
  it('sends planFirst, shows the plan, and starts the team only after approval', async () => {
    let posted: Record<string, unknown> = {};
    let decided: Record<string, unknown> | null = null;
    const plan = { goal: 'rebuild auth', source: 'planner', steps: [{ order: 1, coworker: 'ARCHITECT' }, { order: 2, coworker: 'CODER' }] };
    const body =
      'event: delta\ndata: {"delta":"Here\'s the plan. Nothing runs until you approve it."}\n\n' +
      `event: done\ndata: ${JSON.stringify({ messageId: null, taskId: 'tsk_p1', approvalId: 'app_p1', plan })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(body);
        }
        if (url.includes('/approvals/app_p1/decide')) {
          decided = JSON.parse(String(init?.body));
          return jsonResponse({ data: { approval: { id: 'app_p1', status: 'APPROVED' } } });
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Cowork' }));
    await user.click(screen.getByRole('button', { name: 'Plan first' }));
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'rebuild auth with tests');
    await user.click(screen.getByRole('button', { name: /send/i }));
    const card = await screen.findByTestId('plan-approval');
    expect(posted.planFirst).toBe(true);
    expect(card).toHaveTextContent('Archie · Architect');
    expect(card).toHaveTextContent('Cody · Coder');
    await user.click(screen.getByRole('button', { name: 'Approve and start' }));
    await waitFor(() => expect(decided).toEqual({ decision: 'APPROVE' }));
    expect(await screen.findByText(/the team is starting/)).toBeInTheDocument();
  });
});

describe('HomeChat — Cowork always has a project', () => {
  it('starts a "My work" project when the account has none, instead of failing', async () => {
    let posted: Record<string, unknown> = {};
    let createdWith: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/v1/projects') && init?.method === 'POST') {
          createdWith = JSON.parse(String(init.body));
          return jsonResponse({ data: { project: { id: 'prj_new' } } });
        }
        if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(SSE_BODY);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Cowork' }));
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'build a landing page');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(posted.projectId).toBe('prj_new'));
    expect(createdWith).toMatchObject({ name: 'My work' });
  });
});

describe('HomeChat — MCP tools (Article 8)', () => {
  it('shows Tools only with a connected server, sends mcpTools, and keeps the approval card after the answer', async () => {
    let posted: Record<string, unknown> = {};
    const body =
      'event: delta\ndata: {"delta":"`notes.create_note` needs your approval before it runs."}\n\n' +
      `event: tool_approval\ndata: ${JSON.stringify({ approvalId: 'app_m1', server: 'notes', tool: 'create_note', arguments: { title: 'Launch' }, risk: 'MEDIUM', destructive: false })}\n\n` +
      'event: done\ndata: {"messageId":"msg_1"}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/v1/mcp/servers')) {
          return jsonResponse({ data: { servers: [{ enabled: true, status: 'CONNECTED', tools: [{ name: 'echo' }, { name: 'create_note' }] }] } });
        }
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(body);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Chat' }));
    const tools = await screen.findByRole('button', { name: 'Tools' });
    expect(tools).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'make a note called Launch');
    await user.click(screen.getByRole('button', { name: /send/i }));
    const card = await screen.findByTestId('tool-approval');
    expect(posted.mcpTools).toBe(true);
    expect(card).toHaveTextContent('notes.create_note');
    // The answer finished ("done") and the card is still there.
    await waitFor(() => expect(screen.getByText(/needs your approval before it runs/)).toBeInTheDocument());
    expect(screen.getByTestId('tool-approval')).toBeInTheDocument();
  });

  it('no MCP server → no Tools chip and no mcpTools flag', async () => {
    let posted: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/v1/mcp/servers')) return jsonResponse({ data: { servers: [] } });
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(SSE_BODY);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Chat' }));
    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    expect(posted.mcpTools).toBeUndefined();
  });
});

describe('HomeChat — Focus Morph + Limit Guard (Part VI)', () => {
  it('morphs to what is being typed and puts the right tool one click away', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    const box = screen.getByPlaceholderText('Ask anything…');
    expect(screen.queryByTestId('focus-morph')).not.toBeInTheDocument();
    await user.type(box, 'checkout is failing');
    const focus = await screen.findByTestId('focus-morph');
    expect(focus).toHaveTextContent('Debugging focus');
    expect(box.closest('[data-focus]')).toHaveAttribute('data-focus', 'debug');
    await user.click(screen.getByRole('button', { name: 'Evidence-first fix' }));
    expect(box).toHaveValue('/bugfix checkout is failing');
    // Slash commands are already a choice, so the chips step aside.
    expect(screen.queryByTestId('focus-morph')).not.toBeInTheDocument();
  });

  it('opens the Limit Guard pop-up details when the stream reports a usage limit', async () => {
    const hits: unknown[] = [];
    const on = (e: Event) => hits.push((e as CustomEvent).detail);
    window.addEventListener('cc:usage-limit-hit', on);
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/v1/conversations/chat'))
          return sseResponse(
            `event: error
data: ${JSON.stringify({ code: 'usage_limit_reached', message: 'Session limit reached', details: { window: 'session', resetsAt, used: 10, limit: 10 } })}

`,
          );
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(hits).toEqual([expect.objectContaining({ code: 'usage_limit_reached', window: 'session', resetsAt, used: 10, limit: 10 })]));
    window.removeEventListener('cc:usage-limit-hit', on);
  });
});

describe('voiceErrorMessage', () => {
  it('explains a blocked mic and a missing device', () => {
    expect(voiceErrorMessage('not-allowed')).toMatch(/blocked/i);
    expect(voiceErrorMessage('audio-capture')).toMatch(/no microphone/i);
    expect(voiceErrorMessage('no-speech')).toMatch(/speak again/i);
  });
  it('stays quiet when you stopped it yourself', () => {
    expect(voiceErrorMessage('aborted')).toBeNull();
    expect(voiceErrorMessage(undefined)).toBeNull();
  });
});
