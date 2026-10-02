/**
 * CodeConClave — Context Flow Analyzer (V4A).
 * Variable flow, input → transformation → output, API data flow, service boundaries,
 * data ownership, origin tracing, destination tracing, suspicious loss/duplication.
 * Evidence-based only.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { globalSearch as searchFiles } from '../search/service.js';
import { logger } from '../../shared/logger.js';

export interface VariableFlow {
  projectId: string;
  variableName: string;
  flows: VariableFlowStep[];
  origin: FlowOrigin;
  destinations: FlowDestination[];
  transformations: Transformation[];
  issues: FlowIssue[];
}

export type VariableOperation = 'declaration' | 'assignment' | 'mutation' | 'pass' | 'return' | 'spread' | 'destructure';

export interface VariableFlowStep {
  filePath: string;
  line: number;
  operation: VariableOperation;
  beforeType?: string;
  afterType?: string;
  context: string;
}

export type OriginSource = 'parameter' | 'import' | 'literal' | 'function_call' | 'global' | 'env';

export interface FlowOrigin {
  filePath: string;
  line: number;
  source: OriginSource;
  description: string;
}

export type DestinationUsage = 'return' | 'render' | 'db_write' | 'api_response' | 'log' | 'state_update' | 'export';
export type TransformationType = 'map' | 'filter' | 'reduce' | 'parse' | 'validate' | 'serialize' | 'transform' | 'combine';

export interface FlowDestination {
  filePath: string;
  line: number;
  usage: DestinationUsage;
  description: string;
}

export interface Transformation {
  filePath: string;
  line: number;
  type: TransformationType;
  inputType?: string;
  outputType?: string;
  description: string;
}

export interface FlowIssue {
  type: 'potential_loss' | 'potential_duplication' | 'type_mismatch' | 'unvalidated_input' | 'sensitive_exposure' | 'unused_transformation';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  filePath: string;
  line: number;
  description: string;
  evidence: string;
}

export interface ApiDataFlow {
  projectId: string;
  endpoint: string;
  method: string;
  inputFlow: DataFlowPath;
  processingFlow: DataFlowStep[];
  outputFlow: DataFlowPath;
  boundaries: ServiceBoundary[];
  ownership: DataOwnership[];
  issues: DataFlowIssue[];
}

export interface DataFlowPath {
  source: string;
  transformations: string[];
  destination: string;
}

export interface DataFlowStep {
  filePath: string;
  function: string;
  line: number;
  operation: string;
  dataIn: string;
  dataOut: string;
  validation?: string;
}

export interface ServiceBoundary {
  service: string;
  boundaryType: 'api' | 'database' | 'external' | 'queue' | 'cache';
  direction: 'inbound' | 'outbound';
  dataTypes: string[];
  validationPresent: boolean;
}

export interface DataOwnership {
  entity: string;
  owner: string;
  accessPattern: 'read' | 'write' | 'read_write';
  enforcement: 'code' | 'policy' | 'none';
}

export interface DataFlowIssue {
  type: 'missing_validation' | 'boundary_violation' | 'ownership_unclear' | 'sensitive_leak' | 'data_loss' | 'duplication';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  location: string;
  description: string;
  evidence: string;
}

export interface ContextFlowResult {
  projectId: string;
  variableFlows: VariableFlow[];
  apiFlows: ApiDataFlow[];
  suspiciousPatterns: SuspiciousPattern[];
}

export interface SuspiciousPattern {
  type: 'data_loss' | 'data_duplication' | 'circular_flow' | 'unvalidated_boundary' | 'sensitive_exposure';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  locations: { filePath: string; line: number }[];
  evidence: string;
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ ok: string } | null>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function analyzeContextFlow(userId: string, projectId: string): Promise<ContextFlowResult> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const variableFlows: VariableFlow[] = [];
  const apiFlows: ApiDataFlow[] = [];
  const suspiciousPatterns: SuspiciousPattern[] = [];

  const keyVariables = await identifyKeyVariables(userId, projectId, files);

  for (const varName of keyVariables.slice(0, 20)) {
    const flow = await traceVariableFlow(userId, projectId, varName, files);
    if (flow.flows.length > 1) {
      variableFlows.push(flow);
      detectFlowIssues(flow, suspiciousPatterns);
    }
  }

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const apiFlowsFound = await analyzeApiEndpoints(userId, projectId, file.path as string);
    apiFlows.push(...apiFlowsFound);
  }

  detectSuspiciousPatterns(variableFlows, apiFlows, suspiciousPatterns);

  await recordAudit({
    action: AuditAction.SEARCH_PERFORMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'context_flow_analysis',
    detail: { projectId, variableFlows: variableFlows.length, apiFlows: apiFlows.length, issues: suspiciousPatterns.length },
  });

  return { projectId, variableFlows, apiFlows, suspiciousPatterns };
}

async function identifyKeyVariables(userId: string, projectId: string, files: Awaited<ReturnType<typeof searchFiles>>): Promise<string[]> {
  const variableCounts = new Map<string, number>();

  for (const file of files.results) {
    if (!file.projectId || file.category === 'test') continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
      q.query(`SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`, [projectId, file.path as string]).then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const f = analysis;

    const declarations = extractVariableDeclarations(f.content);
    for (const decl of declarations) {
      variableCounts.set(decl.name, (variableCounts.get(decl.name) || 0) + 1);
    }
  }

  return Array.from(variableCounts.entries())
    .filter(([_, count]) => count > 2)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

function extractVariableDeclarations(content: string): { name: string; type: string; filePath: string }[] {
  const declarations: { name: string; type: string; filePath: string }[] = [];
  const patterns = [
    /const\s+(\w+)\s*=/g,
    /let\s+(\w+)\s*=/g,
    /var\s+(\w+)\s*=/g,
    /function\s+(\w+)/g,
    /class\s+(\w+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      declarations.push({ name: match[1] ?? '', type: 'variable', filePath: '' });
    }
  }
  return declarations;
}

export async function traceVariableFlow(
  userId: string,
  projectId: string,
  variableName: string,
  files: Awaited<ReturnType<typeof searchFiles>>
): Promise<VariableFlow> {
  const flows: VariableFlowStep[] = [];
  let origin: VariableFlow['origin'] | null = null;
  const destinations: FlowDestination[] = [];
  const transformations: Transformation[] = [];
  const issues: FlowIssue[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
      q.query(`SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`, [projectId, file.path as string]).then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const content = analysis.content;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (!line.includes(variableName)) continue;
      if (!line.includes(variableName)) continue;

      const operation = classifyVariableOperation(line, variableName);
      if (!operation) continue;

      const step: VariableFlowStep = {
        filePath: file.path as string,
        line: i + 1,
        operation: operation as VariableOperation,
        context: line.trim().slice(0, 200),
      };

      if (operation === 'declaration' && !origin) {
        origin = {
          filePath: file.path as string,
          line: i + 1,
          source: classifyOrigin(line) as OriginSource,
          description: `Variable ${variableName} declared as ${classifyOrigin(line)}`,
        };
      }

      if (operation === 'assignment' || operation === 'mutation') {
        const transformType: TransformationType | null = classifyTransformation(line);
        if (transformType) {
          transformations.push({
            filePath: file.path as string,
            line: i + 1,
            type: transformType as TransformationType,
            description: `${transformType} operation on ${variableName}`,
          });
        }
      }

      const dest: DestinationUsage | null = classifyDestination(line, variableName);
      if (dest) {
        destinations.push({
          filePath: file.path as string,
          line: i + 1,
          usage: dest as DestinationUsage,
          description: `${variableName} used for ${dest}`,
        });
      }

      flows.push(step);
    }
  }

  return {
    projectId,
    variableName,
    flows,
    origin: origin || { filePath: '', line: 0, source: 'global', description: 'Origin not found in analyzed files' },
    destinations,
    transformations,
    issues,
  };
}

function classifyVariableOperation(line: string, varName: string): VariableOperation | null {
  const patterns: { pattern: RegExp; op: VariableOperation }[] = [
    { pattern: new RegExp(`(?:const|let|var)\\s+${varName}\\s*=`), op: 'declaration' },
    { pattern: new RegExp(`${varName}\\s*=`), op: 'assignment' },
    { pattern: new RegExp(`${varName}\\.[a-zA-Z]+\\s*=`), op: 'mutation' },
    { pattern: new RegExp(`${varName}\\s*\\(`), op: 'declaration' },
    { pattern: new RegExp(`return\\s+${varName}`), op: 'return' },
    { pattern: new RegExp(`\\.\\.\\.${varName}`), op: 'spread' },
    { pattern: new RegExp(`\\{\\s*${varName}\\s*\\}`), op: 'destructure' },
  ];

  for (const { pattern, op } of patterns) {
    if (pattern.test(line)) return op as VariableOperation;
  }
  return null;
}

function classifyOrigin(line: string): OriginSource {
  if (line.includes('req.') || line.includes('request.')) return 'parameter';
  if (line.includes('import') || line.includes('require(')) return 'import';
  if (/['"`]/.test(line)) return 'literal';
  if (line.includes('(') && line.includes(')')) return 'function_call';
  if (line.includes('process.env') || line.includes('env.')) return 'env';
  return 'global';
}

function classifyTransformation(line: string): TransformationType | null {
  if (line.includes('.map(')) return 'map';
  if (line.includes('.filter(')) return 'filter';
  if (line.includes('.reduce(')) return 'reduce';
  if (line.includes('JSON.parse') || line.includes('parse(')) return 'parse';
  if (line.includes('.validate') || line.includes('validate(')) return 'validate';
  if (line.includes('JSON.stringify') || line.includes('serialize')) return 'serialize';
  if (line.includes('.map') || line.includes('.flatMap') || line.includes('transform')) return 'transform';
  if (line.includes('Object.assign') || line.includes('{ ...') || line.includes('concat')) return 'combine';
  return null;
}

function classifyDestination(line: string, varName: string): DestinationUsage | null {
  if (line.includes(`return ${varName}`) || line.includes(`return ${varName}.`)) return 'return';
  if (line.includes('res.json') || line.includes('res.send') || line.includes('response.')) return 'api_response';
  if (line.includes('.save(') || line.includes('.insert') || line.includes('.update') || line.includes('.create')) return 'db_write';
  if (line.includes('console.log') || line.includes('logger.') || line.includes('log.')) return 'log';
  if (line.includes('setState') || line.includes('.set(') || line.includes('this.')) return 'state_update';
  if (line.includes('export') && line.includes(varName)) return 'export';
  return null;
}

async function analyzeApiEndpoints(userId: string, projectId: string, filePath: string): Promise<ApiDataFlow[]> {
  const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
    q.query(`SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`, [projectId, filePath]).then((r) => r.rows[0] ?? null),
  );
  if (!analysis || !analysis.content) return [];
  const content = analysis.content;

  const flows: ApiDataFlow[] = [];
  const routePatterns = [
    /app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
    /router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  for (const regex of routePatterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const method = match[1]!.toUpperCase();
      const endpoint = match[2]!;
      const funcStart = match.index;
      const handlerBody = extractFunctionBody(content, funcStart);

      const inputFlow = traceApiInput(handlerBody);
      const processingFlow = traceApiProcessing(handlerBody);
      const outputFlow = traceApiOutput(handlerBody);
      const boundaries = identifyServiceBoundaries(handlerBody);
      const ownership = identifyDataOwnership(handlerBody, endpoint);
      const issues = detectDataFlowIssues(handlerBody, endpoint);

      flows.push({
        projectId,
        endpoint,
        method,
        inputFlow,
        processingFlow,
        outputFlow,
        boundaries,
        ownership,
        issues,
      });
    }
  }

  return flows;
}

function extractFunctionBody(content: string, startIndex: number): string {
  let braceCount = 0;
  let inFunction = false;
  let start = -1;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') { braceCount++; if (!inFunction) { inFunction = true; start = i + 1; } }
    else if (content[i] === '}') { braceCount--; if (inFunction && braceCount === 0) return content.slice(start, i); }
  }
  return '';
}

function traceApiInput(body: string): DataFlowPath {
  const sources: string[] = [];
  if (body.includes('req.body')) sources.push('req.body');
  if (body.includes('req.query')) sources.push('req.query');
  if (body.includes('req.params')) sources.push('req.params');
  if (body.includes('req.headers')) sources.push('req.headers');
  return {
    source: sources.join(', ') || 'unknown',
    transformations: extractTransformations(body).map(t => t.type),
    destination: 'handler',
  };
}

function traceApiProcessing(body: string): DataFlowStep[] {
  const steps: DataFlowStep[] = [];
  const lines = body.split('\n');
  let stepId = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const validation = detectValidation(line);
    if (validation) {
      steps.push({
        filePath: '',
        function: 'handler',
        line: i + 1,
        operation: 'validation',
        dataIn: 'input',
        dataOut: 'validated_input',
        validation,
      });
    }

    const transform: TransformationType | null = classifyTransformation(line);
    if (transform) {
      steps.push({
        filePath: '',
        function: 'handler',
        line: i + 1,
        operation: transform,
        dataIn: 'data',
        dataOut: 'transformed',
      });
    }

    if (line.includes('await') && line.includes('db') || line.includes('query') || line.includes('save')) {
      steps.push({
        filePath: '',
        function: 'handler',
        line: i + 1,
        operation: 'db_operation',
        dataIn: 'validated_input',
        dataOut: 'db_result',
      });
    }
  }

  return steps;
}

function traceApiOutput(body: string): DataFlowPath {
  let destination = 'unknown';
  if (body.includes('res.json')) destination = 'JSON response';
  else if (body.includes('res.send')) destination = 'text response';
  else if (body.includes('res.redirect')) destination = 'redirect';

  return {
    source: 'handler',
    transformations: ['serialization'],
    destination,
  };
}

function identifyServiceBoundaries(body: string): ServiceBoundary[] {
  const boundaries: ServiceBoundary[] = [];
  if (body.includes('db.') || body.includes('pool.query') || body.includes('prisma.')) {
    boundaries.push({ service: 'database', boundaryType: 'database', direction: 'outbound', dataTypes: ['entities'], validationPresent: body.includes('validate') });
  }
  if (body.includes('fetch(') || body.includes('axios.') || body.includes('http.')) {
    boundaries.push({ service: 'external_api', boundaryType: 'external', direction: 'outbound', dataTypes: ['requests'], validationPresent: false });
  }
  if (body.includes('redis') || body.includes('cache')) {
    boundaries.push({ service: 'cache', boundaryType: 'cache', direction: 'outbound', dataTypes: ['cached_data'], validationPresent: false });
  }
  if (body.includes('queue') || body.includes('publish') || body.includes('send')) {
    boundaries.push({ service: 'message_queue', boundaryType: 'queue', direction: 'outbound', dataTypes: ['events'], validationPresent: false });
  }
  return boundaries;
}

function identifyDataOwnership(body: string, endpoint: string): DataOwnership[] {
  const ownership: DataOwnership[] = [];
  if (body.includes('user.')) ownership.push({ entity: 'user', owner: 'auth_service', accessPattern: 'read', enforcement: 'code' });
  if (body.includes('payment') || body.includes('billing')) ownership.push({ entity: 'payment', owner: 'billing_service', accessPattern: 'read_write', enforcement: 'policy' });
  if (body.includes('admin')) ownership.push({ entity: 'admin', owner: 'admin_service', accessPattern: 'read_write', enforcement: 'policy' });
  return ownership;
}

function detectDataFlowIssues(body: string, endpoint: string): DataFlowIssue[] {
  const issues: DataFlowIssue[] = [];

  if (!body.includes('validate') && !body.includes('zod') && !body.includes('joi') && (body.includes('req.body') || body.includes('req.query'))) {
    issues.push({ type: 'missing_validation', severity: 'HIGH', location: endpoint, description: 'No input validation detected', evidence: 'Handler accepts req.body/req.query without validation' });
  }

  if (body.includes('res.json') && body.includes('password')) {
    issues.push({ type: 'sensitive_leak', severity: 'CRITICAL', location: endpoint, description: 'Potential password exposure in response', evidence: 'Response may include password field' });
  }

  if (body.includes('SELECT *') && body.includes('res.json')) {
    issues.push({ type: 'data_loss', severity: 'MEDIUM', location: endpoint, description: 'SELECT * may expose internal fields', evidence: 'Raw database result returned directly' });
  }

  return issues;
}

function detectValidation(line: string): string | null {
  if (line.includes('zod') || line.includes('schema')) return 'zod';
  if (line.includes('joi')) return 'joi';
  if (line.includes('validate')) return 'custom';
  if (line.includes('assert')) return 'assert';
  return null;
}

function extractTransformations(body: string): { type: string }[] {
  const transforms: { type: string }[] = [];
  if (body.includes('.map(')) transforms.push({ type: 'map' });
  if (body.includes('.filter(')) transforms.push({ type: 'filter' });
  if (body.includes('.reduce(')) transforms.push({ type: 'reduce' });
  if (body.includes('JSON.parse') || body.includes('parse(')) transforms.push({ type: 'parse' });
  return transforms;
}

function detectFlowIssues(flow: VariableFlow, patterns: SuspiciousPattern[]): void {
  const declarations = flow.flows.filter(f => f.operation === 'declaration').length;
  const assignments = flow.flows.filter(f => f.operation === 'assignment').length;
  const mutations = flow.flows.filter(f => f.operation === 'mutation').length;

  if (declarations > 1) {
    patterns.push({
      type: 'data_duplication',
      severity: 'MEDIUM',
      description: `Variable ${flow.variableName} declared multiple times`,
      locations: flow.flows.filter(f => f.operation === 'declaration').map(f => ({ filePath: f.filePath, line: f.line })),
      evidence: `${declarations} declarations found`,
    });
  }

  if (assignments > 5) {
    patterns.push({
      type: 'data_duplication',
      severity: 'LOW',
      description: `Variable ${flow.variableName} reassigned ${assignments} times`,
      locations: flow.flows.filter(f => f.operation === 'assignment').slice(0, 3).map(f => ({ filePath: f.filePath, line: f.line })),
      evidence: 'Frequent reassignment may indicate confusion',
    });
  }

  const hasValidation = flow.transformations.some(t => t.type === 'validate');
  const hasDbWrite = flow.destinations.some(d => d.usage === 'db_write');
  if (hasDbWrite && !hasValidation) {
    patterns.push({
      type: 'unvalidated_boundary',
      severity: 'HIGH',
      description: `Variable ${flow.variableName} written to DB without validation`,
      locations: flow.destinations.filter(d => d.usage === 'db_write').map(d => ({ filePath: d.filePath, line: d.line })),
      evidence: 'DB write without prior validation step',
    });
  }

  const sensitive = flow.variableName.toLowerCase().includes('password') ||
    flow.variableName.toLowerCase().includes('secret') ||
    flow.variableName.toLowerCase().includes('token') ||
    flow.variableName.toLowerCase().includes('key');
  if (sensitive && flow.destinations.some(d => d.usage === 'log' || d.usage === 'api_response')) {
    patterns.push({
      type: 'sensitive_exposure',
      severity: 'CRITICAL',
      description: `Sensitive variable ${flow.variableName} may be exposed`,
      locations: flow.destinations.filter(d => d.usage === 'log' || d.usage === 'api_response').map(d => ({ filePath: d.filePath, line: d.line })),
      evidence: 'Sensitive data flowing to log or API response',
    });
  }
}

function detectSuspiciousPatterns(variableFlows: VariableFlow[], apiFlows: ApiDataFlow[], patterns: SuspiciousPattern[]): void {
  for (const flow of variableFlows) {
    if (flow.flows.length > 15) {
      patterns.push({
        type: 'data_duplication',
        severity: 'MEDIUM',
        description: `Variable ${flow.variableName} has complex flow (${flow.flows.length} steps)`,
        locations: flow.flows.slice(0, 3).map(f => ({ filePath: f.filePath, line: f.line })),
        evidence: 'Complex variable flow increases bug risk',
      });
    }
  }

  for (const api of apiFlows) {
    const dbWrites = api.processingFlow.filter(s => s.operation === 'db_operation').length;
    const validations = api.processingFlow.filter(s => s.operation === 'validation').length;
    if (dbWrites > validations) {
      patterns.push({
        type: 'unvalidated_boundary',
        severity: 'HIGH',
        description: `API ${api.endpoint} has ${dbWrites} DB writes but only ${validations} validations`,
        locations: [{ filePath: api.endpoint, line: 0 }],
        evidence: 'More mutations than validations',
      });
    }
  }
}

export async function traceDataOrigin(userId: string, projectId: string, variableName: string, filePath: string): Promise<FlowOrigin | null> {
  await assertProjectAccess(userId, projectId);

  const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
    q.query(`SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`, [projectId, filePath]).then((r) => r.rows[0] ?? null),
  );
  if (!analysis || !analysis.content) return null;
  const content = analysis.content;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (!line.includes(variableName)) continue;

    const op = classifyVariableOperation(line, variableName);
    if (op === 'declaration') {
      return {
        filePath,
        line: i + 1,
        source: classifyOrigin(line),
        description: `Origin of ${variableName} found`,
      };
    }
  }
  return null;
}

export async function traceDataDestination(userId: string, projectId: string, variableName: string): Promise<FlowDestination[]> {
  await assertProjectAccess(userId, projectId);

  const files = await searchFiles(userId, { q: '', type: 'file', projectId, limit: 300 });
  const destinations: FlowDestination[] = [];

  for (const file of files.results) {
    if (!file.projectId || !file.path) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
      q.query(`SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`, [projectId, file.path as string]).then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;
    const content = analysis.content;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line && line.includes(variableName)) {
        const dest: DestinationUsage | null = classifyDestination(line, variableName);
        if (dest) {
          destinations.push({
            filePath: file.path as string,
            line: i + 1,
            usage: dest as DestinationUsage,
            description: `${variableName} used for ${dest}`,
          });
        }
      }
    }
  }

  return destinations;
}

function getFunctionEndLine(content: string, startIndex: number): number {
  let braceCount = 0;
  let inFunction = false;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') { braceCount++; inFunction = true; }
    else if (content[i] === '}') { braceCount--; if (inFunction && braceCount === 0) return getLineNumber(content, i); }
  }
  return getLineNumber(content, startIndex) + 20;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}