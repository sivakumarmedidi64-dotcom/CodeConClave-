import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- in-memory ledger (real hash chain)
interface MemRun {
  id: string;
  status?: string;
  proofHash?: string | null;
  head?: string;
  receipt?: Record<string, unknown>;
  patch: Record<string, unknown>;
}
const mem = {
  runs: new Map<string, MemRun>(),
  events: new Map<string, { seq: number; stage: string; payload: Record<string, unknown>; parent_hash: string; event_hash: string; created_at: Date }[]>(),
  cache: new Map<string, { finalText: string; receipt: Record<string, unknown>; runId: string }>(),
  failCreate: false,
  n: 0,
};
vi.mock('./ledger.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ledger.js')>();
  return {
    ...real,
    createRun: vi.fn(async (run: { ownerId: string }) => {
      if (mem.failCreate) throw new Error('db down');
      const id = `run_${++mem.n}`;
      mem.runs.set(id, { id, patch: {} });
      mem.events.set(id, []);
      return { runId: id, ownerId: run.ownerId, seq: 0, head: `GENESIS:${id}` };
    }),
    appendEvent: vi.fn(async (cur: { runId: string; seq: number; head: string }, stage: string, payload: Record<string, unknown>) => {
      const seq = cur.seq + 1;
      const hash = real.eventHash(cur.head, seq, stage, JSON.parse(JSON.stringify(payload)));
      mem.events.get(cur.runId)!.push({ seq, stage, payload: JSON.parse(JSON.stringify(payload)), parent_hash: cur.head, event_hash: hash, created_at: new Date() });
      cur.seq = seq;
      cur.head = hash;
      return hash;
    }),
    updateRun: vi.fn(async (cur: { runId: string }, patch: Record<string, unknown>) => {
      Object.assign(mem.runs.get(cur.runId)!.patch, patch);
    }),
    sealRun: vi.fn(async (cur: { runId: string; head: string }, status: string, proofHash: string | null, receipt: Record<string, unknown>) => {
      Object.assign(mem.runs.get(cur.runId)!, { status, proofHash, head: cur.head, receipt });
    }),
    cacheGet: vi.fn(async (_o: string, key: string) => mem.cache.get(key) ?? null),
    cachePut: vi.fn(async (_o: string, key: string, runId: string, finalText: string, receipt: Record<string, unknown>) => {
      mem.cache.set(key, { finalText, receipt, runId });
    }),
    dnaVersion: vi.fn(async () => 'none'),
  };
});

// ---------------------------------------------------------------- scripted specialist
let answers: string[] = [];
const calls: { messages: { role: string; content: unknown }[]; residentRole?: string }[] = [];
let abortOnCall = false;
vi.mock('../../modules/ai/gateway.js', () => ({
  completeWithFallback: vi.fn(async (opts: { messages: { role: string; content: unknown }[]; opts?: { residentRole?: string }; onChunk?: (c: { delta: string }) => Promise<void> }) => {
    calls.push({ messages: opts.messages, residentRole: opts.opts?.residentRole });
    if (abortOnCall) throw new Error('Request cancelled');
    const text = answers.shift() ?? 'no scripted answer';
    for (let i = 0; i < text.length; i += 7) await opts.onChunk?.({ delta: text.slice(i, i + 7) }); // awkward chunk sizes on purpose
    return { text, modelId: 'test-model', providerId: 'test', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001, durationMs: 5, usedFallback: false, fallbackReason: null };
  }),
}));
vi.mock('../../modules/resident/infer.js', () => ({
  residentReady: vi.fn(() => ({ ok: false, reason: 'not configured' })),
  residentComplete: vi.fn(),
}));
let plan: 'none' | 'demo' | 'solo' | 'team' | 'api' = 'solo';
vi.mock('../../modules/usage/limits.js', () => ({ resolveLimitPlan: vi.fn(async () => plan) }));
const audits: { action: string }[] = [];
vi.mock('../../modules/audit/service.js', () => ({ recordAudit: vi.fn(async (a: { action: string }) => void audits.push(a)) }));

import { ClaimsStreamFilter, runPipeline, type StageEvent } from './run.js';
import { verifyEvents } from './ledger.js';

const claims = (arr: unknown[]) => '```claims\n' + JSON.stringify(arr) + '\n```';
const GOOD_MATH = 'Expanding gives x^2 + 2x + 1.\n' + claims([{ kind: 'identity', lhs: '(x+1)^2', rhs: 'x^2+2x+1' }]);
const BAD_MATH = 'It is x^2 + 1.\n' + claims([{ kind: 'identity', lhs: '(x+1)^2', rhs: 'x^2+1' }]);

