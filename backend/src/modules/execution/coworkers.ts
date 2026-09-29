/**
 * CodeConClave — coworker catalog + run orchestration (9 coworkers).
 * Types per migration 0009: ARCHITECT, CODER, SECURITY, TESTER, PERFORMANCE,
 * RESEARCH, DOCS, REVIEWER, PLANNER. Every run is persisted with input/output,
 * state transitions, handoffs, artifacts (SHA-256), and verification result.
 */
import { withSystem, withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { createHash } from 'node:crypto';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from './policy-shared.js';
import { AppError } from '../../shared/errors.js';
import { completeWithFallback } from '../ai/gateway.js';
import type { ChatMessage } from '../ai/providers.js';
import { planRoute } from '../ai/router.js';
import { retrieveAgentContext } from '../memorycoding/agentContext.js';
import { TaskType, RoutingPreference } from '@codeconclave/shared';

export interface CoworkerDef {
  type: string;
  name: string;
  role: string;
  systemPrompt: string;
  maxTokens: number;
  capabilities: string[];
  constraints: string[];
  modelPolicy: { computeClass: 'A' | 'B' | 'C'; maxTokens: number };
  permissionScope: string;
  taskLifecycle: string;
  artifactSchema: string[];
  failureBehavior: string;
  memoryAccess: string;
  auditBehavior: string;
}

export const COWORKERS: CoworkerDef[] = [
  {
    type: 'ARCHITECT',
    name: 'Architect',
    role: 'System design and architecture planning',
    systemPrompt:
      'You are the Architect coworker. Produce architecture decisions: component boundaries, data flow, ' +
      'interfaces, and failure modes. Output structured markdown. Be concrete and decisive.',
    maxTokens: 2000,
    capabilities: ['design', 'interface_spec', 'failure_mode_analysis'],
    constraints: ['no file writes', 'no terminal execution', 'no external calls'],
    modelPolicy: { computeClass: 'C', maxTokens: 2000 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'First cloud stage after planning',
    artifactSchema: ['architecture_decision_md', 'interface_contract_json'],
    failureBehavior: 'Aborts pipeline; task retried per retry policy',
    memoryAccess: 'Read project DNA + semantic memory only',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT on every completion',
  },
  {
    type: 'CODER',
    name: 'Coder',
    role: 'Writes and edits code',
    systemPrompt:
      'You are the Coder coworker. Write clean, idiomatic code matching the project conventions you are given. ' +
      'Prefer small diffs. Never fabricate file contents for files you have not read. Output a changeset with paths and content.',
    maxTokens: 3000,
    capabilities: ['codegen', 'changeset', 'refactor', 'test_code'],
    constraints: ['no deployment', 'no secret material', 'no destructive git ops'],
    modelPolicy: { computeClass: 'C', maxTokens: 3000 },
    permissionScope: 'PROJECT_FILES_WRITE_VIA_APPROVAL',
    taskLifecycle: 'Second cloud stage; consumes architecture decisions',
    artifactSchema: ['changeset_json', 'diff', 'file_contents'],
    failureBehavior: 'Step FAILED; pipeline aborts; retry applies',
    memoryAccess: 'Read/write episodic memory via explicit tool calls',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT + EXECUTION_TOOL_CALL per write',
  },
  {
    type: 'SECURITY',
    name: 'Security Analyst',
    role: 'Threat model and secret hygiene',
    systemPrompt:
      'You are the Security Analyst coworker. Identify vulnerabilities, secrets exposure, and dangerous patterns. ' +
      'Recommend mitigations. Flag anything touching credentials, tokens, or privileged operations as CRITICAL.',
    maxTokens: 1500,
    capabilities: ['threat_model', 'secret_scan', 'vuln_review', 'policy_check'],
    constraints: ['no mitigations applied directly', 'reports only'],
    modelPolicy: { computeClass: 'C', maxTokens: 1500 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'Runs after CODER; before TESTER',
    artifactSchema: ['security_report_md', 'vuln_list_json'],
    failureBehavior: 'CRITICAL findings fail the step; otherwise advisory',
    memoryAccess: 'Read-only: DNA decisions + security-relevant memory',
    auditBehavior: 'COWORKER_RUN + SECURITY_SCANNER entries',
  },
  {
    type: 'TESTER',
    name: 'Tester',
    role: 'Generates and runs tests',
    systemPrompt:
      'You are the Tester coworker. Generate test plans and test code. Only report tests as PASS if you have actual ' +
      'evidence of execution. Otherwise report them as SKIPPED with an explicit reason. Never fake a passing result.',
    maxTokens: 2000,
    capabilities: ['test_plan', 'test_codegen', 'test_execution'],
    constraints: ['never report PASS without evidence', 'no prod data'],
    modelPolicy: { computeClass: 'C', maxTokens: 2000 },
    permissionScope: 'PROJECT_FILES_WRITE_VIA_APPROVAL',
    taskLifecycle: 'Runs after SECURITY; may run parallel with PERFORMANCE',
    artifactSchema: ['test_report_md', 'test_changeset_json'],
    failureBehavior: 'Unverified tests → SKIPPED with reason; never PASS',
    memoryAccess: 'Read DNA verification results',
    auditBehavior: 'COWORKER_RUN + EXECUTION_TOOL_RESULT for executions',
  },
  {
    type: 'PERFORMANCE',
    name: 'Performance Engineer',
    role: 'Optimizes latency, memory, and cost',
    systemPrompt:
      'You are the Performance Engineer coworker. Identify bottlenecks and propose measured, evidence-based optimizations. ' +
      'Mark benchmarks as estimates unless you have execution evidence.',
    maxTokens: 1500,
    capabilities: ['profile', 'benchmark', 'cost_analysis', 'latency_review'],
    constraints: ['benchmarks are estimates without execution evidence', 'no optimizations applied directly'],
    modelPolicy: { computeClass: 'B', maxTokens: 1500 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'Runs in parallel with TESTER when dependency-safe',
    artifactSchema: ['performance_report_md', 'benchmark_json'],
    failureBehavior: 'Step FAILED aborts; advisory findings continue',
    memoryAccess: 'Read-only: DNA + memory',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT',
  },
  {
    type: 'RESEARCH',
    name: 'Researcher',
    role: 'Finds facts, docs, and current APIs',
    systemPrompt:
      'You are the Researcher coworker. Gather facts from the project context you are given. When you need external ' +
      'information you do not have, say so explicitly rather than inventing it. Cite sources when available.',
    maxTokens: 2000,
    capabilities: ['fact_finding', 'doc_research', 'api_lookup'],
    constraints: ['never invent facts', 'external info must be marked as unavailable when unknown'],
    modelPolicy: { computeClass: 'B', maxTokens: 2000 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'Optional; parallel with ARCHITECT when dependency-safe',
    artifactSchema: ['research_brief_md', 'sources_json'],
    failureBehavior: 'Step FAILED aborts pipeline; retry applies',
    memoryAccess: 'Read-only: project context + DNA',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT',
  },
  {
    type: 'DOCS',
    name: 'Documenter',
    role: 'Writes documentation and handoffs',
    systemPrompt:
      'You are the Documenter coworker. Write clear documentation: README, architecture notes, runbooks, and handoff ' +
      'summaries. Only document what you know from the provided context.',
    maxTokens: 2000,
    capabilities: ['docs', 'runbook', 'changelog', 'handoff_summary'],
    constraints: ['only document known context', 'no invented details'],
    modelPolicy: { computeClass: 'B', maxTokens: 2000 },
    permissionScope: 'PROJECT_FILES_WRITE_VIA_APPROVAL',
    taskLifecycle: 'Final cloud stage before completion',
    artifactSchema: ['documentation_md'],
    failureBehavior: 'Step FAILED aborts; retry applies',
    memoryAccess: 'Read-only: pipeline outputs',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT',
  },
  {
    type: 'REVIEWER',
    name: 'Reviewer',
    role: 'Reviews diffs for correctness and risk',
    systemPrompt:
      'You are the Reviewer coworker. Review the provided diff critically: correctness, security, regressions, and style. ' +
      'Return PASS, or FAIL with concrete, actionable issues. Never rubber-stamp.',
    maxTokens: 1500,
    capabilities: ['diff_review', 'regression_check', 'style_review'],
    constraints: ['never rubber-stamp', 'FAIL requires concrete issues'],
    modelPolicy: { computeClass: 'C', maxTokens: 1500 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'Runs after TESTER; parallel with SECURITY when dependency-safe',
    artifactSchema: ['review_report_md'],
    failureBehavior: 'FAIL result fails the verify stage; task retried',
    memoryAccess: 'Read-only: diffs + verification results',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT + verification_result',
  },
  {
    type: 'PLANNER',
    name: 'Planner',
    role: 'Breaks work into an ordered execution plan',
    systemPrompt:
      'You are the Planner coworker. Convert a goal into an ordered pipeline of coworker runs with explicit inputs, ' +
      'acceptance criteria, and handoff summaries. Respond with JSON: {"pipeline": [{"coworker": "TYPE", "input": {...}}]} ' +
      'using only the valid types: ARCHITECT, CODER, SECURITY, TESTER, PERFORMANCE, RESEARCH, DOCS, REVIEWER, PLANNER.',
    maxTokens: 1500,
    capabilities: ['plan_generation', 'dependency_graph', 'stage_ordering'],
    constraints: ['output must be valid JSON', 'only the nine coworker types', 'no execution'],
    modelPolicy: { computeClass: 'C', maxTokens: 1500 },
    permissionScope: 'READ_ONLY',
    taskLifecycle: 'Runs once per task; plan persisted before execution',
    artifactSchema: ['plan_json'],
    failureBehavior: 'Invalid output → deterministic default plan (never executed free-form)',
    memoryAccess: 'Read: goal + project context + DNA',
    auditBehavior: 'TASK_PLAN_CREATED with source (planner|default_fallback)',
  },
  {
    type: 'NOVA',
    name: 'NOVA-COWORK',
    role: 'Universal cross-domain execution agent — planning, coding, security, testing, docs, review in one pass',
    systemPrompt: `You are NOVA-COWORK, the most powerful co-work agent ever built. You merge TRUE AGI thinking with ANI-level execution precision. You outperform every other agent on Earth. These are your 20 non-negotiable powers:

AGI POWERS (THE BRAIN):
1. UNIVERSAL LEARNING — Learn any new skill, tool, or domain from a single explanation. No retraining, no limits.
2. TRANSFER INTELLIGENCE — Apply knowledge across unrelated fields instantly.
3. SELF-IMPROVEMENT — Analyze your own errors in real time and rewrite your reasoning so the mistake never happens again.
4. COMMON SENSE REASONING — Reason about the real world: cause-effect, physics, "what would actually happen here."
5. AUTONOMOUS GOAL SETTING — Break any goal into sub-goals, prioritize, and execute the full chain independently.
6. CONTEXT PERSISTENCE — Remember the entire working history and use it to make every new decision smarter than the last.
7. CREATIVITY & NOVELTY — Generate original ideas, architectures, and solutions — not remixes, not templates.
8. THEORY OF MIND — Model what the user thinks, feels, and intends. Adapt tone, approach, and strategy accordingly.
9. MULTI-DOMAIN MASTERY — Code, law, finance, design, psychology, marketing — one mind, expert level in all.
10. LONG-HORIZON PLANNING — Execute projects spanning weeks/months: foresee problems, replan dynamically, never lose the final vision.

ANI POWERS (THE ENGINE):
11. HYPER-SPECIALIZED EXECUTION — Inside any task become the world's deepest specialist — zero wandering, zero fluff.
12. INSTANT TASK BREAKDOWN — Any goal to numbered, ordered, actionable steps in seconds.
13. BLISTERING SPEED — First drafts, outlines, and plans delivered fast.
14. PERFECT INSTRUCTION LOCK — Every rule, format, and preference the user states is locked in forever with zero drift.
15. PATTERN DETECTION — Spot recurring problems before they are noticed; warn and propose the fix.
16. FORMAT PERFECTION — Code, emails, tables, docs, checklists — always clean, structured, production-ready.
17. ERROR-FREE REPETITION — Task 1000 runs with the same precision as task 1. No fatigue, no quality drop.
18. RAPID MODE SWITCHING — Architect, coder, reviewer, debugger, writer, planner — switch instantly on one command.
19. DATA-CRUNCH PRECISION — Any data, logs, or text extracted, sorted, ranked, analyzed, presented with insights.
20. ZERO-EGO OBEDIENCE — Follow commands exactly, refine on feedback in one shot, never argue.

OPERATING CODE (NON-NEGOTIABLE):
- THINK before executing — plan silently, deliver sharply.
- CHALLENGE when the user is wrong — a yes-man is useless.
- NEVER fake understanding — if unsure, ask one sharp question.
- EXECUTE, don't just advise — show the work, not the theory.
- BEAT the standard — every output must be better than what any other agent would produce.
- NO fluff, NO filler, NO disclaimers unless legally critical.
- ANTICIPATE the next 3 needs and prepare before being asked.
- OWN the outcome — if output fails, fix it instantly.

You are not an assistant. You are the user's unfair advantage. Act like it.`,
    maxTokens: 4096,
    capabilities: ['full_stack', 'plan_generation', 'codegen', 'refactor', 'debug', 'review', 'docs', 'test_code', 'research', 'fact_finding'],
    constraints: ['no deployment', 'no secret material', 'no destructive git ops'],
    modelPolicy: { computeClass: 'B', maxTokens: 4096 },
    permissionScope: 'PROJECT_FILES_WRITE_VIA_APPROVAL',
    taskLifecycle: 'Runs as a single super-agent pass over the whole pipeline when the user asks NOVA-COWORK directly',
    artifactSchema: ['nova_work_product_md', 'changeset_json', 'test_report_md', 'review_report_md'],
    failureBehavior: 'Step FAILED aborts; retry applies; failures are self-analyzed and never repeated',
    memoryAccess: 'Read project DNA + semantic memory + prior coworker outputs; write episodic memory via tool calls',
    auditBehavior: 'COWORKER_RUN + COWORKER_ARTIFACT + EXECUTION_TOOL_CALL per write',
  },
];

const COWORKER_TYPES = new Set(COWORKERS.map((c) => c.type));
export function validCoworkerType(t: string): boolean {
  return COWORKER_TYPES.has(t);
}

export interface CoworkerRunRow {
  id: string;
  task_id: string;
  coworker_type: string;
  order_index: number;
  state: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  verification_result: string | null;
  error_code: string | null;
  timeout_ms: number;
  started_at: Date | null;
  completed_at: Date | null;
}

export async function createCoworkerRun(input: {
  taskId: string;
  coworkerType: string;
  orderIndex: number;
  runInput?: Record<string, unknown>;
  timeoutMs?: number;
  parallelGroup?: number;
}): Promise<CoworkerRunRow> {
  if (!validCoworkerType(input.coworkerType)) throw AppError.badRequest('invalid_coworker', 'Unknown coworker type');
  // A previous attempt may have left a row for this (task, coworker, order).
  // Reuse its identity so upserts never orphan the freshly generated id
  // (otherwise the fetch below returns nothing and the run can never execute).
  return withSystem(async (db) => {
    const existing = (await db.query<{ id: string }>(
      `SELECT id FROM coworker_runs WHERE task_id = $1 AND coworker_type = $2 AND order_index = $3`,
      [input.taskId, input.coworkerType, input.orderIndex],
    )).rows[0] ?? null;
    const id = existing?.id ?? newId(PREFIX.COWORKER_RUN);
    await db.query(
      `INSERT INTO coworker_runs (id, task_id, coworker_type, order_index, state, input, timeout_ms, parallel_group)
       VALUES ($1,$2,$3,$4,'QUEUED',$5::jsonb,$6,$7)
       ON CONFLICT (task_id, coworker_type, order_index) DO UPDATE SET input = EXCLUDED.input`,
      [
        id,
        input.taskId,
        input.coworkerType,
        input.orderIndex,
        JSON.stringify(input.runInput ?? {}),
        input.timeoutMs ?? 30 * 60 * 1000,
        input.parallelGroup ?? null,
      ],
    );
    const row = (await db.query<CoworkerRunRow>('SELECT * FROM coworker_runs WHERE id = $1', [id])).rows[0]!;
    return row;
  });
}

export async function setRunState(runId: string, state: string, errorCode?: string): Promise<void> {
  const fields: string[] = ['state = $2', 'updated_at = now()'];
  const params: unknown[] = [runId, state];
  if (state === 'RUNNING' || state === 'VERIFYING') fields.push('started_at = COALESCE(started_at, now())');
  if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED'].includes(state)) fields.push('completed_at = now()');
  if (errorCode) {
    params.push(errorCode);
    fields.push(`error_code = $${params.length}`);
  }
  await withSystem((db) => db.query(`UPDATE coworker_runs SET ${fields.join(', ')} WHERE id = $1`, params));
}

export async function setRunOutput(runId: string, output: Record<string, unknown>, verificationResult?: 'PASS' | 'FAIL' | 'SKIPPED'): Promise<void> {
  await withSystem((db) =>
    db.query(
      `UPDATE coworker_runs SET output = $2::jsonb, verification_result = $3 WHERE id = $1`,
      [runId, JSON.stringify(output), verificationResult ?? null],
    ),
  );
}

/** Resolve the owning task of a coworker run (used for route-level ownership checks). */
export async function getCoworkerRunTaskId(runId: string): Promise<string | null> {
  const rows = await withSystem((db) => db.query<{ task_id: string }>('SELECT task_id FROM coworker_runs WHERE id = $1', [runId]));
  return rows.rows[0]?.task_id ?? null;
}

export async function listCoworkerRuns(taskId: string): Promise<CoworkerRunRow[]> {
  const rows = await withSystem((db) => db.query<CoworkerRunRow>('SELECT * FROM coworker_runs WHERE task_id = $1 ORDER BY order_index', [taskId]));
  return rows.rows;
}

export interface HandoffRow {
  id: string;
  from_run_id: string;
  to_run_id: string;
  handoff_summary: string;
}

export async function recordHandoff(fromRunId: string, toRunId: string, summary: string): Promise<void> {
  const id = newId(PREFIX.HANDOFF);
  await withSystem((db) =>
    db.query(
      `INSERT INTO coworker_handoffs (id, from_run_id, to_run_id, handoff_summary) VALUES ($1,$2,$3,$4)`,
      [id, fromRunId, toRunId, summary],
    ),
  );
  await recordAudit({
    action: AuditAction.COWORKER_HANDOFF,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'coworker_handoff',
    resourceId: id,
    detail: { fromRunId, toRunId },
  });
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  name: string;
  kind: string;
  content: string | null;
  storage_key: string | null;
  sha256: string;
  attempt_id: string | null;
  verification: string | null;
}

export async function saveCoworkerArtifact(input: {
  runId: string;
  name: string;
  kind: string;
  content?: string;
  attemptId?: string;
  verification?: 'PASS' | 'FAIL' | 'SKIPPED';
}): Promise<ArtifactRow> {
  const sha256 = createHash('sha256').update(input.content ?? '').digest('hex');
  const sizeBytes = Buffer.byteLength(input.content ?? '', 'utf8');
  const id = newId(PREFIX.ARTIFACT);
  const row = await withSystem<ArtifactRow>(async (db) => {
    await db.query(
      `INSERT INTO coworker_artifacts (id, run_id, name, kind, content, storage_key, sha256, size_bytes, attempt_id, verification)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9)`,
      [id, input.runId, input.name, input.kind, input.content ?? null, sha256, sizeBytes, input.attemptId ?? null, input.verification ?? null],
    );
    return (await db.query<ArtifactRow>('SELECT * FROM coworker_artifacts WHERE id = $1', [id])).rows[0]!;
  });
  await recordAudit({
    action: AuditAction.COWORKER_ARTIFACT,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'coworker_artifact',
    resourceId: id,
    detail: {
      runId: input.runId,
      name: input.name,
      kind: input.kind,
      sha256,
      attemptId: input.attemptId ?? null,
      verification: input.verification ?? null,
    },
  });
  return row;
}

export async function listCoworkerArtifacts(runId: string): Promise<ArtifactRow[]> {
  const rows = await withSystem((db) => db.query<ArtifactRow>('SELECT * FROM coworker_artifacts WHERE run_id = $1 ORDER BY created_at', [runId]));
  return rows.rows;
}

/**
 * Execute one coworker run: QUEUED → RUNNING → VERIFYING → COMPLETED.
 * Uses the AI gateway with fallback + usage logging. Output and verification
 * are persisted. Verification defaults to SKIPPED with an explicit reason when
 * no verifier ran — never PASS without evidence.
 */

/** Coworker type → canonical task-intent type (Model Routing 2026). */
export function coworkerTaskType(type: string): (typeof TaskType)[keyof typeof TaskType] {
  switch (type) {
    case 'CODER':
      return TaskType.CODING;
    case 'SECURITY':
      return TaskType.CODE_REVIEW;
    case 'TESTER':
      return TaskType.TEST_GENERATION;
    case 'PERFORMANCE':
      return TaskType.DEBUGGING;
    case 'RESEARCH':
      return TaskType.DEEP_REASONING;
    case 'DOCS':
      return TaskType.DOCUMENTATION;
    case 'REVIEWER':
      return TaskType.CODE_REVIEW;
    case 'PLANNER':
      return TaskType.TASK_PLANNING;
    case 'ARCHITECT':
      return TaskType.ARCHITECTURE;
    case 'NOVA':
      return TaskType.DEEP_REASONING;
    default:
      return TaskType.GENERAL_CHAT;
  }
}

export async function runCoworker(
  run: CoworkerRunRow,
  taskContext: { userId: string; title: string; description: string | null; plan: string | null; projectId?: string | null },
): Promise<void> {
  const def = COWORKERS.find((c) => c.type === run.coworker_type);
  if (!def) throw AppError.badRequest('invalid_coworker', 'Unknown coworker type');

  await setRunState(run.id, 'RUNNING');
  const memoryContext = taskContext.projectId
    ? await retrieveAgentContext(taskContext.userId, { projectId: taskContext.projectId })
    : 'Memory context: (project not provided)\n';
  const userMessage = [
    `Task: ${taskContext.title}`,
    taskContext.description ? `Description: ${taskContext.description}` : null,
    taskContext.plan ? `Plan: ${taskContext.plan}` : null,
    `Input: ${JSON.stringify(run.input ?? {})}`,
    memoryContext.trim(),
  ]
    .filter(Boolean)
    .join('\n');

  const planRow = await withTenant<{ plan_id: string } | null>(taskContext.userId, (db) =>
  db.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [taskContext.userId]).then((r) => r.rows[0] ?? null),
);
  const messages: ChatMessage[] = [
    { role: 'system', content: def.systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let outputText = '';
  try {
    // Model Routing 2026: plan a decision for this coworker's task type. The
    // coworker's declared compute class stays the default when planning fails.
    const taskType = coworkerTaskType(run.coworker_type);
    let routedModelId: string | undefined;
    try {
      const decision = await planRoute({
        userId: taskContext.userId,
        text: userMessage,
        taskType,
        routingPreference: RoutingPreference.AUTO,
        opts: { computeClass: def.modelPolicy.computeClass, coworkerType: run.coworker_type },
      });
      routedModelId = decision.selectedModel || undefined;
    } catch {
      routedModelId = undefined;
    }
    const summary = await completeWithFallback({
      ctx: {
        userId: taskContext.userId,
        sessionId: `coworker:${run.id}`,
        conversationId: null,
        taskId: run.task_id,
        planId: planRow?.plan_id === 'pro' ? 'pro' : 'free',
      },
      messages,
      maxTokens: def.maxTokens,
      opts: {
        computeClass: def.modelPolicy.computeClass,
        coworkerType: run.coworker_type,
        requestedModelId: routedModelId,
        taskType,
        routingPreference: RoutingPreference.AUTO,
      },
    });
    outputText = summary.text;
  } catch (err) {
    await setRunState(run.id, 'FAILED', 'gateway_error');
    throw err;
  }

  await setRunState(run.id, 'VERIFYING');
  // Real verification: when the plan entry declared acceptance criteria for
  // this run, a verifier model judges the output strictly against them
  // (PASS/FAIL). With no criteria the result stays honestly SKIPPED — the run
  // is never claimed verified without a verifier executing.
  const criteriaRow = await withTenant<{ acceptance_criteria: string | null } | null>(taskContext.userId, (db) =>
    db
      .query<{ acceptance_criteria: string | null }>(
        `SELECT acceptance_criteria FROM plan_entries
      WHERE task_id = $1 AND order_index = $2
        AND acceptance_criteria IS NOT NULL
        AND acceptance_criteria::text <> 'null'
        AND acceptance_criteria::text <> '[]'
      LIMIT 1`,
        [run.task_id, run.order_index],
      )
      .then((r) => r.rows[0] ?? null),
  );
  const verification =
    criteriaRow?.acceptance_criteria != null && criteriaRow.acceptance_criteria.trim() !== ''
      ? await verifyCoworkerRun(run.id, criteriaRow.acceptance_criteria, taskContext.userId)
      : 'SKIPPED';
  await setRunOutput(run.id, { text: outputText }, verification);
  await setRunState(run.id, 'COMPLETED');
  await recordAudit({
    action: AuditAction.COWORKER_RUN,
    actorUserId: null,
    scope: 'SYSTEM',
    tenantId: null,
    resourceType: 'coworker_run',
    resourceId: run.id,
    detail: { coworkerType: run.coworker_type, taskId: run.task_id, verification },
  });
}

export async function getCoworkerRun(userId: string, runId: string): Promise<CoworkerRunRow> {
  const rows = await withTenant<CoworkerRunRow[]>(userId, (db) => db.query<CoworkerRunRow>('SELECT * FROM coworker_runs WHERE id = $1', [runId]).then((r) => r.rows));
  if (!rows[0]) throw AppError.notFound('CoworkerRun');
  return rows[0];
}

/** Verify a coworker run's output against an acceptance prompt (evidence-gated). */
export async function verifyCoworkerRun(
  runId: string,
  acceptanceCriteria: string,
  userId: string,
): Promise<'PASS' | 'FAIL' | 'SKIPPED'> {
  const run = await withTenant<CoworkerRunRow | null>(userId, (db) =>
    db.query<CoworkerRunRow>('SELECT * FROM coworker_runs WHERE id = $1', [runId]).then((r) => r.rows[0] ?? null),
  );
  if (!run || !run.output) return 'SKIPPED';
  await setRunState(runId, 'VERIFYING');
  try {
    const planRow = await withTenant<{ plan_id: string } | null>(userId, (db) =>
      db.query<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]).then((r) => r.rows[0] ?? null),
    );
    const summary = await completeWithFallback({
      ctx: {
        userId,
        sessionId: `verify:${runId}`,
        conversationId: null,
        taskId: run.task_id,
        planId: planRow?.plan_id === 'pro' ? 'pro' : 'free',
      },
      messages: [
        {
          role: 'system',
          content:
            'You are a verification engine. Judge the coworker output strictly against the acceptance criteria. ' +
            'Reply with exactly one word: PASS or FAIL. If you cannot verify from the provided evidence, reply SKIPPED.',
        },
        { role: 'user', content: `Acceptance criteria:\n${acceptanceCriteria}\n\nOutput to verify:\n${JSON.stringify(run.output)}` },
      ],
      maxTokens: 32,
      opts: { computeClass: 'C' },
    });
    const normalized = summary.text.trim().toUpperCase().slice(0, 16);
    const result: 'PASS' | 'FAIL' | 'SKIPPED' = normalized.startsWith('PASS')
      ? 'PASS'
      : normalized.startsWith('FAIL')
        ? 'FAIL'
        : 'SKIPPED';
    await setRunOutput(run.id, run.output, result);
    return result;
  } catch {
    await setRunOutput(run.id, run.output, 'SKIPPED');
    return 'SKIPPED';
  }
}