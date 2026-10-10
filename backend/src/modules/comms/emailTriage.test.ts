/**
 * CodeConClave — scoped email triage tests.
 *
 * Pins: deterministic verdicts with reasons, draft-only construction (the
 * draft can never self-send — it carries APPROVAL_REQUIRED and a placeholder
 * body), inbox counting/bounds, and the service layer delegating list/get to
 * the plugin engine and send ONLY to the approval-gated engine path. No
 * network, no Gmail, no credentials anywhere in this file.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyThread,
  triageInbox,
  buildReplyDraft,
  fetchUnreadThreads,
  requestSendDraft,
} from './emailTriage.js';

describe('email triage — deterministic classification', () => {
  it('routes machine/bulk mail to NOISE with reasons', () => {
    const d = classifyThread({ id: 'm1', from: 'newsletter@example.com', subject: 'Weekly deals - unsubscribe here', snippet: 'view in browser' });
    expect(d.verdict).toBe('NOISE');
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('routes money/credential/legal topics to NEEDS_REVIEW', () => {
    const d = classifyThread({ id: 'm2', from: 'boss@company.com', subject: 'Invoice payment overdue', snippet: 'please review the attached invoice' });
    expect(d.verdict).toBe('NEEDS_REVIEW');
    expect(d.reasons.join(' ')).toContain('sensitive');
  });

  it('routes long threads to NEEDS_REVIEW instead of guessing', () => {
    const d = classifyThread({ id: 'm3', from: 'a@b.com', subject: 'Thread', snippet: 'word '.repeat(130) });
    expect(d.verdict).toBe('NEEDS_REVIEW');
  });

  it('marks short scheduling asks as DRAFT_CANDIDATE (draftable, not sendable)', () => {
    const d = classifyThread({ id: 'm4', from: 'a@b.com', subject: 'Call tomorrow?', snippet: 'Can we meet tomorrow at 10:30 to review?' });
    expect(d.verdict).toBe('DRAFT_CANDIDATE');
  });

  it('marks short direct questions as DRAFT_CANDIDATE', () => {
    const d = classifyThread({ id: 'm5', from: 'a@b.com', subject: 'Quick question', snippet: 'Is the deploy done?' });
    expect(d.verdict).toBe('DRAFT_CANDIDATE');
  });

  it('defaults anything unexplainable to NEEDS_REVIEW', () => {
    const d = classifyThread({ id: 'm6', from: 'a@b.com', subject: 'Hello', snippet: 'Just saying hello, no action needed really.' });
    expect(d.verdict).toBe('NEEDS_REVIEW');
  });

  it('rejects threads without id/sender', () => {
    expect(() => classifyThread({ id: '', from: '', subject: 'x', snippet: 'y' })).toThrow(/thread id and sender/);
  });
});

describe('email triage — inbox + drafts', () => {
  it('counts verdicts across an inbox', () => {
    const out = triageInbox([
      { id: 'a', from: 'noreply@x.com', subject: 'Receipt', snippet: 'thanks' },
      { id: 'b', from: 'a@b.com', subject: 'Call?', snippet: 'Meet at 3pm?' },
      { id: 'c', from: 'a@b.com', subject: 'Hi', snippet: 'Just hello there friend.' },
    ]);
    expect(out.counts).toEqual({ DRAFT_CANDIDATE: 1, NEEDS_REVIEW: 1, NOISE: 1 });
  });

  it('bounds triage runs at 100 threads', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, from: 'a@b.com', subject: 's', snippet: 'x' }));
    expect(() => triageInbox(many)).toThrow(/at most 100/);
  });

  it('builds a draft that cannot self-send', () => {
    const draft = buildReplyDraft({ id: 'm9', from: 'a@b.com', subject: 'Call?', snippet: 'Meet?' });
    expect(draft.to).toEqual(['a@b.com']);
    expect(draft.subject).toBe('Re: Call?');
    expect(draft.bodyTemplate).toContain('[Write the reply here');
    expect(draft.sendPolicy).toBe('APPROVAL_REQUIRED');
    expect(draft.sourceThreadId).toBe('m9');
  });
});

describe('email triage — plugin-engine service layer (mocked transport)', () => {
  function engineFor(scripts: Record<string, unknown>) {
    return vi.fn(async (opts: { action: string }) => ({ ok: true, data: scripts[opts.action] ?? null }));
  }

  it('fetches unread threads via gmail.messages.list/get only', async () => {
    const engine = engineFor({
      'gmail.messages.list': { messages: [{ id: 'g1' }, { id: 'g2' }] },
      'gmail.messages.get': {
        payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'Hi?' }] },
        snippet: 'hello there?',
      },
    });
    const threads = await fetchUnreadThreads('u1', 'conn-1', {}, engine);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ id: 'g1', from: 'a@b.com', subject: 'Hi?' });
    const actions = engine.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(['gmail.messages.list', 'gmail.messages.get', 'gmail.messages.get']);
    expect(actions).not.toContain('gmail.send');
  });

  it('requestSendDraft delegates to the approval-gated engine gmail.send action', async () => {
    const engine = engineFor({ 'gmail.send': { id: 'sent-1' } });
    const out = await requestSendDraft(
      'u1',
      'conn-1',
      { to: ['a@b.com'], subject: 'Re: Hi?', body: 'Approved body', idempotencyKey: 'k-1' },
      engine,
    );
    expect(out).toEqual({ id: 'sent-1' });
    expect(engine).toHaveBeenCalledWith({
      userId: 'u1',
      connectionId: 'conn-1',
      action: 'gmail.send',
      input: { to: ['a@b.com'], subject: 'Re: Hi?', body: 'Approved body', idempotencyKey: 'k-1' },
    });
  });

  it('requestSendDraft refuses incomplete drafts before touching the engine', async () => {
    const engine = engineFor({});
    await expect(requestSendDraft('u1', 'conn-1', { to: [], subject: '', body: '' }, engine)).rejects.toThrow(/complete draft/);
    expect(engine).not.toHaveBeenCalled();
  });

  it('requires user and connection identity', async () => {
    await expect(fetchUnreadThreads('', '', {}, engineFor({}))).rejects.toThrow(/userId and connectionId/);
  });
});
