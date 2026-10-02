/**
 * CodeConClave — Architecture Oracle (V4A).
 * Uses existing Project DNA, memory, search, and dependency graph.
 * Never fabricates dependencies — only evidence-backed analysis.
 */
import { pool, queryMany, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { listDna, retrieveDnaForPrompt } from '../dna/service.js';
import { semanticSearch, retrieveMemoriesForPrompt } from '../memory/service.js';
import { globalSearch } from '../search/service.js';
import { logger } from '../../shared/logger.js';

export interface ArchitectureSummary {
  projectId: string;
  summary: string;
  totalDnaBlocks: number;
  memoryCount: number;
  keyDecisions: DnaSummary[];
  riskAreas: string[];
}

export interface DnaSummary {
  id: string;
  kind: string;
  title: string;
  version: number;
  conflictState: string;
  updatedAt: Date;
}

export interface DependencyGraph {
  projectId: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  circularDependencies: string[][];
}

export interface DependencyNode {
  id: string;
  label: string;
  type: 'module' | 'service' | 'api' | 'database' | 'external';
  metadata: Record<string, unknown>;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'imports' | 'calls' | 'depends_on' | 'data_flow';
  confidence: number;
  evidence: string;
}

export interface ImpactAnalysis {
  projectId: string;
  targetModule: string;
  impactedModules: ImpactedModule[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendedActions: string[];
}

export interface ImpactedModule {
  id: string;
  name: string;
  impactType: 'breaking' | 'behavioral' | 'performance' | 'security';
  confidence: number;
  evidence: string;
}

export interface ArchitectureRisk {
  projectId: string;
  risks: RiskItem[];
  overallRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface RiskItem {
  id: string;
  category: 'circular_dependency' | 'missing_layer' | 'tight_coupling' | 'god_module' | 'data_inconsistency' | 'api_drift';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  affectedModules: string[];
  evidence: string;
  recommendation: string;
}

export interface ArchitectureChangeHistory {
  projectId: string;
  changes: ArchitectureChange[];
}

export interface ArchitectureChange {
  id: string;
  timestamp: Date;
  type: 'dna_created' | 'dna_updated' | 'dna_merged' | 'memory_correction' | 'dependency_change';
  actorId: string;
  description: string;
  affectedModules: string[];
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project');
}

function mapDnaKindToModuleType(kind: string): 'module' | 'service' | 'api' | 'database' | 'external' {
  switch (kind) {
    case 'DECISION':
    case 'PROJECT_CONTEXT':
      return 'module';
    case 'RELEVANT_FILES':
      return 'api';
    case 'ENVIRONMENT_STATE':
      return 'database';
    default:
      return 'module';
  }
}

export async function getArchitectureSummary(userId: string, projectId: string): Promise<ArchitectureSummary> {
  await assertProjectAccess(userId, projectId);

  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const memories = await retrieveMemoriesForPrompt(userId, projectId, 20);
  const searchResults = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 100 });

  const keyDecisions: DnaSummary[] = dnaBlocks
    .filter(d => ['DECISION', 'PROJECT_CONTEXT', 'ENVIRONMENT_STATE'].includes(d.kind))
    .slice(0, 10)
    .map(d => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      version: d.version,
      conflictState: d.conflict_state,
      updatedAt: d.updated_at,
    }));

  const riskAreas: string[] = [];
  const conflictDna = dnaBlocks.filter(d => d.conflict_state === 'CONFLICT');
  if (conflictDna.length > 0) {
    riskAreas.push(`${conflictDna.length} DNA blocks in CONFLICT state`);
  }

  const summary = `Project has ${dnaBlocks.length} DNA blocks (${keyDecisions.length} key decisions), ${searchResults.total} files indexed. ${riskAreas.length > 0 ? 'RISKS: ' + riskAreas.join('; ') : 'No critical risks detected.'}`;

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'architecture_summary',
    detail: { projectId, dnaCount: dnaBlocks.length, fileCount: searchResults.total },
  });

  return {
    projectId,
    summary,
    totalDnaBlocks: dnaBlocks.length,
    memoryCount: memories.length,
    keyDecisions,
    riskAreas,
  };
}

