/**
 * CodeConClave — PKG-24 AI Developer Copilot — HTTP routes.
 * Mounted at /api/v1/copilot. Feature-gated: every operation except GET
 * /capabilities requires the flag ON; when OFF they report feature_disabled and
 * never mutate. Auth is required on all routes.
 */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { jsonResult } from '../auth/schemas.js';
import { AppError } from '../../shared/errors.js';
import { COPILOT_CONFIG } from './config.js';
import { requireProjectAccess } from './security.js';
import { copilotCapabilities } from './service.js';
import { providerState } from './provider.js';
import { buildCopilotContext } from './context.js';
import { explainCode } from './explain.js';
import { suggestContextAware } from './suggest.js';
import { askCopilot, type AskDeps } from './ask.js';
import { generateTestProposals } from './testgen.js';
import { diagnoseFailure, type DiagnosisDeps } from './diagnose.js';
import { proposeChangeViaB1 } from './proposal.js';
import { copilotFeedback } from './feedback.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { Request } from 'express';

const router = Router();
router.use(requireAuth);

function requireEnabled(): void {
  if (!COPILOT_CONFIG.enabled()) {
    throw AppError.unavailable('feature_disabled', 'Copilot is feature-gated OFF (AIOS_P2_COPILOT).');
  }
}

function projectIdOf(req: Request): string {
  const pid = (req.query.projectId as string) || (req.body?.projectId as string);
  if (!pid) throw AppError.badRequest('project_required', 'projectId is required');
  return pid;
}

interface Body {
  projectId: string;
  file?: string | null;
  symbol?: string | null;
  error?: string | null;
  taskId?: string | null;
  selection?: { line?: number; col?: number; text?: string } | null;
}

function bodyOf(req: Request): Body {
  return {
    projectId: projectIdOf(req),
    file: req.body?.file ?? null,
    symbol: req.body?.symbol ?? null,
    error: req.body?.error ?? null,
    taskId: req.body?.taskId ?? null,
    selection: req.body?.selection ?? null,
  };
}

async function assert(userId: string, b: Body): Promise<void> {
  await requireProjectAccess(userId, b.projectId);
}

// ------------------------------------------------------------ capabilities (always available)
router.get(
  '/capabilities',
  asyncRoute(async (req, res) => {
    const caps = await copilotCapabilities(req.ctx.user!.id);
    res.json(jsonResult(caps));
  }),
);

router.get(
  '/provider',
  asyncRoute(async (req, res) => {
    const state = await providerState(req.ctx.user!.id);
    res.json(jsonResult(state));
  }),
);

// ------------------------------------------------------------ memory-aware suggestion
router.post(
  '/suggest',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const sessionId = (req.ctx as { sessionId?: string }).sessionId ?? 'copilot';
    const planId = 'free' as const;
    const result = await suggestContextAware(
      { userId: uid, sessionId, planId, coworkerType: 'COPILOT' },
      b,
    );
    res.json(jsonResult(result));
  }),
);

// ------------------------------------------------------------ explanation
router.post(
  '/explain',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const sessionId = (req.ctx as { sessionId?: string }).sessionId ?? 'copilot';
    const planId = 'free' as const;
    const result = await explainCode({ userId: uid, sessionId, planId, coworkerType: 'COPILOT' }, b);
    res.json(jsonResult(result));
  }),
);

// ------------------------------------------------------------ ask-project
const askDeps = (): AskDeps => {
  return {
    async listFiles(projectId) {
      const { listFilePaths } = await import('../codeworkspace/fs.js');
      try {
        const r = await listFilePaths(projectId);
        return r ?? [];
      } catch {
        return [];
      }
    },
    async readFile(projectId, path) {
      const { readFileEntry } = await import('../codeworkspace/fs.js');
      try {
        const e = await readFileEntry(projectId, path);
        return e?.content ?? null;
      } catch {
        return null;
      }
    },
    async relevantMemories(userId, projectId) {
      const { buildCodingContext } = await import('../memorycoding/codingContext.js');
      const items = await buildCodingContext(userId, { projectId });
      return items.map((i) => ({
        kind: 'memory' as const,
        ref: i.ref ?? i.label,
        detail: i.detail,
        confidence: i.confidence,
      }));
    },
    async runtimeEvidence(userId, projectId) {
      const { runtimeMemory } = await import('../memorycoding/runtimeMemory.js');
      const ev = await runtimeMemory(userId, projectId, 6);
      return ev.map((e) => ({ kind: 'runtime' as const, ref: e.ref ?? e.label, detail: e.detail, confidence: e.confidence }));
    },
    async deploymentEvidence(userId, projectId) {
      const { deploymentMemory } = await import('../memorycoding/deploymentMemory.js');
      const { items } = await deploymentMemory(userId, projectId);
      return items.slice(0, 5).map((d) => ({
        kind: 'deployment' as const,
        ref: d.environment ?? 'deployment',
        detail: `environment=${d.environment} status=${d.status} version=${d.version ?? '?'}`,
        confidence: 0.7,
      }));
    },
  };
};

