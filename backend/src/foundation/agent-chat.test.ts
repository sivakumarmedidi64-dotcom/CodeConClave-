/**
 * Agent chat mode — unit tests for the model↔local-agent tool loop.
 * The gateway and the hub are mocked; policy and wiring stay real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractToolJsonForTest, runAgentLoop, AGENT_MODE_TOOLS } from '../modules/conversations/agentChat.js';
import { evaluateToolCall, registerGrants, revokeGrants } from '../modules/execution/policy.js';
import { AppError } from '../shared/errors.js';

const gatewayMock = vi.hoisted(() => ({
  complete: vi.fn(async () => {
    throw new Error('no scripted response');
  }),
}));

vi.mock('../modules/ai/gateway.js', () => ({
  completeWithFallback: async (opts: { onChunk: (c: { delta: string }) => void }) => {
    const text = await gatewayMock.complete();
    if (typeof text === 'string') opts.onChunk({ delta: text });
    return {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.002,
      modelId: 'test-model',
      providerId: 'test-provider',
      durationMs: 1,
    };
  },
}));

const hubMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../modules/agent/ws.js', () => ({
  agentWs: () => ({ executeCommandResult: hubMock.execute }),
}));

describe('agent chat loop', () => {
  beforeEach(() => {
    gatewayMock.complete.mockReset();
    gatewayMock.complete.mockImplementation(async () => {
      throw new Error('no scripted response');
    });
    hubMock.execute.mockReset();
    registerGrants([
      { userId: 'u1', grantId: 'g-exec', capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + 60_000 },
      { userId: 'u1', grantId: 'g-read', capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 },
      { userId: 'u1', grantId: 'g-write', capability: 'WRITE_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 },
    ]);
  });

  afterEach(() => {
    revokeGrants('u1');
  });

  it('exposes the expected tool surface', () => {
    expect(AGENT_MODE_TOOLS).toEqual(['terminal_exec', 'file_list', 'file_read', 'file_write', 'browser_open']);
  });

  it('treats a plain answer as the final response (no execution)', async () => {
    gatewayMock.complete.mockResolvedValueOnce('Done — listed the workspace and nothing else needed running.');
    const deltas: string[] = [];
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'list my files',
      events: { onDelta: (d) => void deltas.push(d) },
    });
    expect(result.text).toContain('Done — listed');
    expect(hubMock.execute).not.toHaveBeenCalled();
    expect(deltas.join('')).not.toContain('**Agent step');
  });

  it('executes a terminal_exec tool call and feeds the result back', async () => {
    gatewayMock.complete
      .mockResolvedValueOnce('{"tool":"terminal_exec","input":{"command":"git status"}}')
      .mockResolvedValueOnce('Found the repo as expected.');
    hubMock.execute.mockResolvedValueOnce({ ok: true, output: 'docs  other.txt', payload: null, error: null });
    const deltas: string[] = [];
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'find the docs folder',
      events: { onDelta: (d) => void deltas.push(d) },
    });
    expect(hubMock.execute).toHaveBeenCalledTimes(1);
    const [userId, deviceId, cmd] = hubMock.execute.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(userId).toBe('u1');
    expect(deviceId).toBe('d1');
    expect(cmd.kind).toBe('terminal.exec');
    expect(cmd.command).toBe('git status');
    expect(result.text).toBe('Found the repo as expected.');
    expect(deltas.join('')).toContain('**Agent step 1**');
    expect(deltas.join('')).toContain('docs  other.txt');
  });

  it('stops without executing when policy denies the tool', async () => {
    gatewayMock.complete.mockResolvedValueOnce('{"tool":"terminal_exec","input":{"command":"rm -rf /"}}');
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'wipe the disk',
      events: {},
    });
    expect(hubMock.execute).not.toHaveBeenCalled();
    expect(result.text).toContain('blocked by policy');
  });

  it('stops without executing when a tool needs approval', async () => {
    gatewayMock.complete.mockResolvedValueOnce('{"tool":"file_write","input":{"path":"notes.txt","content":"x"}}');
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'write a note',
      events: {},
    });
    expect(hubMock.execute).not.toHaveBeenCalled();
    expect(result.text).toContain('approval');
  });

  it('handles an unknown tool by failing closed', async () => {
    gatewayMock.complete.mockResolvedValueOnce('{"tool":"rm_disk","input":{"path":"/"}}');
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'do the thing',
      events: {},
    });
    expect(hubMock.execute).not.toHaveBeenCalled();
    expect(result.text).toContain('unknown tool');
  });

  it('surfaces a model error instead of claiming success', async () => {
    gatewayMock.complete.mockResolvedValueOnce('{"tool":"terminal_exec","input":{"command":"git status"}}');
    hubMock.execute.mockRejectedValueOnce(AppError.unavailable('local_agent_offline', 'Local Agent is offline'));
    const result = await runAgentLoop({
      ctx: { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'free' },
      userId: 'u1',
      deviceId: 'd1',
      messages: [],
      currentUserText: 'run git status',
      events: {},
    });
    expect(result.text).toContain('Local Agent is offline');
  });

  it('parses tool JSON from code-fenced markdown', () => {
    expect(extractToolJsonForTest('```json\n{"tool":"browser_open","input":{"url":"https://x.dev"}}\n```')).toEqual({
      tool: 'browser_open',
      input: { url: 'https://x.dev' },
    });
  });
});

/** Ensure policy treats browser_open + file_list as LOW auto-approve. */
describe('agent tool policy surface', () => {
  beforeEach(() => {
    registerGrants([
      { userId: 'u-pol', grantId: 'g-exec2', capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + 60_000 },
      { userId: 'u-pol', grantId: 'g-read2', capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 },
    ]);
  });

  afterEach(() => revokeGrants('u-pol'));

  it('browser_open is LOW and needs no approval for public URLs', () => {
    const d = evaluateToolCall({ tool: 'browser_open', input: { url: 'https://example.com' }, userId: 'u-pol' });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.risk).toBe('LOW');
      expect(d.requiresApproval).toBe(false);
    }
  });
  it('file_list is LOW and needs no approval', () => {
    const d = evaluateToolCall({ tool: 'file_list', input: { path: 'src' }, userId: 'u-pol' });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.risk).toBe('LOW');
      expect(d.requiresApproval).toBe(false);
    }
  });
});