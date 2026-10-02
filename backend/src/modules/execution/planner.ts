/**
 * CodeConClave — planner (Phase 7): structured, persisted, validated plans.
 *
 * The PLANNER coworker's output is NEVER executed free-form. It is parsed,
 * validated against the nine coworker types, and persisted to plans +
 * plan_entries. Only then does the orchestrator turn it into an executable
 * pipeline. Invalid or missing model output falls back to a deterministic
 * default plan — nothing arbitrary is ever executed.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { completeWithFallback } from '../ai/gateway.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from './policy-shared.js';
import { logger } from '../../shared/logger.js';
import { retrieveAgentContext } from '../memorycoding/agentContext.js';

export interface PlanEntryInput {
  coworker: string;
  input?: Record<string, unknown>;
  parallelGroup?: number;
  requiredTools?: string[];
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  acceptanceCriteria?: string;
  expectedArtifacts?: string[];
}

/** Executable pipeline entry (plan entry + runtime hints). */
export interface PipelineEntry {
  coworker: string;
  input?: Record<string, unknown>;
  parallelGroup?: number;
  requiredTools?: string[];
  risk?: string;
  acceptanceCriteria?: string;
  expectedArtifacts?: string[];
}

export interface PersistedPlan {
  id: string;
  task_id: string;
  goal: string;
  status: string;
  entries: PlanEntryInput[];
}

const VALID_COWORKER_TYPES = new Set([
  'ARCHITECT',
  'CODER',
  'SECURITY',
  'TESTER',
  'PERFORMANCE',
  'RESEARCH',
  'DOCS',
  'REVIEWER',
  'PLANNER',
  'NOVA',
]);

const VALID_RISK = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Deterministic fallback plan — used whenever the PLANNER output is unusable. */
export const DEFAULT_PLAN: PlanEntryInput[] = [
  { coworker: 'ARCHITECT' },
  { coworker: 'CODER' },
  { coworker: 'SECURITY' },
  { coworker: 'TESTER' },
  { coworker: 'REVIEWER' },
  { coworker: 'DOCS' },
];

const PLANNER_SYSTEM_PROMPT =
  'You are the Planner coworker. Convert the goal into an ordered, dependency-safe pipeline of coworker runs. ' +
  'Respond with ONLY a JSON object of the form ' +
  '{"pipeline":[{"coworker":"TYPE","input":{},"parallelGroup":0,"requiredTools":[],"risk":"MEDIUM",' +
  '"acceptanceCriteria":"...","expectedArtifacts":["..."]}]}. ' +
  'parallelGroup: consecutive entries with the same integer run in parallel (only when dependency-safe; ' +
  'omit it for a fully sequential pipeline). ' +
  'Use only these coworker types: ARCHITECT, CODER, SECURITY, TESTER, PERFORMANCE, RESEARCH, DOCS, REVIEWER, PLANNER. ' +
  'Keep the pipeline minimal: at most one of SECURITY/PERFORMANCE/REVIEWER per stage.';

/**
 * Parse and validate a PLANNER response. Returns null on ANY invalid input —
 * callers must fall back to the deterministic default plan, never execute
 * arbitrary text.
 */
export function parsePlannerResponse(text: string): PlanEntryInput[] | null {
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* fall through to bracket scan */
  }
  if (!json) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        json = JSON.parse(text.slice(start, end + 1));
      } catch {
        json = null;
      }
    }
  }
  if (!json || typeof json !== 'object') return null;
  const raw = (json as { pipeline?: unknown }).pipeline ?? (json as { entries?: unknown }).entries;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return validatePlannerEntries(raw);
}

