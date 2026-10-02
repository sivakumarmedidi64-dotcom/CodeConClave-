/**
 * CodeConClave — Superpowers: LANGUAGE FERRY (Master Feature #100).
 *
 * Cross-language rewrite with behavioral test harnesses proving equivalence.
 * Source code is rewritten; tests prove the new implementation matches.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FerryTestHarness {
  name: string;
  input: string;
  expected: string;
}

export interface LanguageFerryRow {
  id: string;
  owner_id: string;
  source_language: string;
  target_language: string;
  source_code: string;
  target_code: string | null;
  test_harness: FerryTestHarness[];
  tests_passed: number;
  total_tests: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): LanguageFerryRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_language: String(r.source_language),
  target_language: String(r.target_language),
  source_code: String(r.source_code),
  target_code: r.target_code == null ? null : String(r.target_code),
  test_harness: (r.test_harness ?? []) as FerryTestHarness[],
  tests_passed: Number(r.tests_passed),
  total_tests: Number(r.total_tests),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function planFerry(userId: string, input: { source_language: string; target_language: string; source_code: string; test_harness: FerryTestHarness[] }): Promise<LanguageFerryRow> {
  if (!input.source_language || typeof input.source_language !== 'string') {
    throw AppError.badRequest('invalid_source_language', 'a source language is required');
  }
  if (!input.target_language || typeof input.target_language !== 'string') {
    throw AppError.badRequest('invalid_target_language', 'a target language is required');
  }
  if (!input.source_code || typeof input.source_code !== 'string') {
    throw AppError.badRequest('invalid_source_code', 'source code is required');
  }
  if (!Array.isArray(input.test_harness) || input.test_harness.length === 0) {
    throw AppError.badRequest('invalid_test_harness', 'at least one behavioral test is required');
  }
  const total = input.test_harness.length;
  const id = newId(PREFIX.LANGUAGE_FERRY);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO language_ferries (id, owner_id, source_language, target_language, source_code, test_harness, tests_passed, total_tests, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.source_language, input.target_language, input.source_code, input.test_harness, 0, total, 'PLANNED'],
  ));
  await recordAudit({
    action: AuditAction.FERRY_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'language_ferries',
    resourceId: id,
    detail: { source: input.source_language, target: input.target_language, tests: total },
  });
  return getLanguageFerry(userId, id);
}

export async function verifyFerryRun(userId: string, id: string, input: { tests_passed: number; target_code: string }): Promise<LanguageFerryRow> {
  if (typeof input.tests_passed !== 'number' || !Number.isFinite(input.tests_passed) || input.tests_passed < 0) {
    throw AppError.badRequest('invalid_tests_passed', 'tests_passed must be a non-negative number');
  }
  if (!input.target_code || typeof input.target_code !== 'string') {
    throw AppError.badRequest('invalid_target_code', 'target code is required');
  }
  const ferry = await getLanguageFerry(userId, id);
  const allPassed = input.tests_passed >= ferry.total_tests;
  const status = allPassed ? 'VERIFIED' : 'RUNNING';
  await withTenant(userId, (q) => q.query(
    'UPDATE language_ferries SET tests_passed = $2, target_code = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $5',
    [id, input.tests_passed, input.target_code, status, userId],
  ));
  await recordAudit({
    action: AuditAction.FERRY_RUN_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'language_ferries',
    resourceId: id,
    detail: { tests_passed: input.tests_passed, total: ferry.total_tests, verified: allPassed },
  });
  return getLanguageFerry(userId, id);
}

export async function getLanguageFerry(userId: string, id: string): Promise<LanguageFerryRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM language_ferries WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('language_ferry_not_found', 'no language ferry found for that id');
  return rowOf(row);
}

export async function listLanguageFerries(userId: string): Promise<LanguageFerryRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM language_ferries WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function languageFerryReport(userId: string): Promise<{ ferries: number; planned: number; verified: number; total_tests: number }> {
  const list = await listLanguageFerries(userId);
  return {
    ferries: list.length,
    planned: list.filter((f) => f.status === 'PLANNED' || f.status === 'RUNNING').length,
    verified: list.filter((f) => f.status === 'VERIFIED').length,
    total_tests: list.reduce((sum, f) => sum + f.total_tests, 0),
  };
}
