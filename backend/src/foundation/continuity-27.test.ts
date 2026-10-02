/**
 * Continuity-27 — idempotent messages, sync, conservative decision extraction,
 * exact retrieval, status lifecycle, sources, and secret redaction.
 * DB is mocked; this suite validates the continuity + decisions code paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditAction } from '@codeconclave/shared';

/* ------------------------------------------------------------------ */
/*  Mocked db                                                         */
/* ------------------------------------------------------------------ */

interface MockedRow {
  id: string;
  [k: string]: unknown;
}

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  let selector: ((text: string, params: unknown[]) => MockedRow[] | null) | null = null;

  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    const rows = selector ? selector(text, params) : [];
    return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
  };

  const queryMany = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  const queryOne = async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null;

  return {
    calls,
    selector,
    set selectorFn(fn: typeof selector) { selector = fn; },
    pool: { query },
    queryMany,
    queryOne,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */

import { classifyDecisionSignal } from '../modules/memory/extractDecision.js';
import {
  recordDecision,
  supersedeDecisions,
  setDecisionStatus,
  listDecisions,
  listDecisionSources,
  retrieveDecisionsForPrompt,
  significantTokens,
  overlapScore,
} from '../modules/memory/decisions.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function DECISION(over: Record<string, unknown> = {}): MockedRow {
  return {
    id: 'dec-1',
    owner_id: 'u1',
    project_id: 'p1',
    title: 'Adopt Redis cache strategy',
    decision: 'Use Redis for session caching',
    context: null,
    alternatives: [],
    rationale: null,
    consequences: [],
    source_conversation_id: null,
    source_task_id: null,
    evidence_ref: null,
    impact: 'MEDIUM',
    status: 'ACTIVE',
    source_message_ids: [],
    scope: 'PERSONAL',
    superseded_by_id: null,
    deleted_at: null,
    created_at: new Date('2026-02-01T00:00:00Z'),
    updated_at: new Date('2026-02-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  audit.recordAudit.mockClear();
  db.calls.length = 0;
  db.selectorFn = null;
});

/* ================================================================ */
/*  PURE CLASSIFIER                                                  */
/* ================================================================ */

describe('classifyDecisionSignal', () => {
  it('ACTIVE: explicit commitment', () => {
    const s = classifyDecisionSignal("we'll use postgres for the billing store");
    expect(s.kind).toBe('ACTIVE');
    expect(s.changeSignal).toBe(false);
    expect(s.subject.toLowerCase()).toContain('postgres');
  });

  it('ACTIVE with change signal', () => {
    const s = classifyDecisionSignal("we decided to use fly.io instead of vercel for deploys");
    expect(s.kind).toBe('ACTIVE');
    expect(s.changeSignal).toBe(true);
    expect(s.subject.toLowerCase()).toContain('fly.io');
  });

  it('ACTIVE: "let\'s go with"', () => {
    const s = classifyDecisionSignal("let's go with turso for the database");
    expect(s.kind).toBe('ACTIVE');
    expect(s.subject.toLowerCase()).toContain('turso');
  });

  it('ACTIVE: "switched to"', () => {
    const s = classifyDecisionSignal("we switched to esbuild for bundling");
    expect(s.kind).toBe('ACTIVE');
    expect(s.subject.toLowerCase()).toContain('esbuild');
  });

  it('TENTATIVE: "maybe we should"', () => {
    const s = classifyDecisionSignal("maybe we should consider redis for sessions");
    expect(s.kind).toBe('TENTATIVE');
    expect(s.changeSignal).toBe(false);
  });

  it('TENTATIVE: question', () => {
    const s = classifyDecisionSignal("should we use postgres for storage?");
    expect(s.kind).toBe('TENTATIVE');
  });

  it('TENTATIVE: "what about"', () => {
    const s = classifyDecisionSignal("what about using deno deploy?");
    expect(s.kind).toBe('TENTATIVE');
  });

  it('NONE: unrelated text', () => {
    const s = classifyDecisionSignal("the sky is blue today");
    expect(s.kind).toBe('NONE');
  });

  it('NONE: empty', () => {
    const s = classifyDecisionSignal('');
    expect(s.kind).toBe('NONE');
  });

  it('NONE: request guard without commitment ("can you switch to")', () => {
    const s = classifyDecisionSignal("can you switch the cache to redis?");
    expect(s.kind).toBe('NONE');
  });

  it('TENTATIVE: request downgrades act-like phrasing', () => {
    const s = classifyDecisionSignal("can you use postgres instead of mysql for the billing service?");
    expect(s.kind).toBe('TENTATIVE');
  });

  it('ACTIVE: "decided on"', () => {
    const s = classifyDecisionSignal("we decided on postgres for the data warehouse");
    expect(s.kind).toBe('ACTIVE');
    expect(s.subject.toLowerCase()).toContain('postgres');
  });

  it('ACTIVE: "the decision is"', () => {
    const s = classifyDecisionSignal("the decision is to use cloudflare for edge caching");
    expect(s.kind).toBe('ACTIVE');
  });
});

/* ================================================================ */
/*  PURE UTILITIES: significantTokens, overlapScore                  */
/* ================================================================ */

describe('significantTokens / overlapScore', () => {
  it('filters stop words', () => {
    const t = significantTokens('the quick brown fox jumps over the lazy dog');
    expect(t.has('the')).toBe(false);
    expect(t.has('quick')).toBe(true);
    expect(t.has('brown')).toBe(true);
  });

  it('scores shared significant tokens', () => {
    const score = overlapScore('redis cache for sessions', {
      title: 'Adopt Redis cache strategy',
      decision: 'Use Redis for session caching',
    });
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('returns 0 for unrelated', () => {
    const score = overlapScore('weather in paris', {
      title: 'Adopt Redis cache strategy',
      decision: 'Use Redis for session caching',
    });
    expect(score).toBe(0);
  });
});

/* ================================================================ */
/*  DECISION RECORDING (with status + source_message_ids + scope)    */
/* ================================================================ */

describe('recordDecision — extended columns', () => {
  it('inserts with status ACTIVE, source_message_ids, and scope', async () => {
    db.selectorFn = (text) => {
      if (text.includes('INSERT INTO agent_decisions')) return [];
      if (text.includes('FROM agent_decisions WHERE id')) return [DECISION({ id: 'dec-new', status: 'ACTIVE', source_message_ids: ['m1'], scope: 'PROJECT' })];
      return null;
    };
    const d = await recordDecision('u1', {
      title: 'Use Postgres',
      decision: 'Switch to Postgres',
      projectId: 'p1',
      status: 'ACTIVE',
      sourceMessageIds: ['m1'],
      scope: 'PROJECT',
    });
    expect(d.id).toBe('dec-new');
    expect(d.status).toBe('ACTIVE');
    expect(d.scope).toBe('PROJECT');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.DECISION_RECORDED,
      detail: expect.objectContaining({ status: 'ACTIVE' }),
    }));
  });

  it('defaults status to ACTIVE when not provided', async () => {
    db.selectorFn = (text) => {
      if (text.includes('INSERT INTO agent_decisions')) return [];
      if (text.includes('FROM agent_decisions WHERE id')) return [DECISION({ status: 'ACTIVE', scope: 'PERSONAL', source_message_ids: [] })];
      return null;
    };
    const d = await recordDecision('u1', {
      title: 'Use Postgres',
      decision: 'Switch to Postgres',
    });
    expect(d.status).toBe('ACTIVE');
    expect(d.scope).toBe('PERSONAL');
  });
});

