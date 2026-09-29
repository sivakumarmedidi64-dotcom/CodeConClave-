/**
 * CodeConClave — PHASE 14 outbox delivery hardening tests.
 * Covers: idempotent enqueue (dedupe key), email address resolution,
 * provider error classification (transient vs permanent), exponential
 * backoff, delivery failure state (last_error), final-failure audit for
 * sensitive notification events, and honest NOT_CONFIGURED behavior (events
 * stay PENDING, never faked as delivered).
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
    rowCount: 1,
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
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { env } from '../config/env.js';
import { enqueueOutbox, flushOutbox } from '../modules/outbox/service.js';
import { EmailDeliveryError, classifyResendStatus } from '../modules/outbox/deliver.js';

function outboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'out1',
    topic: 'notification.email',
    payload: { channel: 'email', to: 'u1', userId: 'u1', subject: 'Hi', html: '<p>Hi</p>' },
    status: 'PENDING',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date(),
    delivered_at: null,
    created_at: new Date(),
    last_error: null,
    dedupe_key: null,
    ...overrides,
  };
}

const originalEnv: Record<string, unknown> = {};
beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 1;
  db.state.resolve = null;
  recordAudit.mockClear();
  for (const key of [
    'RESEND_API_KEY',
    'RESEND_ENABLED',
    'RESEND_FROM_EMAIL',
    'EMAIL_TRANSPORT',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'GMAIL_FROM_EMAIL',
  ]) {
    originalEnv[key] = env[key as keyof typeof env];
  }
  env.RESEND_ENABLED = 'true';
  env.RESEND_API_KEY = 're_test_key';
  // Hermetic: these fetch-mock assertions target the Resend rail. Without
  // pinning the transport, a real .env EMAIL_TRANSPORT=gmail would open a
  // live SMTP connection and time out instead of hitting the fetch mock.
  env.EMAIL_TRANSPORT = 'resend';
  env.GMAIL_USER = '';
  env.GMAIL_APP_PASSWORD = '';
  env.GMAIL_FROM_EMAIL = '';
});

afterEach(() => {
  for (const key of [
    'RESEND_API_KEY',
    'RESEND_ENABLED',
    'RESEND_FROM_EMAIL',
    'EMAIL_TRANSPORT',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'GMAIL_FROM_EMAIL',
  ]) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('idempotent enqueue', () => {
  it('enqueues once per dedupe key and reports duplicates', async () => {
    expect(await enqueueOutbox('notification.email', { channel: 'email', userId: 'u1' }, { dedupeKey: 'evt:1' })).toBe(true);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO outbox_events'))!;
    expect(insert.text).toContain('ON CONFLICT (dedupe_key)');
    expect(insert.params[3]).toBe('evt:1');

    db.state.resolve = (text) => (text.includes('WHERE dedupe_key = $1') ? [{ id: 'out1' }] : null);
    expect(await enqueueOutbox('notification.email', { channel: 'email', userId: 'u1' }, { dedupeKey: 'evt:1' })).toBe(false);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO outbox_events')).length).toBe(1);
  });

  it('enqueues without a dedupe key when none is provided', async () => {
    expect(await enqueueOutbox('auth.email_verification', { to: 'a@b.com' })).toBe(true);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO outbox_events'))!;
    expect(insert.params[3]).toBeNull();
  });
});

describe('delivery success + address resolution', () => {
  it('resolves userId to the persisted email before sending', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT email FROM users') ? [{ email: 'real@example.com' }] : null;
    const fetchMock = vi.fn(async () => new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.to).toEqual(['real@example.com']);
    const upd = db.state.calls.find((c) => c.text.includes("SET status = 'DELIVERED'"))!;
    expect(upd).toBeDefined();
  });

  it('sends the Idempotency-Key header from the dedupe key', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow({ dedupe_key: 'digest:u1:daily:2026-08-15' })];
    await flushOutbox();
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      'Idempotency-Key': 'digest:u1:daily:2026-08-15',
    });
  });

  it('marks non-email events delivered without contacting the provider', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow({ topic: 'internal.record', payload: { channel: 'internal' } })];
    await expect(flushOutbox()).resolves.toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider error classification + retry/backoff', () => {
  it('classifies Resend status codes', () => {
    expect(classifyResendStatus(401)).toBe('auth_invalid');
    expect(classifyResendStatus(422)).toBe('invalid_request');
    expect(classifyResendStatus(429)).toBe('rate_limited');
    expect(classifyResendStatus(500)).toBe('provider_unavailable');
    expect(classifyResendStatus(503)).toBe('provider_unavailable');
  });

  it('keeps transient failures PENDING with exponential backoff', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"message":"rate limited"}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(0);
    const upd = db.state.calls.find((c) => c.text.includes('make_interval(secs => $5)'))!;
    expect(upd).toBeDefined();
    expect(upd.params[1]).toBe('PENDING');
    expect(upd.params[2]).toBe(1); // attempts = 0 + 1
    expect(String(upd.params[3])).toContain('[rate_limited]');
  });

  it('fails fast on permanent provider errors (auth_invalid)', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"message":"invalid key"}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow()];
    await flushOutbox();
    const upd = db.state.calls.find((c) => c.text.includes("SET status = 'FAILED'"))!;
    expect(upd).toBeDefined();
    expect(String(upd.params[2])).toContain('[auth_invalid]');
  });

  it('marks FAILED after max_attempts on transient errors', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"message":"down"}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow({ attempts: 4, max_attempts: 5 })];
    await flushOutbox();
    const upd = db.state.calls.find((c) => c.text.includes("SET status = 'FAILED'"))!;
    // Params are [id, attempts, last_error] — the unused $2 placeholder that
    // made this UPDATE fail at runtime was removed (Stage 21 fix).
    expect(upd.params[1]).toBe(5);
  });

  it('stays PENDING (never faked) when the email provider is not configured', async () => {
    env.RESEND_API_KEY = undefined;
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [outboxRow()];
    await flushOutbox();
    expect(fetchMock).not.toHaveBeenCalled();
    const upd = db.state.calls.find((c) => c.text.includes('make_interval(secs => $5)'))!;
    expect(upd.params[1]).toBe('PENDING');
    expect(String(upd.params[3])).toContain('not_configured');
  });
});

describe('sensitive-event audit', () => {
  it('audits the final delivery failure of sensitive notification events', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"message":"down"}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [
      outboxRow({ id: 'out-auth', topic: 'auth.email_verification', payload: { channel: 'email', userId: 'u1', to: 'u1' }, attempts: 4, max_attempts: 5 }),
    ];
    await flushOutbox();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'email.delivery_failed',
        tenantId: 'u1',
        resourceId: 'out-auth',
      }),
    );
  });

  it('does not audit final failure for non-sensitive topics', async () => {
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    const fetchMock = vi.fn(async () => new Response('{"message":"down"}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.rows = [
      outboxRow({ id: 'out2', topic: 'digest.email', payload: { channel: 'email', userId: 'u1' }, attempts: 4, max_attempts: 5 }),
    ];
    await flushOutbox();
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'email.delivery_failed' }));
  });
});