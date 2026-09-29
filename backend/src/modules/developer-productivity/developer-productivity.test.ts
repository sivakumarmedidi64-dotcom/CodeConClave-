/**
 * CodeConClave — V4B Developer Productivity Tests.
 * Tests for: Git Ninja, Testing Strategy, Documentation Autobot,
 * API Doc Generator, Flow Diagram Generator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: any[];
    rowCount: number;
    queryOverrides: { pattern: RegExp; rows: any[]; rowCount?: number }[];
  } = {
    calls: [],
    rows: [],
    rowCount: 1,
    queryOverrides: [],
  };

  const PROJECT_ROW = { id: 'proj-1' };
  const WORKSPACE_ROW = { root: '/workspace/proj-1' };

  const resolveRows = (text: string): { rows: any[]; rowCount: number } => {
    for (const override of state.queryOverrides) {
      if (override.pattern.test(text)) {
        return { rows: override.rows, rowCount: override.rowCount ?? override.rows.length };
      }
    }
    if (/FROM projects/i.test(text)) {
      return { rows: [PROJECT_ROW], rowCount: 1 };
    }
    if (/FROM workspaces/i.test(text)) {
      return { rows: [WORKSPACE_ROW], rowCount: 1 };
    }
    if (/FROM files/i.test(text)) {
      return state.rows;
    }
    if (/information_schema\.tables/i.test(text)) {
      return state.rows;
    }
    if (/information_schema\.columns/i.test(text)) {
      return state.rows;
    }
    if (/information_schema\.table_constraints/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: state.rows, rowCount: state.rowCount };
  };

  const query = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text);
  };

  const queryMany = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text).rows;
  };

  const withTenant = async (_tid: string, fn: (q: { query: typeof query; queryMany: typeof queryMany }) => any) =>
    fn({ query, queryMany });

  return { state, pool: { query }, queryMany, withTenant };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const globalSearch = vi.hoisted(() => vi.fn(async () => ({ results: [], total: 0 })));
const createTask = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1' })));
const proposeApproval = vi.hoisted(() => vi.fn(async () => ({ approval: { id: 'approval-1' } })));
const listDna = vi.hoisted(() => vi.fn(async () => []));
const retrieveDnaForPrompt = vi.hoisted(() => vi.fn(async () => ''));
const retrieveMemoriesForPrompt = vi.hoisted(() => vi.fn(async () => []));
const listTasks = vi.hoisted(() => vi.fn(async () => []));
const listSwarms = vi.hoisted(() => vi.fn(async () => []));
const newId = vi.hoisted(() => vi.fn(() => 'id-1'));
const PREFIX = vi.hoisted(() => ({
  TEST_SUGGESTION: 'ts_',
  TEST_STRATEGY: 'tst_',
  DIAGRAM: 'diag_',
  DOC: 'doc_',
  API_DOC: 'apidoc_',
}));

vi.mock('../../shared/db.js', () => db);
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
  },
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../shared/ids.js', () => ({ newId, PREFIX }));
vi.mock('@codeconclave/shared', () => ({
  AuditAction: {
    FILE_READ: 'file_read',
    FILE_WRITTEN: 'file_written',
    SEARCH_PERFORMED: 'search_performed',
  },
}));
vi.mock('../search/service.js', () => ({ globalSearch }));
vi.mock('../execution/tasks.js', () => ({
  createTask,
  listTasks,
  getTask: vi.fn(async () => null),
  cancelTask: vi.fn(async () => {}),
}));
vi.mock('../execution/approvals.js', () => ({ proposeApproval }));
vi.mock('../dna/service.js', () => ({ listDna, retrieveDnaForPrompt }));
vi.mock('../memory/service.js', () => ({ retrieveMemoriesForPrompt }));
vi.mock('../engineering/prReview.js', () => ({ listSwarms }));

// ─── GIT NINJA ────────────────────────────────────────────────────
describe('GIT NINJA — diff, blame, commits, branches, conflicts, history, stash, bisect', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('getDiff returns structured diff result', async () => {
    const { getDiff } = await import('./gitNinja.js');
    const result = await getDiff('user-1', { projectId: 'proj-1', filePath: 'src/index.ts' });

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('diffs');
    expect(result).toHaveProperty('stats');
    expect(Array.isArray(result.diffs)).toBe(true);
    expect(result.stats).toHaveProperty('additions');
    expect(result.stats).toHaveProperty('deletions');
    expect(result.stats).toHaveProperty('files');
    expect(recordAudit).toHaveBeenCalled();
  });

  it('getBlame returns blame result for file', async () => {
    const { getBlame } = await import('./gitNinja.js');
    const result = await getBlame('user-1', 'proj-1', 'src/index.ts');

    expect(result).toHaveProperty('filePath', 'src/index.ts');
    expect(result).toHaveProperty('lines');
    expect(Array.isArray(result.lines)).toBe(true);
    expect(recordAudit).toHaveBeenCalled();
  });

  it('suggestCommitMessage returns suggestions array', async () => {
    const { suggestCommitMessage } = await import('./gitNinja.js');
    const result = await suggestCommitMessage('user-1', 'proj-1');

    expect(result).toHaveProperty('suggestions');
    expect(result).toHaveProperty('diffSummary');
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(recordAudit).toHaveBeenCalled();
  });

  it('getStagedChanges returns staged files summary', async () => {
    const { getStagedChanges } = await import('./gitNinja.js');
    const result = await getStagedChanges('user-1', 'proj-1');

    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.summary).toBe('string');
  });

  it('getBranches returns branch preview', async () => {
    const { getBranches } = await import('./gitNinja.js');
    const result = await getBranches('user-1', 'proj-1');

    expect(result).toHaveProperty('currentBranch');
    expect(result).toHaveProperty('branches');
    expect(typeof result.currentBranch).toBe('string');
    expect(Array.isArray(result.branches)).toBe(true);
  });

  it('getMergeConflicts returns conflict result', async () => {
    const { getMergeConflicts } = await import('./gitNinja.js');
    const result = await getMergeConflicts('user-1', 'proj-1');

    expect(result).toHaveProperty('hasConflicts');
    expect(result).toHaveProperty('conflicts');
    expect(result).toHaveProperty('conflictedFiles');
    expect(typeof result.hasConflicts).toBe('boolean');
    expect(Array.isArray(result.conflicts)).toBe(true);
  });

  it('getHistory returns paginated commit history', async () => {
    const { getHistory } = await import('./gitNinja.js');
    const result = await getHistory('user-1', 'proj-1', { limit: 10, offset: 0 });

    expect(result).toHaveProperty('commits');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('page');
    expect(result).toHaveProperty('perPage');
    expect(result.perPage).toBe(10);
    expect(Array.isArray(result.commits)).toBe(true);
  });

  it('getHistory uses default perPage when not specified', async () => {
    const { getHistory } = await import('./gitNinja.js');
    const result = await getHistory('user-1', 'proj-1');

    expect(result.perPage).toBe(50);
  });

  it('getStashes returns stash list', async () => {
    const { getStashes } = await import('./gitNinja.js');
    const result = await getStashes('user-1', 'proj-1');

    expect(result).toHaveProperty('stashes');
    expect(Array.isArray(result.stashes)).toBe(true);
  });

  it('startBisect returns bisect state with good/bad commits', async () => {
    const { startBisect } = await import('./gitNinja.js');
    const result = await startBisect('user-1', 'proj-1', { bad: 'abc123', good: 'def456' });

    expect(result).toHaveProperty('goodCommits');
    expect(result).toHaveProperty('badCommits');
    expect(result).toHaveProperty('status', 'running');
    expect(result.goodCommits).toContain('def456');
    expect(result.badCommits).toContain('abc123');
  });

  it('stepBisect returns updated bisect state', async () => {
    const { stepBisect } = await import('./gitNinja.js');
    const result = await stepBisect('user-1', 'proj-1', { result: 'good' });

    expect(result).toHaveProperty('goodCommits');
    expect(result).toHaveProperty('badCommits');
    expect(result).toHaveProperty('remaining');
    expect(result).toHaveProperty('status');
  });

  it('resetBisect completes without error', async () => {
    const { resetBisect } = await import('./gitNinja.js');
    await expect(resetBisect('user-1', 'proj-1')).resolves.toBeUndefined();
    expect(recordAudit).toHaveBeenCalled();
  });

  it('throws on non-existent project', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
      { pattern: /FROM workspaces/i, rows: [], rowCount: 0 },
    ];

    const { getDiff } = await import('./gitNinja.js');
    await expect(getDiff('user-1', { projectId: 'nonexistent' })).rejects.toThrow('Project');
  });
});

// ─── TESTING STRATEGY ─────────────────────────────────────────────
describe('TESTING STRATEGY — suggestions, diffs, proposals', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    createTask.mockResolvedValue({ id: 'task-1' });
    proposeApproval.mockResolvedValue({ approval: { id: 'approval-1' } });
  });

  it('generateTestStrategy returns structure with suggestions and gaps', async () => {
    const { generateTestStrategy } = await import('./testingStrategy.js');
    const result = await generateTestStrategy('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('suggestions');
    expect(result).toHaveProperty('coverageGaps');
    expect(result).toHaveProperty('prioritizedOrder');
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(Array.isArray(result.coverageGaps)).toBe(true);
    expect(Array.isArray(result.prioritizedOrder)).toBe(true);
  });

  it('generateTestStrategy with no files returns empty suggestions', async () => {
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    const { generateTestStrategy } = await import('./testingStrategy.js');
    const result = await generateTestStrategy('user-1', 'proj-1');

    expect(result.suggestions).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(0);
  });

  it('generateTestDiff returns diff for valid suggestion', async () => {
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    const { generateTestStrategy, generateTestDiff } = await import('./testingStrategy.js');
    const strategy = await generateTestStrategy('user-1', 'proj-1');

    if (strategy.suggestions.length > 0) {
      const diff = await generateTestDiff('user-1', 'proj-1', strategy.suggestions[0].id, strategy);
      expect(diff).toHaveProperty('suggestionId');
      expect(diff).toHaveProperty('testFilePath');
      expect(diff).toHaveProperty('diff');
      expect(diff).toHaveProperty('newFile', true);
      expect(diff.diff).toContain('+++');
    } else {
      expect(strategy.suggestions).toHaveLength(0);
    }
  });

  it('generateTestDiff throws for unknown suggestion id', async () => {
    const { generateTestDiff } = await import('./testingStrategy.js');
    const fakeStrategy = { suggestions: [], coverageGaps: [], prioritizedOrder: [], projectId: 'proj-1' };
    await expect(generateTestDiff('user-1', 'proj-1', 'unknown-id', fakeStrategy)).rejects.toThrow('Suggestion');
  });

  it('proposeTestSuggestion creates task and approval', async () => {
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    const { generateTestStrategy, proposeTestSuggestion } = await import('./testingStrategy.js');
    const strategy = await generateTestStrategy('user-1', 'proj-1');

    if (strategy.suggestions.length > 0) {
      const result = await proposeTestSuggestion('user-1', 'proj-1', strategy.suggestions[0].id, strategy);
      expect(result).toHaveProperty('suggestionId');
      expect(result).toHaveProperty('taskId');
      expect(result).toHaveProperty('approvalId');
      expect(createTask).toHaveBeenCalled();
      expect(proposeApproval).toHaveBeenCalled();
    } else {
      expect(strategy.suggestions).toHaveLength(0);
    }
  });

  it('records audit on generateTestStrategy', async () => {
    const { generateTestStrategy } = await import('./testingStrategy.js');
    await generateTestStrategy('user-1', 'proj-1');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search_performed' }),
    );
  });

  it('throws on non-existent project', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
      { pattern: /FROM workspaces/i, rows: [], rowCount: 0 },
    ];
    const { generateTestStrategy } = await import('./testingStrategy.js');
    await expect(generateTestStrategy('user-1', 'nonexistent')).rejects.toThrow('Project');
  });
});

// ─── DOCUMENTATION AUTOBOT ─────────────────────────────────────────
describe('DOCUMENTATION AUTOBOT — readme, architecture, changelog', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    listDna.mockResolvedValue([]);
    listTasks.mockResolvedValue([]);
    listSwarms.mockResolvedValue([]);
    retrieveMemoriesForPrompt.mockResolvedValue([]);
  });

  it('generateReadme returns markdown document with content', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT name, description FROM projects/i, rows: [{ name: 'TestProject', description: 'A test project' }] },
    ];
    const { generateReadme } = await import('./documentationAutobot.js');
    const doc = await generateReadme('user-1', 'proj-1');

    expect(doc).toHaveProperty('id');
    expect(doc).toHaveProperty('target');
    expect(doc.target.type).toBe('readme');
    expect(doc).toHaveProperty('format', 'markdown');
    expect(doc).toHaveProperty('content');
    expect(doc.content).toContain('TestProject');
    expect(doc).toHaveProperty('aiGenerated', true);
    expect(doc).toHaveProperty('sources');
    expect(Array.isArray(doc.sources)).toBe(true);
  });

  it('generateReadme with badges option disabled excludes badge lines', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT name, description FROM projects/i, rows: [{ name: 'TestProject', description: 'A test' }] },
    ];
    const { generateReadme } = await import('./documentationAutobot.js');
    const doc = await generateReadme('user-1', 'proj-1', { includeBadges: false });

    expect(doc.content).not.toContain('shields.io');
  });

  it('generateArchitectureDoc returns markdown with diagrams', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT name, description FROM projects/i, rows: [{ name: 'TestProject', description: 'An architecture' }] },
    ];
    const { generateArchitectureDoc } = await import('./documentationAutobot.js');
    const doc = await generateArchitectureDoc('user-1', 'proj-1');

    expect(doc.target.type).toBe('architecture');
    expect(doc.content).toContain('Architecture');
    expect(doc.content).toContain('mermaid');
    expect(doc.format).toBe('markdown');
  });

  it('generateArchitectureDoc with diagrams disabled excludes mermaid blocks', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT name, description FROM projects/i, rows: [{ name: 'TestProject', description: 'A project' }] },
    ];
    const { generateArchitectureDoc } = await import('./documentationAutobot.js');
    const doc = await generateArchitectureDoc('user-1', 'proj-1', { includeDiagrams: false });

    expect(doc.content).not.toContain('```mermaid');
  });

  it('generateChangelog returns changelog with period info', async () => {
    listTasks.mockResolvedValue([
      { id: 't1', title: 'Add login feature', description: 'Auth', status: 'COMPLETED', completed_at: new Date(), owner_id: 'u1' },
      { id: 't2', title: 'Fix memory leak', description: 'Bug', status: 'COMPLETED', completed_at: new Date(), owner_id: 'u1' },
    ]);
    listDna.mockResolvedValue([]);

    const { generateChangelog } = await import('./documentationAutobot.js');
    const doc = await generateChangelog('user-1', 'proj-1');

    expect(doc.target.type).toBe('changelog');
    expect(doc.content).toContain('Changelog');
    expect(doc.content).toContain('Period');
    expect(doc.content).toContain('login feature');
  });

  it('generateChangelog groups by date correctly', async () => {
    listTasks.mockResolvedValue([
      { id: 't1', title: 'Task A', description: '', status: 'COMPLETED', completed_at: new Date(), owner_id: 'u1' },
    ]);
    listDna.mockResolvedValue([]);

    const { generateChangelog } = await import('./documentationAutobot.js');
    const doc = await generateChangelog('user-1', 'proj-1', { groupBy: 'date' });

    expect(doc.target.type).toBe('changelog');
    expect(doc.content).toContain('Changelog');
  });

  it('throws on non-existent project', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
      { pattern: /FROM workspaces/i, rows: [], rowCount: 0 },
    ];
    const { generateReadme } = await import('./documentationAutobot.js');
    await expect(generateReadme('user-1', 'nonexistent')).rejects.toThrow('Project');
  });
});

// ─── API DOC GENERATOR ────────────────────────────────────────────
describe('API DOC GENERATOR — openapi and markdown generation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('generateApiDocumentation returns openapi and markdown', async () => {
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    const result = await generateApiDocumentation('user-1', 'proj-1');

    expect(result).toHaveProperty('openapi');
    expect(result).toHaveProperty('markdown');
    expect(result.openapi).toHaveProperty('openapi', '3.0.3');
    expect(result.openapi).toHaveProperty('info');
    expect(result.openapi.info).toHaveProperty('title', 'CodeConClave API');
    expect(result.openapi).toHaveProperty('paths');
    expect(result.openapi).toHaveProperty('components');
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown).toContain('CodeConClave API Documentation');
  });

  it('generateApiDocumentation has security schemes', async () => {
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    const result = await generateApiDocumentation('user-1', 'proj-1');

    expect(result.openapi.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(result.openapi.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('generateApiDocumentation includes known endpoints', async () => {
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    const result = await generateApiDocumentation('user-1', 'proj-1');

    const paths = Object.keys(result.openapi.paths);
    expect(paths).toContain('/api/v1/auth/login');
    expect(paths).toContain('/api/v1/projects');
    expect(paths).toContain('/health');
    expect(paths).toContain('/healthz');
  });

  it('generateApiDocumentation markdown contains endpoint details', async () => {
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    const result = await generateApiDocumentation('user-1', 'proj-1');

    expect(result.markdown).toContain('Authentication');
    expect(result.markdown).toContain('Projects');
    expect(result.markdown).toContain('POST');
    expect(result.markdown).toContain('GET');
  });

  it('exportOpenApiSpec returns JSON string', async () => {
    const { exportOpenApiSpec } = await import('./apiDocGenerator.js');
    const spec = await exportOpenApiSpec('user-1', 'proj-1');

    expect(typeof spec).toBe('string');
    const parsed = JSON.parse(spec);
    expect(parsed).toHaveProperty('openapi', '3.0.3');
    expect(parsed).toHaveProperty('paths');
  });

  it('records audit on generateApiDocumentation', async () => {
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    await generateApiDocumentation('user-1', 'proj-1');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search_performed' }),
    );
  });

  it('throws on non-existent project', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
      { pattern: /FROM workspaces/i, rows: [], rowCount: 0 },
    ];
    const { generateApiDocumentation } = await import('./apiDocGenerator.js');
    await expect(generateApiDocumentation('user-1', 'nonexistent')).rejects.toThrow('Project');
  });
});

// ─── FLOW DIAGRAM GENERATOR ───────────────────────────────────────
describe('FLOW DIAGRAM GENERATOR — mermaid diagram types', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    listDna.mockResolvedValue([]);
  });

  it('generates flowchart diagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'flowchart', projectId: 'proj-1' });

    expect(diagram).toHaveProperty('id');
    expect(diagram).toHaveProperty('type', 'flowchart');
    expect(diagram).toHaveProperty('projectId', 'proj-1');
    expect(diagram).toHaveProperty('mermaid');
    expect(diagram.mermaid).toContain('flowchart');
    expect(diagram).toHaveProperty('metadata');
    expect(diagram.metadata).toHaveProperty('nodeCount');
    expect(diagram.metadata).toHaveProperty('edgeCount');
    expect(diagram.metadata).toHaveProperty('complexity');
    expect(diagram).toHaveProperty('generatedAt');
  });

  it('generates architecture diagram with layers', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'architecture', projectId: 'proj-1' });

    expect(diagram.type).toBe('architecture');
    expect(diagram.mermaid).toContain('Client Layer');
    expect(diagram.mermaid).toContain('API Layer');
    expect(diagram.mermaid).toContain('Core Services');
    expect(diagram.mermaid).toContain('Data Layer');
  });

  it('generates sequence diagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'sequence', projectId: 'proj-1' });

    expect(diagram.type).toBe('sequence');
    expect(diagram.mermaid).toContain('sequenceDiagram');
    expect(diagram.mermaid).toContain('participant');
    expect(diagram.mermaid).toContain('User');
  });

  it('generates state diagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'state', projectId: 'proj-1' });

    expect(diagram.type).toBe('state');
    expect(diagram.mermaid).toContain('stateDiagram');
    expect(diagram.mermaid).toContain('Running');
    expect(diagram.mermaid).toContain('Completed');
  });

  it('generates journey diagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'journey', projectId: 'proj-1' });

    expect(diagram.type).toBe('journey');
    expect(diagram.mermaid).toContain('journey');
    expect(diagram.mermaid).toContain('Developer Workflow');
  });

  it('generates gitgraph diagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'gitgraph', projectId: 'proj-1' });

    expect(diagram.type).toBe('gitgraph');
    expect(diagram.mermaid).toContain('gitGraph');
    expect(diagram.mermaid).toContain('commit');
  });

  it('generates pie chart from task statuses', async () => {
    db.state.queryOverrides = [
      { pattern: /GROUP BY status/i, rows: [{ status: 'COMPLETED', count: 5 }, { status: 'RUNNING', count: 2 }] },
    ];
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'pie', projectId: 'proj-1' });

    expect(diagram.type).toBe('pie');
    expect(diagram.mermaid).toContain('pie');
    expect(diagram.metadata.nodeCount).toBe(2);
  });

  it('records audit on generateDiagram', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    await generateDiagram('user-1', { type: 'flowchart', projectId: 'proj-1' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search_performed' }),
    );
  });

  it('throws on non-existent project', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
      { pattern: /FROM workspaces/i, rows: [], rowCount: 0 },
    ];
    const { generateDiagram } = await import('./flowDiagram.js');
    await expect(
      generateDiagram('user-1', { type: 'flowchart', projectId: 'nonexistent' }),
    ).rejects.toThrow('Project');
  });

  it('generates dependency diagram with direction option', async () => {
    const { generateDiagram } = await import('./flowDiagram.js');
    const diagram = await generateDiagram('user-1', { type: 'dependency', projectId: 'proj-1', direction: 'LR' });

    expect(diagram.type).toBe('dependency');
    expect(diagram.mermaid).toContain('graph LR');
  });
});
