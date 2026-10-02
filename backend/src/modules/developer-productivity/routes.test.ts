/**
 * CodeConClave — V4B Developer Productivity Route Tests.
 * Tests for: Workspace Context Keeper, Git Ninja, Testing Strategy Generator,
 * Documentation Autobot, API Documentation Generator, Flow Diagram Generator routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateOpenProject = vi.hoisted(() => vi.fn());
const updateActiveFile = vi.hoisted(() => vi.fn());
const removeActiveFile = vi.hoisted(() => vi.fn());
const setCurrentTask = vi.hoisted(() => vi.fn());
const setActiveAgent = vi.hoisted(() => vi.fn());
const addRecentSearch = vi.hoisted(() => vi.fn());
const addRecentCommand = vi.hoisted(() => vi.fn());
const setSelectedBranch = vi.hoisted(() => vi.fn());
const getSessionContextForUser = vi.hoisted(() => vi.fn());
const clearSessionContext = vi.hoisted(() => vi.fn());
const exportSessionContext = vi.hoisted(() => vi.fn());
const importSessionContext = vi.hoisted(() => vi.fn());
const cleanupOldContexts = vi.hoisted(() => vi.fn());
const getDiff = vi.hoisted(() => vi.fn());
const getBlame = vi.hoisted(() => vi.fn());
const suggestCommitMessage = vi.hoisted(() => vi.fn());
const getStagedChanges = vi.hoisted(() => vi.fn());
const getBranches = vi.hoisted(() => vi.fn());
const getMergeConflicts = vi.hoisted(() => vi.fn());
const getHistory = vi.hoisted(() => vi.fn());
const getStashes = vi.hoisted(() => vi.fn());
const startBisect = vi.hoisted(() => vi.fn());
const stepBisect = vi.hoisted(() => vi.fn());
const resetBisect = vi.hoisted(() => vi.fn());
const generateTestStrategy = vi.hoisted(() => vi.fn());
const generateTestDiff = vi.hoisted(() => vi.fn());
const proposeTestSuggestion = vi.hoisted(() => vi.fn());
const generateReadme = vi.hoisted(() => vi.fn());
const generateArchitectureDoc = vi.hoisted(() => vi.fn());
const generateChangelog = vi.hoisted(() => vi.fn());
const generateApiDocumentation = vi.hoisted(() => vi.fn());
const exportOpenApiSpec = vi.hoisted(() => vi.fn());
const generateDiagram = vi.hoisted(() => vi.fn());

vi.mock('./workspaceContext.js', () => ({
  updateOpenProject, updateActiveFile, removeActiveFile, setCurrentTask,
  setActiveAgent, addRecentSearch, addRecentCommand, setSelectedBranch,
  getSessionContextForUser, clearSessionContext, exportSessionContext,
  importSessionContext, cleanupOldContexts,
}));
vi.mock('./gitNinja.js', () => ({
  getDiff, getBlame, suggestCommitMessage, getStagedChanges, getBranches,
  getMergeConflicts, getHistory, getStashes, startBisect, stepBisect, resetBisect,
}));
vi.mock('./testingStrategy.js', () => ({
  generateTestStrategy, generateTestDiff, proposeTestSuggestion,
}));
vi.mock('./documentationAutobot.js', () => ({
  generateReadme, generateArchitectureDoc, generateChangelog,
}));
vi.mock('./apiDocGenerator.js', () => ({
  generateApiDocumentation, exportOpenApiSpec,
}));
vi.mock('./flowDiagram.js', () => ({
  generateDiagram,
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/security.js', () => ({
  asyncRoute: vi.fn((fn: Function) => (req: unknown, res: unknown, next: unknown) =>
    Promise.resolve(fn(req, res, next)).catch(next),
  ),
}));
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    unauthorized: (code: string, msg: string) => Object.assign(new Error(msg), { status: 401, errorCode: code }),
  },
}));
vi.mock('../auth/schemas.js', () => ({
  jsonResult: (data: unknown) => data,
}));

// ─── Helpers ──────────────────────────────────────────────────────
function findHandler(router: any, method: string, path: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route?.methods?.[method]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
}

function req(overrides: Record<string, unknown> = {}): any {
  return { ctx: { user: { id: 'user-1' } }, params: {}, query: {}, body: {}, ...overrides };
}

function res(): any {
  const r: any = {};
  r.json = vi.fn().mockReturnValue(r);
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  r.set = vi.fn().mockReturnValue(r);
  return r;
}

// ─── WORKSPACE CONTEXT KEEPER ROUTES ────────────────────────────
describe('WORKSPACE CONTEXT KEEPER routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /context/project sets open project', async () => {
    updateOpenProject.mockResolvedValue({ openProjectId: 'proj-1', lastActivityAt: new Date() });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/project');
    const r = res();
    await h(req({ body: { projectId: 'proj-1' } }), r, vi.fn());
    expect(updateOpenProject).toHaveBeenCalledWith('user-1', 'proj-1');
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /context/project requires projectId (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/project');
    const next = vi.fn();
    await h(req({ body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /context/active-file requires filePath and projectId (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/active-file');
    const next = vi.fn();
    await h(req({ body: { filePath: 'a.ts' } }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('DELETE /context/active-file requires filePath and projectId (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'delete', '/context/active-file');
    const next = vi.fn();
    await h(req({ body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /context/search requires query (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/search');
    const next = vi.fn();
    await h(req({ body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /context/command requires command (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/command');
    const next = vi.fn();
    await h(req({ body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('GET /context returns session context', async () => {
    getSessionContextForUser.mockResolvedValue({ openProjectId: null, activeFiles: [] });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/context');
    const r = res();
    await h(req(), r, vi.fn());
    expect(getSessionContextForUser).toHaveBeenCalledWith('user-1');
    expect(r.json).toHaveBeenCalled();
  });

  it('DELETE /context clears context', async () => {
    clearSessionContext.mockResolvedValue(undefined);
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'delete', '/context');
    const r = res();
    await h(req(), r, vi.fn());
    expect(clearSessionContext).toHaveBeenCalledWith('user-1');
    expect(r.json).toHaveBeenCalledWith({ cleared: true });
  });

  it('POST /context/import requires context (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/import');
    const next = vi.fn();
    await h(req({ body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /context/cleanup returns cleaned count', async () => {
    cleanupOldContexts.mockResolvedValue(3);
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/context/cleanup');
    const r = res();
    await h(req(), r, vi.fn());
    expect(r.json).toHaveBeenCalledWith({ cleaned: 3 });
  });
});

// ─── GIT NINJA ROUTES ───────────────────────────────────────────
describe('GIT NINJA routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /git/diff returns diff', async () => {
    getDiff.mockResolvedValue({ projectId: 'proj-1', diffs: [], stats: { files: 0 } });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/diff');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(getDiff).toHaveBeenCalledWith('user-1', expect.objectContaining({ projectId: 'proj-1' }));
  });

  it('GET /git/diff requires projectId (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/diff');
    const next = vi.fn();
    await h(req({ query: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('GET /git/blame returns blame', async () => {
    getBlame.mockResolvedValue({ filePath: 'src/index.ts', lines: [] });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/blame');
    const r = res();
    await h(req({ query: { projectId: 'proj-1', filePath: 'src/index.ts' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /git/blame requires filePath (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/blame');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' } }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('GET /git/commit-suggestion returns suggestion', async () => {
    suggestCommitMessage.mockResolvedValue({ suggestions: ['feat: add'] });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/commit-suggestion');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /git/branches returns branches', async () => {
    getBranches.mockResolvedValue({ currentBranch: 'main', branches: [] });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/git/branches');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /git/bisect/start requires bad and good (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/git/bisect/start');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /git/bisect/step requires valid result (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/git/bisect/step');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: { result: 'invalid' } }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /git/bisect/step accepts good result', async () => {
    stepBisect.mockResolvedValue({ status: 'running' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/git/bisect/step');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: { result: 'good' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });
});

// ─── TESTING STRATEGY GENERATOR ROUTES ──────────────────────────
describe('TESTING STRATEGY GENERATOR routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /test/strategy returns strategy', async () => {
    generateTestStrategy.mockResolvedValue({ suggestions: [], coverageGaps: [] });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/test/strategy');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /test/suggestion/diff requires suggestionId and strategy (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/test/suggestion/diff');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /test/suggestion/propose requires suggestionId and strategy (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/test/suggestion/propose');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

// ─── DOCUMENTATION AUTOBOT ROUTES ───────────────────────────────
describe('DOCUMENTATION AUTOBOT routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /docs/readme returns document', async () => {
    generateReadme.mockResolvedValue({ id: 'doc-1', content: '# Readme' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/docs/readme');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /docs/architecture returns document', async () => {
    generateArchitectureDoc.mockResolvedValue({ id: 'doc-2', content: '# Arch' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/docs/architecture');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /docs/changelog returns document', async () => {
    generateChangelog.mockResolvedValue({ id: 'doc-3', content: '# Changelog' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/docs/changelog');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });
});

// ─── API DOCUMENTATION GENERATOR ROUTES ─────────────────────────
describe('API DOCUMENTATION GENERATOR routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /api-doc returns openapi by default', async () => {
    generateApiDocumentation.mockResolvedValue({ openapi: { openapi: '3.0.3' }, markdown: '# API' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/api-doc');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /api-doc/export returns spec as attachment', async () => {
    exportOpenApiSpec.mockResolvedValue(JSON.stringify({ openapi: '3.0.3' }));
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/api-doc/export');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.set).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(r.send).toHaveBeenCalled();
  });

  it('GET /api-doc requires projectId (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'get', '/api-doc');
    const next = vi.fn();
    await h(req({ query: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

// ─── FLOW DIAGRAM GENERATOR ROUTES ─────────────────────────────
describe('FLOW DIAGRAM GENERATOR routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /diagram generates diagram', async () => {
    generateDiagram.mockResolvedValue({ id: 'diag-1', mermaid: 'flowchart LR', type: 'flowchart' });
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/diagram');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: { type: 'flowchart' } }), r, vi.fn());
    expect(generateDiagram).toHaveBeenCalledWith('user-1', expect.objectContaining({ type: 'flowchart', projectId: 'proj-1' }));
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /diagram requires type (400)', async () => {
    const router = (await import('./routes.js')).developerProductivityRoutes();
    const h = findHandler(router, 'post', '/diagram');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