router.post(
  '/ask',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const question = (req.body?.question as string) ?? '';
    if (!question.trim()) throw AppError.badRequest('question_required', 'question is required');
    const sessionId = (req.ctx as { sessionId?: string }).sessionId ?? 'copilot';
    const planId = 'free' as const;
    const result = await askCopilot({ userId: uid, sessionId, planId, coworkerType: 'COPILOT' }, b.projectId, question, askDeps());
    res.json(jsonResult(result));
  }),
);

// ------------------------------------------------------------ test generation
router.post(
  '/testgen',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    if (!b.file) throw AppError.badRequest('file_required', 'file is required for test generation');
    const sessionId = (req.ctx as { sessionId?: string }).sessionId ?? 'copilot';
    const planId = 'free' as const;
    const readFile = askDeps().readFile;
    const result = await generateTestProposals(
      { userId: uid, sessionId, planId, coworkerType: 'COPILOT' },
      b.projectId,
      {
        file: b.file,
        functionName: (req.body?.functionName as string) ?? null,
        failureInfo: b.error,
      },
      { readFile },
    );
    res.json(jsonResult(result));
  }),
);

// ------------------------------------------------------------ failure diagnosis
const diagnoseDeps = (): DiagnosisDeps => {
  return {
    async contextualDebug(userId, projectId, error) {
      const { buildContextualDebugReport } = await import('../developer-workflow/contextualDebug.js');
      try {
        const r = await buildContextualDebugReport(userId, projectId, error);
        return r.clues.map((c) => ({
          file: c.filePath || undefined,
          reason: c.hypothesizedCause,
          score: r.matchType === 'EXACT' ? 0.8 : 0.5,
        }));
      } catch {
        return [];
      }
    },
    async recoveryPlaybook(userId, projectId, error) {
      const { buildErrorRecoveryPlaybook } = await import('../developer-workflow/errorRunbook.js');
      try {
        const r = await buildErrorRecoveryPlaybook(userId, projectId, error);
        return r.steps.map((s) => ({ action: s.action }));
      } catch {
        return [];
      }
    },
    async runtimeEvidence(userId, projectId) {
      const { runtimeMemory } = await import('../memorycoding/runtimeMemory.js');
      const ev = await runtimeMemory(userId, projectId, 6);
      return ev.map((e) => ({ label: e.label, detail: e.detail, confidence: e.confidence, ref: e.ref ?? null }));
    },
    async relevantMemories(userId, projectId) {
      const { buildCodingContext } = await import('../memorycoding/codingContext.js');
      const items = await buildCodingContext(userId, { projectId });
      return items.map((i) => ({ label: i.label, detail: i.detail, confidence: i.confidence }));
    },
  };
};

router.post(
  '/diagnose',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const errorText = (req.body?.error as string) ?? '';
    if (!errorText.trim()) throw AppError.badRequest('error_required', 'error/failure text is required');
    const sessionId = (req.ctx as { sessionId?: string }).sessionId ?? 'copilot';
    const planId = 'free' as const;
    const result = await diagnoseFailure({ userId: uid, sessionId, planId, coworkerType: 'COPILOT' }, b.projectId, errorText, diagnoseDeps());
    res.json(jsonResult(result));
  }),
);

// ------------------------------------------------------------ safe proposal via B1
router.post(
  '/propose',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const taskId = (req.body?.taskId as string) ?? b.taskId ?? undefined;
    if (!taskId) throw AppError.badRequest('task_required', 'taskId is required to create a B1 review');
    const edits = Array.isArray(req.body?.edits) ? (req.body.edits as Array<{ path: string; proposedContent: string; summary?: string }>) : [];
    if (!edits.length) throw AppError.badRequest('edits_required', 'no edits proposed');
    const title = (req.body?.title as string) ?? 'Copilot proposal';
    const review = await proposeChangeViaB1(
      uid,
      b.projectId,
      taskId,
      edits.map((e) => ({ path: e.path, proposedContent: e.proposedContent, summary: e.summary ?? '' })),
      title,
    );
    res.json(jsonResult({ review }));
  }),
);

// ------------------------------------------------------------ memory feedback
router.post(
  '/feedback',
  asyncRoute(async (req, res) => {
    requireEnabled();
    const uid = req.ctx.user!.id;
    const b = bodyOf(req);
    await assert(uid, b);
    const level = (req.body?.level as string) ?? '';
    if (!['OBSERVED', 'CONFIRMED', 'EXPLICIT', 'INFERRED'].includes(level)) {
      throw AppError.badRequest('invalid_level', 'level must be OBSERVED/CONFIRMED/EXPLICIT/INFERRED');
    }
    const content = (req.body?.content as string) ?? '';
    if (!content.trim()) throw AppError.badRequest('content_required', 'content is required');
    const result = await copilotFeedback(uid, {
      projectId: b.projectId,
      content,
      level: level as 'OBSERVED' | 'CONFIRMED' | 'EXPLICIT' | 'INFERRED',
      source: (req.body?.source as string) ?? 'copilot',
      structured: (req.body?.structured as Record<string, unknown>) ?? { id: newId(PREFIX.MESSAGE) },
    });
    res.json(jsonResult(result));
  }),
);

export const copilotRoutes = (): Router => router;
