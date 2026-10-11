/**
 * CodeConClave — comms service tests.
 *
 * Pins: project ownership enforced before any fetch, live fetch delegates to
 * the injected engine (never raw Gmail), provided-threads path needs no
 * network, drafts built only for candidates, audit carries counts, and no
 * send path exists (requestSendDraft is NOT called anywhere here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../audit/service.js', () => ({ recordAudit: audit }));

import { triageEmailInbox, draftEmailReply } from './service.js';

const owned = vi.fn(async () => {});
const THREADS = [
  { id: 'a', from: 'noreply@x.com', subject: 'Receipt', snippet: 'thanks' },
  { id: 'b', from: 'a@b.com', subject: 'Call?', snippet: 'Meet at 3pm?' },
];

describe('comms service — email triage orchestration', () => {
  beforeEach(() => {
    audit.mockClear();
    owned.mockClear();
  });

  it('triages provided threads without any network and audits counts', async () => {
    const out = await triageEmailInbox('u1', { projectId: 'p1', threads: THREADS }, { assertProjectOwned: owned });
    expect(owned).toHaveBeenCalledWith('u1', 'p1');
    expect(out.summary.counts).toEqual({ DRAFT_CANDIDATE: 1, NEEDS_REVIEW: 0, NOISE: 1 });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]!.sendPolicy).toBe('APPROVAL_REQUIRED');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'comms.email_triaged' }));
  });

  it('fetches live threads through the injected engine when a connection is given', async () => {
    const engine = vi.fn(async (opts: { action: string }) => {
      if (opts.action === 'gmail.messages.list') return { ok: true, data: { messages: [{ id: 'g1' }] } };
      return {
        ok: true,
        data: { payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'Hi?' }] }, snippet: 'hello?' },
      };
    });
    const out = await triageEmailInbox('u1', { projectId: 'p1', connectionId: 'c1' }, { assertProjectOwned: owned, engine });
    expect(engine).toHaveBeenCalledWith(expect.objectContaining({ action: 'gmail.messages.list' }));
    expect(engine).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'gmail.send' }));
    expect(out.summary.decisions).toHaveLength(1);
  });

  it('refuses without a source of threads', async () => {
    await expect(triageEmailInbox('u1', { projectId: 'p1' }, { assertProjectOwned: owned })).rejects.toMatchObject({
      errorCode: 'invalid_input',
    });
  });

  it('builds a draft for one thread', () => {
    expect(draftEmailReply(THREADS[1]!).subject).toBe('Re: Call?');
  });
});
