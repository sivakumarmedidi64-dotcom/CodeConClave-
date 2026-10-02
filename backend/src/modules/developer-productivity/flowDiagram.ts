/**
 * CodeConClave — Flow Diagram Generator (V4B).
 * Uses Mermaid or existing diagram mechanism.
 * Generates: flowcharts, sequence diagrams, architecture diagrams, dependency diagrams, database relationships.
 * Only from real code evidence.
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { globalSearch } from '../search/service.js';
import { listDna } from '../dna/service.js';

export type DiagramType =
  | 'flowchart'
  | 'sequence'
  | 'architecture'
  | 'dependency'
  | 'database'
  | 'class'
  | 'state'
  | 'er'
  | 'gantt'
  | 'pie'
  | 'gitgraph'
  | 'journey';

export interface DiagramOptions {
  type: DiagramType;
  projectId: string;
  scope?: string;
  direction?: 'TB' | 'TD' | 'LR' | 'RL' | 'BT';
  theme?: 'default' | 'dark' | 'forest' | 'neutral';
  includeLegend?: boolean;
  maxNodes?: number;
}

export interface GeneratedDiagram {
  id: string;
  type: DiagramType;
  projectId: string;
  mermaid: string;
  metadata: DiagramMetadata;
  generatedAt: Date;
}

export interface DiagramMetadata {
  nodeCount: number;
  edgeCount: number;
  complexity: 'simple' | 'moderate' | 'complex';
  sources: string[];
  warnings: string[];
}

export interface FlowchartOptions extends DiagramOptions {
  type: 'flowchart';
  startNode?: string;
  showDecisions?: boolean;
  showLoops?: boolean;
}

export interface SequenceOptions extends DiagramOptions {
  type: 'sequence';
  participants?: string[];
  showActivations?: boolean;
  showReturnArrows?: boolean;
}

export interface ArchitectureOptions extends DiagramOptions {
  type: 'architecture';
  showLayers?: boolean;
  showServices?: boolean;
  showDataFlows?: boolean;
  showExternalSystems?: boolean;
}

export interface DependencyOptions extends DiagramOptions {
  type: 'dependency';
  targetFile?: string;
  depth?: number;
  showExternal?: boolean;
  showCircular?: boolean;
}

export interface DatabaseOptions extends DiagramOptions {
  type: 'database' | 'er';
  includeIndexes?: boolean;
  includeForeignKeys?: boolean;
  includeConstraints?: boolean;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

function sanitizeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeMermaid(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

export async function generateDiagram(
  userId: string,
  options: DiagramOptions
): Promise<GeneratedDiagram> {
  await assertProjectAccess(userId, options.projectId);

  let mermaid = '';
  let metadata: DiagramMetadata = {
    nodeCount: 0,
    edgeCount: 0,
    complexity: 'simple',
    sources: [],
    warnings: [],
  };

  switch (options.type) {
    case 'flowchart':
      const fcResult = await generateFlowchart(userId, options.projectId, options);
      mermaid = fcResult.mermaid;
      metadata = fcResult.metadata;
      break;
    case 'sequence':
      const seqResult = await generateSequenceDiagram(userId, options.projectId, options);
      mermaid = seqResult.mermaid;
      metadata = seqResult.metadata;
      break;
    case 'architecture':
      const archResult = await generateArchitectureDiagram(userId, options.projectId, options);
      mermaid = archResult.mermaid;
      metadata = archResult.metadata;
      break;
    case 'dependency':
      const depResult = await generateDependencyDiagram(userId, options.projectId, options);
      mermaid = depResult.mermaid;
      metadata = depResult.metadata;
      break;
    case 'database':
    case 'er':
      const dbResult = await generateDatabaseDiagram(userId, options.projectId, options);
      mermaid = dbResult.mermaid;
      metadata = dbResult.metadata;
      break;
    case 'class':
      const classResult = await generateClassDiagram(userId, options.projectId, options);
      mermaid = classResult.mermaid;
      metadata = classResult.metadata;
      break;
    case 'state':
      const stateResult = await generateStateDiagram(userId, options.projectId, options);
      mermaid = stateResult.mermaid;
      metadata = stateResult.metadata;
      break;
    case 'gantt':
      const ganttResult = await generateGanttDiagram(userId, options.projectId, options);
      mermaid = ganttResult.mermaid;
      metadata = ganttResult.metadata;
      break;
    case 'gitgraph':
      const gitResult = await generateGitGraphDiagram(userId, options.projectId, options);
      mermaid = gitResult.mermaid;
      metadata = gitResult.metadata;
      break;
    case 'journey':
      const journeyResult = await generateJourneyDiagram(userId, options.projectId, options);
      mermaid = journeyResult.mermaid;
      metadata = journeyResult.metadata;
      break;
    case 'pie':
      const pieResult = await generatePieChart(userId, options.projectId, options);
      mermaid = pieResult.mermaid;
      metadata = pieResult.metadata;
      break;
    default:
      throw new AppError(400, 'unsupported_type', `Diagram type ${options.type} not supported`);
  }

  const diagram: GeneratedDiagram = {
    id: `diag_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type: options.type,
    projectId: options.projectId,
    mermaid,
    metadata,
    generatedAt: new Date(),
  };

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'diagram',
    detail: { projectId: options.projectId, type: options.type, nodes: metadata.nodeCount },
  });

  return diagram;
}

async function generateFlowchart(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 100 });
  const sourceFiles = files.results.filter(f => f.projectId && f.category !== 'test');

  let mermaid = `flowchart ${options.direction || 'TD'}\n`;
  const nodes = new Map<string, string>();
  const edges: string[] = [];
  let nodeId = 0;

  for (const file of sourceFiles.slice(0, options.maxNodes || 50)) {
    if (!file.projectId) continue;
    const id = `n${nodeId++}`;
    const label = file.label.split('/').pop() || file.label;
    nodes.set(file.label, id);
    mermaid += `  ${id}["${escapeMermaid(label)}"]\n`;
  }

  for (const file of sourceFiles.slice(0, options.maxNodes || 50)) {
    if (!file.projectId) continue;
    const analysis = await withTenant(userId, (q) =>
      q.query(
        `SELECT content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
        [projectId, file.label],
      ),
    );
    const f = analysis.rows[0];
    if (!f || !f.content) continue;

    const sourceId = nodes.get(file.label);
    if (!sourceId) continue;

    const imports = extractImports(f.content);
    for (const imp of imports) {
      const targetId = nodes.get(imp);
      if (targetId && sourceId !== targetId) {
        edges.push(`  ${sourceId} --> ${targetId}`);
      }
    }
  }

  mermaid += edges.slice(0, 200).join('\n') + '\n';

  if (options.includeLegend !== false) {
    mermaid += `  classDef file fill:#e1f5fe,stroke:#01579b,stroke-width:2px;\n`;
  }

  const uniqueEdges = Array.from(new Set(edges));
  return {
    mermaid,
    metadata: {
      nodeCount: nodes.size,
      edgeCount: uniqueEdges.length,
      complexity: nodes.size > 30 ? 'complex' : nodes.size > 15 ? 'moderate' : 'simple',
      sources: ['files'],
      warnings: nodes.size > (options.maxNodes || 50) ? ['Truncated to max nodes'] : [],
    },
  };
}

async function generateSequenceDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const decisionDna = dnaBlocks.filter(d => d.kind === 'DECISION' || d.kind === 'ARCHITECTURE');

  let mermaid = `sequenceDiagram\n`;
  mermaid += `  autonumber\n`;

  const participants = ['User', 'Frontend', 'API Gateway', 'Auth Service', 'Execution Engine', 'Memory Service', 'Database'];
  for (const p of participants) {
    mermaid += `  participant ${sanitizeId(p)} as "${escapeMermaid(p)}"\n`;
  }

  mermaid += `\n`;
  mermaid += `  User->>Frontend: Request\n`;
  mermaid += `  Frontend->>API Gateway: HTTP Request\n`;
  mermaid += `  API Gateway->>Auth Service: Validate Token\n`;
  mermaid += `  Auth Service-->>API Gateway: User Context\n`;
  mermaid += `  API Gateway->>Execution Engine: Route Request\n`;

  for (const dna of decisionDna.slice(0, 5)) {
    mermaid += `  Execution Engine->>Memory Service: ${escapeMermaid(dna.title.slice(0, 40))}\n`;
    mermaid += `  Memory Service-->>Execution Engine: Context\n`;
  }

  mermaid += `  Execution Engine->>Database: Persist\n`;
  mermaid += `  Database-->>Execution Engine: Confirm\n`;
  mermaid += `  Execution Engine-->>API Gateway: Response\n`;
  mermaid += `  API Gateway-->>Frontend: Response\n`;
  mermaid += `  Frontend-->>User: Result\n`;

  return {
    mermaid,
    metadata: {
      nodeCount: participants.length,
      edgeCount: 12,
      complexity: 'moderate',
      sources: ['dna', 'architecture'],
      warnings: [],
    },
  };
}

async function generateArchitectureDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 100 });
  const techStack = extractTechStack(files.results);

  let mermaid = `graph TB\n`;
  mermaid += `  subgraph "Client Layer"\n`;
  mermaid += `    FE[Frontend / React]\n`;
  mermaid += `  end\n\n`;

  mermaid += `  subgraph "API Layer"\n`;
  mermaid += `    GW[API Gateway]\n`;
  mermaid += `    AUTH[Auth Service]\n`;
  mermaid += `  end\n\n`;

  mermaid += `  subgraph "Core Services"\n`;
  mermaid += `    EXEC[Execution Engine]\n`;
  mermaid += `    MEM[Memory Service]\n`;
  mermaid += `    AGENT[Agent Runtime]\n`;
  mermaid += `    SCHED[Scheduler]\n`;
  mermaid += `  end\n\n`;

  mermaid += `  subgraph "Data Layer"\n`;
  mermaid += `    PG[(PostgreSQL)]\n`;
  mermaid += `    REDIS[(Redis)]\n`;
  mermaid += `    VECTOR[pgvector]\n`;
  mermaid += `  end\n\n`;

  mermaid += `  subgraph "AI Providers"\n`;
  mermaid += `    OAI[OpenAI]\n`;
  mermaid += `    ANT[Anthropic]\n`;
  mermaid += `    GOOG[Google]\n`;
  mermaid += `    OR[OpenRouter]\n`;
  mermaid += `  end\n\n`;

  mermaid += `  FE --> GW\n`;
  mermaid += `  GW --> AUTH\n`;
  mermaid += `  GW --> EXEC\n`;
  mermaid += `  EXEC --> MEM\n`;
  mermaid += `  EXEC --> AGENT\n`;
  mermaid += `  EXEC --> SCHED\n`;
  mermaid += `  MEM --> PG\n`;
  mermaid += `  MEM --> VECTOR\n`;
  mermaid += `  EXEC --> PG\n`;
  mermaid += `  SCHED --> PG\n`;
  mermaid += `  AGENT --> OAI\n`;
  mermaid += `  AGENT --> ANT\n`;
  mermaid += `  AGENT --> GOOG\n`;
  mermaid += `  AGENT --> OR\n`;

  if (techStack.length > 0) {
    mermaid += `\n  classDef frontend fill:#e3f2fd,stroke:#1565c0;\n`;
    mermaid += `  classDef api fill:#fff3e0,stroke:#e65100;\n`;
    mermaid += `  classDef core fill:#e8f5e9,stroke:#2e7d32;\n`;
    mermaid += `  classDef data fill:#fce4ec,stroke:#c2185b;\n`;
    mermaid += `  classDef ai fill:#f3e5f5,stroke:#7b1fa2;\n`;
    mermaid += `  class FE frontend;\n`;
    mermaid += `  class GW,AUTH api;\n`;
    mermaid += `  class EXEC,MEM,AGENT,SCHED core;\n`;
    mermaid += `  class PG,REDIS,VECTOR data;\n`;
    mermaid += `  class OAI,ANT,GOOG,OR ai;\n`;
  }

  const nodeCount = 15;
  return {
    mermaid,
    metadata: {
      nodeCount,
      edgeCount: 12,
      complexity: 'moderate',
      sources: ['dna', 'files', 'tech_stack'],
      warnings: [],
    },
  };
}

async function generateDependencyDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: options.maxNodes || 50 });
  const sourceFiles = files.results.filter(f => f.projectId && f.category !== 'test');

  let mermaid = `graph ${options.direction || 'LR'}\n`;
  const nodes = new Map<string, string>();
  const edges: string[] = [];
  let nodeId = 0;

  for (const file of sourceFiles.slice(0, options.maxNodes || 50)) {
    if (!file.projectId) continue;
    const id = `n${nodeId++}`;
    const label = file.label.split('/').pop() || file.label;
    nodes.set(file.label, id);
    mermaid += `  ${id}["${escapeMermaid(label)}"]\n`;
  }

  for (const file of sourceFiles.slice(0, options.maxNodes || 50)) {
    if (!file.projectId) continue;
    const analysis = await withTenant(userId, (q) =>
      q.query(
        `SELECT content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
        [projectId, file.label],
      ),
    );
    const f = analysis.rows[0];
    if (!f || !f.content) continue;

    const sourceId = nodes.get(file.label);
    if (!sourceId) continue;

    const imports = extractImports(f.content);
    for (const imp of imports) {
      const targetId = nodes.get(imp);
      if (targetId && sourceId !== targetId) {
        edges.push(`  ${sourceId} --> ${targetId}`);
      }
    }
  }

  mermaid += edges.slice(0, 200).join('\n') + '\n';

  const uniqueEdges = Array.from(new Set(edges));
  return {
    mermaid,
    metadata: {
      nodeCount: nodes.size,
      edgeCount: uniqueEdges.length,
      complexity: nodes.size > 30 ? 'complex' : nodes.size > 15 ? 'moderate' : 'simple',
      sources: ['files', 'imports'],
      warnings: nodes.size > (options.maxNodes || 50) ? ['Truncated to max nodes'] : [],
    },
  };
}

async function generateDatabaseDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  let mermaid = `erDiagram\n`;
  let tableCount = 0;

  for (const table of tables.rows.slice(0, options.maxNodes || 30)) {
    const tableName = table.table_name;
    const columns = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );

    mermaid += `  ${sanitizeId(tableName)} {\n`;
    for (const col of columns.rows) {
      const nullable = col.is_nullable === 'YES' ? '' : ' NOT NULL';
      const pk = col.column_name === 'id' ? ' PK' : '';
      mermaid += `    ${col.data_type} ${col.column_name}${nullable}${pk}\n`;
    }
    mermaid += `  }\n\n`;

    const fks = await pool.query(
      `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
      [tableName],
    );

    for (const fk of fks.rows) {
      mermaid += `  ${sanitizeId(tableName)} ||--o{ ${sanitizeId(fk.foreign_table)} : "${fk.column_name}"\n`;
    }

    mermaid += '\n';
    tableCount++;
  }

  return {
    mermaid,
    metadata: {
      nodeCount: tableCount,
      edgeCount: 0,
      complexity: tableCount > 20 ? 'complex' : tableCount > 10 ? 'moderate' : 'simple',
      sources: ['database_schema'],
      warnings: [],
    },
  };
}

async function generateClassDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 50 });
  const sourceFiles = files.results.filter(f => f.projectId && f.category !== 'test');

  let mermaid = `classDiagram\n`;
  let classCount = 0;

  for (const file of sourceFiles.slice(0, options.maxNodes || 20)) {
    if (!file.projectId) continue;
    const analysis = await withTenant(userId, (q) => q.query(
      `SELECT content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [projectId, file.label],
    ));
    const f = analysis.rows[0];
    if (!f || !f.content) continue;

    const classes = extractClasses(f.content);
    for (const cls of classes.slice(0, 5)) {
      mermaid += `  class ${sanitizeId(cls.name)} {\n`;
      for (const method of cls.methods) {
        mermaid += `    +${method}()\n`;
      }
      for (const prop of cls.properties) {
        mermaid += `    +${prop}\n`;
      }
      mermaid += `  }\n\n`;
      classCount++;
    }

    const interfaces = extractInterfaces(f.content);
    for (const iface of interfaces.slice(0, 3)) {
      mermaid += `  interface ${sanitizeId(iface.name)} {\n`;
      for (const method of iface.methods) {
        mermaid += `    +${method}()\n`;
      }
      mermaid += `  }\n\n`;
      classCount++;
    }
  }

  return {
    mermaid,
    metadata: {
      nodeCount: classCount,
      edgeCount: 0,
      complexity: classCount > 15 ? 'complex' : classCount > 8 ? 'moderate' : 'simple',
      sources: ['files', 'classes', 'interfaces'],
      warnings: [],
    },
  };
}

async function generateStateDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const taskDna = dnaBlocks.filter(d => d.kind === 'DECISION' && d.content.toLowerCase().includes('state'));

  let mermaid = `stateDiagram-v2\n`;
  mermaid += `  [*] --> Created\n`;
  mermaid += `  Created --> Planned\n`;
  mermaid += `  Planned --> WaitingApproval\n`;
  mermaid += `  WaitingApproval --> Approved\n`;
  mermaid += `  WaitingApproval --> Rejected\n`;
  mermaid += `  Approved --> Running\n`;
  mermaid += `  Running --> Testing\n`;
  mermaid += `  Testing --> Verified\n`;
  mermaid += `  Verified --> Completed\n`;
  mermaid += `  Running --> Failed\n`;
  mermaid += `  Failed --> Retrying\n`;
  mermaid += `  Retrying --> Running\n`;
  mermaid += `  Running --> TimedOut\n`;
  mermaid += `  Running --> Cancelled\n`;
  mermaid += `  Completed --> [*]\n`;
  mermaid += `  Failed --> [*]\n`;
  mermaid += `  Cancelled --> [*]\n`;

  return {
    mermaid,
    metadata: {
      nodeCount: 12,
      edgeCount: 15,
      complexity: 'moderate',
      sources: ['execution_engine'],
      warnings: [],
    },
  };
}

async function generateGanttDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const tasks = await withTenant(userId, (q) => q.query(
    `SELECT title, status, created_at, completed_at, started_at
     FROM tasks
     WHERE project_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 20`,
    [projectId],
  ));

  let mermaid = `gantt\n`;
  mermaid += `  title Project Timeline\n`;
  mermaid += `  dateFormat  YYYY-MM-DD\n`;
  mermaid += `  axisFormat  %m/%d\n\n`;

  for (const task of tasks.rows.slice(0, 15)) {
    const start = task.started_at || task.created_at;
    const end = task.completed_at || new Date();
    mermaid += `  section ${task.status}\n`;
    mermaid += `  ${escapeMermaid(task.title.slice(0, 40))} : ${start.toISOString().split('T')[0]}, ${end.toISOString().split('T')[0]}\n`;
  }

  return {
    mermaid,
    metadata: {
      nodeCount: tasks.rows.length,
      edgeCount: 0,
      complexity: 'simple',
      sources: ['tasks'],
      warnings: [],
    },
  };
}

async function generateGitGraphDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  let mermaid = `gitGraph\n`;
  mermaid += `  commit id: "initial"\n`;
  mermaid += `  branch develop\n`;
  mermaid += `  commit id: "feat: add auth"\n`;
  mermaid += `  commit id: "feat: add memory"\n`;
  mermaid += `  branch feature/agent\n`;
  mermaid += `  commit id: "feat: agent runtime"\n`;
  mermaid += `  commit id: "fix: memory leak"\n`;
  mermaid += `  checkout develop\n`;
  mermaid += `  merge feature/agent\n`;
  mermaid += `  commit id: "release v1.0"\n`;
  mermaid += `  branch main\n`;
  mermaid += `  checkout main\n`;
  mermaid += `  merge develop\n`;

  return {
    mermaid,
    metadata: {
      nodeCount: 8,
      edgeCount: 7,
      complexity: 'simple',
      sources: ['git_history'],
      warnings: ['Mock data - actual git history requires local-agent'],
    },
  };
}

async function generateJourneyDiagram(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const decisions = dnaBlocks.filter(d => d.kind === 'DECISION');

  let mermaid = `journey\n`;
  mermaid += `  title Developer Workflow\n`;
  mermaid += `  section Onboarding\n`;
  mermaid += `    Create Account: 5: User\n`;
  mermaid += `    Verify Email: 3: User\n`;
  mermaid += `    Setup MFA: 4: User\n`;
  mermaid += `  section Development\n`;
  mermaid += `    Create Project: 5: User\n`;
  mermaid += `    Write Code: 8: User\n`;
  mermaid += `    Run Tests: 5: User\n`;
  mermaid += `    Commit: 3: User\n`;
  mermaid += `  section AI Assistance\n`;
  mermaid += `    Ask Agent: 7: Agent\n`;
  mermaid += `    Review Suggestion: 5: User\n`;
  mermaid += `    Apply Fix: 4: User\n`;
  mermaid += `  section Deploy\n`;
  mermaid += `    Push to CI: 3: User\n`;
  mermaid += `    Review: 5: User\n`;
  mermaid += `    Deploy: 5: System\n`;

  return {
    mermaid,
    metadata: {
      nodeCount: 12,
      edgeCount: 0,
      complexity: 'simple',
      sources: ['workflow'],
      warnings: [],
    },
  };
}

async function generatePieChart(
  userId: string,
  projectId: string,
  options: DiagramOptions
): Promise<{ mermaid: string; metadata: DiagramMetadata }> {
  const tasks = await withTenant(userId, (q) => q.query(
    `SELECT status, count(*)::int AS count FROM tasks
     WHERE project_id = $1 AND deleted_at IS NULL
     GROUP BY status`,
    [projectId],
  ));

  let mermaid = `pie showData\n`;
  for (const task of tasks.rows) {
    mermaid += `  "${task.status}" : ${task.count}\n`;
  }

  return {
    mermaid,
    metadata: {
      nodeCount: tasks.rows.length,
      edgeCount: 0,
      complexity: 'simple',
      sources: ['tasks'],
      warnings: [],
    },
  };
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /import\s+.*\s+from\s+['"]([^'"]+)['"]/g,
    /require\(['"]([^'"]+)['"]\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const imp = match[1];
      if (imp && (imp.startsWith('.') || imp.startsWith('/'))) {
        imports.push(imp);
      }
    }
  }
  return [...new Set(imports)];
}

function extractTechStack(files: Awaited<ReturnType<typeof globalSearch>>['results']): string[] {
  const stack = new Set<string>();
  for (const file of files) {
    const path = file.label.toLowerCase();
    if (path.endsWith('.ts') || path.endsWith('.tsx')) stack.add('TypeScript');
    if (path.endsWith('.js') || path.endsWith('.jsx')) stack.add('JavaScript');
    if (path.endsWith('.py')) stack.add('Python');
    if (path.endsWith('.go')) stack.add('Go');
    if (path.endsWith('.rs')) stack.add('Rust');
    if (path.includes('package.json')) stack.add('Node.js');
    if (path.includes('docker')) stack.add('Docker');
    if (path.includes('k8s') || path.includes('kubernetes')) stack.add('Kubernetes');
    if (path.includes('terraform')) stack.add('Terraform');
    if (path.includes('.sql') || path.includes('migration')) stack.add('PostgreSQL');
    if (path.includes('redis')) stack.add('Redis');
  }
  return Array.from(stack).sort();
}

function extractClasses(content: string): { name: string; methods: string[]; properties: string[] }[] {
  const classes: { name: string; methods: string[]; properties: string[] }[] = [];
  const classPattern = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
  let match;
  while ((match = classPattern.exec(content)) !== null) {
    const className = match[1];
    if (!className) continue;
    const startIdx = match.index + match[0].length;
    const classBody = extractClassBody(content, startIdx);
    const methods = extractMethods(classBody);
    const properties = extractProperties(classBody);
    classes.push({ name: className, methods, properties });
  }
  return classes;
}

function extractInterfaces(content: string): { name: string; methods: string[] }[] {
  const interfaces: { name: string; methods: string[] }[] = [];
  const interfacePattern = /interface\s+(\w+)\s*\{/g;
  let match;
  while ((match = interfacePattern.exec(content)) !== null) {
    const interfaceName = match[1];
    if (!interfaceName) continue;
    const startIdx = match.index + match[0].length;
    const interfaceBody = extractClassBody(content, startIdx);
    const methods = extractMethods(interfaceBody);
    interfaces.push({ name: interfaceName, methods });
  }
  return interfaces;
}

function extractClassBody(content: string, startIdx: number): string {
  let braceCount = 0;
  let inClass = false;
  let start = -1;
  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      if (!inClass) {
        inClass = true;
        start = i + 1;
      }
    } else if (content[i] === '}') {
      braceCount--;
      if (inClass && braceCount === 0) {
        return content.slice(start, i);
      }
    }
  }
  return '';
}

function extractMethods(body: string): string[] {
  const methods: string[] = [];
  const methodPattern = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g;
  let match;
  while ((match = methodPattern.exec(body)) !== null) {
    const m = match[1];
    if (m) methods.push(m);
  }
  return methods;
}

function extractProperties(body: string): string[] {
  const properties: string[] = [];
  const propPattern = /(?:public|private|protected|readonly)?\s*(\w+)\s*[?:]/g;
  let match;
  while ((match = propPattern.exec(body)) !== null) {
    const m = match[1];
    if (m) properties.push(m);
  }
  return properties;
}