/** Validate raw planner entries against the coworker catalog. Null on any invalid entry. */
export function validatePlannerEntries(raw: unknown[]): PlanEntryInput[] | null {
  const out: PlanEntryInput[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null;
    const rec = e as Record<string, unknown>;
    if (typeof rec.coworker !== 'string' || !VALID_COWORKER_TYPES.has(rec.coworker)) return null;
    const entry: PlanEntryInput = { coworker: rec.coworker };
    if (rec.input && typeof rec.input === 'object' && !Array.isArray(rec.input)) {
      entry.input = rec.input as Record<string, unknown>;
    }
    if (typeof rec.parallelGroup === 'number' && Number.isInteger(rec.parallelGroup) && rec.parallelGroup >= 0) {
      entry.parallelGroup = rec.parallelGroup;
    }
    if (Array.isArray(rec.requiredTools)) {
      entry.requiredTools = rec.requiredTools.filter((t): t is string => typeof t === 'string');
    }
    if (typeof rec.risk === 'string' && VALID_RISK.has(rec.risk)) {
      entry.risk = rec.risk as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    }
    if (typeof rec.acceptanceCriteria === 'string') entry.acceptanceCriteria = rec.acceptanceCriteria;
    if (Array.isArray(rec.expectedArtifacts)) {
      entry.expectedArtifacts = rec.expectedArtifacts.filter((s): s is string => typeof s === 'string');
    }
    out.push(entry);
  }
  return out;
}

export interface PlanRow {
  id: string;
  task_id: string;
  goal: string;
  status: string;
  risk_level: string | null;
  estimated_work: string | null;
  acceptance_criteria: unknown;
  expected_artifacts: unknown;
}

export interface PlanEntryRow {
  id: string;
  plan_id: string;
  order_index: number;
  coworker_type: string;
  input: unknown;
  parallel_group: number | null;
  required_tools: unknown;
  risk: string | null;
  acceptance_criteria: string | null;
  expected_artifacts: unknown;
}

/** Persist a plan idempotently (per task). Replaces entries on re-persist. */
export async function persistPlan(input: {
  taskId: string;
  goal: string;
  entries: PlanEntryInput[];
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedWork?: string;
  acceptanceCriteria?: string[];
  expectedArtifacts?: string[];
}): Promise<PersistedPlan> {
  const planId = await withSystem(async (q) => {
    const existing = (await q.query<{ id: string }>('SELECT id FROM plans WHERE task_id = $1', [input.taskId])).rows[0];
    const id = existing?.id ?? newId(PREFIX.PLAN);
    await q.query(
      `INSERT INTO plans (id, task_id, goal, status, risk_level, estimated_work, acceptance_criteria, expected_artifacts)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (task_id) DO UPDATE SET goal = EXCLUDED.goal, status = 'ACTIVE', updated_at = now()`,
      [
        id,
        input.taskId,
        input.goal,
        input.riskLevel ?? null,
        input.estimatedWork ?? null,
        JSON.stringify(input.acceptanceCriteria ?? []),
        JSON.stringify(input.expectedArtifacts ?? []),
      ],
    );
    await q.query('DELETE FROM plan_entries WHERE plan_id = $1', [id]);
    for (const [i, e] of input.entries.entries()) {
      await q.query(
        `INSERT INTO plan_entries (
           id, plan_id, order_index, coworker_type, input, parallel_group,
           depends_on, required_tools, risk, acceptance_criteria, expected_artifacts
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb)`,
        [
          newId(PREFIX.PLAN_ENTRY),
          id,
          i,
          e.coworker,
          JSON.stringify(e.input ?? {}),
          e.parallelGroup ?? null,
          JSON.stringify([]),
          JSON.stringify(e.requiredTools ?? []),
          e.risk ?? null,
          e.acceptanceCriteria ?? null,
          JSON.stringify(e.expectedArtifacts ?? []),
        ],
      );
    }
    return id;
  });
  return getPlan(input.taskId) as Promise<PersistedPlan>;
}

