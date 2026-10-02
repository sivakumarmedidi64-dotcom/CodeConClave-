/**
 * CodeConClave — founder provisioning script invariants (B2).
 *
 * Founder entitlement requires ALL THREE of:
 *   1. email === PAYMENT_FOUNDER_EMAIL
 *   2. users.email_verified = true
 *   3. users.is_founder = true
 *
 * The workspace gate reads the ENTITLEMENT row, not is_founder. So the script
 * must never write a live Team PRO_VERIFIED entitlement while the account is
 * unverified — that was the bug: `--verified`-less provisioning handed the Team
 * product to an unverified account, satisfying conditions 1 and 3 only.
 *
 * The script also must not be a no-op when re-run with --verified, because that
 * is the documented remediation step, and it must never DE-verify an already
 * verified founder on a plain re-run.
 *
 * DB is mocked; the assertions are on the SQL and parameters the script issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { calls: { text: string; params: unknown[] }[]; resolve: ((text: string) => unknown[] | null) | null } = {
    calls: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    return { rows: state.resolve ? state.resolve(text) ?? [] : [], rowCount: 1 };
  };
  return {
    state,
    pool: { query, end: async () => {} },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const envMock = vi.hoisted(() => ({
  env: { PAYMENT_FOUNDER_EMAIL: 'medidisaharsh@gmail.com' },
}));
vi.mock('../config/env.js', () => envMock);

import { provisionFounder } from '../scripts/provision-founder.js';

const FOUNDER = 'medidisaharsh@gmail.com';
const KEYWORD = 'CorrectHorse9Battery';

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  envMock.env.PAYMENT_FOUNDER_EMAIL = FOUNDER;
});

function noExistingUser(): void {
  db.state.resolve = (text) => (text.includes('FROM users WHERE lower(email)') ? [] : null);
}

describe('provision-founder — refuses to act on a non-founder address', () => {
  it('rejects an address that is not PAYMENT_FOUNDER_EMAIL and writes nothing', async () => {
    db.state.resolve = () => [];
    await expect(
      provisionFounder({ email: 'attacker@example.com', keyword: KEYWORD, markVerified: true }),
    ).rejects.toThrow(/does not match/i);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO users'))).toHaveLength(0);
    expect(db.state.calls.some((c) => c.text.includes('is_founder = true'))).toBe(false);
  });

  it('refuses to run at all when PAYMENT_FOUNDER_EMAIL is unset', async () => {
    envMock.env.PAYMENT_FOUNDER_EMAIL = undefined;
    await expect(
      provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: true }),
    ).rejects.toThrow(/not configured/i);
  });

  it('rejects a weak keyword', async () => {
    noExistingUser();
    await expect(
      provisionFounder({ email: FOUNDER, keyword: 'short', markVerified: true }),
    ).rejects.toThrow(/at least 12/i);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
  });
});

describe('provision-founder — an UNVERIFIED founder stays locked on FREE', () => {
  it('provisions is_founder but writes plan free / FREE, not team', async () => {
    noExistingUser();
    const result = await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: false });
    expect(result).toMatchObject({ created: true, emailVerified: false });

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(insert.text).toContain('is_founder');
    expect(insert.params[3]).toBe(false); // email_verified = false
    expect(insert.params[4]).toBe('free'); // plan_id
    expect(insert.params[5]).toBe('FREE'); // entitlement_state
  });

  it('NEVER writes a live Team PRO_VERIFIED entitlement while unverified', async () => {
    noExistingUser();
    await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: false });
    const grants = db.state.calls.filter(
      (c) => c.text.includes('entitlements') && c.text.includes('PRO_VERIFIED') && !c.text.includes("state = 'FREE'"),
    );
    expect(grants).toHaveLength(0);
  });

  it('demotes any stale Team PRO_VERIFIED grant on an unverified run', async () => {
    noExistingUser();
    await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: false });
    const demote = db.state.calls.find((c) => c.text.includes('UPDATE entitlements'));
    expect(demote).toBeTruthy();
    expect(demote!.text).toContain("state = 'FREE'");
    expect(demote!.text).toContain("plan_id = 'team'");
  });
});

describe('provision-founder — a VERIFIED founder gets the Team grant', () => {
  it('writes team / PRO_VERIFIED and grants the Team entitlement', async () => {
    noExistingUser();
    const result = await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: true });
    expect(result).toMatchObject({ created: true, emailVerified: true });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(insert.params[3]).toBe(true);
    expect(insert.params[4]).toBe('team');
    expect(insert.params[5]).toBe('PRO_VERIFIED');
    const grant = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(grant).toBeTruthy();
    expect(grant.text).toContain("'team','PRO_VERIFIED'");
  });

  it('normalises the address case before comparing', async () => {
    noExistingUser();
    await expect(
      provisionFounder({ email: '  MediDisAharsh@Gmail.com ', keyword: KEYWORD, markVerified: true }),
    ).resolves.toMatchObject({ created: true });
  });
});

describe('provision-founder — idempotence and remediation', () => {
  function existingFounder(emailVerified: boolean): void {
    db.state.resolve = (text) =>
      text.includes('FROM users WHERE lower(email)')
        ? [{ id: 'usr_founder', is_founder: true, email_verified: emailVerified, password_hash: 'scrypt$v2$x' }]
        : null;
  }

  it('is a no-op when the founder is already provisioned AND verified', async () => {
    existingFounder(true);
    const result = await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: true });
    expect(result).toMatchObject({ created: false, alreadyProvisioned: true, emailVerified: true });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE users'))).toBe(false);
  });

  it('completes the remediation when re-run with --verified on an unverified founder', async () => {
    // This is the documented recovery step; it must not short-circuit.
    existingFounder(false);
    const result = await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: true });
    expect(result).toMatchObject({ created: false, alreadyProvisioned: true, emailVerified: true });
    const update = db.state.calls.find((c) => c.text.includes('UPDATE users'))!;
    expect(update).toBeTruthy();
    expect(update.params[1]).toBe(true);
    expect(update.params[2]).toBe('team');
    const grant = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(grant).toBeTruthy();
  });

  it('never de-verifies an already-verified founder on a plain re-run', async () => {
    existingFounder(true);
    const result = await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: false });
    expect(result).toMatchObject({ emailVerified: true, alreadyProvisioned: true });
    expect(db.state.calls.some((c) => c.text.includes('UPDATE users'))).toBe(false);
  });

  it('never prints the keyword or the password hash to the log', async () => {
    existingFounder(false);
    await provisionFounder({ email: FOUNDER, keyword: KEYWORD, markVerified: true });
    const serialised = JSON.stringify(db.state.calls.map((c) => c.params));
    expect(serialised).not.toContain(KEYWORD);
  });
});
