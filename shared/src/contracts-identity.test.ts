/**
 * CodeConClave — the CLIENT-side handle/keyword contract must accept exactly
 * what the SERVER-side policy accepts.
 *
 * These schemas ship to the browser and Electron app, where they gate the
 * registration form before any request is made. If `handleSchema` is stricter
 * than backend/src/modules/auth/identity-policy.ts the user is blocked from a
 * legal handle; if it is looser the user types something that is rejected on
 * submit. Both are defects, and both are invisible to a single-side test, so
 * this file re-declares the server rules as fixtures and diffs them against the
 * shipped schema.
 */
import { describe, it, expect } from 'vitest';
import { handleSchema, keywordSchema, registerSchema } from './contracts.js';

/** Mirror of validateHandle() in backend/src/modules/auth/identity-policy.ts. */
function serverValidateHandle(raw: string): string {
  const handle = raw.trim().toLowerCase();
  if (handle.length < 3 || handle.length > 20) return 'length';
  if (!/^[a-z0-9][a-z0-9_]*$/.test(handle)) return 'charset';
  if (handle.endsWith('_')) return 'trailing_underscore';
  return 'ok';
}

/** Mirror of validateKeyword() in backend/src/modules/auth/identity-policy.ts. */
function serverValidateKeyword(raw: string): string {
  const keyword = raw.trim();
  if (keyword.length < 12) return 'length';
  if (keyword.length > 128) return 'length';
  if (!/[a-z]/.test(keyword) || !/[A-Z]/.test(keyword) || !/[0-9]/.test(keyword)) return 'composition';
  return 'ok';
}

const HANDLE_SAMPLES = [
  'saharsh',
  '7saharsh',
  's_a_h',
  'a'.repeat(20),
  'ab',
  'a'.repeat(21),
  '2short',
  'trailing_',
  'has space',
  'Upper-Case',
  'Sah@arsh',
  'emoji\u{1F600}x',
  '',
  '_leading',
  'ok_1',
  'k',
  'abcd',
  '999',
  'a_',
  'a'.repeat(3),
];

const KEYWORD_SAMPLES = [
  'CorrectHorse9Battery',
  'short1A',
  'alllowercase1',
  'ALLUPPERCASE1',
  'NoDigitsHereAtAll',
  'MiXeD1234567890',
  'A1'.padEnd(12, 'x'),
  'A1'.padEnd(128, 'x'),
  'A1'.padEnd(129, 'x'),
  'spaces are fine 1A',
  'ünïcodéKéy1',
];

describe('handleSchema agrees with the server policy', () => {
  it('accepts exactly the handles the server would accept', () => {
    for (const sample of HANDLE_SAMPLES) {
      const server = serverValidateHandle(sample);
      const client = handleSchema.safeParse(sample);
      expect(
        client.success,
        `handle "${sample}": server=${server} client=${client.success ? 'accept' : 'reject'}`,
      ).toBe(server === 'ok');
    }
  });

  it('canonicalises to the same value the server normalises to', () => {
    for (const sample of HANDLE_SAMPLES) {
      const parsed = handleSchema.safeParse(sample);
      if (!parsed.success) continue;
      expect(parsed.data).toBe(sample.trim().toLowerCase());
    }
  });

  it('accepts a leading digit (the server allows it)', () => {
    // Regression: the shared schema once required a leading LETTER while the
    // server allowed a leading letter or number, so "7saharsh" was untypable
    // in the web form yet legal on the API.
    expect(handleSchema.safeParse('7saharsh').success).toBe(true);
  });

  it('rejects a trailing underscore (the server rejects it)', () => {
    expect(serverValidateHandle('saharsh_')).not.toBe('ok');
    expect(handleSchema.safeParse('saharsh_').success).toBe(false);
  });
});

describe('keywordSchema agrees with the server policy', () => {
  it('accepts exactly the keywords the server would accept', () => {
    for (const sample of KEYWORD_SAMPLES) {
      const server = serverValidateKeyword(sample);
      const client = keywordSchema.safeParse(sample);
      expect(
        client.success,
        `keyword (len ${sample.length}): server=${server} client=${client.success ? 'accept' : 'reject'}`,
      ).toBe(server === 'ok');
    }
  });
});

describe('registerSchema keeps the D1 handle/keyword rules', () => {
  it('treats handle and keyword as an all-or-nothing pair', () => {
    expect(registerSchema.safeParse({ email: 'a@b.com', password: 'Aa1bbbbbbbb', handle: 'saharsh' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'a@b.com', password: 'Aa1bbbbbbbb', keyword: 'CorrectHorse9Battery' }).success).toBe(false);
    expect(
      registerSchema.safeParse({
        email: 'a@b.com',
        password: 'Aa1bbbbbbbb',
        handle: 'saharsh',
        keyword: 'CorrectHorse9Battery',
      }).success,
    ).toBe(true);
  });

  it('still allows a legacy registration with neither field', () => {
    // Legacy clients cannot be broken by the D1 migration; enrolment is a
    // separate, later step.
    const parsed = registerSchema.safeParse({ email: 'a@b.com', password: 'Aa1bbbbbbbb' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.handle).toBeUndefined();
      expect(parsed.data.keyword).toBeUndefined();
    }
  });
});
