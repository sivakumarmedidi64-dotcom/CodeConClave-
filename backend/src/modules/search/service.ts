/**
 * CodeConClave — global search (Phase 8).
 * PostgreSQL is the source of truth: entity queries are tenant-scoped
 * (owner or project member), keyword ILIKE with filters (type, project,
 * date range, owner, tag), limit capped at 50. No external search engine.
 */
import { queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, SearchEntity } from '@codeconclave/shared';

export interface SearchFilters {
  q?: string;
  type?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
  ownerId?: string;
  tag?: string;
  teamId?: string;
  memberId?: string;
  limit?: number;
}

export interface SearchHit {
  entity: string;
  id: string;
  label: string;
  createdAt: Date | string;
  projectId?: string | null;
  [key: string]: unknown;
}

export interface SearchResult {
  results: SearchHit[];
  total: number;
}

const VALID_TYPES = new Set<string>(Object.values(SearchEntity));

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function globalSearch(userId: string, filters: SearchFilters): Promise<SearchResult> {
  const { q, type, projectId, dateFrom, dateTo, ownerId, tag, teamId, memberId } = filters;
  if (type && !VALID_TYPES.has(type)) {
    throw AppError.badRequest('invalid_type', `type must be one of: ${[...VALID_TYPES].join(', ')}`);
  }
  if (ownerId && type !== 'project') {
    throw AppError.badRequest('owner_scope', 'ownerId is only supported for project search');
  }
  if (teamId) {
    // Phase 9: team-scoped search is gated on ACTIVE membership; outsiders
    // simply see no results (never an authorization leak).
    const { teamRoleFor } = await import('../teams/service.js');
    const role = await teamRoleFor(userId, teamId);
    if (!role) return { results: [], total: 0 };
  }
  if (!q?.trim() && !tag && !projectId && !teamId) {
    return { results: [], total: 0 };
  }

  const keyword = `%${escapeLike(q?.trim() ?? '')}%`;
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const tenant = '(p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))';

  const teamScope = (col: string, params: unknown[]): string | null => {
    if (!teamId) return null;
    params.push(teamId);
    return `${col} = $${params.length}`;
  };
  const memberScope = (col: string, params: unknown[]): string | null => {
    if (!memberId) return null;
    params.push(memberId);
    return `${col} = $${params.length}`;
  };

  let results: SearchHit[] = [];
  const entity = type ?? 'all';

  if (!type || type === 'file') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = [`${tenant}`, 'f.deleted_at IS NULL', 'f.path ILIKE $2'];
    if (projectId) {
      params.push(projectId);
      clauses.push(`f.project_id = $${params.length}`);
    }
    const ts = teamScope('p.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('f.owner_id', params);
    if (ms) clauses.push(ms);
    if (dateFrom) {
      params.push(dateFrom);
      clauses.push(`f.created_at >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      clauses.push(`f.created_at <= $${params.length}`);
    }
    if (tag) {
      params.push(tag);
      clauses.push(`$${params.length} = ANY(f.tags)`);
    }
    const rows = await queryMany<{ id: string; path: string; category: string | null; created_at: Date; project_id: string }>(
      `SELECT f.id, f.path, f.category, f.created_at, f.project_id
       FROM files f
       JOIN projects p ON p.id = f.project_id
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY f.updated_at DESC LIMIT ${limit}`,
      params,
    );
    results = rows.map((r) => ({
      entity: SearchEntity.FILE,
      id: r.id,
      label: r.path,
      createdAt: r.created_at,
      projectId: r.project_id,
      category: r.category,
    }));
  }

  if (!type || type === 'project') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = ['p.owner_id = $1', 'p.deleted_at IS NULL', 'p.name ILIKE $2'];
    const ts = teamScope('p.team_id', params);
    if (ts) clauses.push(ts);
    if (ownerId) {
      params.push(ownerId);
      clauses.push(`p.owner_id = $${params.length}`);
    }
    const ms = memberScope('p.owner_id', params);
    if (ms) clauses.push(ms);
    const rows = await queryMany<{ id: string; name: string; description: string | null; created_at: Date; owner_id: string }>(
      `SELECT p.id, p.name, p.description, p.created_at, p.owner_id
       FROM projects p
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY p.updated_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.PROJECT,
        id: r.id,
        label: r.name,
        createdAt: r.created_at,
        description: r.description,
        ownerId: r.owner_id,
      })),
    ];
  }

  if (!type || type === 'conversation') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = ['c.owner_id = $1', 'c.title ILIKE $2'];
    const ts = teamScope('c.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('c.owner_id', params);
    if (ms) clauses.push(ms);
    const rows = await queryMany<{ id: string; title: string; mode: string; created_at: Date; project_id: string | null }>(
      `SELECT c.id, c.title, c.mode, c.created_at, c.project_id
       FROM conversations c
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY c.updated_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.CONVERSATION,
        id: r.id,
        label: r.title,
        createdAt: r.created_at,
        projectId: r.project_id,
        mode: r.mode,
      })),
    ];
  }

  if (!type || type === 'memory') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = ['m.owner_id = $1', 'm.content ILIKE $2'];
    const ts = teamScope('m.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('m.owner_id', params);
    if (ms) clauses.push(ms);
    const rows = await queryMany<{ id: string; content: string; type: string; created_at: Date; project_id: string | null }>(
      `SELECT m.id, m.content, m.type, m.created_at, m.project_id
       FROM memories m
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY m.updated_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.MEMORY,
        id: r.id,
        label: r.content,
        createdAt: r.created_at,
        projectId: r.project_id,
        memoryType: r.type,
      })),
    ];
  }

  if (!type || type === 'task') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = [`${tenant}`, 't.title ILIKE $2'];
    const ts = teamScope('p.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('t.owner_id', params);
    if (ms) clauses.push(ms);
    const rows = await queryMany<{ id: string; title: string; status: string; created_at: Date; project_id: string }>(
      `SELECT t.id, t.title, t.status, t.created_at, t.project_id
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY t.created_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.TASK,
        id: r.id,
        label: r.title,
        createdAt: r.created_at,
        projectId: r.project_id,
        status: r.status,
      })),
    ];
  }

  if (!type || type === 'artifact') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = [`${tenant}`, 'a.name ILIKE $2'];
    const ts = teamScope('p.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('t.owner_id', params);
    if (ms) clauses.push(ms);
    const rows = await queryMany<{ id: string; name: string; kind: string; created_at: Date; project_id: string }>(
      `SELECT a.id, a.name, a.kind, a.created_at, t.project_id
       FROM artifacts a
       JOIN tasks t ON t.id = a.task_id
       JOIN projects p ON p.id = t.project_id
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY a.created_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.ARTIFACT,
        id: r.id,
        label: r.name,
        createdAt: r.created_at,
        projectId: r.project_id,
        kind: r.kind,
      })),
    ];
  }

  if (!type || type === 'idea') {
    const params: unknown[] = [userId, keyword];
    const clauses: string[] = [
      `(i.owner_id = $1 OR i.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) ` +
        `OR i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE'))`,
      'i.deleted_at IS NULL',
      '(i.title ILIKE $2 OR COALESCE(i.description, \'\') ILIKE $2)',
    ];
    if (projectId) {
      params.push(projectId);
      clauses.push(`i.project_id = $${params.length}`);
    }
    const ts = teamScope('i.team_id', params);
    if (ts) clauses.push(ts);
    const ms = memberScope('i.owner_id', params);
    if (ms) clauses.push(ms);
    if (tag) {
      params.push(tag);
      clauses.push(`$${params.length} = ANY(i.tags)`);
    }
    const rows = await queryMany<{ id: string; title: string; status: string; priority: string; created_at: Date; project_id: string | null }>(
      `SELECT i.id, i.title, i.status, i.priority, i.created_at, i.project_id
       FROM ideas i
       WHERE ${clauses.join('\n  AND ')}
       ORDER BY i.updated_at DESC LIMIT ${limit}`,
      params,
    );
    results = [
      ...results,
      ...rows.map((r) => ({
        entity: SearchEntity.IDEA,
        id: r.id,
        label: r.title,
        createdAt: r.created_at,
        projectId: r.project_id,
        status: r.status,
        priority: r.priority,
      })),
    ];
  }

  const filtersDetail: Record<string, string> = {};
  if (projectId) filtersDetail.projectId = projectId;
  if (tag) filtersDetail.tag = tag;
  if (teamId) filtersDetail.teamId = teamId;
  if (memberId) filtersDetail.memberId = memberId;

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'search',
    detail: { entity, q: q?.trim() ?? '', filters: filtersDetail },
  });

  return { results, total: results.length };
}