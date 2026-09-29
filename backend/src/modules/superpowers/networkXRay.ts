/**
 * CodeConClave — Superpowers: NETWORK X-RAY (Master Feature #91).
 *
 * Maps every service-to-service call, queue, and dependency in real time;
 * shows the blast radius of any failure instantly. Architecture graphs that
 * are alive, not drawn once.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface NetworkEdgeRow {
  id: string;
  owner_id: string;
  src: string;
  dst: string;
  calls: number;
  created_at: Date;
  updated_at: Date;
}

export interface NetworkMap {
  services: string[];
  edges: Array<{ from: string; to: string; calls: number }>;
}

const rowOf = (r: Record<string, unknown>): NetworkEdgeRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  src: String(r.src),
  dst: String(r.dst),
  calls: Number(r.calls),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function recordServiceCall(userId: string, input: { from: string; to: string; calls?: number }): Promise<NetworkEdgeRow> {
  if (!input.from || typeof input.from !== 'string') throw AppError.badRequest('invalid_from', 'the source service is required');
  if (!input.to || typeof input.to !== 'string') throw AppError.badRequest('invalid_to', 'the destination service is required');
  const calls = typeof input.calls === 'number' && Number.isFinite(input.calls) && input.calls > 0 ? Math.floor(input.calls) : 1;
  const existing = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM network_edges WHERE owner_id = $1 AND src = $2 AND dst = $3', [userId, input.from, input.to])).rows[0] ?? null,
  );
  if (existing) {
    const row = rowOf(existing);
    await withTenant(userId, (q) =>
      q.query('UPDATE network_edges SET calls = calls + $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [row.id, userId, calls]),
    );
    const updated = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM network_edges WHERE id = $1 AND owner_id = $2', [row.id, userId])).rows[0] ?? null,
    );
    return rowOf(updated!);
  }
  const id = newId(PREFIX.NETWORK_EDGE);
  await withTenant(userId, (q) =>
    q.query('INSERT INTO network_edges (id, owner_id, src, dst, calls) VALUES ($1,$2,$3,$4,$5)', [id, userId, input.from, input.to, calls]),
  );
  await recordAudit({
    action: AuditAction.SERVICE_CALL_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'network_edges',
    resourceId: id,
    detail: { from: input.from, to: input.to, calls },
  });
  return getNetworkEdge(userId, id);
}

export async function getNetworkEdge(userId: string, id: string): Promise<NetworkEdgeRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM network_edges WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('network_edge_not_found', 'no network edge found for that id');
  return rowOf(row);
}

export async function listNetworkEdges(userId: string): Promise<NetworkEdgeRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM network_edges WHERE owner_id = $1', [userId])).rows,
  );
  return rows.map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function getNetworkMap(userId: string): Promise<NetworkMap> {
  const edges = await listNetworkEdges(userId);
  const services = Array.from(new Set(edges.flatMap((e) => [e.src, e.dst]))).sort();
  return {
    services,
    edges: edges.map((e) => ({ from: e.src, to: e.dst, calls: e.calls })),
  };
}

/** Every service reachable downstream of a failing node. */
export function computeBlastRadius(edges: NetworkEdgeRow[], node: string): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.src) ?? [];
    list.push(e.dst);
    adjacency.set(e.src, list);
  }
  const reachable = new Set<string>();
  const queue = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (next !== node && !reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return Array.from(reachable).sort();
}

export async function blastRadius(userId: string, node: string): Promise<{ node: string; radius: number; services: string[] }> {
  const edges = await listNetworkEdges(userId);
  if (!edges.some((e) => e.src === node || e.dst === node)) {
    throw AppError.badRequest('service_not_in_map', 'that service is not on the network map');
  }
  const services = computeBlastRadius(edges, node);
  await recordAudit({
    action: AuditAction.BLAST_RADIUS_COMPUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'network_edges',
    resourceId: `${node}`,
    detail: { node, radius: services.length },
  });
  return { node, radius: services.length, services };
}

export async function networkXrayReport(userId: string): Promise<{ services: number; edges: number; calls_total: number }> {
  const edges = await listNetworkEdges(userId);
  const nodes = new Set(edges.flatMap((e) => [e.src, e.dst]));
  return {
    services: nodes.size,
    edges: edges.length,
    calls_total: edges.reduce((s, e) => s + e.calls, 0),
  };
}