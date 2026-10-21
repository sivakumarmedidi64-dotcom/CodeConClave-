/**
 * CodeConClave · execution pipeline v3 — objective in → verified outcome out.
 *
 *   Intake → [Cache hit?] → Route·scout → Dispatch·maker (1 role · 1 run)
 *   → Gate·sentinel (0 tokens) → Specialist → Scientific Verification Kernel
 *   → Verify·judge (repair ≤ 2, then Escalate) → Act → Commit·seal
 *
 * Every stage is a hash-linked ledger event. The ledger is written BEFORE any
 * specialist runs; if it can't be written the run fails closed (offline rule).
 * An abort (Stop / kill switch) halts the run and persists where it stopped.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../config/env.js';
import { completeWithFallback, type CompletionSummary, type GatewayContext, type RouteOptions } from '../../modules/ai/gateway.js';
import type { ChatMessage } from '../../modules/ai/providers.js';
import { residentComplete, residentReady } from '../../modules/resident/infer.js';
import { resolveLimitPlan } from '../../modules/usage/limits.js';
import { recordAudit } from '../../modules/audit/service.js';
import { canonicalJson } from '../../modules/audit/chain.js';
import { extractClaims, runKernel, KERNEL_VERSION, type KernelResult } from '../kernel/index.js';
import { contractFor, contractVersion, driverSlot, roleSystemPrompt } from './contracts.js';
import { heuristicRoute, parseScoutModelOutput, scoutPrompt, type ScoutDecision } from './scout.js';
import { runGate } from './gate.js';
import { canAfford, lockBudget, SCOUT_TOKENS, type BudgetTier, type Effort } from './governor.js';
import { judge, repairNote } from './judge.js';
import { knownAnswer } from './known.js';
import { appendEvent, cacheGet, cachePut, createRun, dnaVersion, sealRun, sha256, updateRun, type ChainCursor, type RunStatus } from './ledger.js';

export const MAX_ATTEMPTS = 3; // first try + 2 repairs; the 3rd failure escalates

export type StageName = 'intake' | 'known' | 'cache' | 'route' | 'dispatch' | 'gate' | 'specialist' | 'verify' | 'repair' | 'act' | 'seal' | 'escalate' | 'denied' | 'budget' | 'halted';

export interface StageEvent {
  stage: StageName;
  status: 'done' | 'fail' | 'skip' | 'start';
  label: string;
  detail?: Record<string, unknown>;
  /** The client should clear the streamed answer (a repair attempt restarts it). */
  reset?: boolean;
}

export interface PublicProof {
  kind: string;
  verifier: string;
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  method: string;
  detail: string;
  proofHash: string;
}

export interface PipelineReceipt {
  runId: string;
  status: RunStatus;
  role: string | null;
  lane: string | null;
  risk: string | null;
  contractVersion: string | null;
  engine: string | null;
  cached: boolean;
  attempts: number;
  tokens: { used: number; budget: number };
  proofs: PublicProof[];
  verdict: { passed: number; failed: number; errors: number };
  textHash: string | null;
  proofHash: string | null;
  kernelVersion: string;
  gate: { check: string; ok: boolean; note?: string }[];
  notes: string[];
}

export interface PipelineInput {
  userId: string;
  planId: string | null | undefined;
  sessionId: string;
  projectId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  incognito?: boolean;
  question: string;
  /** The resolved attachment block (hashed into the cache key as the file hash). */
  attachmentsText?: string;
  /** Hash of earlier turns, so a follow-up never hits another context's cache. */
  historyHash?: string;
  effort?: Effort;
  routeOptions?: RouteOptions;
  signal?: AbortSignal;
  onStage?: (ev: StageEvent) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  /** Builds the specialist's full message list (memory, history, skills…). */
  buildMessages: (args: { roleSystem: string; question: string; repair?: string }) => Promise<ChatMessage[]>;
}

export interface PipelineOutcome {
  runId: string;
  status: RunStatus;
  finalText: string;
  receipt: PipelineReceipt;
  /** Aggregated usage for persistence (real ids stay server-side). */
  summary: CompletionSummary | null;
}

export function pipelineEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(String(env.PIPELINE_V3 ?? 'on'));
}

/** Product-facing engine name ("only our AI"). */
export function engineLabel(providerId: string | null | undefined, modelId: string | null | undefined): string {
  if (providerId === 'cache') return 'CodeConClave AI · cache';
  if (providerId === 'resident') return `CodeConClave AI · ${String(modelId ?? '').split('/').pop()?.replace(/^codeconclave-/, '') || 'own model'}`;
  return 'CodeConClave AI · cloud engine';
}

