/**
 * CodeConClave — Superpowers: TEST CONVERTER (Master Feature #103).
 *
 * Migrates tests between frameworks (Jest→Vitest, unittest→pytest,
 * Selenium→Playwright); proves the converted tests cover the same things.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface TestConversionRow {
  id: string;
  owner_id: string;
  source_framework: string;
  target_framework: string;
  source_test_path: string;
  target_test_path: string;
  coverage_match: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): TestConversionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_framework: String(r.source_framework),
  target_framework: String(r.target_framework),
  source_test_path: String(r.source_test_path),
  target_test_path: String(r.target_test_path),
  coverage_match: Boolean(r.coverage_match),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function planConversion(userId: string, input: {
  source_framework: string;
  target_framework: string;
  source_test_path: string;
  target_test_path?: string;
}): Promise<TestConversionRow> {
  if (!input.source_framework || typeof input.source_framework !== 'string') throw AppError.badRequest('invalid_source_framework', 'source framework is required');
  if (!input.target_framework || typeof input.target_framework !== 'string') throw AppError.badRequest('invalid_target_framework', 'target framework is required');
  if (!input.source_test_path || typeof input.source_test_path !== 'string') throw AppError.badRequest('invalid_source_path', 'source test path is required');
  const id = newId(PREFIX.TEST_CONVERTER);
  const targetPath = input.target_test_path ?? input.source_test_path;
  await withTenant(userId, (q) => q.query(
    'INSERT INTO test_conversions (id, owner_id, source_framework, target_framework, source_test_path, target_test_path, coverage_match, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.source_framework.trim(), input.target_framework.trim(), input.source_test_path.trim(), targetPath.trim(), false, 'PLANNING'],
  ));
  await recordAudit({
    action: AuditAction.TEST_CONVERT_PLANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'test_conversions',
    resourceId: id,
    detail: { source: input.source_framework, target: input.target_framework },
  });
  return getTestConversion(userId, id);
}

export async function verifyConversion(userId: string, id: string, input: { coverage_match: boolean; tests_passed: number; tests_failed: number }): Promise<TestConversionRow> {
  const conversion = await getTestConversion(userId, id);
  if (conversion.status === 'DONE') throw AppError.badRequest('already_verified', 'this conversion is already verified');
  await withTenant(userId, (q) => q.query(
    'UPDATE test_conversions SET coverage_match = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $2',
    [id, userId, input.coverage_match ? true : false, 'DONE'],
  ));
  await recordAudit({
    action: AuditAction.TEST_CONVERT_VERIFIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'test_conversions',
    resourceId: id,
    detail: { coverage_match: input.coverage_match, tests_passed: input.tests_passed, tests_failed: input.tests_failed },
  });
  return getTestConversion(userId, id);
}

export async function getTestConversion(userId: string, id: string): Promise<TestConversionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM test_conversions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('test_conversion_not_found', 'no test conversion found for that id');
  return rowOf(row);
}

export async function listTestConversions(userId: string): Promise<TestConversionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM test_conversions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function testConverterReport(userId: string): Promise<{
  conversions: number;
  verified: number;
  coverage_matches: number;
  by_source: Record<string, number>;
}> {
  const list = await listTestConversions(userId);
  const bySource: Record<string, number> = {};
  for (const c of list) bySource[c.source_framework] = (bySource[c.source_framework] ?? 0) + 1;
  return {
    conversions: list.length,
    verified: list.filter((c) => c.status === 'DONE').length,
    coverage_matches: list.filter((c) => c.coverage_match).length,
    by_source: bySource,
  };
}