export async function getDependencyGraph(userId: string, projectId: string): Promise<DependencyGraph> {
  await assertProjectAccess(userId, projectId);

  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const fileSearch = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 200 });

  const nodes: DependencyNode[] = [];
  const edges: DependencyEdge[] = [];
  const moduleMap = new Map<string, DependencyNode>();

  for (const file of fileSearch.results) {
    if (!file.projectId || file.category === 'test') continue;
    const path = file.label;
    const parts = path.split('/');
    const moduleName = parts[parts.length - 2] ?? parts[0] ?? '';
    const nodeId = `module:${moduleName}`;

    if (!moduleMap.has(nodeId)) {
      moduleMap.set(nodeId, {
        id: nodeId,
        label: moduleName,
        type: mapFileToModuleType(path),
        metadata: { path, fileCount: 1 },
      });
    } else {
      const existing = moduleMap.get(nodeId)!;
      existing.metadata.fileCount = (existing.metadata.fileCount as number) + 1;
    }
  }

  nodes.push(...moduleMap.values());

  const dnaEdges = await extractDependenciesFromDna(userId, projectId, nodes, moduleMap);
  edges.push(...dnaEdges);

  const circularDependencies = detectCircularDependencies(nodes, edges);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'dependency_graph',
    detail: { projectId, nodeCount: nodes.length, edgeCount: edges.length, circularCount: circularDependencies.length },
  });

  return { projectId, nodes, edges, circularDependencies };
}

function mapFileToModuleType(path: string): 'module' | 'service' | 'api' | 'database' | 'external' {
  if (path.includes('/api/') || path.includes('/routes/') || path.includes('/controllers/')) return 'api';
  if (path.includes('/services/') || path.includes('/service/')) return 'service';
  if (path.includes('/models/') || path.includes('/db/') || path.includes('/database/') || path.includes('/migrations/')) return 'database';
  if (path.includes('/external/') || path.includes('/integrations/')) return 'external';
  return 'module';
}

async function extractDependenciesFromDna(
  userId: string,
  projectId: string,
  nodes: DependencyNode[],
  moduleMap: Map<string, DependencyNode>
): Promise<DependencyEdge[]> {
  const edges: DependencyEdge[] = [];

  const memories = await retrieveMemoriesForPrompt(userId, projectId, 30);
  for (const mem of memories) {
    if (mem.includes('import') || mem.includes('depends') || mem.includes('calls')) {
      const parts = mem.match(/(?:import|depends|call)[^a-zA-Z0-9_]*([a-zA-Z0-9_/.-]+)/gi);
      if (parts) {
        for (const part of parts) {
          const match = part.match(/[a-zA-Z0-9_/.-]+/);
          if (match) {
            const target = match[0];
            const targetNodeId = `module:${target.split('/').pop()}`;
            if (moduleMap.has(targetNodeId)) {
              edges.push({
                from: 'unknown',
                to: targetNodeId,
                type: 'depends_on',
                confidence: 0.6,
                evidence: `Memory: ${mem.slice(0, 200)}`,
              });
            }
          }
        }
      }
    }
  }

  return edges;
}

function detectCircularDependencies(nodes: DependencyNode[], edges: DependencyEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const node of nodes) graph.set(node.id, []);
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from)!.push(edge.to);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const neighbors = graph.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recursionStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cycle = path.slice(cycleStart);
          if (cycle.length > 1 && !cycles.some(c => c.length === cycle.length && c.every((v, i) => v === cycle[i]))) {
            cycles.push([...cycle, neighbor]);
          }
        }
      }
    }

    recursionStack.delete(nodeId);
    path.pop();
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id);
    }
  }

  return cycles;
}

export async function analyzeImpact(userId: string, projectId: string, targetModule: string): Promise<ImpactAnalysis> {
  await assertProjectAccess(userId, projectId);

  const { nodes, edges } = await getDependencyGraph(userId, projectId);
  const targetNode = nodes.find(n => n.id === targetModule || n.label === targetModule);
  if (!targetNode) throw AppError.notFound('Target module');

  const impacted: ImpactedModule[] = [];
  const visited = new Set<string>();
  const queue = [targetNode.id];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const outgoingEdges = edges.filter(e => e.from === current);
    for (const edge of outgoingEdges) {
      const target = nodes.find(n => n.id === edge.to);
      if (target && !impacted.some(i => i.id === target.id)) {
        impacted.push({
          id: target.id,
          name: target.label,
          impactType: classifyImpact(edge.type, target.type),
          confidence: edge.confidence,
          evidence: edge.evidence,
        });
        queue.push(edge.to);
      }
    }
  }

  const riskLevel = calculateRiskLevel(impacted);
  const recommendedActions = generateRecommendations(impacted, riskLevel);

  return {
    projectId,
    targetModule: targetNode.label,
    impactedModules: impacted,
    riskLevel,
    recommendedActions,
  };
}