/** Hides ```claims blocks from the live stream (they're shown as verdicts). */
export class ClaimsStreamFilter {
  private buf = '';
  private inClaims = false;
  private static readonly OPEN = '```claims';
  private static readonly CLOSE = '```';

  push(delta: string): string {
    this.buf += delta;
    let out = '';
    for (;;) {
      if (!this.inClaims) {
        const at = this.buf.indexOf(ClaimsStreamFilter.OPEN);
        if (at >= 0) {
          out += this.buf.slice(0, at);
          this.buf = this.buf.slice(at + ClaimsStreamFilter.OPEN.length);
          this.inClaims = true;
          continue;
        }
        // Keep a tail that could be the start of the marker.
        let keep = 0;
        for (let k = Math.min(ClaimsStreamFilter.OPEN.length - 1, this.buf.length); k > 0; k -= 1) {
          if (ClaimsStreamFilter.OPEN.startsWith(this.buf.slice(-k))) {
            keep = k;
            break;
          }
        }
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const end = this.buf.indexOf(ClaimsStreamFilter.CLOSE);
      if (end < 0) {
        this.buf = this.buf.slice(-2);
        return out;
      }
      this.buf = this.buf.slice(end + ClaimsStreamFilter.CLOSE.length);
      this.inClaims = false;
    }
  }

  flush(): string {
    const rest = this.inClaims ? '' : this.buf;
    this.buf = '';
    return rest;
  }
}

function normalizeQuestion(q: string): string {
  return q.normalize('NFC').replace(/\s+/g, ' ').trim();
}

async function streamText(text: string, onDelta?: (d: string) => void | Promise<void>): Promise<void> {
  if (!onDelta) return;
  for (let i = 0; i < text.length; i += 400) await onDelta(text.slice(i, i + 400));
}

const publicProofs = (k: KernelResult | null): PublicProof[] =>
  (k?.proofs ?? []).map((p) => ({ kind: p.kind, verifier: p.verifier, verdict: p.verdict, method: p.method, detail: p.detail, proofHash: p.proofHash }));

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const stage = async (ev: StageEvent) => {
    try {
      await input.onStage?.(ev);
    } catch {
      /* a disconnected client never breaks the run */
    }
  };
  const effort: Effort = input.effort ?? 'medium';

  // No free tier: no plan → no run (the gateway enforces the same rule).
  const tierRaw = await resolveLimitPlan(input.userId, input.planId);
  if (tierRaw === 'none') {
    throw AppError.paymentRequired('plan_required', 'CodeConClave has no free tier. Choose Solo, Team or API Access to use CodeConClave AI.');
  }
  const tier = tierRaw as BudgetTier;

