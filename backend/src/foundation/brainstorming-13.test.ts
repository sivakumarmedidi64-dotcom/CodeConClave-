/**
 * CodeConClave — Phase 13 brainstorming tests: session lifecycle, participants,
 * idea capture and gated AI generation (gateway -> schema -> validation ->
 * persist; raw output never trusted). DB mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback: vi.fn() }));
vi.mock('../modules/ai/registry.js', () => ({ configuredProviders: vi.fn() }));

import { completeWithFallback } from '../modules/ai/gateway.js';
import { configuredProviders } from '../modules/ai/registry.js';
import * as notifications from '../modules/notifications/service.js';
import {
  createSession,
  addParticipant,
  listSessions,
  getSessionDetail,
  captureIdea,
  generateIdeas,
  completeSession,
  archiveSession,
} from '../modules/brainstorming/service.js';

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bsh_1',
    owner_id: 'u1',
    title: 'Q3 roadmap',
    description: null,
    status: 'ACTIVE',
    grouping: 'NONE',
    ended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function ideaRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ide_9',
    owner_id: 'u1',
    team_id: null,
    project_id: null,
    title: 'Generated idea',
    description: null,
    tags: [],
    category: null,
    priority: 'MEDIUM',
    status: 'PROPOSED',
    assignee_id: null,
    archived: false,
    deleted_at: null,
    vote_count: 0,
    comment_count: 0,
    ai_generated: true,
    provenance: 'brainstorm://bsh_1/ai',
    references: [],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(configuredProviders).mockReturnValue([]);
  vi.mocked(completeWithFallback).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createSession', () => {
  it('creates a session, adds the host participant and audits', async () => {
    db.state.resolve = (text) => {
      if (text.includes('INSERT INTO brainstorming_sessions')) return [sessionRow({ id: 'bsh_1' })];
      return null;
    };
    const session = await createSession('u1', { title: 'Q3 roadmap' });
    expect(session.id).toBe('bsh_1');
    expect(session.status).toBe('ACTIVE');
    const hostInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO brainstorming_participants'));
    expect(hostInsert!.text).toContain("VALUES ($1,$2,$3,'HOST')");
    expect(db.state.calls.some((c) => c.params.includes('brainstorm.created'))).toBe(true);
  });
});

describe('addParticipant', () => {
  it('lets the host invite a participant and notify them', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify').mockResolvedValue(undefined);
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes('SELECT role FROM brainstorming_participants WHERE session_id = $1 AND user_id = $2')) return [{ role: 'HOST' }];
      if (text.includes('SELECT * FROM brainstorming_participants WHERE session_id = $1 ORDER BY joined_at ASC')) return [{ id: 'bsp_1', session_id: 'bsh_1', user_id: 'u2', role: 'PARTICIPANT', joined_at: new Date() }];
      return null;
    };
    const participants = await addParticipant('u1', 'bsh_1', 'u2');
    expect(participants).toHaveLength(1);
    expect(participants[0].role).toBe('PARTICIPANT');
    expect(notifySpy).toHaveBeenCalledWith('u2', 'brainstorm.invite', expect.any(String), expect.objectContaining({ resourceType: 'brainstorm' }));
  });

  it('blocks non-hosts from inviting', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes('SELECT role FROM brainstorming_participants WHERE session_id = $1 AND user_id = $2')) return [{ role: 'PARTICIPANT' }];
      return null;
    };
    await expect(addParticipant('u2', 'bsh_1', 'u3')).rejects.toMatchObject({ errorCode: 'host_only' });
  });
});

describe('captureIdea', () => {
  it('captures a participant proposal as a real idea with brainstorm provenance', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes('INSERT INTO ideas')) return [ideaRow({ id: 'ide_9', title: 'AI-first onboarding', ai_generated: false, provenance: 'brainstorm://bsh_1' })];
      if (text.includes('INSERT INTO brainstorming_ideas')) return [{ id: 'bsi_1', session_id: 'bsh_1', idea_id: 'ide_9', created_by: 'u1', proposal: 'AI-first onboarding', grouping: null, ai_generated: false, created_at: new Date() }];
      return null;
    };
    const result = await captureIdea('u1', 'bsh_1', { proposal: 'AI-first onboarding' });
    expect(result.idea.title).toBe('AI-first onboarding');
    expect(result.idea.aiGenerated).toBe(false);
    expect(result.idea.provenance).toBe('brainstorm://bsh_1');
    expect(result.brainstormIdea.aiGenerated).toBe(false);
    expect(db.state.calls.some((c) => c.params.includes('brainstorm.idea_captured'))).toBe(true);
  });

  it('rejects capture when the session is not active', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1') ? [sessionRow({ status: 'COMPLETED' })] : null;
    await expect(captureIdea('u1', 'bsh_1', { proposal: 'x' })).rejects.toMatchObject({ errorCode: 'session_not_active' });
  });
});

describe('generateIdeas — gated AI pipeline', () => {
  it('is unavailable without a configured provider', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1') ? [sessionRow()] : null);
    await expect(generateIdeas('u1', 'bsh_1', { topic: 'onboarding', count: 3 })).rejects.toMatchObject({
      errorCode: 'ai_unavailable',
    });
  });

  it('validates structured output via schema and persists ai_generated ideas', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockResolvedValue({
      text: JSON.stringify({
        ideas: [
          { title: 'Dark mode', description: 'Reduce eye strain', tags: ['ux'] },
          { title: 'Keyboard shortcuts', description: 'Power users', tags: ['power'] },
        ],
      }),
      modelId: 'm1',
      providerId: 'anthropic',
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0.001,
      durationMs: 100,
      usedFallback: false,
      fallbackReason: null,
    });
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes("SELECT plan_id FROM users")) return [{ plan_id: 'pro' }];
      if (text.includes('INSERT INTO ideas')) {
        const title = text.includes('Dark mode') ? 'Dark mode' : 'Keyboard shortcuts';
        return [ideaRow({ id: 'ide_9', title, ai_generated: true })];
      }
      if (text.includes('INSERT INTO brainstorming_ideas')) return [{ id: 'bsi_1', session_id: 'bsh_1', idea_id: 'ide_9', created_by: 'u1', proposal: 'Dark mode', grouping: null, ai_generated: true, created_at: new Date() }];
      return null;
    };
    const result = await generateIdeas('u1', 'bsh_1', { topic: 'ux polish', count: 2 });
    expect(result.generated).toBe(true);
    expect(result.ideas).toHaveLength(2);
    expect(result.ideas[0].idea.aiGenerated).toBe(true);
    expect(result.ideas[0].idea.provenance).toBe('brainstorm://bsh_1/ai');
    expect(completeWithFallback).toHaveBeenCalledOnce();
  });

  it('persists nothing when the AI output is not valid JSON', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockResolvedValue({
      text: 'Here are some ideas: 1) Do a thing',
      modelId: 'm1',
      providerId: 'anthropic',
      inputTokens: 5,
      outputTokens: 5,
      estimatedCostUsd: 0,
      durationMs: 10,
      usedFallback: false,
      fallbackReason: null,
    });
    db.state.resolve = (text) => (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1') ? [sessionRow()] : null);
    await expect(generateIdeas('u1', 'bsh_1', { topic: 't', count: 2 })).rejects.toMatchObject({
      errorCode: 'ai_generation_invalid',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO ideas'))).toBe(false);
  });

  it('persists nothing when the schema validation fails (title missing/too long)', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockResolvedValue({
      text: JSON.stringify({ ideas: [{ description: 'no title here' }] }),
      modelId: 'm1',
      providerId: 'anthropic',
      inputTokens: 5,
      outputTokens: 5,
      estimatedCostUsd: 0,
      durationMs: 10,
      usedFallback: false,
      fallbackReason: null,
    });
    db.state.resolve = (text) => (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1') ? [sessionRow()] : null);
    await expect(generateIdeas('u1', 'bsh_1', { topic: 't', count: 2 })).rejects.toMatchObject({
      errorCode: 'ai_generation_invalid',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO ideas'))).toBe(false);
  });

  it('caps generated ideas at the requested count', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockResolvedValue({
      text: JSON.stringify({ ideas: Array.from({ length: 8 }, (_, i) => ({ title: `Idea ${i + 1}` })) }),
      modelId: 'm1',
      providerId: 'anthropic',
      inputTokens: 5,
      outputTokens: 5,
      estimatedCostUsd: 0,
      durationMs: 10,
      usedFallback: false,
      fallbackReason: null,
    });
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes("SELECT plan_id FROM users")) return [{ plan_id: 'pro' }];
      if (text.includes('INSERT INTO ideas')) return [ideaRow({ id: 'ide_9', title: 'Idea 1', ai_generated: true })];
      if (text.includes('INSERT INTO brainstorming_ideas')) return [{ id: 'bsi_1', session_id: 'bsh_1', idea_id: 'ide_9', created_by: 'u1', proposal: 'Idea 1', grouping: null, ai_generated: true, created_at: new Date() }];
      return null;
    };
    const result = await generateIdeas('u1', 'bsh_1', { topic: 't', count: 3 });
    expect(result.ideas).toHaveLength(3);
  });
});

describe('session lifecycle', () => {
  it('completes the session as host and audits', async () => {
    let done = false;
    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM brainstorming_participants WHERE session_id = $1 AND user_id = $2')) return [{ role: 'HOST' }];
      if (text.includes('UPDATE brainstorming_sessions SET status = \'COMPLETED\'')) {
        done = true;
        return [];
      }
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) {
        return [sessionRow(done ? { status: 'COMPLETED', ended_at: new Date() } : { status: 'ACTIVE' })];
      }
      return null;
    };
    const session = await completeSession('u1', 'bsh_1');
    expect(session.status).toBe('COMPLETED');
    expect(db.state.calls.some((c) => c.params.includes('brainstorm.completed'))).toBe(true);
  });

  it('archives the session and audits', async () => {
    let done = false;
    db.state.resolve = (text) => {
      if (text.includes('SELECT role FROM brainstorming_participants WHERE session_id = $1 AND user_id = $2')) return [{ role: 'HOST' }];
      if (text.includes('UPDATE brainstorming_sessions SET status = \'ARCHIVED\'')) {
        done = true;
        return [];
      }
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) {
        return [sessionRow(done ? { status: 'ARCHIVED', ended_at: new Date() } : { status: 'ACTIVE' })];
      }
      return null;
    };
    const session = await archiveSession('u1', 'bsh_1');
    expect(session.status).toBe('ARCHIVED');
    expect(db.state.calls.some((c) => c.params.includes('brainstorm.archived'))).toBe(true);
  });

  it('lists only sessions the user owns or participates in', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT s.* FROM brainstorming_sessions s') ? [sessionRow(), sessionRow({ id: 'bsh_2', owner_id: 'u2' })] : null;
    const sessions = await listSessions('u1');
    expect(sessions).toHaveLength(2);
    const call = db.state.calls.find((c) => c.text.includes('SELECT s.* FROM brainstorming_sessions s'));
    expect(call!.text).toContain('s.owner_id = $1');
    expect(call!.text).toContain('brainstorming_participants WHERE user_id = $1');
  });

  it('detail includes participants and ideas only for members', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM brainstorming_sessions WHERE id = $1')) return [sessionRow()];
      if (text.includes('SELECT * FROM brainstorming_participants WHERE session_id = $1 ORDER BY joined_at ASC')) return [{ id: 'bsp_1', session_id: 'bsh_1', user_id: 'u1', role: 'HOST', joined_at: new Date() }];
      if (text.includes('SELECT * FROM brainstorming_ideas WHERE session_id = $1')) return [{ id: 'bsi_1', session_id: 'bsh_1', idea_id: 'ide_9', created_by: 'u1', proposal: 'p', grouping: null, ai_generated: false, created_at: new Date() }];
      return null;
    };
    const detail = await getSessionDetail('u1', 'bsh_1');
    expect(detail.participants).toHaveLength(1);
    expect(detail.ideas).toHaveLength(1);
  });

  it('blocks outsiders from a session', async () => {
    await expect(getSessionDetail('u9', 'bsh_1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});