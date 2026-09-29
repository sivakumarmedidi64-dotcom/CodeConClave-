/**
 * CodeClave — Error Correlation Engine (V4D) — Part 2
 * Continuation of errorCorrelation.ts
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';

// Types and functions from Part 1
export interface CorrelationChain {
  correlationId: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  chain: CorrelationLink[];
  userImpact: UserImpactAssessment;
  timeline: TimelineEvent[];
}

export interface CorrelationLink {
  type: 'REQUEST' | 'TASK' | 'AGENT' | 'COMMIT' | 'DEPLOYMENT' | 'ERROR';
  id: string;
  name: string;
  timestamp: Date;
  status: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'PENDING' | 'UNKNOWN';
  details: Record<string, unknown>;
  parentId?: string;
  children: string[];
}

export interface UserImpactAssessment {
  affectedUsers: string[];
  severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  affectedFeatures: string[];
  estimatedUsersAffected: number;
  dataLossRisk: boolean;
  recoveryTimeEstimateMs?: number;
}

export interface TimelineEvent {
  timestamp: Date;
  eventType: string;
  entityType: string;
  entityId: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface CorrelationSearchOptions {
  correlationId?: string;
  requestId?: string;
  userId?: string;
  taskId?: string;
  agentId?: string;
  commitSha?: string;
  deploymentId?: string;
  timeWindowMs?: number;
  includeChildren?: boolean;
}

export interface CorrelationSearchResult {
  chains: CorrelationChain[];
  total: number;
}



async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<Record<string, unknown> | null>(userId, (db) =>
    db.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

// ... Continuation functions from Part 1

export async function traceCorrelation(
  userId: string,
  projectId: string,
  options: CorrelationSearchOptions
): Promise<CorrelationSearchResult> {
  await assertProjectAccess(userId, projectId);

  const timeWindowMs = options.timeWindowMs ?? 3600000;
  const since = new Date(Date.now() - options.timeWindowMs!);

  const chains: CorrelationChain[] = [];

  if (options.correlationId) {
    const chain = await buildChainFromCorrelationId(userId, projectId, options.correlationId, options.includeChildren);
    if (chain) chains.push(chain);
  } else if (options.requestId) {
    const chain = await buildChainFromRequestId(userId, projectId, options.requestId);
    if (chain) chains.push(chain);
  } else if (options.taskId) {
    const chain = await buildChainFromTaskId(userId, projectId, options.taskId);
    if (chain) chains.push(chain);
  } else if (options.agentId) {
    const chain = await buildChainFromAgentId(userId, projectId, options.agentId);
    if (chain) chains.push(chain);
  } else if (options.commitSha) {
    const chain = await buildChainFromCommitSha(userId, projectId, options.commitSha);
    if (chain) chains.push(chain);
  } else if (options.deploymentId) {
    const chain = await buildChainFromDeploymentId(userId, projectId, options.deploymentId);
    if (chain) chains.push(chain);
  } else if (options.userId) {
    const chain = await buildChainFromUserId(userId, projectId, options.userId);
    if (chain) chains.push(chain);
  } else {
    const chains = await findRecentErrorChains(userId, projectId, 3600000);
    return { chains, total: chains.length };
  }

  return { chains, total: chains.length };
}

async function buildChainFromCorrelationId(
  userId: string,
  projectId: string,
  correlationId: string,
  includeChildren = true
): Promise<CorrelationChain | null> {
  const errorRows = await withTenant<{
    correlation_id: string;
    created_at: Date;
    action: string;
    detail: any;
    actor_user_id: string;
  }[]>(userId, (db) =>
    db
      .query<{
        correlation_id: string;
        created_at: Date;
        action: string;
        detail: any;
        actor_user_id: string;
      }>(
        `SELECT correlation_id, created_at, action, detail, actor_user_id
         FROM audit_logs
         WHERE correlation_id = $1 AND success = false
         ORDER BY created_at ASC LIMIT 50`,
        [correlationId],
      )
      .then((r) => r.rows),
  );

  if (errorRows.length === 0) return null;

  const firstError = errorRows[0]!;
  const chainId = correlationId;
  const links: CorrelationLink[] = [];
  const timeline: TimelineEvent[] = [];

  links.push({
    type: 'ERROR',
    id: correlationId,
    name: 'Error Detected',
    timestamp: firstError.created_at,
    status: 'FAILED',
    details: { action: firstError.action, detail: firstError.detail },
    children: [],
  });
  timeline.push({
    timestamp: firstError.created_at,
    eventType: 'ERROR_DETECTED',
    entityType: 'ERROR',
    entityId: correlationId,
    description: `Error detected: ${firstError.action}`,
    metadata: { detail: firstError.detail },
  });

  const relatedLinks = await traceForward(userId, correlationId);
  links.push(...relatedLinks.links);
  timeline.push(...relatedLinks.timeline);

  const backwardLinks = await traceBackward(userId, correlationId);
  links.unshift(...backwardLinks.links);
  timeline.unshift(...backwardLinks.timeline);

  const userImpact = await assessUserImpact(userId, correlationId);
  const timelineEvents = timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    correlationId: chainId,
    chain: links,
    userImpact,
    timeline: timelineEvents,
  };
}

async function traceForward(userId: string, correlationId: string): Promise<{ links: CorrelationLink[]; timeline: TimelineEvent[] }> {
  const links: CorrelationLink[] = [];
  const timeline: TimelineEvent[] = [];

  const taskRows = await withTenant<{
    id: string;
    title: string;
    status: string;
    created_at: Date;
    completed_at: Date | null;
    correlation_id: string;
  }[]>(userId, (db) =>
    db
      .query<{
        id: string;
        title: string;
        status: string;
        created_at: Date;
        completed_at: Date | null;
        correlation_id: string;
      }>(
        `SELECT id, title, status, created_at, completed_at, correlation_id
         FROM tasks
         WHERE correlation_id = $1
         ORDER BY created_at ASC`,
        [correlationId],
      )
      .then((r) => r.rows),
  );

  for (const task of taskRows) {
    const linkId = task.id;
    links.push({
      type: 'TASK',
      id: linkId,
      name: `Task: ${task.title}`,
      timestamp: task.created_at,
      status: mapTaskStatus(task.status),
      details: { taskId: task.id, title: task.title },
      children: [],
    });
    timeline.push({
      timestamp: task.created_at,
      eventType: 'TASK_STARTED',
      entityType: 'TASK',
      entityId: task.id,
      description: `Task started: ${task.title}`,
      metadata: { status: task.status },
    });
    if (task.completed_at) {
      timeline.push({
        timestamp: task.completed_at,
        eventType: 'TASK_COMPLETED',
        entityType: 'TASK',
        entityId: task.id,
        description: `Task completed: ${task.title}`,
        metadata: { status: task.status },
      });
    }

    const agentRuns = await withTenant<{
      id: string;
      agent_id: string;
      status: string;
      created_at: Date;
      completed_at: Date | null;
    }[]>(userId, (db) =>
      db
        .query<{
          id: string;
          agent_id: string;
          status: string;
          created_at: Date;
          completed_at: Date | null;
        }>(
          `SELECT ar.id, ar.agent_id, ar.status, ar.created_at, ar.completed_at
           FROM agent_runs ar
           WHERE ar.task_id = $1
           ORDER BY ar.created_at ASC`,
          [task.id],
        )
        .then((r) => r.rows),
    );

    for (const agentRun of agentRuns) {
      links.push({
        type: 'AGENT',
        id: agentRun.id,
        name: `Agent Run: ${agentRun.id}`,
        timestamp: agentRun.created_at,
        status: mapAgentRunStatus(agentRun.status),
        details: { agentRunId: agentRun.id, agentId: agentRun.agent_id },
        parentId: task.id,
        children: [],
      });
      timeline.push({
        timestamp: agentRun.created_at,
        eventType: 'AGENT_RUN_STARTED',
        entityType: 'AGENT_RUN',
        entityId: agentRun.id,
        description: `Agent run started for task`,
        metadata: { agentId: agentRun.agent_id },
      });
    }

    const deployments = await withTenant<{
      id: string;
      status: string;
      created_at: Date;
      completed_at: Date | null;
    }[]>(userId, (db) =>
      db
        .query<{
          id: string;
          status: string;
          created_at: Date;
          completed_at: Date | null;
        }>(
          `SELECT id, status, created_at, completed_at
           FROM deployments
           WHERE task_id = $1
           ORDER BY created_at ASC`,
          [task.id],
        )
        .then((r) => r.rows),
    );

    for (const deploy of deployments) {
      links.push({
        type: 'DEPLOYMENT',
        id: deploy.id,
        name: `Deployment: ${deploy.id}`,
        timestamp: deploy.created_at,
        status: mapDeploymentStatus(deploy.status),
        details: { deploymentId: deploy.id },
        parentId: task.id,
        children: [],
      });
      timeline.push({
        timestamp: deploy.created_at,
        eventType: 'DEPLOYMENT_STARTED',
        entityType: 'DEPLOYMENT',
        entityId: deploy.id,
        description: `Deployment started for task`,
        metadata: { status: deploy.status },
      });
    }
  }

  return { links, timeline };
}

async function traceBackward(userId: string, correlationId: string): Promise<{ links: CorrelationLink[]; timeline: TimelineEvent[] }> {
  const links: CorrelationLink[] = [];
  const timeline: TimelineEvent[] = [];

  const requestRows = await withTenant<{
    id: string;
    method: string;
    path: string;
    user_id: string;
    correlation_id: string;
    created_at: Date;
  }[]>(userId, (db) =>
    db
      .query<{
        id: string;
        method: string;
        path: string;
        user_id: string;
        correlation_id: string;
        created_at: Date;
      }>(
        `SELECT id, method, path, user_id, correlation_id, created_at
         FROM http_requests
         WHERE correlation_id = $1
         ORDER BY created_at ASC LIMIT 1`,
        [correlationId],
      )
      .then((r) => r.rows),
  );

  if (requestRows.length > 0) {
    const req = requestRows[0]!;
    links.push({
      type: 'REQUEST',
      id: req.id,
      name: `Request: ${req.method} ${req.path}`,
      timestamp: req.created_at,
      status: 'SUCCESS',
      details: { requestId: req.id, method: req.method, path: req.path, userId: req.user_id },
      children: [],
    });
    timeline.push({
      timestamp: req.created_at,
      eventType: 'REQUEST_RECEIVED',
      entityType: 'HTTP_REQUEST',
      entityId: req.id,
      description: `Request received: ${req.method} ${req.path}`,
      metadata: { userId: req.user_id },
    });

    if (req.user_id) {
      const user = await withTenant<{ id: string; email: string; display_name: string }[]>(userId, (db) =>
        db
          .query<{ id: string; email: string; display_name: string }>('SELECT id, email, display_name FROM users WHERE id = $1', [req.user_id])
          .then((r) => r.rows),
      );
      if (user[0]) {
        timeline.push({
          timestamp: req.created_at,
          eventType: 'USER_IDENTIFIED',
          entityType: 'USER',
          entityId: req.user_id,
          description: `Request from user: ${user[0].email}`,
          metadata: { email: user[0].email },
        });
      }
    }
  }

  return { links, timeline };
}

async function buildChainFromRequestId(userId: string, projectId: string, requestId: string): Promise<CorrelationChain | null> {
  const req = await withTenant<{ correlation_id: string } | null>(userId, (db) =>
    db
      .query<{ correlation_id: string }>(
        `SELECT id, method, path, user_id, correlation_id, created_at
         FROM http_requests
         WHERE id = $1`,
        [requestId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!req) return null;
  return buildChainFromCorrelationId(userId, projectId, req.correlation_id);
}

async function buildChainFromTaskId(userId: string, projectId: string, taskId: string): Promise<CorrelationChain | null> {
  const task = await withTenant<{ correlation_id: string | null } | null>(userId, (db) =>
    db
      .query<{ correlation_id: string | null }>('SELECT id, correlation_id FROM tasks WHERE id = $1', [taskId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!task?.correlation_id) return null;
  return buildChainFromCorrelationId(userId, projectId, task.correlation_id);
}

async function buildChainFromAgentId(userId: string, projectId: string, agentId: string): Promise<CorrelationChain | null> {
  const agentRun = await withTenant<{ correlation_id: string | null } | null>(userId, (db) =>
    db
      .query<{ correlation_id: string | null }>(
        `SELECT ar.id, t.correlation_id
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         WHERE ar.agent_id = $1
         ORDER BY ar.created_at DESC LIMIT 1`,
        [agentId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!agentRun?.correlation_id) return null;
  return buildChainFromCorrelationId(userId, projectId, agentRun.correlation_id);
}

async function buildChainFromCommitSha(userId: string, projectId: string, commitSha: string): Promise<CorrelationChain | null> {
  const deployment = await withTenant<{ correlation_id: string | null } | null>(userId, (db) =>
    db
      .query<{ correlation_id: string | null }>(
        `SELECT d.id, t.correlation_id
         FROM deployments d
         JOIN tasks t ON t.id = d.task_id
         WHERE d.commit_sha = $1
         ORDER BY d.created_at DESC LIMIT 1`,
        [commitSha],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!deployment?.correlation_id) return null;
  return buildChainFromCorrelationId(userId, projectId, deployment.correlation_id);
}

async function buildChainFromDeploymentId(userId: string, projectId: string, deploymentId: string): Promise<CorrelationChain | null> {
  const deployment = await withTenant<{ correlation_id: string | null } | null>(userId, (db) =>
    db
      .query<{ correlation_id: string | null }>(
        `SELECT id, t.correlation_id
         FROM deployments d
         JOIN tasks t ON t.id = d.task_id
         WHERE d.id = $1`,
        [deploymentId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (!deployment?.correlation_id) return null;
  return buildChainFromCorrelationId(userId, projectId, deployment.correlation_id);
}

async function buildChainFromUserId(userId: string, projectId: string, targetUserId: string): Promise<CorrelationChain | null> {
  const errors = await withTenant<{ correlation_id: string; created_at: Date }[]>(userId, (db) =>
    db
      .query<{ correlation_id: string; created_at: Date }>(
        `SELECT correlation_id, created_at
         FROM audit_logs
         WHERE actor_user_id = $1 AND success = false AND created_at > now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT 10`,
        [targetUserId],
      )
      .then((r) => r.rows),
  );
  if (errors.length === 0) return null;
  return buildChainFromCorrelationId(userId, projectId, errors[0]!.correlation_id);
}

async function findRecentErrorChains(userId: string, projectId: string, timeWindowMs: number): Promise<CorrelationChain[]> {
  const chains: CorrelationChain[] = [];
  const since = new Date(Date.now() - timeWindowMs);

  const errorCorrIds = await withTenant<{ correlation_id: string; created_at: Date }[]>(userId, (db) =>
    db
      .query<{ correlation_id: string; created_at: Date }>(
        `SELECT DISTINCT correlation_id, MAX(created_at) as created_at
         FROM audit_logs
         WHERE project_id = $1 AND success = false AND created_at >= $2 AND correlation_id IS NOT NULL
         GROUP BY correlation_id
         ORDER BY MAX(created_at) DESC LIMIT 20`,
        [projectId, since.toISOString()],
      )
      .then((r) => r.rows),
  );

  for (const row of errorCorrIds) {
    const chain = await buildChainFromCorrelationId(userId, projectId, row.correlation_id);
    if (chain) chains.push(chain);
  }

  return chains;
}

async function assessUserImpact(userId: string, correlationId: string): Promise<UserImpactAssessment> {
  const affectedUsers = new Set<string>();
  let affectedFeatures: string[] = [];
  let dataLossRisk = false;

  const tasks = await withTenant<{ id: string; title: string; project_id: string }[]>(userId, (db) =>
    db
      .query<{ id: string; title: string; project_id: string }>(
        `SELECT DISTINCT t.id, t.title, t.project_id
         FROM tasks t
         JOIN tasks t2 ON t2.correlation_id = t.correlation_id
         WHERE t2.correlation_id = $1`,
        [correlationId],
      )
      .then((r) => r.rows),
  );

  for (const task of tasks) {
    const members = await withTenant<{ user_id: string }[]>(userId, (db) =>
      db
        .query<{ user_id: string }>(`SELECT user_id FROM project_members WHERE project_id = $1`, [task.project_id])
        .then((r) => r.rows),
    );
    for (const m of members) affectedUsers.add(m.user_id);
    affectedFeatures.push(task.title);
  }

  const dataLossIndicators = await withTenant<{ count: number }[]>(userId, (db) =>
    db
      .query<{ count: number }>(
        `SELECT count(*)::int as count
         FROM audit_logs
         WHERE correlation_id = $1 AND action LIKE '%DELETE%' AND success = true`,
        [correlationId],
      )
      .then((r) => r.rows),
  );
  dataLossRisk = (dataLossIndicators[0]?.count ?? 0) > 0;

  const taskCount = await withTenant<{ count: number }[]>(userId, (db) =>
    db
      .query<{ count: number }>(`SELECT count(*)::int as count FROM tasks WHERE correlation_id = $1`, [correlationId])
      .then((r) => r.rows),
  );
  const recoveryTimeEstimateMs = (taskCount[0]?.count ?? 1) * 300000;

  return {
    affectedUsers: Array.from(affectedUsers),
    severity: affectedUsers.size > 100 ? 'CRITICAL' : affectedUsers.size > 10 ? 'HIGH' : affectedUsers.size > 0 ? 'MEDIUM' : 'LOW',
    description: `${affectedUsers.size} users potentially affected across ${new Set(affectedFeatures).size} features`,
    affectedFeatures: Array.from(new Set(affectedFeatures)),
    estimatedUsersAffected: affectedUsers.size,
    dataLossRisk,
    recoveryTimeEstimateMs,
  };
}

function mapTaskStatus(status: string): CorrelationLink['status'] {
  switch (status) {
    case 'COMPLETED': return 'SUCCESS';
    case 'FAILED': return 'FAILED';
    case 'RUNNING':
    case 'TESTING':
    case 'VERIFIED': return 'RUNNING';
    case 'WAITING_APPROVAL':
    case 'BLOCKED':
    case 'WAITING_FOR_LOCAL_AGENT': return 'PENDING';
    default: return 'UNKNOWN';
  }
}

function mapAgentRunStatus(status: string): CorrelationLink['status'] {
  switch (status) {
    case 'COMPLETED': return 'SUCCESS';
    case 'FAILED': return 'FAILED';
    case 'RUNNING': return 'RUNNING';
    default: return 'UNKNOWN';
  }
}

function mapDeploymentStatus(status: string): CorrelationLink['status'] {
  switch (status) {
    case 'SUCCESS': return 'SUCCESS';
    case 'FAILED': return 'FAILED';
    case 'DEPLOYING': return 'RUNNING';
    default: return 'UNKNOWN';
  }
}