  // ---------------------------------------------------------------- Intake
  const question = normalizeQuestion(input.question);
  const questionHash = sha256(question);
  const fileHash = input.attachmentsText ? sha256(input.attachmentsText) : 'none';
  const budget = lockBudget(tier, effort);
  let dnaV = 'none';
  let cur: ChainCursor;
  try {
    dnaV = await dnaVersion(input.userId, input.projectId);
    const cacheKey = sha256([input.userId, questionHash, fileHash, dnaV, tier, effort, input.historyHash ?? 'none'].join('|'));
    cur = await createRun({
      ownerId: input.userId,
      projectId: input.projectId ?? null,
      conversationId: input.incognito ? null : (input.conversationId ?? null),
      taskId: input.taskId ?? null,
      questionHash,
      fileHash,
      dnaVersion: dnaV,
      cacheKey,
      budgetTier: tier,
      budgetTokens: budget.cap,
    });
    await appendEvent(cur, 'intake', { questionHash, fileHash, dnaVersion: dnaV, budget, incognito: Boolean(input.incognito) });
    (cur as ChainCursor & { cacheKey?: string }).cacheKey = cacheKey;
  } catch (err) {
    // Offline rule: no ledger → no unverified answer.
    logger.warn('pipeline ledger unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw AppError.unavailable('ledger_offline', "CodeConClave's ledger is offline, so it won't answer without a record. Try again in a moment.");
  }
  const cacheKey = (cur as ChainCursor & { cacheKey?: string }).cacheKey!;
  await stage({ stage: 'intake', status: 'done', label: 'Intake · budget locked', detail: { budget: budget.cap, tier, dnaVersion: dnaV, fileHash: fileHash.slice(0, 12) } });

  const receipt: PipelineReceipt = {
    runId: cur.runId,
    status: 'RUNNING',
    role: null,
    lane: null,
    risk: null,
    contractVersion: null,
    engine: null,
    cached: false,
    attempts: 0,
    tokens: { used: 0, budget: budget.cap },
    proofs: [],
    verdict: { passed: 0, failed: 0, errors: 0 },
    textHash: null,
    proofHash: null,
    kernelVersion: KERNEL_VERSION,
    gate: [],
    notes: [],
  };

  const seal = async (status: RunStatus, finalText: string, kernel: KernelResult | null): Promise<PipelineOutcome['receipt']> => {
    receipt.status = status;
    receipt.textHash = finalText ? sha256(finalText) : null;
    if (kernel) {
      receipt.proofs = publicProofs(kernel);
      receipt.verdict = { passed: kernel.passed, failed: kernel.failed, errors: kernel.errors };
    }
    receipt.proofHash = sha256(
      canonicalJson({ textHash: receipt.textHash, rollup: kernel?.rollupHash ?? null, role: receipt.role, contract: receipt.contractVersion, status }),
    );
    await appendEvent(cur, 'seal', { status, textHash: receipt.textHash, proofHash: receipt.proofHash, tokens: receipt.tokens.used });
    await sealRun(cur, status, receipt.proofHash, receipt as unknown as Record<string, unknown>, receipt.tokens.used);
    void recordAudit({
      action: 'pipeline.sealed',
      actorUserId: input.userId,
      scope: 'USER',
      tenantId: input.userId,
      resourceType: 'pipeline_run',
      resourceId: cur.runId,
      detail: { status, role: receipt.role, proofHash: receipt.proofHash, attempts: receipt.attempts },
    }).catch(() => undefined);
    await stage({ stage: 'seal', status: 'done', label: `Sealed · ${status.toLowerCase()}`, detail: { proofHash: receipt.proofHash } });
    return receipt;
  };

  // ---------------------------------------------------------------- Known answers (0 tokens)
  const known = knownAnswer(question);
  if (known) {
    await appendEvent(cur, 'known', { topic: known.topic });
    await stage({ stage: 'known', status: 'done', label: "Answered from CodeConClave's records · 0 tokens", detail: { topic: known.topic } });
    receipt.engine = "CodeConClave AI · records";
    receipt.notes.push("This answer comes from CodeConClave's own records, not a model.");
    await streamText(known.text, input.onDelta);
    await seal('KNOWN', known.text, null);
    return { runId: cur.runId, status: 'KNOWN', finalText: known.text, receipt, summary: null };
  }

  // ---------------------------------------------------------------- Cache
  if (!input.incognito) {
    const hit = await cacheGet(input.userId, cacheKey).catch(() => null);
    if (hit) {
      await appendEvent(cur, 'cache', { hit: true, fromRun: hit.runId });
      await stage({ stage: 'cache', status: 'done', label: 'Cache hit · 0 tokens', detail: { fromRun: hit.runId } });
      const prior = hit.receipt as Partial<PipelineReceipt>;
      receipt.role = prior.role ?? null;
      receipt.lane = prior.lane ?? null;
      receipt.contractVersion = prior.contractVersion ?? null;
      receipt.engine = 'CodeConClave AI · cache';
      receipt.cached = true;
      receipt.notes.push(`Stored answer from run ${hit.runId ?? 'earlier'} (same question, files, project DNA and budget tier).`);
      receipt.proofs = prior.proofs ?? [];
      receipt.verdict = prior.verdict ?? receipt.verdict;
      await streamText(hit.finalText, input.onDelta);
      await seal('CACHED', hit.finalText, null);
      return { runId: cur.runId, status: 'CACHED', finalText: hit.finalText, receipt, summary: null };
    }
    await appendEvent(cur, 'cache', { hit: false });
  }

  let spent = 0;
  try {
    // -------------------------------------------------------------- Route · scout
    let route: ScoutDecision = heuristicRoute(question);
    if (residentReady('Route-scout').ok) {
      try {
        const ans = await residentComplete('Route-scout', scoutPrompt(question), SCOUT_TOKENS);
        spent += ans.tokens;
        const parsed = parseScoutModelOutput(ans.text);
        if (parsed) route = { ...parsed, by: 'scout-model' };
      } catch {
        /* scout unreachable → the heuristic decision stands (recorded below) */
      }
    }
    await appendEvent(cur, 'route', { ...route });
    await stage({ stage: 'route', status: 'done', label: `Route · ${route.shortlist.join(', ')}`, detail: { ...route } });

    // -------------------------------------------------------------- Dispatch · maker
    const role = route.shortlist[0]!;
    const contract = contractFor(role)!;
    const version = contractVersion(contract);
    receipt.role = role;
    receipt.lane = contract.lane;
    receipt.risk = route.risk;
    receipt.contractVersion = version;
    await updateRun(cur, { lane: contract.lane, risk: route.risk, role, driver: driverSlot(role), contractVersion: version });
    await appendEvent(cur, 'dispatch', { role, driver: driverSlot(role), contractVersion: version, tools: contract.tools, claimKinds: contract.claimKinds });
    await stage({ stage: 'dispatch', status: 'done', label: `Dispatch · ${role}`, detail: { role, contractVersion: version, science: contract.science } });

    // -------------------------------------------------------------- Gate · sentinel
    const gate = runGate({ userId: input.userId, projectId: input.projectId, role, question: input.question });
    receipt.gate = gate.checks;
    await appendEvent(cur, 'gate', { allowed: gate.allowed, checks: gate.checks, redactions: gate.redactions, riskyCommand: gate.riskyCommand });
    if (!gate.allowed) {
      await appendEvent(cur, 'denied', { check: gate.denial!.check, reason: gate.denial!.reason });
      await stage({ stage: 'gate', status: 'fail', label: `Gate · denied (${gate.denial!.check})`, detail: { reason: gate.denial!.reason } });
      const text = gate.denial!.reason;
      receipt.notes.push('Denied requests are recorded and never retried.');
      await streamText(text, input.onDelta);
      await seal('DENIED', text, null);
      return { runId: cur.runId, status: 'DENIED', finalText: text, receipt, summary: null };
    }
    if (gate.redactions) receipt.notes.push(`${gate.redactions} secret(s) were redacted before the model saw your message.`);
    if (gate.riskyCommand) receipt.notes.push('A destructive command was mentioned — nothing runs without your approval.');
    await stage({ stage: 'gate', status: 'done', label: 'Gate · passed (0 tokens)', detail: { checks: gate.checks.length, redactions: gate.redactions } });

    // -------------------------------------------------------------- Specialist → Kernel → Judge (repair ≤ 2)
    let note: string | undefined;
    let finalText = '';
    let kernel: KernelResult | null = null;
    let status: RunStatus = 'UNVERIFIED';
    let lastSummary: CompletionSummary | null = null;
    let inTokens = 0;
    let outTokens = 0;
    let cost = 0;
    const ctx: GatewayContext = { userId: input.userId, sessionId: input.sessionId, conversationId: input.incognito ? null : (input.conversationId ?? null), taskId: input.taskId ?? null, planId: (input.planId ?? 'free') as GatewayContext['planId'] };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const messages = await input.buildMessages({ roleSystem: roleSystemPrompt(contract), question: gate.question, repair: note });
      const promptChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 2000), 0);
      const afford = canAfford(budget, spent, promptChars);
      if (!afford.ok) {
        await appendEvent(cur, 'budget', { attempt, need: afford.need, left: afford.left, cap: budget.cap });
        await stage({ stage: 'budget', status: 'fail', label: 'Budget · would exceed the per-run cap', detail: { need: afford.need, left: afford.left } });
        const text = finalText
          ? `${finalText}\n\n— Stopped before repair attempt ${attempt}: it needs about ${afford.need.toLocaleString()} tokens and ${afford.left.toLocaleString()} are left in this run's budget. Ask to continue with a higher effort or plan.`
          : `This request needs about ${afford.need.toLocaleString()} tokens, more than this run's budget (${budget.cap.toLocaleString()}). Try a lower effort, a shorter request, or a bigger plan.`;
        receipt.attempts = attempt - 1;
        receipt.tokens.used = spent;
        await seal('NEEDS_BUDGET', text, kernel);
        return { runId: cur.runId, status: 'NEEDS_BUDGET', finalText: text, receipt, summary: lastSummary };
      }

