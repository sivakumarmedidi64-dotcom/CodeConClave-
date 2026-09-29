/**
 * CodeConClave — Security Analysis Engine (V4C).
 * Extends existing security/red-team systems.
 * Detects vulnerabilities with evidence-based findings only.
 * Never fabricates vulnerabilities.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { globalSearch } from '../search/service.js';

export type VulnerabilityType =
  | 'sql_injection'
  | 'xss'
  | 'csrf'
  | 'authorization_flaw'
  | 'authentication_flaw'
  | 'secret_exposure'
  | 'insecure_deserialization'
  | 'weak_cryptography'
  | 'unsafe_dependency'
  | 'path_traversal'
  | 'command_injection';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface VulnerabilityFinding {
  id: string;
  type: VulnerabilityType;
  severity: Severity;
  projectId: string;
  filePath: string;
  line?: number;
  column?: number;
  evidence: string;
  description: string;
  remediation: string;
  confidence: number;
  detectedAt: Date;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'FIXED' | 'FALSE_POSITIVE';
  assignedTo?: string;
  cve?: string;
  references: string[];
}

export interface SecurityScanOptions {
  projectId: string;
  types?: VulnerabilityType[];
  paths?: string[];
  minConfidence?: number;
  includeTestFiles?: boolean;
}

export interface SecurityScanResult {
  scanId: string;
  projectId: string;
  startedAt: Date;
  completedAt: Date;
  findings: VulnerabilityFinding[];
  summary: Record<Severity, number>;
  scannedFiles: number;
}

interface DetectionRule {
  type: VulnerabilityType;
  severity: Severity;
  patterns: DetectionPattern[];
  description: string;
  remediation: string;
  references: string[];
}

interface DetectionPattern {
  regex: RegExp;
  weight: number;
  context?: (line: string, fileContent: string) => boolean;
}

const DETECTION_RULES: DetectionRule[] = [
  {
    type: 'sql_injection',
    severity: 'CRITICAL',
    description: 'SQL query constructed via string concatenation with user input',
    remediation: 'Use parameterized queries / prepared statements',
    references: ['OWASP-A03', 'CWE-89'],
    patterns: [
      { regex: /\$\{.*\b(select|insert|update|delete|drop|union|exec)\b.*\}/gi, weight: 0.9 },
      { regex: /['"`]\s*\+\s*.*?\b(select|insert|update|delete|drop|union)\b.*?\+\s*['"`]/gi, weight: 0.85 },
      { regex: /\b(query|execute)\s*\(\s*['"`][^'"`]*\$\{/gi, weight: 0.8 },
    ],
  },
  {
    type: 'xss',
    severity: 'HIGH',
    description: 'Unsafe rendering of user input in HTML/JS context',
    remediation: 'Use proper output encoding, CSP, and sanitization libraries',
    references: ['OWASP-A03', 'CWE-79'],
    patterns: [
      { regex: /dangerouslySetInnerHTML\s*=\s*\{/g, weight: 0.95 },
      { regex: /\.innerHTML\s*=\s*.*\{/g, weight: 0.9 },
      { regex: /\$\{.*\}\s*\}\s*\)/g, weight: 0.6, context: (l) => l.includes('jsx') || l.includes('tsx') },
      { regex: /v-html\s*=/gi, weight: 0.7 },
      { regex: /{{.*}}/g, weight: 0.5, context: (l) => !l.includes('escape') },
    ],
  },
  {
    type: 'csrf',
    severity: 'HIGH',
    description: 'Missing CSRF protection on state-changing operations',
    remediation: 'Implement CSRF tokens with SameSite cookies and origin validation',
    references: ['OWASP-A01', 'CWE-352'],
    patterns: [
      { regex: /(app|router)\.(post|put|patch|delete)\s*\([^,]+,(?!\s*csrf)/gi, weight: 0.7, context: (l) => !l.includes('csrf') },
      { regex: /method\s*[:=]\s*['"](post|put|patch|delete)['"]/gi, weight: 0.5, context: (l) => !l.includes('csrf') && !l.includes('xsrf') },
    ],
  },
  {
    type: 'authorization_flaw',
    severity: 'HIGH',
    description: 'Missing authorization checks on sensitive operations',
    remediation: 'Implement proper RBAC checks on all sensitive endpoints',
    references: ['OWASP-A01', 'CWE-285'],
    patterns: [
      { regex: /(delete|remove|admin|privilege|role|permission)\b/gi, weight: 0.7, context: (l) => !l.includes('requireAuth') && !l.includes('requireAdmin') && !l.includes('requireRole') && !l.includes('checkPermission') },
      { regex: /(req|request)\.(user|session)\b/gi, weight: 0.5, context: (l) => !l.includes('if') && !l.includes('check') && !l.includes('verify') },
    ],
  },
  {
    type: 'authentication_flaw',
    severity: 'CRITICAL',
    description: 'Weak or missing authentication checks',
    remediation: 'Enforce authentication on all non-public endpoints; use strong password policies and MFA',
    references: ['OWASP-A07', 'CWE-287'],
    patterns: [
      { regex: /password\s*[=:]\s*['"][^'"]{1,12}['"]/gi, weight: 0.9 },
      { regex: /(api|secret|token|key)\s*[=:]\s*['"][^'"]{1,12}['"]/gi, weight: 0.8 },
      { regex: /\b(md5|sha1)\b/gi, weight: 0.8 },
    ],
  },
  {
    type: 'secret_exposure',
    severity: 'CRITICAL',
    description: 'Hardcoded secrets, API keys, or credentials in code',
    remediation: 'Use environment variables, secret managers, or vault solutions',
    references: ['OWASP-A02', 'CWE-798'],
    patterns: [
      { regex: /\b(api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][^'"]{16,}['"]/gi, weight: 0.95 },
      { regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, weight: 1 },
      { regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, weight: 0.95 },
      { regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, weight: 0.95 },
      { regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, weight: 0.95 },
      { regex: /\bsk_live_[0-9A-Za-z]{24,}\b/g, weight: 0.95 },
    ],
  },
  {
    type: 'insecure_deserialization',
    severity: 'HIGH',
    description: 'Unsafe deserialization of untrusted data',
    remediation: 'Validate and sanitize before deserialization; use safe serialization formats',
    references: ['OWASP-A08', 'CWE-502'],
    patterns: [
      { regex: /\b(eval|Function)\s*\(/g, weight: 0.9 },
      { regex: /JSON\.parse\s*\(\s*['"`][^{]*\$\{/g, weight: 0.7 },
      { regex: /(deserialize|unserialize|pickle\.loads|yaml\.load)\s*\(/gi, weight: 0.85 },
    ],
  },
  {
    type: 'weak_cryptography',
    severity: 'HIGH',
    description: 'Use of weak or deprecated cryptographic algorithms',
    remediation: 'Use AES-GCM, ChaCha20-Poly1305, Argon2, scrypt, or bcrypt with appropriate parameters',
    references: ['OWASP-A02', 'CWE-327'],
    patterns: [
      { regex: /\b(md5|sha1|des|3des|rc4)\b/gi, weight: 0.9 },
      { regex: /createCipher\s*\(/g, weight: 0.8 },
      { regex: /crypto\.createHash\s*\(\s*['"](md5|sha1)['"]/g, weight: 0.85 },
    ],
  },
  {
    type: 'unsafe_dependency',
    severity: 'MEDIUM',
    description: 'Dependencies with known vulnerabilities',
    remediation: 'Update to patched versions; use automated dependency scanning',
    references: ['OWASP-A06', 'CWE-1104'],
    patterns: [],
  },
  {
    type: 'path_traversal',
    severity: 'HIGH',
    description: 'Unsanitized user input used in file paths',
    remediation: 'Validate and sanitize paths; use path.resolve with base directory checks',
    references: ['OWASP-A01', 'CWE-22'],
    patterns: [
      { regex: /\.\.\//g, weight: 0.7, context: (l) => l.includes('user') || l.includes('input') || l.includes('req.') },
      { regex: /path\.join\s*\([^)]*\$\{/g, weight: 0.75 },
      { regex: /readFile|writeFile|unlink|mkdir.*\$\{/g, weight: 0.7 },
    ],
  },
  {
    type: 'command_injection',
    severity: 'CRITICAL',
    description: 'User input passed to shell commands without sanitization',
    remediation: 'Use execFile with array arguments; avoid shell=true; validate allowlists',
    references: ['OWASP-A03', 'CWE-78'],
    patterns: [
      { regex: /exec\s*\([^)]*\$\{/g, weight: 0.9 },
      { regex: /spawn\s*\([^)]*\$\{/g, weight: 0.85 },
      { regex: /child_process\.(exec|spawn|execSync)\s*\(/g, weight: 0.8, context: (l) => l.includes('$') || l.includes('`') },
    ],
  },
];

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ ok: string } | null>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

function calculateSeverity(score: number): Severity {
  if (score >= 0.9) return 'CRITICAL';
  if (score >= 0.75) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'INFO';
}

function calculateConfidence(matches: { pattern: DetectionPattern; matched: boolean }[]): number {
  const totalWeight = matches.reduce((sum, m) => sum + m.pattern.weight, 0);
  const matchedWeight = matches.filter(m => m.matched).reduce((sum, m) => sum + m.pattern.weight, 0);
  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

export async function runSecurityScan(
  userId: string,
  options: SecurityScanOptions
): Promise<SecurityScanResult> {
  await assertProjectAccess(userId, options.projectId);

  const scanId = newId(PREFIX.SECURITY_SCAN_COMPLETED);
  const startedAt = new Date();

  const files = await globalSearch(userId, {
    q: '',
    type: 'file',
    projectId: options.projectId,
    limit: 500,
  });

  const sourceFiles = files.results.filter(f => {
    if (!f.projectId) return false;
    if (!options.includeTestFiles && f.category === 'test') return false;
    if (options.paths && options.paths.length > 0) {
      return options.paths.some(p => (f.path as string)?.startsWith(p));
    }
    return true;
  });

  const findings: VulnerabilityFinding[] = [];
  let scannedFiles = 0;

  for (const file of sourceFiles) {
    if (!file.projectId) continue;
    const path = file.path as string;
    if (!path) continue;

    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
      q
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [options.projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;

    const f = analysis;

    scannedFiles++;
    const lines = f.content.split('\n');

    for (const rule of DETECTION_RULES) {
      if (options.types && !options.types.includes(rule.type)) continue;

      for (const pattern of rule.patterns) {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g');
        let match: RegExpExecArray | null;
        while ((match = re.exec(f.content)) !== null) {
          const lineNumber = f.content.substring(0, match.index).split('\n').length;
          const contextPasses = !pattern.context || pattern.context(match[0], f.content);

          if (contextPasses) {
            const confidence = pattern.weight;
            if (confidence >= (options.minConfidence ?? 0.5)) {
              const finding: VulnerabilityFinding = {
                id: newId(PREFIX.VULNERABILITY),
                type: rule.type,
                severity: rule.severity,
                projectId: options.projectId,
                filePath: path,
                line: lineNumber,
                evidence: match[0].slice(0, 200),
                description: rule.description,
                remediation: rule.remediation,
                confidence,
                detectedAt: new Date(),
                status: 'OPEN',
                references: rule.references,
              };
              findings.push(finding);
            }
          }
        }
      }
    }
  }

  const completedAt = new Date();
  const summary: Record<Severity, number> = {
    CRITICAL: findings.filter(f => f.severity === 'CRITICAL').length,
    HIGH: findings.filter(f => f.severity === 'HIGH').length,
    MEDIUM: findings.filter(f => f.severity === 'MEDIUM').length,
    LOW: findings.filter(f => f.severity === 'LOW').length,
    INFO: findings.filter(f => f.severity === 'INFO').length,
  };

  const scanResult: SecurityScanResult = {
    scanId,
    projectId: options.projectId,
    startedAt,
    completedAt,
    findings,
    summary,
    scannedFiles,
  };

  await recordAudit({
    action: AuditAction.SECURITY_SCAN_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'security_scan',
    resourceId: scanId,
    detail: {
      projectId: options.projectId,
      findings: findings.length,
      summary,
      scannedFiles,
    },
  });

  return scanResult;
}

export async function getVulnerabilityFindings(
  userId: string,
  projectId: string,
  options: { type?: VulnerabilityType; severity?: Severity; status?: VulnerabilityFinding['status']; limit?: number } = {}
): Promise<VulnerabilityFinding[]> {
  await assertProjectAccess(userId, projectId);

  let query = `
    SELECT * FROM vulnerability_findings
    WHERE project_id = $1
  `;
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.type) {
    query += ` AND type = $${paramIndex++}`;
    params.push(options.type);
  }
  if (options.severity) {
    query += ` AND severity = $${paramIndex++}`;
    params.push(options.severity);
  }
  if (options.status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(options.status);
  }
  query += ` ORDER BY detected_at DESC LIMIT $${paramIndex}`;
  params.push(options.limit ?? 100);

  return withTenant<VulnerabilityFinding[]>(userId, (q) =>
    q.query<VulnerabilityFinding>(query, params).then((r) => r.rows),
  );
}

export async function updateVulnerabilityStatus(
  userId: string,
  projectId: string,
  findingId: string,
  status: VulnerabilityFinding['status'],
  assignedTo?: string
): Promise<VulnerabilityFinding> {
  await assertProjectAccess(userId, projectId);

  const fields: string[] = ['status = $3', 'updated_at = now()'];
  const params: unknown[] = [findingId, projectId, status];
  if (assignedTo !== undefined) {
    params.push(assignedTo);
    fields.push(`assigned_to = $${params.length}`);
  }

  await withTenant(userId, (q) =>
    q.query(`UPDATE vulnerability_findings SET ${fields.join(', ')} WHERE id = $1 AND project_id = $2`, params),
  );

  const rows = await withTenant<VulnerabilityFinding[]>(userId, (q) =>
    q.query<VulnerabilityFinding>('SELECT * FROM vulnerability_findings WHERE id = $1', [findingId]).then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Vulnerability finding');
  return rows[0];
}

export async function getSecurityScanHistory(userId: string, projectId: string, limit = 20) {
  await assertProjectAccess(userId, projectId);
  return withTenant<SecurityScanResult[]>(userId, (q) =>
    q
      .query<SecurityScanResult>(
        'SELECT * FROM security_scans WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2',
        [projectId, limit],
      )
      .then((r) => r.rows),
  );
}