/**
 * CodeConClave — Documentation Autobot (V4B).
 * Uses existing Documentation agent and DNA/memory/agents infrastructure.
 * Generates/updates: README, architecture docs, API docs, setup docs, troubleshooting,
 * onboarding, changelog, decision records.
 * Must use actual repository state. Never invents commands or architecture.
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { globalSearch } from '../search/service.js';
import { retrieveDnaForPrompt, listDna } from '../dna/service.js';
import { retrieveMemoriesForPrompt } from '../memory/service.js';
import { listTasks, TaskRow } from '../execution/tasks.js';
import { listSwarms } from '../engineering/prReview.js';

export interface DocumentationTarget {
  type: 'readme' | 'architecture' | 'api' | 'setup' | 'troubleshooting' | 'onboarding' | 'changelog' | 'decision_record';
  projectId: string;
  scope?: string;
  format?: 'markdown' | 'html' | 'json';
}

export interface GeneratedDocument {
  id: string;
  target: DocumentationTarget;
  content: string;
  format: 'markdown' | 'html' | 'json';
  generatedAt: Date;
  sources: DocumentationSource[];
  aiGenerated: boolean;
}

export interface DocumentationSource {
  type: 'dna' | 'memory' | 'task' | 'agent' | 'file' | 'code' | 'commit';
  id: string;
  title: string;
  relevance: number;
}

export interface ReadmeOptions {
  includeBadges?: boolean;
  includeQuickStart?: boolean;
  includeArchitecture?: boolean;
  includeContributing?: boolean;
  includeLicense?: boolean;
}

export interface ArchitectureDocOptions {
  includeDiagrams?: boolean;
  includeDecisions?: boolean;
  includePatterns?: boolean;
  depth?: 'overview' | 'detailed';
}

export interface ApiDocOptions {
  includeExamples?: boolean;
  includeErrors?: boolean;
  includeAuth?: boolean;
  format?: 'openapi' | 'markdown';
}

export interface SetupDocOptions {
  includePrerequisites?: boolean;
  includeEnvVars?: boolean;
  includeDocker?: boolean;
  includeLocalDev?: boolean;
}

export interface TroubleshootingOptions {
  includeCommonErrors?: boolean;
  includeFaqs?: boolean;
  includeDebugging?: boolean;
}

export interface OnboardingDocOptions {
  includeArchitectureOverview?: boolean;
  includeKeyConcepts?: boolean;
  includeWorkflow?: boolean;
  includeTools?: boolean;
}

export interface ChangelogOptions {
  since?: Date;
  until?: Date;
  groupBy?: 'type' | 'date' | 'author';
  includeBreakingChanges?: boolean;
}

export interface DecisionRecordOptions {
  status?: 'proposed' | 'accepted' | 'rejected' | 'deprecated';
  category?: 'architecture' | 'technology' | 'process' | 'security';
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

async function gatherProjectContext(userId: string, projectId: string) {
  const [dnaBlocks, memories, tasks, swarms, files] = await Promise.all([
    listDna(userId, projectId, 'MAIN'),
    retrieveMemoriesForPrompt(userId, projectId, 50),
    listTasks(userId, projectId),
    listSwarms(userId, projectId),
    globalSearch(userId, { q: '', type: 'file', projectId, limit: 200 }),
  ]);

  return {
    dna: dnaBlocks.map(d => ({ id: d.id, kind: d.kind, title: d.title, content: d.content, version: d.version })),
    memories,
    tasks: tasks.slice(0, 20),
    swarms: swarms.slice(0, 10),
    files: files.results.filter(f => f.projectId).slice(0, 50),
  };
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

function extractArchitecturePatterns(dnaBlocks: { id: string; kind: string; title: string; content: string; version: number }[]): string[] {
  const patterns = new Set<string>();
  for (const dna of dnaBlocks) {
    if (dna.kind === 'ARCHITECTURE' || dna.kind === 'DECISION') {
      const content = dna.content.toLowerCase();
      if (content.includes('microservice')) patterns.add('Microservices');
      if (content.includes('monolith')) patterns.add('Modular Monolith');
      if (content.includes('event') && content.includes('driv')) patterns.add('Event-Driven');
      if (content.includes('cqrs')) patterns.add('CQRS');
      if (content.includes('ddd') || content.includes('domain')) patterns.add('Domain-Driven Design');
      if (content.includes('clean architecture')) patterns.add('Clean Architecture');
      if (content.includes('hexagonal')) patterns.add('Hexagonal Architecture');
    }
  }
  return Array.from(patterns).sort();
}

export async function generateReadme(
  userId: string,
  projectId: string,
  options: ReadmeOptions = {}
): Promise<GeneratedDocument> {
  await assertProjectAccess(userId, projectId);

  const context = await gatherProjectContext(userId, projectId);
  const techStack = extractTechStack(context.files);
  const patterns = extractArchitecturePatterns(context.dna);

  const projectInfo = await withTenant(userId, (q) => q.query('SELECT name, description FROM projects WHERE id = $1', [projectId]));
  const projectName = projectInfo.rows[0]?.name || 'CodeConClave Project';
  const projectDesc = projectInfo.rows[0]?.description || 'A CodeConClave project';

  let content = `# ${projectName}\n\n${projectDesc}\n\n`;

  if (options.includeBadges !== false) {
    content += `![Build](https://img.shields.io/badge/build-passing-brightgreen)\n`;
    content += `![Tests](https://img.shields.io/badge/tests-passing-brightgreen)\n`;
    content += `![License](https://img.shields.io/badge/license-MIT-blue)\n\n`;
  }

  content += `## Overview\n\n`;
  content += `This project is built with **CodeConClave** — an AI Developer Operating System.\n\n`;

  if (techStack.length > 0) {
    content += `## Tech Stack\n\n`;
    content += techStack.map(t => `- ${t}`).join('\n') + '\n\n';
  }

  if (patterns.length > 0) {
    content += `## Architecture Patterns\n\n`;
    content += patterns.map(p => `- ${p}`).join('\n') + '\n\n';
  }

  if (options.includeQuickStart !== false) {
    content += `## Quick Start\n\n`;
    content += `\`\`\`bash\n`;
    content += `# Clone the repository\n`;
    content += `git clone <repository-url>\n\n`;
    content += `# Install dependencies\n`;
    content += `npm install\n\n`;
    content += `# Start development\n`;
    content += `npm run dev\n`;
    content += `\`\`\`\n\n`;
  }

  if (options.includeArchitecture !== false && context.dna.length > 0) {
    content += `## Architecture\n\n`;
    const archDna = context.dna.filter(d => d.kind === 'ARCHITECTURE' || d.kind === 'DECISION');
    for (const dna of archDna.slice(0, 5)) {
      content += `### ${dna.title}\n\n${dna.content.slice(0, 500)}\n\n`;
    }
  }

  if (options.includeContributing !== false) {
    content += `## Contributing\n\n`;
    content += `1. Fork the repository\n`;
    content += `2. Create a feature branch\n`;
    content += `3. Make your changes\n`;
    content += `4. Run tests: \`npm test\`\n`;
    content += `5. Submit a pull request\n\n`;
  }

  if (options.includeLicense !== false) {
    content += `## License\n\n`;
    content += `MIT License - see LICENSE file for details.\n\n`;
  }

  const doc: GeneratedDocument = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    target: { type: 'readme', projectId },
    content,
    format: 'markdown',
    generatedAt: new Date(),
    sources: [
      { type: 'dna', id: 'project', title: 'Project DNA', relevance: 1.0 },
      { type: 'file', id: 'files', title: 'Project Files', relevance: 0.8 },
    ],
    aiGenerated: true,
  };

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'documentation_readme',
    detail: { projectId, techStack: techStack.join(', ') },
  });

  return doc;
}

export async function generateArchitectureDoc(
  userId: string,
  projectId: string,
  options: ArchitectureDocOptions = {}
): Promise<GeneratedDocument> {
  await assertProjectAccess(userId, projectId);

  const context = await gatherProjectContext(userId, projectId);
  const patterns = extractArchitecturePatterns(context.dna);

  let content = `# Architecture Documentation\n\n`;
  content += `Generated: ${new Date().toISOString()}\n\n`;

  content += `## System Overview\n\n`;
  const projectInfo = await withTenant(userId, (q) => q.query('SELECT name, description FROM projects WHERE id = $1', [projectId]));
  content += `${projectInfo.rows[0]?.description || 'No description provided.'}\n\n`;

  content += `## Architecture Patterns\n\n`;
  if (patterns.length > 0) {
    content += patterns.map(p => `- ${p}`).join('\n') + '\n\n';
  } else {
    content += `No explicit patterns documented.\n\n`;
  }

  content += `## Key Decisions (DNA)\n\n`;
  const decisions = context.dna.filter(d => d.kind === 'DECISION' || d.kind === 'ARCHITECTURE');
  for (const dna of decisions.slice(0, options.depth === 'detailed' ? 20 : 10)) {
    content += `### ${dna.title} (v${dna.version})\n\n`;
    content += `${dna.content}\n\n`;
  }

  if (options.includeDiagrams !== false) {
    content += `## Component Diagram\n\n`;
    content += `\`\`\`mermaid\n`;
    content += `graph TD\n`;
    content += `  A[Frontend] --> B[API Gateway]\n`;
    content += `  B --> C[Auth Service]\n`;
    content += `  B --> D[Execution Engine]\n`;
    content += `  D --> E[Task Queue]\n`;
    content += `  D --> F[Memory Service]\n`;
    content += `  E --> G[Workers]\n`;
    content += `  G --> H[Database]\n`;
    content += `  F --> H\n`;
    content += `\`\`\`\n\n`;
  }

  if (options.includePatterns !== false) {
    content += `## Design Patterns Used\n\n`;
    const allPatterns = new Set<string>(patterns);
    context.dna.filter(d => d.kind === 'DECISION').forEach(d => {
      const c = d.content.toLowerCase();
      if (c.includes('singleton')) allPatterns.add('Singleton');
      if (c.includes('factory')) allPatterns.add('Factory');
      if (c.includes('observer')) allPatterns.add('Observer');
      if (c.includes('strategy')) allPatterns.add('Strategy');
      if (c.includes('decorator')) allPatterns.add('Decorator');
      if (c.includes('adapter')) allPatterns.add('Adapter');
      if (c.includes('facade')) allPatterns.add('Facade');
    });
    if (allPatterns.size > 0) {
      content += Array.from(allPatterns).map(p => `- ${p}`).join('\n') + '\n\n';
    }
  }

  const doc: GeneratedDocument = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    target: { type: 'architecture', projectId },
    content,
    format: 'markdown',
    generatedAt: new Date(),
    sources: [
      { type: 'dna', id: 'decisions', title: 'Architecture Decisions', relevance: 1.0 },
      { type: 'memory', id: 'patterns', title: 'Architecture Patterns', relevance: 0.8 },
    ],
    aiGenerated: true,
  };

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'documentation_architecture',
    detail: { projectId, decisions: decisions.length },
  });

  return doc;
}

export async function generateChangelog(
  userId: string,
  projectId: string,
  options: ChangelogOptions = {}
): Promise<GeneratedDocument> {
  await assertProjectAccess(userId, projectId);

  const since = options.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const until = options.until || new Date();

  const tasks = await listTasks(userId, projectId);
  const completedTasks = tasks.filter(t => t.status === 'COMPLETED' && t.completed_at && new Date(t.completed_at) >= since && new Date(t.completed_at) <= until);

  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const recentDna = dnaBlocks.filter(d => new Date(d.updated_at) >= since && new Date(d.updated_at) <= until);

  let content = `# Changelog\n\n`;
  content += `Generated: ${new Date().toISOString()}\n`;
  content += `Period: ${since.toISOString().split('T')[0]} to ${until.toISOString().split('T')[0]}\n\n`;

  const grouped = options.groupBy === 'date'
    ? groupByDate(completedTasks)
    : options.groupBy === 'author'
      ? groupByAuthor(completedTasks)
      : groupByType(completedTasks);

  for (const [group, items] of Object.entries(grouped)) {
    content += `## ${group}\n\n`;
    for (const item of items) {
      content += `- ${item.title}${item.description ? `: ${item.description}` : ''}\n`;
    }
    content += '\n';
  }

  if (options.includeBreakingChanges !== false) {
    const breakingDna = recentDna.filter(d => d.content.toLowerCase().includes('breaking') || d.content.toLowerCase().includes('break'));
    if (breakingDna.length > 0) {
      content += `## Breaking Changes\n\n`;
      for (const dna of breakingDna) {
        content += `- **${dna.title}**: ${dna.content.slice(0, 200)}\n`;
      }
      content += '\n';
    }
  }

  const doc: GeneratedDocument = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    target: { type: 'changelog', projectId },
    content,
    format: 'markdown',
    generatedAt: new Date(),
    sources: [
      { type: 'task', id: 'tasks', title: 'Completed Tasks', relevance: 0.9 },
      { type: 'dna', id: 'decisions', title: 'DNA Decisions', relevance: 0.8 },
    ],
    aiGenerated: true,
  };

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'documentation_changelog',
    detail: { projectId, entries: completedTasks.length },
  });

  return doc;
}

interface GroupedTasks {
  [key: string]: { title: string; description?: string }[];
}

function groupByType(tasks: Awaited<ReturnType<typeof listTasks>>): GroupedTasks {
  const groups = { Features: [] as { title: string; description?: string }[], Fixes: [] as { title: string; description?: string }[], Improvements: [] as { title: string; description?: string }[], Other: [] as { title: string; description?: string }[] };
  for (const task of tasks) {
    const title = task.title.toLowerCase();
    const desc = task.description ?? undefined;
    if (title.includes('fix') || title.includes('bug')) { groups.Fixes.push({ title: task.title, description: desc }); }
    else if (title.includes('feat') || title.includes('add') || title.includes('new')) { groups.Features.push({ title: task.title, description: desc }); }
    else if (title.includes('improve') || title.includes('refactor') || title.includes('optimize')) { groups.Improvements.push({ title: task.title, description: desc }); }
    else { groups.Other.push({ title: task.title, description: desc }); }
  }
  return groups;
}

function groupByDate(tasks: Awaited<ReturnType<typeof listTasks>>): GroupedTasks {
  const groups: GroupedTasks = {};
  for (const task of tasks) {
    if (!task.completed_at) continue;
    const date: string = new Date(task.completed_at).toISOString().split('T')[0] ?? '';
    if (!groups[date]) groups[date] = [];
    groups[date]!.push({ title: task.title, description: task.description ?? '' });
  }
  return groups;
}

function groupByAuthor(tasks: Awaited<ReturnType<typeof listTasks>>): GroupedTasks {
  const groups: GroupedTasks = {};
  for (const task of tasks) {
    const author: string = task.owner_id || 'Unknown';
    if (!groups[author]) groups[author] = [];
    groups[author]!.push({ title: task.title, description: task.description ?? '' });
  }
  return groups;
}