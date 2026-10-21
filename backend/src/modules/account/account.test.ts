/**
 * Account data rights: export never selects secret columns; deletion needs an
 * exact email confirmation, refuses to orphan a team, and the sweep never
 * reports a partial erase as complete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: string[] = [];
let rowsFor: (text: string) => unknown[] = () => [];
let failOn: RegExp | null = null;

const client = {
  query: async (text: string) => {
    queries.push(text);
    if (failOn && failOn.test(text)) throw new Error('boom');
    const rows = rowsFor(text);
    return { rows, rowCount: rows.length };
  },
};
vi.mock('../../shared/db.js', () => ({
  withTenant: async (_u: string, fn: (q: unknown) => Promise<unknown>) => fn(client),
  withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
}));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

import { exportAccount, requestDeletion, sweepDueDeletions } from './service.js';

beforeEach(() => {
  queries.length = 0;
  rowsFor = () => [];
  failOn = null;
});

describe('exportAccount', () => {
  it('never selects hashes, secrets, tokens or embeddings', async () => {
    rowsFor = (t) => (t.includes('FROM users') ? [{ id: 'usr_1', email: 'a@b.test' }] : []);
    const out = await exportAccount('usr_1');
    expect(out.format).toBe('codeconclave-account-export/v1');
    const all = queries.join('\n');
    for (const secret of ['password_hash', 'mfa_secret_encrypted', 'recovery_codes_hash', 'token_hash', 'key_hash', 'pairing_code_hash', 'embedding']) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/SELECT \*/);
  });
});

describe('requestDeletion', () => {
  it('requires the exact account email', async () => {
    rowsFor = (t) => (t.startsWith('SELECT email FROM users') ? [{ email: 'me@x.test' }] : []);
    await expect(requestDeletion('usr_1', 'someone@else.test')).rejects.toMatchObject({ status: 400 });
    expect(queries.some((q) => q.includes('INSERT INTO account_deletion_requests'))).toBe(false);
  });

  it('refuses while the user owns a team with other members', async () => {
    rowsFor = (t) =>
      t.startsWith('SELECT email FROM users') ? [{ email: 'me@x.test' }] : t.includes('FROM teams t') ? [{ name: 'Platform' }] : [];
    await expect(requestDeletion('usr_1', 'ME@x.test')).rejects.toMatchObject({ status: 409 });
  });
});

describe('sweepDueDeletions', () => {
  it('leaves the request PENDING when erasure fails', async () => {
    rowsFor = (t) =>
      t.includes('due_at <= now()') ? [{ id: 'adr_1', user_id: 'usr_1' }] : t.includes('FOR UPDATE') ? [{ '?column?': 1 }] : [];
    failOn = /UPDATE messages/;
    expect(await sweepDueDeletions()).toBe(0);
    expect(queries.some((q) => q.includes("state = 'COMPLETED'"))).toBe(false);
  });

  it('skips a request cancelled between scan and lock', async () => {
    rowsFor = (t) => (t.includes('due_at <= now()') ? [{ id: 'adr_1', user_id: 'usr_1' }] : []);
    expect(await sweepDueDeletions()).toBe(0);
    expect(queries.some((q) => q.includes('UPDATE users'))).toBe(false);
  });
});