/** Load the persisted plan for a task, or null. */
export async function getPlan(taskId: string): Promise<PersistedPlan | null> {
  const plan = await withSystem(async (q) => (await q.query<PlanRow>('SELECT * FROM plans WHERE task_id = $1', [taskId])).rows[0] ?? null);
  if (!plan) return null;
  const rows = await withSystem(async (q) => (await q.query<PlanEntryRow>('SELECT * FROM plan_entries WHERE plan_id = $1 ORDER BY order_index', [plan.id])).rows);
  return {
    id: plan.id,
    task_id: plan.task_id,
    goal: plan.goal,
    status: plan.status,
    entries: rows.map((r) => {
      const requiredTools = (r.required_tools as string[] | null) ?? [];
      const expectedArtifacts = (r.expected_artifacts as string[] | null) ?? [];
      return {
        coworker: r.coworker_type,
        input: (r.input as Record<string, unknown> | null) ?? {},
        parallelGroup: r.parallel_group ?? undefined,
        requiredTools: requiredTools.length ? requiredTools : undefined,
        risk: (r.risk as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null) ?? undefined,
        acceptanceCriteria: r.acceptance_criteria ?? undefined,
        expectedArtifacts: expectedArtifacts.length ? expectedArtifacts : undefined,
      };
    }),
  };
}

/**
 * Generate a plan by invoking the PLANNER coworker through the AI gateway.
 * Any failure — gateway error, unparseable output, invalid entries — falls back
 * to the deterministic DEFAULT_PLAN. The result is always persisted, and the
 * audit trail records which source produced it.
 */
export async function generatePlan(input: {
  userId: string;
  taskId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
}): Promise<PersistedPlan> {
  let entries: PlanEntryInput[] | null = null;
  try {
    const planRow = await withTenant(input.userId, async (q) => (await q.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [input.userId])).rows[0] ?? null);
    const memoryContext = input.projectId
      ? await retrieveAgentContext(input.userId, { projectId: input.projectId })
      : 'Memory context: (project not provided)\n';
    const summary = await completeWithFallback({
      ctx: {
        userId: input.userId,
        sessionId: `plan:${input.taskId}`,
        conversationId: null,
        taskId: input.taskId,
        planId: planRow?.plan_id === 'pro' ? 'pro' : 'free',
        coworkerType: 'PLANNER',
      },
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Goal: ${input.title}\nDescription: ${input.description ?? 'none'}\n\n${memoryContext}`,
        },
      ],
      maxTokens: 1500,
      opts: { computeClass: 'C', coworkerType: 'PLANNER' },
    });
    entries = parsePlannerResponse(summary.text);
    if (!entries) logger.warn('planner returned invalid output; using default plan', { taskId: input.taskId });
  } catch (err) {
    logger.warn('planner generation failed; using default plan', { taskId: input.taskId, err });
  }
  const finalEntries = entries ?? DEFAULT_PLAN;
  const plan = await persistPlan({ taskId: input.taskId, goal: input.title, entries: finalEntries });
  await recordAudit({
    action: AuditAction.TASK_PLAN_CREATED,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'task',
    resourceId: input.taskId,
    detail: {
      planId: plan.id,
      source: entries ? 'planner' : 'default_fallback',
      pipeline: finalEntries.map((e) => e.coworker),
    },
  });
  return plan;
}

/** Turn a persisted plan into executable pipeline entries. */
export function planToPipeline(plan: PersistedPlan): PipelineEntry[] {
  return plan.entries.map((e) => ({
    coworker: e.coworker,
    input: e.input ?? {},
    parallelGroup: e.parallelGroup,
    requiredTools: e.requiredTools,
    risk: e.risk,
    acceptanceCriteria: e.acceptanceCriteria,
    expectedArtifacts: e.expectedArtifacts,
  }));
}

/**
 * Bucket pipeline entries into execution groups: consecutive entries sharing
 * the same parallelGroup run together; standalone entries run alone. Order is
 * always preserved — parallel never reorders or conflicts state.
 */
export function groupPipeline(pipeline: PipelineEntry[]): PipelineEntry[][] {
  const groups: PipelineEntry[][] = [];
  for (const entry of pipeline) {
    const last = groups[groups.length - 1];
    if (entry.parallelGroup !== undefined && last && last.length > 0 && last[0]?.parallelGroup === entry.parallelGroup) {
      last.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}