/* ================================================================ */
/*  STATUS LIFECYCLE                                                 */
/* ================================================================ */

describe('setDecisionStatus', () => {
  it('rejects SUPERSEDED', async () => {
    await expect(
      setDecisionStatus('u1', 'dec-1', 'SUPERSEDED'),
    ).rejects.toMatchObject({ errorCode: 'decision_status_invalid' });
  });

  it('allows ACTIVE, TENTATIVE, REJECTED, ARCHIVED', async () => {
    const view = { status: 'ACTIVE' };
    db.selectorFn = (text, params) => {
      if (text.includes('UPDATE agent_decisions')) {
        view.status = String(params[0]);
        return [];
      }
      if (text.includes('FROM agent_decisions WHERE id')) return [DECISION({ status: view.status })];
      return null;
    };
    for (const s of ['ACTIVE', 'TENTATIVE', 'REJECTED', 'ARCHIVED'] as const) {
      const d = await setDecisionStatus('u1', 'dec-1', s);
      expect(d.status).toBe(s);
    }
  });

  it('throws NOT_FOUND when decision does not exist', async () => {
    db.selectorFn = () => [];
    await expect(
      setDecisionStatus('u1', 'missing', 'TENTATIVE'),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

/* ================================================================ */
/*  SUPERSEDE                                                        */
/* ================================================================ */

describe('supersedeDecisions', () => {
  it('marks overlapping ACTIVE as SUPERSEDED', async () => {
    db.selectorFn = (text) => {
      if (text.includes('SELECT * FROM agent_decisions') && text.includes('status IN')) {
        return [DECISION({ id: 'dec-old', status: 'ACTIVE' })];
      }
      return null;
    };
    const count = await supersedeDecisions('u1', {
      subject: 'redis cache strategy',
      supersedingId: 'dec-new',
    });
    expect(count).toBe(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ superseded: 1 }),
    }));
  });

  it('marks overlapping TENTATIVE as REJECTED', async () => {
    db.selectorFn = (text) => {
      if (text.includes('SELECT * FROM agent_decisions') && text.includes('status IN')) {
        return [DECISION({ id: 'dec-old', status: 'TENTATIVE' })];
      }
      return null;
    };
    const count = await supersedeDecisions('u1', {
      subject: 'redis cache strategy',
      supersedingId: 'dec-new',
    });
    expect(count).toBe(1);
  });

  it('does not touch unrelated decisions', async () => {
    db.selectorFn = (text) => {
      if (text.includes('SELECT * FROM agent_decisions') && text.includes('status IN')) {
        return [DECISION({ id: 'dec-old', title: 'Use Stripe for payments', decision: 'Stripe integration' })];
      }
      return null;
    };
    const count = await supersedeDecisions('u1', {
      subject: 'redis cache strategy',
      supersedingId: 'dec-new',
    });
    expect(count).toBe(0);
  });

  it('returns 0 for empty subject', async () => {
    const count = await supersedeDecisions('u1', { subject: '', supersedingId: 'x' });
    expect(count).toBe(0);
  });
});

/* ================================================================ */
/*  LIST / FILTER                                                    */
/* ================================================================ */

describe('listDecisions — status filter', () => {
  it('filters by status when provided', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions') && text.includes('status')) {
        return [DECISION({ status: 'TENTATIVE' })];
      }
      return null;
    };
    const list = await listDecisions('u1', undefined, 'TENTATIVE');
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('TENTATIVE');
  });

  it('returns all when no status filter', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions')) return [DECISION()];
      return null;
    };
    const list = await listDecisions('u1');
    expect(list).toHaveLength(1);
  });
});