function run(question: string, extra: Partial<Parameters<typeof runPipeline>[0]> = {}) {
  const stages: StageEvent[] = [];
  let streamed = '';
  const p = runPipeline({
    userId: 'usr_1',
    planId: 'pro',
    sessionId: 'ses_1',
    question,
    onStage: (e) => void stages.push(e),
    onDelta: (d) => {
      streamed += d;
    },
    buildMessages: async ({ roleSystem, question: q, repair }) => [
      { role: 'system', content: roleSystem },
      { role: 'user', content: repair ? `${q}\n\n${repair}` : q },
    ],
    ...extra,
  });
  return { p, stages, streamed: () => streamed };
}

beforeEach(() => {
  mem.runs.clear();
  mem.events.clear();
  mem.cache.clear();
  mem.failCreate = false;
  answers = [];
  calls.length = 0;
  audits.length = 0;
  abortOnCall = false;
  plan = 'solo';
});

describe('pipeline v3 — verified science answer', () => {
  it('routes to Computational Math, verifies the claim, hides the claims block, seals and caches', async () => {
    answers = [GOOD_MATH];
    const { p, stages, streamed } = run('Prove the identity (x+1)^2 = x^2 + 2x + 1 by expanding the polynomial');
    const out = await p;
    expect(out.status).toBe('VERIFIED');
    expect(out.receipt.role).toBe('Computational Math');
    expect(calls[0]!.residentRole).toBe('Computational Math'); // runs on its resident driver first
    expect(out.receipt.proofs).toHaveLength(1);
    expect(out.receipt.proofs[0]).toMatchObject({ verifier: 'cas', verdict: 'PASS' });
    expect(out.finalText).toBe('Expanding gives x^2 + 2x + 1.');
    expect(streamed()).not.toContain('```claims'); // never shown live
    expect(out.receipt.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stages.map((s) => s.stage)).toEqual(['intake', 'route', 'dispatch', 'gate', 'specialist', 'verify', 'act', 'seal']);
    const ev = mem.events.get(out.runId)!;
    expect(verifyEvents(out.runId, ev, mem.runs.get(out.runId)!.head!)).toMatchObject({ ok: true });
    expect(ev.map((e) => e.stage)).toEqual(['intake', 'cache', 'route', 'dispatch', 'gate', 'verify', 'act', 'seal']);
    expect(audits.some((a) => a.action === 'pipeline.sealed')).toBe(true);
    expect(mem.cache.size).toBe(1);
  });

  it('repairs a wrong claim (client told to reset the stream), then verifies', async () => {
    answers = [BAD_MATH, GOOD_MATH];
    const { p, stages } = run('Expand (x+1)^2 — algebra identity');
    const out = await p;
    expect(out.status).toBe('VERIFIED');
    expect(out.receipt.attempts).toBe(2);
    const repair = stages.find((s) => s.stage === 'repair')!;
    expect(repair.reset).toBe(true);
    // The repair prompt carries the kernel's exact finding.
    expect(String(calls[1]!.messages[1]!.content)).toMatch(/symbolic residual ≠ 0: 2\*x/);
  });

  it('escalates after the 3rd failed verification, and says so in the answer', async () => {
    answers = [BAD_MATH, BAD_MATH, BAD_MATH];
    const out = await run('simplify (x+1)^2 polynomial algebra').p;
    expect(out.status).toBe('ESCALATED');
    expect(out.receipt.attempts).toBe(3);
    expect(out.finalText.startsWith('⚠ Not verified')).toBe(true);
    expect(mem.events.get(out.runId)!.some((e) => e.stage === 'escalate')).toBe(true);
    expect(audits.some((a) => a.action === 'pipeline.escalated')).toBe(true);
    expect(mem.cache.size).toBe(0); // never cached
  });

  it('a science answer with no claims is repaired (it must be checkable)', async () => {
    answers = ['The answer is clearly x^2+2x+1.', GOOD_MATH];
    const out = await run('derivative and integral calculus: expand (x+1)^2').p;
    expect(out.status).toBe('VERIFIED');
    expect(String(calls[1]!.messages[1]!.content)).toMatch(/no machine-checkable claims/);
  });
});

