/**
 * CodeConClave — EMAIL_TRANSPORT=gmail (TEMPORARY zero-cost pilot) transport tests.
 * Mirrors outbox-14 patterns: hoisted db mock, provider never contacted on a
 * non-email event, honest NOT_CONFIGURED (never faked delivery), SMTP reply
 * code classification, and credential hygiene (app password never escapes
 * into errors/last_error/logs).
 * The Resend rail is untouched: EMAIL_TRANSPORT=resend remains the default and
 * its behavior is covered by outbox-14.test.ts.
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

const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: 'gmail-test-id' })));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { env } from '../config/env.js';
import { flushOutbox } from '../modules/outbox/service.js';
import { classifySmtpCode, gmailSmtpSend } from '../modules/outbox/deliver.js';

const GMAIL_USER = 'codeconclave.dev@gmail.com';
const GMAIL_APP_PASSWORD = 'test-app-password-value';

function outboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'out1',
    topic: 'auth.email_verification',
    payload: { channel: 'email', to: 'u1', userId: 'u1', subject: 'Your code', html: '<p>code</p>' },
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
  sendMail.mockReset();
  sendMail.mockImplementation(async () => ({ messageId: 'gmail-test-id' }));
  createTransport.mockClear();
  for (const key of ['EMAIL_TRANSPORT', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GMAIL_FROM_EMAIL']) {
    originalEnv[key] = env[key as keyof typeof env];
  }
  env.EMAIL_TRANSPORT = 'gmail';
  env.GMAIL_USER = GMAIL_USER;
  env.GMAIL_APP_PASSWORD = GMAIL_APP_PASSWORD;
  env.GMAIL_FROM_EMAIL = '';
  env.RESEND_ENABLED = 'false';
  env.RESEND_API_KEY = '';
});

afterEach(() => {
  for (const key of ['EMAIL_TRANSPORT', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GMAIL_FROM_EMAIL']) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('gmailSmtpSend (pilot transport)', () => {
  it('connects to smtp.gmail.com:587 with the configured account', async () => {
    await gmailSmtpSend({ from: GMAIL_USER, to: ['a@b.com'], subject: 'Hi', html: '<p>Hi</p>' });
    expect(createTransport).toHaveBeenCalledTimes(1);
    const config = createTransport.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.host).toBe('smtp.gmail.com');
    expect(config.port).toBe(587);
    expect(config.secure).toBe(false);
    expect(config.auth).toEqual({ user: GMAIL_USER, pass: GMAIL_APP_PASSWORD });
  });

  it('sends to every recipient with the app-named From derived from the account', async () => {
    await gmailSmtpSend({ from: 'ignored', to: ['a@b.com', 'c@d.com'], subject: 'Hi', html: '<p>Hi</p>' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(mail.to).toBe('a@b.com, c@d.com');
    expect(mail.subject).toBe('Hi');
    expect(mail.html).toBe('<p>Hi</p>');
    // SMTP From can never be spoofed: it is always the authenticated account.
    expect(mail.from).not.toContain('ignored');
    expect(mail.from).toContain(GMAIL_USER);
  });

  it('uses GMAIL_FROM_EMAIL as the display sender when provided', async () => {
    env.GMAIL_FROM_EMAIL = 'noreply@codeconclave.app';
    await gmailSmtpSend({ from: GMAIL_USER, to: ['a@b.com'], subject: 'Hi', html: '<p>Hi</p>' });
    const mail = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(mail.from).toContain('noreply@codeconclave.app');
  });

  it('refuses to send when the app password is not configured (never faked)', async () => {
    env.GMAIL_APP_PASSWORD = '';
    await expect(gmailSmtpSend({ from: GMAIL_USER, to: ['a@b.com'], subject: 'Hi', html: '<p>Hi</p>' })).rejects.toMatchObject({
      name: 'EmailDeliveryError',
      code: 'not_configured',
    });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('SMTP reply code classification', () => {
  it('maps credential/recipient 5xx to permanent classes and 4xx to retryable', () => {
    expect(classifySmtpCode(535)).toBe('auth_invalid');
    expect(classifySmtpCode(530)).toBe('auth_invalid');
    expect(classifySmtpCode(550)).toBe('invalid_request');
    expect(classifySmtpCode(554)).toBe('invalid_request');
    expect(classifySmtpCode(452)).toBe('rate_limited');
    expect(classifySmtpCode(421)).toBe('provider_unavailable');
    expect(classifySmtpCode(450)).toBe('provider_unavailable');
    expect(classifySmtpCode(999)).toBe('provider_unreachable');
  });

  it('never leaks the app password or sender account into the error', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('534-5.7.9 Application-specific password required'), { responseCode: 534 }));
    let caught: unknown;
    try {
      await gmailSmtpSend({ from: GMAIL_USER, to: ['a@b.com'], subject: 'Hi', html: '<p>Hi</p>' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const detail = String((caught as Error).message);
    expect(detail).not.toContain(GMAIL_APP_PASSWORD);
    expect(detail).not.toContain(GMAIL_USER);
  });
});

describe('outbox flush via Gmail pilot transport', () => {
  it('delivers and marks DELIVERED, never calling the Resend API', async () => {
    const fetchMock = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'real@example.com' }] : null);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(1);
    const mail = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(mail.to).toBe('real@example.com');
    const upd = db.state.calls.find((c) => c.text.includes("SET status = 'DELIVERED'"))!;
    expect(upd).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the row PENDING with backoff when the SMTP server is transient (421)', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('timeout'), { responseCode: 421 }));
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(0);
    const upd = db.state.calls.find((c) => c.text.includes('status = $2, attempts = $3'))!;
    expect(upd.params[1]).toBe('PENDING');
    expect(upd.params[2]).toBe(1);
    expect(String(upd.params[3])).toContain('provider_unavailable');
  });

  it('fails permanently and audits on auth_invalid for a sensitive topic', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('503 5.7.0 auth failed'), { responseCode: 535 }));
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(0);
    const upd = db.state.calls.find((c) => c.text.includes("status = 'FAILED'"))!;
    expect(upd).toBeDefined();
    expect(upd.params[1]).toBe(1);
    expect(String(upd.params[2])).toContain('auth_invalid');
    expect(String(upd.params[2])).not.toContain(GMAIL_APP_PASSWORD);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'outbox_event' }));
  });

  it('fails permanently without audit on invalid_request for a non-sensitive topic', async () => {
    sendMail.mockRejectedValue(Object.assign(new Error('550 recipient rejected'), { responseCode: 550 }));
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    db.state.rows = [outboxRow({ topic: 'notification.email' })];
    await expect(flushOutbox()).resolves.toBe(0);
    const upd = db.state.calls.find((c) => c.text.includes("status = 'FAILED'"))!;
    expect(String(upd.params[2])).toContain('invalid_request');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('is not configured: no send, PENDING + retry, nothing faked', async () => {
    env.GMAIL_APP_PASSWORD = '';
    db.state.resolve = (text) => (text.includes('SELECT email FROM users') ? [{ email: 'a@b.com' }] : null);
    db.state.rows = [outboxRow()];
    await expect(flushOutbox()).resolves.toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    const upd = db.state.calls.find((c) => c.text.includes('status = $2, attempts = $3'))!;
    expect(upd.params[1]).toBe('PENDING');
  });

  it('never treats a non-email event as a Gmail send', async () => {
    db.state.rows = [outboxRow({ topic: 'internal.record', payload: { channel: 'internal' } })];
    await expect(flushOutbox()).resolves.toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
  });
});