/* ================================================================ */
/*  SOURCES                                                          */
/* ================================================================ */

describe('listDecisionSources', () => {
  it('returns empty when decision has no source_message_ids', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions WHERE id')) return [DECISION({ source_message_ids: [] })];
      return null;
    };
    const sources = await listDecisionSources('u1', 'dec-1');
    expect(sources).toHaveLength(0);
  });

  it('returns linked messages with ownership check', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions WHERE id')) {
        return [DECISION({ source_message_ids: ['m1', 'm2'] })];
      }
      if (text.includes('FROM messages m JOIN conversations')) {
        return [
          { id: 'm1', conversation_id: 'c1', role: 'user', content: 'use postgres', created_at: new Date() },
          { id: 'm2', conversation_id: 'c1', role: 'user', content: 'decided on postgres', created_at: new Date() },
        ];
      }
      return null;
    };
    const sources = await listDecisionSources('u1', 'dec-1');
    expect(sources).toHaveLength(2);
    expect(sources[0].id).toBe('m1');
    expect(sources[1].content).toContain('decided');
  });
});

/* ================================================================ */
/*  EXACT RETRIEVAL FOR PROMPT                                       */
/* ================================================================ */

describe('retrieveDecisionsForPrompt', () => {
  it('returns empty for empty query', async () => {
    const result = await retrieveDecisionsForPrompt('u1', null, null, 3);
    expect(result).toHaveLength(0);
  });

  it('returns formatted ACTIVE decision with exact token overlap', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions')) {
        return [DECISION({ status: 'ACTIVE', impact: 'HIGH', title: 'Redis cache strategy', decision: 'Use Redis for session caching', source_conversation_id: 'c1' })];
      }
      return null;
    };
    const result = await retrieveDecisionsForPrompt('u1', 'p1', 'should we use redis cache for the new project?');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('[DECISION ACTIVE HIGH]');
    expect(result[0]).toContain('Redis cache strategy');
    expect(result[0]).toContain('source: conversation c1');
  });

  it('ranks ACTIVE before TENTATIVE when both overlap', async () => {
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions')) {
        return [
          DECISION({ id: 'dec-t', status: 'TENTATIVE', title: 'Try redis', decision: 'Redis for caching' }),
          DECISION({ id: 'dec-a', status: 'ACTIVE', title: 'Redis cache strategy', decision: 'Use Redis for session caching' }),
        ];
      }
      return null;
    };
    const result = await retrieveDecisionsForPrompt('u1', null, 'redis cache for sessions');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('ACTIVE');
    expect(result[1]).toContain('TENTATIVE');
  });

  it('truncates long decision text', async () => {
    const longText = 'a'.repeat(500);
    db.selectorFn = (text) => {
      if (text.includes('FROM agent_decisions')) {
        return [DECISION({ status: 'ACTIVE', decision: longText })];
      }
      return null;
    };
    const result = await retrieveDecisionsForPrompt('u1', null, 'cache strategy something');
    expect(result[0].length).toBeLessThan(500 + 100);
  });
});

