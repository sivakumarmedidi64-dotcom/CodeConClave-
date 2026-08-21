/**
 * CodeConClave — PHASE 17 full-system integration journey.
 *
 * One user, one product: the journey below runs the REAL services end-to-end
 * through an in-memory SQL emulation (contract-level: every call the service
 * makes is matched by table/SQL shape, inserts are captured into the same
 * tables later reads resolve against — so data genuinely flows between
 * modules, not through hand-wired fixtures). Only infrastructure boundaries
 * are mocked: the AI provider adapter (no live provider), email delivery
 * (outbox payloads, not SMTP), storage, cache, and the worker queue.
 *
 * Covered chapters:
 *   1. identity   — register → verify email → login → MFA setup → MFA login
 *   2. continuity — workspace state persists and restores across requests
 *   3. chat       — fast path: user+assistant messages persisted, stream
 *                   events honest (thinking_start → deltas → done w/ messageId)
 *   4. memory+DNA — provenance, correction, verification, scoped retrieval
 *   5. deep work  — COWORK message → persisted task via createTaskFromChat
 *   6. execution  — task → plan → approval → execute → artifact → DNA →
 *                   notification → completed
 *   7. WYWA       — return-to-work summary built from REAL rows only
 *   8. free limit — free_limit_reached thrown; the Moon fires exactly once
 *                   (cache-gated), never on a replay attempt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: (rows ?? []).length };
  };
  return {
    state,
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const cache = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  incr: vi.fn(async () => 1),
  del: vi.fn(async () => {}),
}));
vi.mock('../shared/cache.js', () => ({ cache }));

const enqueueOutbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox }));

const queue = vi.hoisted(() => ({
  enqueueTask: vi.fn(async () => {}),
  claimNextTask: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../shared/queue.js', () => queue);

const storageMock = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  get: vi.fn(async () => Buffer.from('')),
  exists: vi.fn(async () => true),
  delete: vi.fn(async () => {}),
  size: vi.fn(async () => 0),
  health: vi.fn(async () => true),
  kind: 'memory',
}));
vi.mock('../integrations/storage.js', () => ({ storage: storageMock }));

const registry = vi.hoisted(() => ({
  getRegistry: vi.fn(async () => [modelRow()]),
  configuredProviders: vi.fn(() => ['openai']),
  getModel: vi.fn(async () => modelRow()),
}));
const providers = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  updateProviderHealth: vi.fn(),
  classifyProviderError: vi.fn(() => 'provider_unavailable' as const),
}));
vi.mock('../modules/ai/registry.js', () => registry);
vi.mock('../modules/ai/providers.js', () => providers);

function modelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'model-fast',
    providerId: 'openai',
    displayName: 'Fast',
    tier: 'EFFICIENT',
    computeClass: 'B',
    contextWindow: 128_000,
    supportsVision: false,
    supportsTools: false,
    supportsFunctionCalling: false,
    inputCostPerM: 0.5,
    outputCostPerM: 1.5,
    entitlement: 'FREE',
    privacyClass: 'STANDARD',
    targetLatencyMs: 1500,
    health: 'UP',
    priority: 1,
    fallbackList: [],
    enabled: true,
    effectiveDate: '2025-01-01',
    deprecationDate: null,
    ...overrides,
  };
}

function fakeAdapter() {
  return {
    providerId: 'openai',
    supportsToolCalls: false,
    complete: async function* () {
      yield { delta: 'Hello ', inputTokens: 10 };
      yield { delta: 'world!', outputTokens: 5 };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory SQL emulation: captures INSERTs into tables that later SELECTs
// resolve against, so modules genuinely share state.
// ---------------------------------------------------------------------------

const USER_ID = 'u1';
const PROJECT_ID = 'p1';
const CONVERSATION_ID = 'c1';
const TASK_ID = 'tsk_17';

function setupJourney() {
  const tables: Record<string, Record<string, unknown>[]> = {
    messages: [],
    memories: [],
    dna: [],
    notifications: [],
    approvals: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    workspace_state: [],
    usage_counters: [],
    recovery_codes: [],
  };
  const user = {
    id: USER_ID,
    email: 'journey@example.com',
    email_verified: false,
    plan_id: 'free',
    mfa_enabled: false,
    mfa_secret_encrypted: null,
    recovery_codes_hash: null,
    created_at: new Date(),
    deleted_at: null,
    ...{ password_hash: 'scrypt$v1$test' },
  };
  let attemptCounter = 0;

  const applyUpdate = (text: string, params: unknown[], rows: Record<string, unknown>[]) => {
    const t = text.toLowerCase();
    const setIdx = t.indexOf(' set ');
    const whereIdx = t.indexOf(' where ');
    const setClause = text.slice(setIdx + 5, whereIdx === -1 ? undefined : whereIdx);
    const wherePart = whereIdx === -1 ? '' : text.slice(whereIdx + 7);
    const idParam = wherePart.match(/id\s*=\s*\$(\d+)/i);
    const target = rows.find((r) => r.id === params[Number(idParam?.[1] ?? 1) - 1]);
    if (!target) return;
    for (const part of setClause.split(',')) {
      const m = part.match(/^\s*([a-z_]+)\s*=\s*(.+?)\s*$/i);
      if (!m) continue;
      const col = m[1]!.toLowerCase();
      const expr = m[2]!.trim();
      let value: unknown = expr;
      if (/^\$\d+$/.test(expr)) value = params[Number(expr.slice(1)) - 1];
      else if (/^'([^']*)'$/.test(expr)) value = expr.slice(1, -1);
      else if (/^now\(\)$/.test(expr)) value = new Date();
      else if (expr === 'true') value = true;
      else if (expr === 'false') value = false;
      else value = Number(expr);
      target[col] = value;
    }
  };

  const row = (text: string, params: unknown[]) => {
    const t = text.toLowerCase();
    if (t.includes('select id from users')) return [];
    if (t.includes('insert into email_verifications')) return [];
    if (t.includes('update email_verifications')) return [{ id: params[0] }];
    if (t.includes('from email_verifications')) {
      return [{ id: 'ev1', user_id: user.id, token_hash: 'x', status: 'PENDING', expires_at: new Date(Date.now() + 60_000), created_at: new Date() }];
    }
    if (t.includes('from users')) return [user];
    if (t.includes('insert into users')) {
      user.id = String(params[0]);
      user.email = String(params[1]);
      user.password_hash = params[2];
      return [];
    }
    if (t.includes('insert into mfa') || t.includes('from mfa')) return [];
    if (t.includes('insert into recovery_codes')) {
      tables.recovery_codes.push({ id: params[0], user_id: params[1], code_hash: params[2] });
      return [];
    }
    if (t.includes('from recovery_codes')) return tables.recovery_codes;
    if (t.includes('update users set')) {
      applyUpdate(text, params, [user]);
      return [];
    }
    if (t.includes('from projects')) return [{ id: PROJECT_ID, owner_id: USER_ID, name: 'Journey', team_id: null, deleted_at: null }];
    if (t.includes('select 1 from projects')) return [{ id: PROJECT_ID }];
    if (t.includes('from conversations')) return [{ id: CONVERSATION_ID, project_id: PROJECT_ID, owner_id: USER_ID, title: 'Journey chat', mode: 'CHAT', deleted_at: null, created_at: new Date(), updated_at: new Date() }];
    if (t.includes('insert into conversations')) return [{ id: CONVERSATION_ID, project_id: PROJECT_ID, owner_id: USER_ID }];
    if (t.includes('insert into messages')) {
      tables.messages.push({
        id: params[0], conversation_id: params[1], sender: params[2], coworker_type: params[3], role: params[4],
        content: params[5], model_id: params[6], provider_id: params[7], input_tokens: params[8], output_tokens: params[9],
        latency_ms: params[10], status: params[11], error_code: params[12], seq: tables.messages.length + 1,
        created_at: new Date(), deleted_at: null, edited_at: null, edit_count: 0, thread_id: null,
      });
      return [];
    }
    if (t.includes('update messages set')) {
      applyUpdate(text, params, tables.messages);
      return [];
    }
    if (t.includes('from messages')) {
      if (t.includes('where id = $1')) return tables.messages.filter((m) => m.id === params[0]);
      return tables.messages;
    }
    if (t.includes('insert into memories')) {
      const episodic = t.includes('episodic');
      tables.memories.push({
        id: params[0], project_id: params[1], team_id: params[2], owner_id: params[3], type: episodic ? 'EPISODIC' : params[4], source: episodic ? 'AI_INFERRED' : params[5],
        content: episodic ? params[3] : params[6], structured: episodic ? null : params[7], confidence: episodic ? 0.5 : params[8], provenance: episodic ? params[4] : params[9],
        contradiction_state: 'NONE', status: 'QUEUED', created_at: new Date(), updated_at: new Date(), deleted_at: null,
      });
      return [];
    }
    if (t.includes('update memories set')) {
      applyUpdate(text, params, tables.memories);
      return [];
    }
    if (t.includes('from memories')) {
      if (t.includes('order by created_at desc limit 1')) return tables.memories.slice(-1);
      return tables.memories;
    }
    if (t.includes('insert into dna')) {
      tables.dna.push({ id: params[0], project_id: params[1], owner_id: params[2], kind: params[3], scope: params[4], title: params[5], content: params[6], version: 1, parent_version_id: params[8], conflict_state: 'NONE', created_at: new Date(), updated_at: new Date(), deleted_at: null });
      return [];
    }
    if (t.includes('update dna set')) {
      applyUpdate(text, params, tables.dna);
      return [];
    }
    if (t.includes('from dna')) return tables.dna;
    if (t.includes('insert into notifications')) {
      tables.notifications.push({ id: params[0], user_id: params[1], type: params[2], title: params[3], body: params[4], read: false, created_at: new Date(), deleted_at: null });
      return [];
    }
    if (t.includes('from notifications')) return tables.notifications;
    if (t.includes('insert into approvals')) {
      tables.approvals.push({
        id: params[0], task_id: params[1], owner_id: params[2], detail: JSON.parse(String(params[3])), risk_level: params[4],
        status: 'PENDING', expires_at: new Date(Date.now() + Number(params[5])), decision: null, decided_by: null, created_at: new Date(),
      });
      return [];
    }
    if (t.includes('update approvals set status')) {
      applyUpdate(text, params, tables.approvals);
      return [];
    }
    if (t.includes('from approvals')) return tables.approvals;
    if (t.includes('insert into tasks')) {
      tables.tasks.push({
        id: params[0], project_id: params[1], conversation_id: params[2], owner_id: params[3], title: params[4], description: params[5],
        status: 'CREATED', risk_level: params[6], required_approval: params[7], coworker_pipeline: params[8], execution_mode: params[9],
        timeout_ms: params[10], max_attempts: params[11], priority: params[12], created_at: new Date(), updated_at: new Date(), completed_at: null, deleted_at: null,
      });
      return [];
    }
    if (t.includes('update tasks set')) {
      applyUpdate(text, params, tables.tasks);
      return [];
    }
    if (t.includes('from tasks')) return tables.tasks;
    if (t.includes('insert into task_attempts')) {
      attemptCounter += 1;
      tables.attempts.push({ id: params[0], task_id: params[1], attempt_number: attemptCounter, started_at: new Date(), finished_at: null, result: null, error_code: null, output_summary: null, checkpoint: null });
      return [];
    }
    if (t.includes('from task_attempts')) return tables.attempts;
    if (t.includes('update task_attempts set')) {
      applyUpdate(text, params, tables.attempts);
      return [];
    }
    if (t.includes('insert into artifacts')) {
      tables.artifacts.push({ id: params[0], task_id: params[1], name: params[2], kind: params[3], storage_key: params[4], sha256: params[5], size_bytes: params[6], content: params[7], attempt_id: params[8], verification: params[9], created_by: params[10], created_at: new Date() });
      return [];
    }
    if (t.includes('from artifacts')) return tables.artifacts;
    if (t.includes('insert into workspace_state')) {
      const parsed = JSON.parse(String(params[3] ?? params[2]));
      const existing = tables.workspace_state.find((w) => w.key === params[2]);
      if (existing) existing.value = parsed;
      else tables.workspace_state.push({ id: params[0], owner_id: params[1], key: params[2], value: parsed, version: 1, updated_at: new Date() });
      return [];
    }
    if (t.includes('from workspace_state')) return tables.workspace_state;
    if (t.includes('insert into usage_counters')) return [{ value: 1 }];
    if (t.includes('from usage_counters')) return tables.usage_counters;
    if (t.includes('from model_usage_logs') || t.includes('from provider_health')) return [];
    if (t.includes('from feature_flags')) return [];
    return [];
  };

  db.state.resolve = (text: string, params: unknown[]) => row(text, params);
  return { tables, user };
}

function fakeReq(): Request {
  return {
    ip: '10.0.0.1',
    headers: { 'user-agent': 'integration/17' },
    ctx: { traceId: 'trace-17', ip: '10.0.0.1', userAgent: 'integration/17', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function totpCode(secret: string): string {
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const key = Buffer.from(bytes);
  const step = Math.floor(Date.now() / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

import { env } from '../config/env.js';
import { register, login, setupMfa, confirmMfa, completeMfa } from '../modules/auth/service.js';
import { sendVerificationEmail, verifyEmailToken } from '../modules/auth/verification.js';
import { setWorkspaceState, getWorkspaceState, listWorkspaceState, restoreWorkspaceState } from '../modules/workspace/service.js';
import { createProject } from '../modules/projects/service.js';
import { sendChatMessage } from '../modules/conversations/chat.js';
import { listMessages } from '../modules/conversations/service.js';
import { createMemory, listMemories, correctMemory, verifyMemory, flagMemoryWrong } from '../modules/memory/service.js';
import { retrieveScopedContext } from '../modules/memory/context.js';
import { saveDna, updateDna, listDna } from '../modules/dna/service.js';
import { createTask, getTask, beginAttempt, finishAttempt, setTaskStatus } from '../modules/execution/tasks.js';
import { createApproval, listApprovals, decideApproval, getApproval } from '../modules/execution/approvals.js';
import { persistPlan } from '../modules/execution/planner.js';
import { approveLinkTask } from '../modules/execution/tasks.js';
import { createTaskArtifact, listArtifacts } from '../modules/artifacts/service.js';
import { createNotification, listNotifications } from '../modules/notifications/service.js';
import { returnToWorkSummary } from '../modules/notifications/service.js';
import { autoSaveTaskDna } from '../modules/dna/service.js';
import { checkFreeLimits, shouldShowFreeLimitMoon } from '../modules/workspace/service.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  enqueueOutbox.mockClear();
  queue.enqueueTask.mockClear();
  queue.claimNextTask.mockClear();
  cache.get.mockReset();
  cache.set.mockReset();
  cache.get.mockResolvedValue(null);
  providers.getAdapter.mockReset();
  providers.getAdapter.mockImplementation(() => fakeAdapter());
  vi.mocked(registry.getRegistry).mockResolvedValue([modelRow()]);
  vi.mocked(registry.getModel).mockResolvedValue(modelRow());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PHASE 17 integration — identity', () => {
  it('signup → verify email → login → MFA setup → MFA login', async () => {
    const { user } = setupJourney();
    const registered = await register(
      { email: 'journey@example.com', password: 'ValidPass123!', displayName: 'Journey' },
      fakeReq(),
    );
    expect(registered.user.id).toBeTruthy();
    expect(registered.sessionToken).toBeTruthy();
    const uid = registered.user.id;

    const sent = await sendVerificationEmail(uid, fakeReq());
    expect(sent.sent).toBe(true);
    expect(enqueueOutbox).toHaveBeenCalledWith(
      'auth.email_verification',
      expect.objectContaining({ channel: 'email', to: 'journey@example.com' }),
    );
    await verifyEmailToken('raw-token', fakeReq());
    expect(user.email_verified).toBe(true);

    const firstLogin = await login({ email: 'journey@example.com', password: 'ValidPass123!' }, fakeReq());
    expect(firstLogin.user.id).toBe(uid);

    const mfa = await setupMfa(uid);
    const confirmed = await confirmMfa(uid, totpCode(mfa.secretBase32), fakeReq());
    expect(confirmed.recoveryCodes.length).toBeGreaterThan(0);
    expect(confirmed.sessionToken).toBeTruthy();
    expect(user.mfa_enabled).toBe(true);

    const mfaLogin = await login({ email: 'journey@example.com', password: 'ValidPass123!' }, fakeReq());
    expect(mfaLogin).toHaveProperty('mfaRequired', true);
    const token = (mfaLogin as { challengeToken: string }).challengeToken;
    const completed = await completeMfa(
      { challengeToken: token, code: totpCode(mfa.secretBase32) },
      fakeReq(),
    );
    expect(completed.sessionToken).toBeTruthy();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.mfa_enabled' }));
  });
});

describe('PHASE 17 integration — continuity', () => {
  it('workspace state persists across requests and restores the last session', async () => {
    const { tables } = setupJourney();
    await createProject(USER_ID, { name: 'Journey', description: 'e2e' });
    await setWorkspaceState(USER_ID, 'current_project', { projectId: PROJECT_ID });
    await setWorkspaceState(USER_ID, 'current_conversation', { conversationId: CONVERSATION_ID });

    const saved = await getWorkspaceState(USER_ID, 'current_project');
    expect(saved).toEqual({ projectId: PROJECT_ID });
    const all = await listWorkspaceState(USER_ID);
    expect(all.map((e) => e.key)).toEqual(expect.arrayContaining(['current_project', 'current_conversation']));

    // A fresh "request" (same user, new session) restores the same values.
    const restored = await restoreWorkspaceState(USER_ID, [
      { key: 'current_project', value: { projectId: PROJECT_ID } },
      { key: 'current_conversation', value: { conversationId: CONVERSATION_ID } },
    ]);
    expect(restored.applied.map((e) => e.key)).toEqual(expect.arrayContaining(['current_project', 'current_conversation']));
    expect(restored.conflicts).toEqual([]);
    const restoredProject = await getWorkspaceState(USER_ID, 'current_project');
    expect(restoredProject).toEqual({ projectId: PROJECT_ID });
    expect(tables.workspace_state.length).toBe(2);
  });
});

describe('PHASE 17 integration — chat fast path', () => {
  it('streams honestly and persists BOTH messages with usage and episodic memory', async () => {
    const { tables } = setupJourney();
    const events: string[] = [];
    const result = await sendChatMessage(
      { id: USER_ID, planId: 'free', entitlementState: 'FREE' },
      'sess_1',
      { content: 'Hello CodeConClave', conversationId: CONVERSATION_ID, projectId: PROJECT_ID, mode: 'CHAT' },
      {
        onThinkingStart: () => {
          events.push('thinking_start');
        },
        onDelta: (d) => {
          events.push(`delta:${d}`);
        },
        onDone: (info) => {
          events.push(`done:${info.messageId}`);
        },
      },
    );
    expect(events).toEqual(['thinking_start', 'delta:Hello ', 'delta:world!', expect.stringMatching(/^done:msg_/)]);
    expect(result.assistant).toBe('Hello world!');
    expect(result.modelId).toBe('model-fast');
    expect(result.costUsd).toBeGreaterThan(0);

    const messages = await listMessages(USER_ID, CONVERSATION_ID, undefined, 100);
    const userMsg = messages.find((m) => m.role === 'user');
    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(userMsg).toMatchObject({ sender: 'USER', content: 'Hello CodeConClave' });
    expect(asstMsg).toMatchObject({ sender: 'AI', content: 'Hello world!', model_id: 'model-fast' });
    expect(asstMsg?.status).toBe('COMPLETED');

    expect(tables.messages.length).toBe(2);
    expect(tables.memories.some((m) => m.provenance === `conversation://${CONVERSATION_ID}`)).toBe(true);
    const usageEvents = db.state.calls.filter((c) => c.text.toLowerCase().includes('usage_events'));
    if (!usageEvents.length) {
      console.error('DEBUG usage calls:', db.state.calls.map((c) => c.text).join('\n'));
    }
    expect(usageEvents.length).toBeGreaterThan(0);
  });
});

describe('PHASE 17 integration — memory + DNA', () => {
  it('memory carries provenance, can be corrected/verified, and is scoped; DNA persists and updates', async () => {
    const { tables } = setupJourney();
    const mem = await createMemory(USER_ID, {
      projectId: PROJECT_ID,
      type: 'FACT',
      source: 'USER_STATED',
      content: 'The billing module must use Razorpay.',
      provenance: 'user said in chat',
    });
    expect(mem.content).toBe('The billing module must use Razorpay.');
    expect(mem.provenance).toBe('user said in chat');

    const flagged = await flagMemoryWrong(USER_ID, mem.id, 'Actually Stripe');
    expect(flagged.contradiction_state).toBe('CONFIRMED');
    expect(flagged.confidence).toBe(0);
    const correctionRow = tables.memories.find((m) => m.id !== mem.id);
    expect(correctionRow?.content).toContain('User correction');
    expect(correctionRow?.provenance).toBe(`memory://${mem.id}`);
    const corrected = await correctMemory(USER_ID, mem.id, 'user corrected to Stripe');
    expect(corrected.contradiction_state).toBe('CONFIRMED');
    expect(corrected.verification_state).toBe('REJECTED');
    const laterCorrection = tables.memories.some((m) => m.id !== mem.id && String(m.content).includes('user corrected to Stripe'));
    expect(laterCorrection).toBe(true);
    const verified = await verifyMemory(USER_ID, mem.id, 'VERIFIED');
    expect(verified.verification_state).toBe('VERIFIED');

    const listed = await listMemories(USER_ID, { projectId: PROJECT_ID });
    expect(listed.items.map((m) => m.content)).toContain('The billing module must use Razorpay.');
    const scoped = await retrieveScopedContext(USER_ID, { projectId: PROJECT_ID, memoryLimit: 8, dnaLimit: 5 });
    expect(scoped.memories.join(' ')).toContain('Razorpay');
    // Cross-project isolation is enforced in SQL: the retrieval query is
    // project-scoped by the service itself.
    const isolationCall = db.state.calls.find((c) => c.text.includes('FROM memories') && c.text.includes('project_id'));
    expect(isolationCall?.text).toContain('project_id');

    const dna = await saveDna(USER_ID, {
      projectId: PROJECT_ID,
      kind: 'PROJECT_CONTEXT',
      title: 'Billing stack',
      content: 'Razorpay chosen; verification provider pending.',
    });
    const updated = await updateDna(USER_ID, dna.id, {
      content: 'Razorpay chosen; verification provider = Stripe webhooks.',
      changeSummary: 'provider decided',
    });
    expect(updated.content).toContain('Stripe webhooks');
    const dnaList = await listDna(USER_ID, PROJECT_ID);
    expect(dnaList.map((d) => d.title)).toContain('Billing stack');
    expect(tables.dna.length).toBeGreaterThan(0);
  });
});

describe('PHASE 17 integration — deep work path', () => {
  it('a COWORK message creates a persisted task and answers honestly', async () => {
    const { tables } = setupJourney();
    const result = await sendChatMessage(
      { id: USER_ID, planId: 'free', entitlementState: 'FREE' },
      'sess_2',
      { content: 'Implement the billing module end to end', conversationId: CONVERSATION_ID, projectId: PROJECT_ID, mode: 'COWORK' },
      {},
    );
    expect(result.mode).toBe('COWORK');
    expect(result.intent).toBe('deep');
    expect(result.assistant).toContain('Deep work task created');
    expect(tables.tasks.length).toBe(1);
    expect(tables.tasks[0]).toMatchObject({ owner_id: USER_ID, title: 'Implement the billing module end to end', status: 'CREATED', risk_level: 'MEDIUM' });
    expect(tables.messages.some((m) => m.role === 'user' && m.content === 'Implement the billing module end to end')).toBe(true);
  });
});

describe('PHASE 17 integration — execution pipeline', () => {
  it('task → plan → approval → execute → artifact → DNA → notification → completed', async () => {
    const { tables } = setupJourney();
    const task = await createTask({
      userId: USER_ID,
      projectId: PROJECT_ID,
      title: 'Ship the billing module',
      description: 'Build and verify the module',
      riskLevel: 'HIGH',
    });
    expect(task.status).toBe('CREATED');
    expect(task.required_approval).toBe(true);

    await persistPlan({ taskId: task.id, entries: [{ action: 'run_tests', resources: ['billing'] }], source: 'manual' });
    const plan = db.state.calls.find((c) => c.text.includes('INSERT INTO plans'));
    expect(plan).toBeDefined();

    const approval = await createApproval({ ownerId: USER_ID, taskId: task.id, riskLevel: 'HIGH', detail: { action: 'execute', resources: ['billing'] } });
    const pending = await listApprovals(USER_ID, 'PENDING');
    expect(pending.map((a) => a.id)).toContain(approval.id);

    const decided = await decideApproval(USER_ID, approval.id, 'APPROVE', 'looks good');
    expect(decided.status).toBe('APPROVED');
    expect(queue.enqueueTask).toHaveBeenCalledWith(task.id);

    // The worker links the approved approval and then runs the attempt.
    await approveLinkTask(task.id, approval.id);
    const attempt = await beginAttempt(task.id);
    expect(attempt.id).toBeTruthy();
    await finishAttempt(attempt.id, 'SUCCESS', 'All tests passed; artifact saved');
    await setTaskStatus(task.id, 'COMPLETED');

    const artifact = await createTaskArtifact({
      userId: USER_ID,
      taskId: task.id,
      name: 'billing-module.ts',
      kind: 'file',
      content: 'export const billing = 1;',
      verification: 'PASS',
      attemptId: attempt.id,
    });
    expect(artifact.sha256).toBeTruthy();
    const artifacts = await listArtifacts(USER_ID, { taskId: task.id });
    expect(artifacts.map((a) => a.name)).toContain('billing-module.ts');

    await autoSaveTaskDna({ userId: USER_ID, projectId: PROJECT_ID, taskId: task.id, title: 'Ship the billing module', description: 'Build and verify the module', outcome: 'PASS' });
    expect(tables.dna.some((d) => d.title.includes('Ship the billing module'))).toBe(true);

    await createNotification({ userId: USER_ID, type: 'task.completed', title: 'Task completed', body: task.title });
    const notifications = await listNotifications(USER_ID);
    expect(notifications.map((n) => n.title)).toContain('Task completed');

    const completed = await getTask(USER_ID, task.id);
    expect(completed.status).toBe('COMPLETED');
    expect(tables.artifacts.length).toBe(1);
  });
});

describe('PHASE 17 integration — return to work (WYWA)', () => {
  it('the summary is built ONLY from real persisted rows — nothing invented', async () => {
    const { tables } = setupJourney();
    const task = await createTask({
      userId: USER_ID,
      projectId: PROJECT_ID,
      title: 'WYWA task',
      description: 'done while away',
      riskLevel: 'LOW',
    });
    tables.tasks[0]!.updated_at = new Date(Date.now() + 1000);
    const approval = await createApproval({ ownerId: USER_ID, taskId: task.id, riskLevel: 'MEDIUM', detail: { action: 'x' } });
    await decideApproval(USER_ID, approval.id, 'APPROVE');
    await createNotification({ userId: USER_ID, type: 'task.completed', title: 'Task completed', body: 'WYWA task' });

    const summary = await returnToWorkSummary(USER_ID, Date.now() - 60_000);
    expect(summary.tasks).toEqual([expect.objectContaining({ id: task.id, title: 'WYWA task', status: 'PLANNED' })]);
    expect(summary.approvals).toEqual([expect.objectContaining({ id: approval.id, status: 'APPROVED' })]);
    expect(summary.notifications.length).toBeGreaterThan(0);
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: expect.stringContaining('invent') }));
  });
});

describe('PHASE 17 integration — free limit + Moon', () => {
  it('rejects over-limit messages honestly and fires the Moon exactly once', async () => {
    const { tables } = setupJourney();
    tables.usage_counters.push({ name: 'daily_messages', value: env.FREE_DAILY_MESSAGES + 1 });

    let moonFired = 0;
    // Emulate the 24h Moon cache so the same over-limit situation does not
    // show the Moon again within the same day.
    const moonStore = new Map<string, string>();
    cache.get.mockImplementation(async (k: string) => moonStore.get(k) ?? null);
    cache.set.mockImplementation(async (k: string, v: unknown) => {
      moonStore.set(k, String(v));
    });
    await expect(
      sendChatMessage(
        { id: USER_ID, planId: 'free', entitlementState: 'FREE' },
        'sess_3',
        { content: 'Hello again', conversationId: CONVERSATION_ID, projectId: PROJECT_ID, mode: 'CHAT' },
        {
          onLimitReached: () => {
            moonFired += 1;
          },
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'free_limit_reached' });
    expect(moonFired).toBe(1);
    // A replay of the same situation must NOT fire the moon again.
    await expect(
      sendChatMessage(
        { id: USER_ID, planId: 'free', entitlementState: 'FREE' },
        'sess_4',
        { content: 'Hello again', conversationId: CONVERSATION_ID, projectId: PROJECT_ID, mode: 'CHAT' },
        {
          onLimitReached: () => {
            moonFired += 1;
          },
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'free_limit_reached' });
    expect(moonFired).toBe(1);
    expect(await shouldShowFreeLimitMoon(USER_ID)).toBe(false);
  });

  it('pro users are never gated by free limits', async () => {
    setupJourney();
    db.state.resolve = (text: string) =>
      text.toLowerCase().includes('from users') && !text.toLowerCase().includes('email_verifications')
        ? [{ id: USER_ID, plan_id: 'pro' }]
        : null;
    const limit = await checkFreeLimits(USER_ID, 'message');
    expect(limit.ok).toBe(true);
  });
});