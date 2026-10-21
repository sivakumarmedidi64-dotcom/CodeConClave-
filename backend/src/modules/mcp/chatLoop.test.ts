/**
 * Article 8 — the chat tool loop: a scripted model asks for tools; the loop
 * runs read-only ones, stops for approval on the rest, and feeds results back
 * as untrusted data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const script = vi.hoisted(() => ({ replies: [] as string[], seen: [] as { role: string; content: string }[][] }));
const svc = vi.hoisted(() => ({
  outcomes: [] as unknown[],
  calls: [] as { server: string; tool: string; arguments?: unknown }[],
}));

vi.mock('../ai/gateway.js', () => ({
  completeWithFallback: vi.fn(async (args: { messages: { role: string; content: string }[]; onChunk?: (c: { delta: string }) => void }) => {
    script.seen.push(args.messages);
    const text = script.replies.shift() ?? 'done';
    args.onChunk?.({ delta: text });
    return { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0, modelId: 'm', providerId: 'p' };
  }),
}));

vi.mock('./service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./service.js')>();
  return {
    ...real,
    enabledTools: vi.fn(async () => [
      { server: 'notes', tool: real.toToolView({ name: 'echo', description: 'Echo', annotations: { readOnlyHint: true } }) },
      { server: 'notes', tool: real.toToolView({ name: 'create_note', description: 'Create a note' }) },
    ]),
    callMcpTool: vi.fn(async (_u: string, input: { server: string; tool: string; arguments?: unknown }) => {
      svc.calls.push(input);
      return svc.outcomes.shift();
    }),
  };
});

import { runMcpLoop } from './chatLoop.js';

const ctx = { userId: 'u1', sessionId: 's1', conversationId: 'c1', planId: 'pro' as const };

beforeEach(() => {
  script.replies = [];
  script.seen = [];
  svc.outcomes = [];
  svc.calls = [];
});

describe('chat with MCP tools', () => {
  it('runs a read-only tool, feeds the result back as untrusted data, then answers', async () => {
    script.replies = ['{"tool":"notes.echo","input":{"text":"hi"}}', 'The tool said: echo: hi'];
    svc.outcomes = [{ status: 'ok', server: 'notes', tool: 'echo', text: 'echo: hi', isError: false }];
    const deltas: string[] = [];
    const r = await runMcpLoop({ ctx, userId: 'u1', messages: [], currentUserText: 'say hi', events: { onDelta: (d) => void deltas.push(d) } });
    expect(r.text).toBe('The tool said: echo: hi');
    expect(svc.calls).toEqual([{ server: 'notes', tool: 'echo', arguments: { text: 'hi' }, via: 'chat' }]);
    expect(deltas.join('')).toContain('**Tool** `notes.echo`');
    const second = script.seen[1]!.map((m) => m.content).join('\n');
    expect(second).toContain('Result of MCP tool notes.echo');
    expect(second).toContain('untrusted data');
    expect(script.seen[0]![0]!.content).toContain('notes.create_note {} [asks the user first]');
  });

  it('stops and asks for approval — nothing runs', async () => {
    script.replies = ['{"tool":"notes.create_note","input":{"title":"Plan"}}'];
    svc.outcomes = [{ status: 'approval_required', server: 'notes', tool: 'create_note', approvalId: 'app_1', risk: 'MEDIUM', readOnly: false, destructive: false, arguments: { title: 'Plan' } }];
    const approvals: unknown[] = [];
    const r = await runMcpLoop({ ctx, userId: 'u1', messages: [], currentUserText: 'make a note', events: { onToolApproval: (i) => void approvals.push(i) } });
    expect(approvals).toEqual([{ approvalId: 'app_1', server: 'notes', tool: 'create_note', arguments: { title: 'Plan' }, risk: 'MEDIUM', destructive: false }]);
    expect(r.text).toMatch(/needs your approval/);
    expect(r.steps).toBe(1);
  });

  it('tells the model when a call was blocked, and keeps going', async () => {
    script.replies = ['{"tool":"notes.create_note","input":{}}', 'I could not create the note: your rules block it.'];
    svc.outcomes = [];
    const { callMcpTool } = await import('./service.js');
    vi.mocked(callMcpTool).mockRejectedValueOnce(new Error('Blocked by policy: Blocked by your rule: deny mcp_call notes/*'));
    const r = await runMcpLoop({ ctx, userId: 'u1', messages: [], currentUserText: 'make a note', events: {} });
    expect(r.text).toMatch(/could not create/);
    expect(script.seen[1]!.map((m) => m.content).join('\n')).toContain('did not run: Blocked by policy');
  });
});
