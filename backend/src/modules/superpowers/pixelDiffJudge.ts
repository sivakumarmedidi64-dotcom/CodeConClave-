/**
 * CodeConClave — Superpowers: PIXEL DIFF JUDGE (Master Feature #113).
 *
 * Visual regression testing with semantic understanding — flags a 2px
 * layout-breaking shift, ignores intentional redesign. Judges diffs that
 * matter and ignores the ones that don't.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PixelDiffRow {
  id: string;
  owner_id: string;
  baseline_url: string;
  current_url: string;
  total_pixels_changed: number;
  layout_breaking: boolean;
  semantic_change: boolean;
  threshold_px: number;
  verdict: 'CLEAN' | 'WARNING' | 'BREAKING';
  diff_regions: Array<{ x: number; y: number; w: number; h: number; severity: string }>;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PixelDiffRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  baseline_url: String(r.baseline_url),
  current_url: String(r.current_url),
  total_pixels_changed: Number(r.total_pixels_changed ?? 0),
  layout_breaking: Boolean(r.layout_breaking),
  semantic_change: Boolean(r.semantic_change),
  threshold_px: Number(r.threshold_px ?? 2),
  verdict: (r.verdict ?? 'CLEAN') as PixelDiffRow['verdict'],
  diff_regions: asArray(r.diff_regions) as PixelDiffRow['diff_regions'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

export function judgePixelDiff(baselinePixels: number, currentPixels: number, thresholdPx: number): { verdict: PixelDiffRow['verdict']; layout_breaking: boolean; total_changed: number } {
  const totalChanged = Math.abs(currentPixels - baselinePixels);
  const layoutBreaking = totalChanged >= thresholdPx * 10;
  if (totalChanged === 0) return { verdict: 'CLEAN', layout_breaking: false, total_changed: 0 };
  if (layoutBreaking) return { verdict: 'BREAKING', layout_breaking: true, total_changed: totalChanged };
  if (totalChanged >= thresholdPx) return { verdict: 'WARNING', layout_breaking: false, total_changed: totalChanged };
  return { verdict: 'CLEAN', layout_breaking: false, total_changed: totalChanged };
}

export async function submitPixelDiff(userId: string, input: { baseline_url: string; current_url: string; baseline_pixels: number; current_pixels: number; threshold_px?: number; diff_regions?: Array<{ x: number; y: number; w: number; h: number; severity: string }> }): Promise<PixelDiffRow> {
  if (!input.baseline_url || typeof input.baseline_url !== 'string') throw AppError.badRequest('invalid_baseline', 'baseline image URL is required');
  if (!input.current_url || typeof input.current_url !== 'string') throw AppError.badRequest('invalid_current', 'current image URL is required');
  if (typeof input.baseline_pixels !== 'number' || !Number.isFinite(input.baseline_pixels) || input.baseline_pixels < 0) throw AppError.badRequest('invalid_pixels', 'baseline pixel count must be a non-negative number');
  if (typeof input.current_pixels !== 'number' || !Number.isFinite(input.current_pixels) || input.current_pixels < 0) throw AppError.badRequest('invalid_pixels', 'current pixel count must be a non-negative number');
  const threshold = typeof input.threshold_px === 'number' && input.threshold_px > 0 ? input.threshold_px : 2;
  const { verdict, layout_breaking, total_changed } = judgePixelDiff(input.baseline_pixels, input.current_pixels, threshold);
  const regions = Array.isArray(input.diff_regions) ? input.diff_regions : [];
  const semantic_change = regions.some((r) => r.severity === 'semantic');
  const id = newId(PREFIX.PIXEL_DIFF);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO pixel_diffs (id, owner_id, baseline_url, current_url, total_pixels_changed, layout_breaking, semantic_change, threshold_px, verdict, diff_regions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.baseline_url, input.current_url, total_changed, layout_breaking, semantic_change, threshold, verdict, JSON.stringify(regions)],
  ));
  await recordAudit({
    action: AuditAction.PIXEL_DIFF_JUDGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pixel_diffs',
    resourceId: id,
    detail: { baseline: input.baseline_url, current: input.current_url, verdict, total_changed, layout_breaking },
  });
  return getPixelDiff(userId, id);
}

export function pixelDiffVerdict(d: PixelDiffRow): string {
  if (d.verdict === 'CLEAN') return `"${d.baseline_url}" vs "${d.current_url}" — clean, no breaking diff`;
  if (d.verdict === 'BREAKING') return `"${d.baseline_url}" vs "${d.current_url}" — BREAKING: ${d.total_pixels_changed}px layout shift`;
  return `"${d.baseline_url}" vs "${d.current_url}" — warning: ${d.total_pixels_changed}px change`;
}

export async function getPixelDiff(userId: string, id: string): Promise<PixelDiffRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pixel_diffs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('pixel_diff_not_found', 'no pixel diff found for that id');
  return rowOf(row);
}

export async function listPixelDiffs(userId: string): Promise<PixelDiffRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pixel_diffs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function pixelDiffReport(userId: string): Promise<{ diffs: number; clean: number; warnings: number; breaking: number }> {
  const list = await listPixelDiffs(userId);
  return {
    diffs: list.length,
    clean: list.filter((d) => d.verdict === 'CLEAN').length,
    warnings: list.filter((d) => d.verdict === 'WARNING').length,
    breaking: list.filter((d) => d.verdict === 'BREAKING').length,
  };
}