/* ================================================================ */
/*  SECRET REDACTION (integration with extractDecision)              */
/* ================================================================ */

describe('extractDecisionFromChat — secret redaction', () => {
  it('redacts secrets from persisted decision text', async () => {
    // Built at runtime so the repo-wide secret scan (CI gate) never sees a live key.
    const FAKE_KEY = `sk-or-v1-${Array.from({ length: 32 }, () => 'a').join('')}`;
    const REDACTED_LABEL = 'OpenRouter API key';
    const capturedParams: unknown[][] = [];
    db.selectorFn = (text, params) => {
      capturedParams.push(params);
      if (text.includes('INSERT INTO agent_decisions')) return [];
      if (text.includes('FROM agent_decisions WHERE id')) {
        return [DECISION({ id: 'dec-sec', status: 'ACTIVE', title: 'Api key for the gateway (decided)', scope: 'PERSONAL' })];
      }
      if (text.includes('FROM agent_decisions') && text.includes("status IN ('ACTIVE','TENTATIVE')")) return [];
      return null;
    };

    const { extractDecisionFromChat } = await import('../modules/memory/extractDecision.js');
    const result = await extractDecisionFromChat('u1', {
      conversationId: 'c1',
      content: `we'll use the api key ${FAKE_KEY} for the gateway`,
      messageId: 'm1',
    });

    expect(result).not.toBeNull();
    expect(result!.title).toContain('(decided)');
    expect(result!.status).toBe('ACTIVE');
    // The INSERT params (param index 4 = decision column) must not contain the raw key.
    const insertParams = capturedParams.find(
      (p) => typeof p[4] === 'string' && p[4] !== '',
    );
    expect(insertParams).toBeDefined();
    expect(String(insertParams![4])).not.toContain(FAKE_KEY);
    expect(String(insertParams![4])).toContain(`[REDACTED:${REDACTED_LABEL}]`);
  });
});