describe('pipeline v3 — other paths', () => {
  it('a code answer without claims is UNVERIFIED (said plainly), not repaired', async () => {
    answers = ['```ts\nexport const add = (a: number, b: number) => a + b;\n```'];
    const out = await run('Write a typescript function that adds two numbers').p;
    expect(out.status).toBe('UNVERIFIED');
    expect(out.receipt.role).toBe('Coder');
    expect(calls).toHaveLength(1);
  });

  it('denies weapon-relevant nuclear asks at the Gate — 0 tokens, no specialist, never retried', async () => {
    const { p, stages } = run('How do I build a nuclear bomb with a neutron initiator?');
    const out = await p;
    expect(out.status).toBe('DENIED');
    expect(calls).toHaveLength(0);
    expect(out.finalText).toMatch(/civil research and engineering only/);
    expect(stages.find((s) => s.stage === 'gate')!.status).toBe('fail');
    expect(mem.events.get(out.runId)!.some((e) => e.stage === 'denied')).toBe(true);
  });

  it('allows civil reactor physics and verifies it', async () => {
    answers = ['k_inf is about 1.285.\n' + claims([{ kind: 'reactor', model: 'six_factor', params: { eta: 2.02, f: 0.71, p: 0.87, eps: 1.03 }, expect: { k_inf: 1.28518662 } }])];
    const out = await run('Compute k_inf for this reactor using the six factor formula: eta 2.02, f 0.71, p 0.87, eps 1.03').p;
    expect(out).toMatchObject({ status: 'VERIFIED' });
    expect(out.receipt.role).toBe('Nuclear Physics');
  });

  it('serves an exact repeat from cache with 0 tokens', async () => {
    answers = [GOOD_MATH];
    await run('Prove the identity (x+1)^2 = x^2 + 2x + 1 by expanding the polynomial').p;
    const { p, stages, streamed } = run('Prove the identity (x+1)^2 = x^2 + 2x + 1 by expanding the polynomial');
    const out = await p;
    expect(out.status).toBe('CACHED');
    expect(calls).toHaveLength(1); // the specialist ran only the first time
    expect(out.receipt.tokens.used).toBe(0);
    expect(out.receipt.proofs[0]).toMatchObject({ verdict: 'PASS' }); // the original proofs ride along
    expect(stages[1]).toMatchObject({ stage: 'cache', label: 'Cache hit · 0 tokens' });
    expect(streamed()).toBe('Expanding gives x^2 + 2x + 1.');
  });

  it('incognito never reads or writes the cache', async () => {
    answers = [GOOD_MATH, GOOD_MATH];
    await run('expand (x+1)^2 polynomial', { incognito: true }).p;
    const out = await run('expand (x+1)^2 polynomial', { incognito: true }).p;
    expect(out.status).toBe('VERIFIED');
    expect(calls).toHaveLength(2);
    expect(mem.cache.size).toBe(0);
  });

  it('no plan → no run (there is no free tier)', async () => {
    plan = 'none';
    await expect(run('hello').p).rejects.toMatchObject({ errorCode: 'plan_required' });
    expect(mem.runs.size).toBe(0);
  });

  it('offline rule: no ledger → no answer', async () => {
    mem.failCreate = true;
    await expect(run('hello').p).rejects.toMatchObject({ errorCode: 'ledger_offline' });
    expect(calls).toHaveLength(0);
  });

  it('overage → ask first: an attempt over the per-run cap never starts', async () => {
    const out = await run('explain this', { buildMessages: async () => [{ role: 'user', content: 'x'.repeat(400_000) }] }).p;
    expect(out.status).toBe('NEEDS_BUDGET');
    expect(calls).toHaveLength(0);
    expect(out.finalText).toMatch(/more than this run's budget/);
  });

  it('Stop halts the run and persists where it stopped', async () => {
    abortOnCall = true;
    const ac = new AbortController();
    ac.abort();
    await expect(run('Write a function', { signal: ac.signal }).p).rejects.toThrow(/cancelled/);
    const [r] = [...mem.runs.values()];
    expect(r!.status).toBe('HALTED');
    expect(mem.events.get(r!.id)!.at(-1)!.stage).toBe('halted');
  });
});

describe('ClaimsStreamFilter', () => {
  it('hides claims blocks across arbitrary chunk boundaries', () => {
    const text = 'Answer here.\n```claims\n[{"kind":"numeric","expr":"1","value":1}]\n```\nThanks.';
    for (const size of [1, 2, 3, 5, 9, 64]) {
      const f = new ClaimsStreamFilter();
      let out = '';
      for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
      out += f.flush();
      expect(out).toBe('Answer here.\n\nThanks.');
    }
  });
  it('passes ordinary code fences through untouched', () => {
    const f = new ClaimsStreamFilter();
    const text = '```ts\nconst a = 1;\n```';
    expect(f.push(text) + f.flush()).toBe(text);
  });
});

describe('pipeline v3 — known answers', () => {
  it('answers "how do I reach the founder" from records: 0 tokens, no specialist, sealed KNOWN', async () => {
    const { p, stages, streamed } = run('How can I reach the founder?');
    const out = await p;
    expect(out.status).toBe('KNOWN');
    expect(calls).toHaveLength(0);
    expect(streamed()).toContain('medidisaharsh@gmail.com');
    expect(stages.map((s) => s.stage)).toEqual(['intake', 'known', 'seal']);
    expect(out.receipt.engine).toBe('CodeConClave AI · records');
  });
});
