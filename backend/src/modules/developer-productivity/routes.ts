/**
 * CodeConClave — Developer Productivity Routes (V4B).
 * Workspace Context, Git Ninja, Testing Strategy, Documentation Autobot,
 * API Documentation, Flow Diagrams.
 */
import { Router, Request } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  updateOpenProject,
  updateActiveFile,
  removeActiveFile,
  setCurrentTask,
  setActiveAgent,
  addRecentSearch,
  addRecentCommand,
  setSelectedBranch,
  getSessionContextForUser,
  clearSessionContext,
  exportSessionContext,
  importSessionContext,
  cleanupOldContexts,
} from './workspaceContext.js';
import {
  getDiff,
  getBlame,
  suggestCommitMessage,
  getStagedChanges,
  getBranches,
  getMergeConflicts,
  getHistory,
  getStashes,
  startBisect,
  stepBisect,
  resetBisect,
} from './gitNinja.js';
import {
  generateTestStrategy,
  generateTestDiff,
  proposeTestSuggestion,
} from './testingStrategy.js';
import {
  generateReadme,
  generateArchitectureDoc,
  generateChangelog,
} from './documentationAutobot.js';
import {
  generateApiDocumentation,
  exportOpenApiSpec,
} from './apiDocGenerator.js';
import {
  generateDiagram,
} from './flowDiagram.js';

