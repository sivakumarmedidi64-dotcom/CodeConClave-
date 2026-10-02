/**
 * CodeConClave — Superpowers: LIVE DEMO LINK (Feature #162).
 *
 * One click: a public, read-only "ask my codebase anything" link.
 * Auto-expires.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface DemoLinkRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  url: string;
  expires_at: Date;
  expired_at: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): DemoLinkRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  title: String(r.title),
  description: String(r.description),
  url: String(r.url),
  expires_at: new Date(r.expires_at as string),
  expired_at: r.expired_at == null ? null : new Date(r.expired_at as string),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createDemoLink(userId: string, input: { title: string; description: string; url: string; expires_at: string }): Promise<DemoLinkRow> {
  if (!input.title || typeof input.title !== 'string') throw AppError.badRequest('invalid_title', 'title is required');
  if (!input.url || typeof input.url !== 'string') throw AppError.badRequest('invalid_url', 'url is required');
  if (!input.expires_at || typeof input.expires_at !== 'string') throw AppError.badRequest('invalid_expires_at', 'expires_at is required');
  const id = newId(PREFIX.DEMO_LINK);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO demo_links (id, owner_id, title, description, url, expires_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.title, input.description ?? '', input.url, input.expires_at, 'ACTIVE'],
  ));
  await recordAudit({
    action: AuditAction.DEMO_LINK_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'demo_links',
    resourceId: id,
    detail: { title: input.title, url: input.url },
  });
  return getDemoLink(userId, id);
}

export async function expireDemoLink(userId: string, id: string): Promise<DemoLinkRow> {
  const link = await getDemoLink(userId, id);
  if (link.status === 'EXPIRED') throw AppError.badRequest('already_expired', 'demo link is already expired');
  await withTenant(userId, (q) => q.query(
    'UPDATE demo_links SET expired_at = now(), status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'EXPIRED', userId],
  ));
  await recordAudit({
    action: AuditAction.DEMO_LINK_EXPIRED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'demo_links',
    resourceId: id,
    detail: { title: link.title },
  });
  return getDemoLink(userId, id);
}

export async function getDemoLink(userId: string, id: string): Promise<DemoLinkRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM demo_links WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('demo_link_not_found', 'no demo link found for that id');
  return rowOf(row);
}

export async function listDemoLinks(userId: string): Promise<DemoLinkRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM demo_links WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function demoLinkReport(userId: string): Promise<{ links: number; active: number; expired: number }> {
  const links = await listDemoLinks(userId);
  return {
    links: links.length,
    active: links.filter((l) => l.status === 'ACTIVE').length,
    expired: links.filter((l) => l.status === 'EXPIRED').length,
  };
}