function classifyImpact(edgeType: string, targetType: string): 'breaking' | 'behavioral' | 'performance' | 'security' {
  if (edgeType === 'imports' && targetType === 'api') return 'breaking';
  if (edgeType === 'data_flow') return 'security';
  if (edgeType === 'calls') return 'behavioral';
  return 'performance';
}

function calculateRiskLevel(impacted: ImpactedModule[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const breakingCount = impacted.filter(i => i.impactType === 'breaking').length;
  const securityCount = impacted.filter(i => i.impactType === 'security').length;
  const highConfidence = impacted.filter(i => i.confidence > 0.7).length;

  if (breakingCount > 3 || securityCount > 0) return 'CRITICAL';
  if (breakingCount > 0 || highConfidence > 5) return 'HIGH';
  if (impacted.length > 10) return 'MEDIUM';
  return 'LOW';
}

function generateRecommendations(impacted: ImpactedModule[], riskLevel: string): string[] {
  const recs: string[] = [];
  if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
    recs.push('Run full test suite before deployment');
    recs.push('Consider phased rollout with canary');
    recs.push('Add integration tests for impacted modules');
  }
  if (impacted.some(i => i.impactType === 'breaking')) {
    recs.push('Review API contracts for breaking changes');
    recs.push('Coordinate with dependent team owners');
  }
  if (impacted.length > 10) {
    recs.push('Consider extracting shared interfaces to reduce coupling');
  }
  return recs;
}

export async function detectArchitectureRisks(userId: string, projectId: string): Promise<ArchitectureRisk> {
  await assertProjectAccess(userId, projectId);

  const { nodes, edges, circularDependencies } = await getDependencyGraph(userId, projectId);
  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  const risks: RiskItem[] = [];

  for (const cycle of circularDependencies) {
    risks.push({
      id: `circular_${cycle.join('_')}`,
      category: 'circular_dependency',
      severity: 'HIGH',
      description: `Circular dependency detected: ${cycle.join(' → ')}`,
      affectedModules: cycle,
      evidence: 'Dependency graph analysis',
      recommendation: 'Extract shared interfaces or introduce mediator pattern',
    });
  }

  const moduleEdgeCounts = new Map<string, number>();
  for (const edge of edges) {
    moduleEdgeCounts.set(edge.from, (moduleEdgeCounts.get(edge.from) || 0) + 1);
    moduleEdgeCounts.set(edge.to, (moduleEdgeCounts.get(edge.to) || 0) + 1);
  }

  for (const [moduleId, count] of moduleEdgeCounts) {
    if (count > 15) {
      risks.push({
        id: `god_module_${moduleId}`,
        category: 'god_module',
        severity: 'MEDIUM',
        description: `Module ${moduleId} has ${count} connections (potential god module)`,
        affectedModules: [moduleId],
        evidence: 'Dependency graph edge count analysis',
        recommendation: 'Consider splitting into smaller, focused modules',
      });
    }
  }

  const dnaKinds = new Set(dnaBlocks.map(d => d.kind));
  if (!dnaKinds.has('DECISION')) {
    risks.push({
      id: 'missing_decisions',
      category: 'missing_layer',
      severity: 'MEDIUM',
      description: 'No architecture DECISION DNA blocks found',
      affectedModules: ['architecture'],
      evidence: 'DNA kind distribution analysis',
      recommendation: 'Document key architectural decisions using DNA',
    });
  }

  const overallRisk = calculateOverallRisk(risks);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'architecture_risk',
    detail: { projectId, riskCount: risks.length, overallRisk },
  });

  return { projectId, risks, overallRiskLevel: overallRisk };
}

function calculateOverallRisk(risks: RiskItem[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (risks.some(r => r.severity === 'CRITICAL')) return 'CRITICAL';
  if (risks.some(r => r.severity === 'HIGH')) return 'HIGH';
  if (risks.some(r => r.severity === 'MEDIUM')) return 'MEDIUM';
  return 'LOW';
}

export async function getArchitectureChangeHistory(userId: string, projectId: string): Promise<ArchitectureChangeHistory> {
  await assertProjectAccess(userId, projectId);

  const changes: ArchitectureChange[] = [];

  const dnaBlocks = await listDna(userId, projectId, 'MAIN');
  for (const dna of dnaBlocks) {
    changes.push({
      id: dna.id,
      timestamp: dna.updated_at,
      type: dna.version > 1 ? 'dna_updated' : 'dna_created',
      actorId: dna.owner_id,
      description: `${dna.kind}: ${dna.title} (v${dna.version})`,
      affectedModules: [dna.kind.toLowerCase()],
    });
  }

  return { projectId, changes: changes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()) };
}