export const developerProductivityRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const userId = (req: Request): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };

  const pid = (req: Request): string => {
    const qp = req.query?.projectId;
    const id = req.params?.projectId ?? (Array.isArray(qp) ? qp[0] : qp);
    if (!id) throw AppError.badRequest('project_required', 'projectId is required');
    return String(id);
  };

  const rid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_id', 'Resource id is required');
    return v;
  };

  // ============================================================ WORKSPACE CONTEXT KEEPER
  router.post(
    '/context/project',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const context = await updateOpenProject(userId(req), projectId);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/active-file',
    asyncRoute(async (req, res) => {
      const { filePath, projectId, cursorPosition } = req.body ?? {};
      if (!filePath || !projectId) throw AppError.badRequest('invalid_input', 'filePath and projectId required');
      const context = await updateActiveFile(userId(req), { filePath, projectId, cursorPosition });
      res.json(jsonResult({ context }));
    }),
  );

  router.delete(
    '/context/active-file',
    asyncRoute(async (req, res) => {
      const { filePath, projectId } = req.body ?? {};
      if (!filePath || !projectId) throw AppError.badRequest('invalid_input', 'filePath and projectId required');
      const context = await removeActiveFile(userId(req), filePath, projectId);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/task',
    asyncRoute(async (req, res) => {
      const taskId = req.body?.taskId ?? null;
      const context = await setCurrentTask(userId(req), taskId);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/agent',
    asyncRoute(async (req, res) => {
      const agentId = req.body?.agentId ?? null;
      const context = await setActiveAgent(userId(req), agentId);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/search',
    asyncRoute(async (req, res) => {
      const query = String(req.body?.query ?? '');
      if (!query) throw AppError.badRequest('query_required', 'query is required');
      const context = await addRecentSearch(userId(req), query);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/command',
    asyncRoute(async (req, res) => {
      const command = String(req.body?.command ?? '');
      if (!command) throw AppError.badRequest('command_required', 'command is required');
      const context = await addRecentCommand(userId(req), command);
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/branch',
    asyncRoute(async (req, res) => {
      const branch = req.body?.branch ?? null;
      const context = await setSelectedBranch(userId(req), branch);
      res.json(jsonResult({ context }));
    }),
  );

  router.get(
    '/context',
    asyncRoute(async (req, res) => {
      const context = await getSessionContextForUser(userId(req));
      res.json(jsonResult({ context }));
    }),
  );

  router.delete(
    '/context',
    asyncRoute(async (req, res) => {
      await clearSessionContext(userId(req));
      res.json(jsonResult({ cleared: true }));
    }),
  );

  router.get(
    '/context/export',
    asyncRoute(async (req, res) => {
      const context = await exportSessionContext(userId(req));
      res.json(jsonResult({ context }));
    }),
  );

  router.post(
    '/context/import',
    asyncRoute(async (req, res) => {
      const context = req.body?.context;
      if (!context) throw AppError.badRequest('context_required', 'context is required');
      const imported = await importSessionContext(userId(req), context);
      res.json(jsonResult({ context: imported }));
    }),
  );

  router.post(
    '/context/cleanup',
    asyncRoute(async (req, res) => {
      const count = await cleanupOldContexts();
      res.json(jsonResult({ cleaned: count }));
    }),
  );

  // ============================================================ GIT NINJA
  router.get(
    '/git/diff',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const filePath = req.query.filePath ? String(req.query.filePath) : undefined;
      const staged = req.query.staged === 'true';
      const cached = req.query.cached === 'true';
      const base = req.query.base ? String(req.query.base) : undefined;
      const target = req.query.target ? String(req.query.target) : undefined;
      const diff = await getDiff(userId(req), { projectId, filePath, staged, cached, base, target });
      res.json(jsonResult({ diff }));
    }),
  );

  router.get(
    '/git/blame',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const filePath = String(req.query.filePath ?? '');
      if (!filePath) throw AppError.badRequest('file_required', 'filePath query param required');
      const blame = await getBlame(userId(req), projectId, filePath);
      res.json(jsonResult({ blame }));
    }),
  );

  router.get(
    '/git/commit-suggestion',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const suggestion = await suggestCommitMessage(userId(req), projectId);
      res.json(jsonResult({ suggestion }));
    }),
  );

  router.get(
    '/git/staged',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const changes = await getStagedChanges(userId(req), projectId);
      res.json(jsonResult({ changes }));
    }),
  );

  router.get(
    '/git/branches',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const branches = await getBranches(userId(req), projectId);
      res.json(jsonResult({ branches }));
    }),
  );

  router.get(
    '/git/conflicts',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const conflicts = await getMergeConflicts(userId(req), projectId);
      res.json(jsonResult({ conflicts }));
    }),
  );

  router.get(
    '/git/history',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const filePath = req.query.filePath ? String(req.query.filePath) : undefined;
      const since = req.query.since ? String(req.query.since) : undefined;
      const until = req.query.until ? String(req.query.until) : undefined;
      const history = await getHistory(userId(req), projectId, { limit, offset, filePath, since, until });
      res.json(jsonResult({ history }));
    }),
  );

  router.get(
    '/git/stashes',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const stashes = await getStashes(userId(req), projectId);
      res.json(jsonResult({ stashes }));
    }),
  );

  router.post(
    '/git/bisect/start',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { bad, good, testCommand } = req.body ?? {};
      if (!bad || !good) throw AppError.badRequest('bisect_required', 'bad and good commits required');
      const result = await startBisect(userId(req), projectId, { bad, good, testCommand });
      res.json(jsonResult({ result }));
    }),
  );

  router.post(
    '/git/bisect/step',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { result } = req.body ?? {};
      if (!result || !['good', 'bad', 'skip'].includes(result)) {
        throw AppError.badRequest('bisect_step_required', 'result must be good, bad, or skip');
      }
      const bisectResult = await stepBisect(userId(req), projectId, { result });
      res.json(jsonResult({ result: bisectResult }));
    }),
  );

  router.post(
    '/git/bisect/reset',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      await resetBisect(userId(req), projectId);
      res.json(jsonResult({ reset: true }));
    }),
  );

  // ============================================================ TESTING STRATEGY GENERATOR
  router.post(
    '/test/strategy',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const strategy = await generateTestStrategy(userId(req), projectId, options);
      res.json(jsonResult({ strategy }));
    }),
  );

  router.post(
    '/test/suggestion/diff',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { suggestionId, strategy } = req.body ?? {};
      if (!suggestionId || !strategy) throw AppError.badRequest('invalid_input', 'suggestionId and strategy required');
      const diff = await generateTestDiff(userId(req), projectId, suggestionId, strategy);
      res.json(jsonResult({ diff }));
    }),
  );

  router.post(
    '/test/suggestion/propose',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { suggestionId, strategy } = req.body ?? {};
      if (!suggestionId || !strategy) throw AppError.badRequest('invalid_input', 'suggestionId and strategy required');
      const approved = await proposeTestSuggestion(userId(req), projectId, suggestionId, strategy);
      res.json(jsonResult({ approved }));
    }),
  );

  // ============================================================ DOCUMENTATION AUTOBOT
  router.post(
    '/docs/readme',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const doc = await generateReadme(userId(req), projectId, options);
      res.json(jsonResult({ document: doc }));
    }),
  );

  router.post(
    '/docs/architecture',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const doc = await generateArchitectureDoc(userId(req), projectId, options);
      res.json(jsonResult({ document: doc }));
    }),
  );

  router.post(
    '/docs/changelog',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const doc = await generateChangelog(userId(req), projectId, options);
      res.json(jsonResult({ document: doc }));
    }),
  );

  // ============================================================ API DOCUMENTATION GENERATOR
  router.get(
    '/api-doc',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const format = req.query.format ? String(req.query.format) : 'openapi';
      const includeExamples = req.query.examples !== 'false';
      const includeErrors = req.query.errors !== 'false';
      const includeAuth = req.query.auth !== 'false';
      const { openapi, markdown } = await generateApiDocumentation(userId(req), projectId, {
        format: format as any,
        includeExamples,
        includeErrors,
        includeAuth,
      });
      if (format === 'markdown') {
        res.set('Content-Type', 'text/markdown');
        res.send(markdown);
      } else {
        res.json(jsonResult({ openapi }));
      }
    }),
  );

  router.get(
    '/api-doc/export',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const spec = await exportOpenApiSpec(userId(req), projectId);
      res.set('Content-Type', 'application/json');
      res.set('Content-Disposition', 'attachment; filename="openapi-spec.json"');
      res.send(spec);
    }),
  );

  // ============================================================ FLOW DIAGRAM GENERATOR
  router.post(
    '/diagram',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const body = req.body ?? {};
      const type = body.type;
      if (!type) throw AppError.badRequest('type_required', 'type is required');
      const options = { ...body, projectId };
      const diagram = await generateDiagram(userId(req), options);
      res.json(jsonResult({ diagram }));
    }),
  );

  return router;
};