      if (attempt > 1) await stage({ stage: 'repair', status: 'start', label: `Repair · attempt ${attempt - 1} of 2`, detail: { reasons: note?.split('\n').slice(1) }, reset: true });
      await stage({ stage: 'specialist', status: 'start', label: `${role} · working` });
      const filter = new ClaimsStreamFilter();
      const summary = await completeWithFallback({
        ctx,
        messages,
        opts: { ...(input.routeOptions ?? {}), residentRole: role },
        maxTokens: budget.perAttempt,
        signal: input.signal,
        onChunk: async (chunk) => {
          const visible = filter.push(chunk.delta);
          if (visible) await input.onDelta?.(visible);
        },
      });
      const tail = filter.flush();
      if (tail) await input.onDelta?.(tail);
      lastSummary = summary;
      inTokens += summary.inputTokens;
      outTokens += summary.outputTokens;
      cost += summary.estimatedCostUsd;
      spent += summary.inputTokens + summary.outputTokens;
      receipt.attempts = attempt;
      receipt.engine = engineLabel(summary.providerId, summary.modelId);
      await updateRun(cur, { attempts: attempt, tokensUsed: spent });

      const { claims, errors, text } = extractClaims(summary.text);
      finalText = text;
      kernel = runKernel(claims, `${cur.runId}:${attempt}`);
      const verdict = judge(contract, claims, errors, kernel);
      await appendEvent(cur, 'verify', {
        attempt,
        claims: claims.length,
        passed: kernel.passed,
        failed: kernel.failed,
        errors: kernel.errors,
        rollupHash: kernel.rollupHash,
        verdict: verdict.verdict,
        reasons: verdict.reasons.slice(0, 8),
      });
      await stage({
        stage: 'verify',
        status: verdict.verdict === 'REPAIR' ? 'fail' : 'done',
        label: verdict.verdict === 'VERIFIED' ? `Verify · ${kernel.passed}/${claims.length} proofs pass` : verdict.verdict === 'UNVERIFIED' ? 'Verify · no checkable claims' : `Verify · ${verdict.reasons.length} problem(s)`,
        detail: { attempt, proofs: publicProofs(kernel), reasons: verdict.reasons.slice(0, 8) },
      });

