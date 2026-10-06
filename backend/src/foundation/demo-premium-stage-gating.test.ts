/**
 * Regression: a free TEMPORARY_DEMO_MODE account must never be routed into a
 * premium-only compute path.
 *
 * Live evidence 2026-10-05 against commit 1850598, all on a free demo account:
 *   - ARCHITECT and SECURITY each failed once before succeeding on retry, with
 *     "Premium compute requires an entitled plan (Pro/Team/Enterprise), and no
 *     qualified cheaper model exists for this request" and "All configured
 *     models failed (billing). Provider health has been updated."
 *   - REVIEWER failed once with the same premium error.
 *
 * Root cause: those stages declare modelPolicy.computeClass 'C' (PREMIUM,
 * entitlement-gated), and a free-plan account has no class-C model eligible. The
 * gateway attempted the premium class and only fell back to a cheaper model when
 * one happened to be healthy, so a transient provider flap turned a demo into a
 * retry loop. resolveComputeClass() demotes a PREMIUM stage policy to STANDARD
 * (B) while demo mode is on, so the demo only requests a model that is actually
 * eligible.
 *
 * Nothing here fakes an entitlement or unlocks Pro/Team/Enterprise: the gateway
 * still enforces entitlement, health, capability, privacy and the premium budget
 * gate, and a paid plan keeps its declared class C.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  let resolve: ((text: string, params: unknown[]) => unknown[] | null) | null = null;
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    return { rows: (resolve ? resolve(text, params) : null) ?? [] };
  };
  return {
    calls,
    setResolver: (fn: ((t: string, p: unknown[]) => unknown[] | null) | null) => { resolve = fn; },
    reset: () => { calls.length = 0; resolve = null; },
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const routeCalls: Array<Record<string, unknown>> = [];
const completionCalls: Array<Record<string, unknown>> = [];
vi.mock('../modules/ai/gateway.js', () => ({
  completeWithFallback: vi.fn(async (opts: Record<string, unknown>) => {
    completionCalls.push(opts);
    return { text: 'staged output', model: 'mock' };
  }),
}));
vi.mock('../modules/ai/router.js', () => ({
  planRoute: vi.fn(async (opts: Record<string, unknown>) => {
    routeCalls.push(opts);
    return { selectedModel: 'mock' };
  }),
}));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => 'ctx') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

let runCounter = 0;
beforeEach(() => {
  db.reset();
  routeCalls.length = 0;
  completionCalls.length = 0;
  runCounter = 0;
  // env.TEMPORARY_DEMO_MODE is parsed once when the module graph loads, so each
  // test needs a fresh graph to observe its own flag value.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.TEMPORARY_DEMO_MODE;
});

async function loadCoworkers() {
  return import('../modules/execution/coworkers.js');
}

/** Run one stage end-to-end and return the class each layer requested. */
async function runStage(coworkerType: string) {
  const { createCoworkerRun, runCoworker } = await loadCoworkers();
  db.setResolver((t) => {
    if (t.includes('FROM users')) return [{ plan_id: 'free' }];
    if (t.includes('INSERT INTO coworker_runs')) {
      runCounter += 1;
      return [{ id: `crw_${runCounter}`, task_id: 'tsk_1', coworker_type: coworkerType, order_index: 0 }];
    }
    if (t.includes('SELECT * FROM coworker_runs WHERE id')) {
      return [{ id: 'crw_1', task_id: 'tsk_1', coworker_type: coworkerType, order_index: 0, output: { text: 'staged output' } }];
    }
    if (t.includes('FROM plan_entries')) return [];
    return [];
  });
  const run = await createCoworkerRun({ taskId: 'tsk_1', coworkerType, orderIndex: 0, runInput: {} });
  await runCoworker(run, { userId: 'usr_1', title: 't', description: 'd', plan: '{}', projectId: 'p1' });
  const completionClass = (completionCalls.at(-1)?.opts as Record<string, unknown> | undefined)?.computeClass;
  const routeClass = (routeCalls.at(-1)?.opts as Record<string, unknown> | undefined)?.computeClass;
  return { completionClass, routeClass };
}

describe('BUG 3 — demo execution requests only an actually-eligible compute class', () => {
  it('resolveComputeClass demotes PREMIUM to STANDARD while demo mode is on', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'true';
    const { resolveComputeClass } = await loadCoworkers();
    expect(resolveComputeClass('C')).toBe('B');
  });

  it('resolveComputeClass leaves STANDARD and EFFICIENT untouched', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'true';
    const { resolveComputeClass } = await loadCoworkers();
    expect(resolveComputeClass('A')).toBe('A');
    expect(resolveComputeClass('B')).toBe('B');
  });

  it('resolveComputeClass keeps PREMIUM for a paid plan (no global unlock)', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'false';
    const { resolveComputeClass } = await loadCoworkers();
    expect(resolveComputeClass('C')).toBe('C');
  });

  it('every declared PREMIUM stage is requested as STANDARD under demo mode', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'true';
    // ARCHITECT, CODER, SECURITY and RESEARCH all declare computeClass 'C' and
    // each failed on the free demo account in production.
    for (const stage of ['ARCHITECT', 'CODER', 'SECURITY', 'RESEARCH']) {
      const { completionClass, routeClass } = await runStage(stage);
      expect(completionClass, `${stage} completion must not request PREMIUM`).not.toBe('C');
      expect(routeClass, `${stage} routing must not request PREMIUM`).not.toBe('C');
      expect(completionClass, `${stage} completion runs STANDARD`).toBe('B');
    }
  });

  it('a stage already declared STANDARD still runs STANDARD under demo mode', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'true';
    // REVIEWER / DOCS / TESTER declare 'B'; the demo path must not shift them.
    for (const stage of ['REVIEWER', 'DOCS', 'TESTER']) {
      const { completionClass } = await runStage(stage);
      expect(completionClass, `${stage} stays STANDARD`).toBe('B');
    }
  });

  it('a paid-plan stage still requests its declared PREMIUM class', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'false';
    const { completionClass, routeClass } = await runStage('ARCHITECT');
    expect(completionClass).toBe('C');
    expect(routeClass).toBe('C');
  });

  it('the entitlement rail is untouched: no demo path writes a paid entitlement', async () => {
    process.env.TEMPORARY_DEMO_MODE = 'true';
    await runStage('ARCHITECT');
    for (const c of db.calls) {
      expect(c.text).not.toMatch(/INSERT INTO (entitlements|subscriptions|payments)/i);
      expect(c.text).not.toMatch(/UPDATE users SET plan_id/i);
    }
  });
});