      if (verdict.verdict !== 'REPAIR') {
        status = verdict.verdict;
        break;
      }
      if (attempt === MAX_ATTEMPTS) {
        status = 'ESCALATED';
        await appendEvent(cur, 'escalate', { reasons: verdict.reasons.slice(0, 8) });
        await stage({ stage: 'escalate', status: 'fail', label: 'Escalate · a human decides', detail: { reasons: verdict.reasons.slice(0, 8) } });
        finalText = `⚠ Not verified — this answer failed verification ${MAX_ATTEMPTS} times, so it's escalated to you to decide.\n\nWhat the verifier found:\n${verdict.reasons
          .slice(0, 6)
          .map((r) => `- ${r}`)
          .join('\n')}\n\n---\n\n${finalText}`;
        receipt.notes.push('Escalated after the 3rd failed verification: review the findings before relying on this answer.');
        break;
      }
      note = repairNote(attempt, verdict.reasons);
    }

    // -------------------------------------------------------------- Act (answer-only in chat)
    await appendEvent(cur, 'act', { action: 'none', note: 'answer only — no writes, sends, publishes, deploys or paid calls requested' });
    await stage({ stage: 'act', status: 'skip', label: 'Act · nothing to execute (0 tokens)' });

    // -------------------------------------------------------------- Commit · seal
    receipt.tokens.used = spent;
    await seal(status, finalText, kernel);
    if ((status === 'VERIFIED' || status === 'UNVERIFIED') && !input.incognito) {
      await cachePut(input.userId, cacheKey, cur.runId, finalText, receipt as unknown as Record<string, unknown>, env.PIPELINE_CACHE_TTL_HOURS).catch(() => undefined);
    }
    if (status === 'ESCALATED') {
      void recordAudit({ action: 'pipeline.escalated', actorUserId: input.userId, scope: 'USER', tenantId: input.userId, resourceType: 'pipeline_run', resourceId: cur.runId, detail: { role } }).catch(() => undefined);
    }
    const summary: CompletionSummary | null = lastSummary ? { ...lastSummary, text: finalText, inputTokens: inTokens, outputTokens: outTokens, estimatedCostUsd: cost } : null;
    return { runId: cur.runId, status, finalText, receipt, summary };
  } catch (err) {
    // Stop / kill switch / engine failure: persist where the run stopped.
    const aborted = input.signal?.aborted === true;
    try {
      await appendEvent(cur, aborted ? 'halted' : 'specialist', { error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' });
      receipt.tokens.used = spent;
      await sealRun(cur, aborted ? 'HALTED' : 'FAILED', null, receipt as unknown as Record<string, unknown>, spent);
    } catch {
      /* the original error matters more */
    }
    await stage({ stage: aborted ? 'halted' : 'specialist', status: 'fail', label: aborted ? 'Halted · state saved' : 'Specialist failed' });
    throw err;
  }
}
