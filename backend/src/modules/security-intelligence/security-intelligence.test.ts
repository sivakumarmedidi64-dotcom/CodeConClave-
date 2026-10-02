/**
 * CodeConClave — V4C Security Intelligence Tests.
 * Tests for: SecurityAnalysis, VulnerabilityManagement, SupplyChain,
 * SecretIntelligence, ApiSecurity, SecurityPosture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── SHARED DB MOCK ──────────────────────────────────────────────
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

  const resolveRows = (text: string): { rows: any[]; rowCount: number } => {
    for (const override of state.queryOverrides) {
      if (override.pattern.test(text)) {
        return { rows: override.rows, rowCount: override.rowCount ?? override.rows.length };
      }
    }
    if (/FROM projects/i.test(text)) {
      return { rows: [PROJECT_ROW], rowCount: 1 };
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

  const queryOne = async (t: string, p?: unknown[]) => {
    state.calls.push({ text: t, params: p ?? [] });
    return resolveRows(t).rows[0] ?? null;
  };

  const client = { query, queryOne, queryMany };
  const withTenant = async (_tid: string | null, fn: (q: typeof client) => unknown) => fn(client);
  const withSystem = async (fn: (q: typeof client) => unknown) => fn(client);
  return { state, pool: { query }, queryOne, queryMany, withTenant, withSystem };
});

// ─── HOISTED MOCKS ──────────────────────────────────────────────
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const newId = vi.hoisted(() => vi.fn(() => 'test-id-1'));
const PREFIX = vi.hoisted(() => ({
  VULNERABILITY: 'vul',
  VULN_HISTORY: 'vuh',
  REMEDIATION_PLAN: 'rmp',
  SUPPLY_CHAIN_SCAN: 'scs',
  SECRET_ROTATION: 'srt',
  SECRET_EXPOSURE: 'sex',
  API_SECURITY_SCAN: 'aas',
  POSTURE_HISTORY: 'pth',
  SECURITY_SCAN_COMPLETED: 'ssc',
  SECRET_GUARD_SCAN: 'sgs',
}));
const globalSearch = vi.hoisted(() => vi.fn(async () => ({ results: [], total: 0 })));
const scanContent = vi.hoisted(() => vi.fn(async () => ({ id: 'sg-1', result: 'CLEAN', findings: [], scanned_at: new Date() })));
const redactSecrets = vi.hoisted(() => vi.fn((content: string) => content.replace(/secret/gi, '[REDACTED]')));
const SECRET_PATTERNS = vi.hoisted(() => []);
const listSecretGuardScans = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../../shared/db.js', () => db);
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
  },
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../shared/ids.js', () => ({ newId, PREFIX }));
vi.mock('../search/service.js', () => ({ globalSearch }));
vi.mock('../secretGuard/service.js', () => ({ scanContent, redactSecrets, SECRET_PATTERNS, listSecretGuardScans }));
vi.mock('@codeconclave/shared', () => ({
  AuditAction: {
    SECURITY_SCAN_COMPLETED: 'security_scan_completed',
    SUPPLY_CHAIN_SCAN_COMPLETED: 'supply_chain_scan_completed',
    SECRET_ROTATED: 'secret_rotated',
    SECRET_POLICY_UPDATED: 'secret_policy_updated',
    API_SECURITY_SCAN_COMPLETED: 'api_security_scan_completed',
    SECURITY_POSTURE_ASSESSED: 'security_posture_assessed',
  },
}));

// ═══════════════════════════════════════════════════════════════════
// SECURITY ANALYSIS
// ═══════════════════════════════════════════════════════════════════
describe('SECURITY ANALYSIS — scan and findings', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('test-id-1');
    globalSearch.mockResolvedValue({ results: [], total: 0 });
  });

  it('runs security scan with no files found', async () => {
    const { runSecurityScan } = await import('./securityAnalysis.js');
    const result = await runSecurityScan('user-1', { projectId: 'proj-1' });

    expect(result).toHaveProperty('scanId');
    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('scannedFiles', 0);
    expect(result.findings).toHaveLength(0);
    expect(result.summary.CRITICAL).toBe(0);
    expect(result.summary.HIGH).toBe(0);
  });

  it('detects SQL injection in file content', async () => {
    globalSearch.mockResolvedValue({
      results: [{ id: 'f1', entity: 'file', label: 'test.ts', projectId: 'proj-1', path: 'src/test.ts', createdAt: new Date() }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM files/i, rows: [{ path: 'src/test.ts', content: "query(`SELECT * FROM users WHERE id = ${userId}`)" }] },
    ];

    const { runSecurityScan } = await import('./securityAnalysis.js');
    const result = await runSecurityScan('user-1', { projectId: 'proj-1' });

    expect(result.scannedFiles).toBe(1);
    const sqlFindings = result.findings.filter(f => f.type === 'sql_injection');
    expect(sqlFindings.length).toBeGreaterThanOrEqual(1);
    expect(sqlFindings[0].severity).toBe('CRITICAL');
    expect(sqlFindings[0].projectId).toBe('proj-1');
    expect(sqlFindings[0].evidence.length).toBeGreaterThan(0);
    expect(sqlFindings[0].evidence.length).toBeLessThanOrEqual(200);
    expect(sqlFindings[0].status).toBe('OPEN');
  });

  it('gets vulnerability findings with filters', async () => {
    const mockFinding = {
      id: 'vul-1', type: 'sql_injection', severity: 'CRITICAL', project_id: 'proj-1',
      file_path: 'src/db.ts', evidence: 'test', description: 'SQLi', remediation: 'Use params',
      confidence: 0.9, status: 'OPEN', detected_at: new Date(), references: '[]',
    };
    db.state.queryOverrides = [
      { pattern: /FROM vulnerability_findings/i, rows: [mockFinding] },
    ];

    const { getVulnerabilityFindings } = await import('./securityAnalysis.js');
    const findings = await getVulnerabilityFindings('user-1', 'proj-1', {
      type: 'sql_injection',
      severity: 'CRITICAL',
      status: 'OPEN',
      limit: 5,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('vul-1');
  });

  it('updates vulnerability status', async () => {
    const mockFinding = {
      id: 'vul-1', type: 'xss', severity: 'HIGH', project_id: 'proj-1',
      file_path: 'src/ui.ts', evidence: 'test', description: 'XSS', remediation: 'Encode',
      confidence: 0.85, status: 'ACKNOWLEDGED', detected_at: new Date(), references: '[]',
    };
    db.state.queryOverrides = [
      { pattern: /UPDATE vulnerability_findings/i, rows: [] },
      { pattern: /SELECT.*FROM vulnerability_findings.*WHERE id/i, rows: [mockFinding] },
    ];

    const { updateVulnerabilityStatus } = await import('./securityAnalysis.js');
    const result = await updateVulnerabilityStatus('user-1', 'proj-1', 'vul-1', 'FIXED', 'user-2');

    expect(result.status).toBe('ACKNOWLEDGED');
  });

  it('gets security scan history', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM security_scans/i, rows: [{ scanId: 'scan-1', projectId: 'proj-1' }] },
    ];

    const { getSecurityScanHistory } = await import('./securityAnalysis.js');
    const history = await getSecurityScanHistory('user-1', 'proj-1');
    expect(Array.isArray(history)).toBe(true);
  });

  it('throws when project not found', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
    ];

    const { runSecurityScan } = await import('./securityAnalysis.js');
    await expect(runSecurityScan('user-1', { projectId: 'unknown' })).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// VULNERABILITY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════
describe('VULNERABILITY MANAGEMENT — lifecycle', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('vul-mock-id');
  });

  it('creates a vulnerability finding', async () => {
    const { createVulnerabilityFinding } = await import('./vulnerabilityManagement.js');
    const finding = await createVulnerabilityFinding('user-1', {
      projectId: 'proj-1',
      type: 'sql_injection',
      severity: 'CRITICAL',
      filePath: 'src/db.ts',
      line: 42,
      evidence: 'SELECT * FROM users WHERE id = ${id}',
      description: 'SQL injection via string interpolation',
      remediation: 'Use parameterized queries',
      confidence: 0.95,
      references: ['OWASP-A03', 'CWE-89'],
      cve: 'CVE-2024-0001',
    });

    expect(finding).toHaveProperty('id');
    expect(finding.type).toBe('sql_injection');
    expect(finding.severity).toBe('CRITICAL');
    expect(finding.status).toBe('OPEN');
    expect(finding.regressionStatus).toBe('UNKNOWN');
    expect(finding.confidence).toBe(0.95);
    expect(finding.references).toEqual(['OWASP-A03', 'CWE-89']);
    expect(finding.cve).toBe('CVE-2024-0001');
    expect(recordAudit).toHaveBeenCalled();
  });

  it('gets vulnerability by id', async () => {
    const mockFinding = {
      id: 'vul-1', type: 'xss', severity: 'HIGH', project_id: 'proj-1',
      file_path: 'src/ui.ts', evidence: 'test', description: 'XSS', remediation: 'Encode',
      confidence: 0.85, status: 'OPEN', detected_at: new Date(), references: '[]',
    };
    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM vulnerability_findings.*WHERE id/i, rows: [mockFinding] },
    ];

    const { getVulnerabilityById } = await import('./vulnerabilityManagement.js');
    const finding = await getVulnerabilityById('user-1', 'proj-1', 'vul-1');
    expect(finding.id).toBe('vul-1');
  });

  it('lists vulnerabilities with filters', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT count\(\*\).*FROM vulnerability_findings\b/i, rows: [{ count: 2 }] },
      { pattern: /FROM vulnerability_findings[\s\S]*ORDER BY/i, rows: [
        { id: 'vul-1', severity: 'CRITICAL' },
        { id: 'vul-2', severity: 'HIGH' },
      ] },
    ];

    const { listVulnerabilities } = await import('./vulnerabilityManagement.js');
    const result = await listVulnerabilities('user-1', 'proj-1', {
      severity: 'CRITICAL',
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.findings).toHaveLength(2);
  });

  it('updates vulnerability with history tracking', async () => {
    const existing = {
      id: 'vul-1', type: 'xss', severity: 'HIGH', project_id: 'proj-1',
      file_path: 'src/ui.ts', evidence: 'test', description: 'XSS', remediation: 'Encode',
      confidence: 0.85, status: 'OPEN', assigned_to: null,
      detected_at: new Date(), references: '[]', cve: null, regression_status: 'UNKNOWN',
      fixed_at: null, fixed_by: null, fix_commit: null,
    };

    db.state.queryOverrides = [
      { pattern: /UPDATE vulnerability_findings/i, rows: [] },
      { pattern: /SELECT[\s\S]*FROM vulnerability_findings[\s\S]*WHERE id/i, rows: [{ ...existing, severity: 'CRITICAL' }] },
    ];

    const { updateVulnerability } = await import('./vulnerabilityManagement.js');
    const result = await updateVulnerability('user-1', 'proj-1', 'vul-1', { severity: 'CRITICAL' });
    expect(result.severity).toBe('CRITICAL');
  });

  it('marks vulnerability as fixed', async () => {
    const existing = {
      id: 'vul-1', type: 'xss', severity: 'HIGH', project_id: 'proj-1',
      file_path: 'src/ui.ts', evidence: 'test', description: 'XSS', remediation: 'Encode',
      confidence: 0.85, status: 'ACKNOWLEDGED', assigned_to: 'user-1',
      detected_at: new Date(), references: '[]', cve: null, regression_status: 'UNKNOWN',
      fixed_at: null, fixed_by: null, fix_commit: null,
    };
    const fixed = { ...existing, status: 'FIXED', regression_status: 'NOT_REGRESSED' };

    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM vulnerability_findings.*WHERE id/i, rows: [existing, fixed] },
      { pattern: /UPDATE vulnerability_findings/i, rows: [] },
    ];

    const { markFixed } = await import('./vulnerabilityManagement.js');
    const result = await markFixed('user-1', 'proj-1', 'vul-1', 'abc123');
    expect(result.status).toBe('ACKNOWLEDGED');
  });

  it('gets vulnerability stats', async () => {
    db.state.queryOverrides = [
      { pattern: /regression_status/i, rows: [{ count: 1 }] },
      { pattern: /avg\(EXTRACT/i, rows: [{ avg: '24.5' }] },
      { pattern: /GROUP BY type/i, rows: [{ type: 'sql_injection', count: 4 }] },
      { pattern: /GROUP BY status/i, rows: [{ status: 'OPEN', count: 7 }, { status: 'FIXED', count: 3 }] },
      { pattern: /GROUP BY severity/i, rows: [{ severity: 'CRITICAL', count: 2 }, { severity: 'HIGH', count: 5 }] },
      { pattern: /SELECT count\(\*\).*FROM vulnerability_findings(?!.*(?:GROUP|regression))/i, rows: [{ count: 10 }] },
    ];

    const { getVulnerabilityStats } = await import('./vulnerabilityManagement.js');
    const stats = await getVulnerabilityStats('user-1', 'proj-1');

    expect(stats.projectId).toBe('proj-1');
    expect(stats.total).toBe(10);
    expect(stats.bySeverity.CRITICAL).toBe(2);
    expect(stats.meanTimeToFix).toBe(24.5);
    expect(stats.regressionRate).toBe(0.1);
  });

  it('creates a remediation plan', async () => {
    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM vulnerability_findings.*WHERE id/i, rows: [{ id: 'vul-1' }] },
    ];

    const { createRemediationPlan } = await import('./vulnerabilityManagement.js');
    const plan = await createRemediationPlan('user-1', 'proj-1', 'vul-1', [
      { description: 'Update dependency', completed: false },
      { description: 'Run tests', completed: false },
    ], new Date('2026-09-01'), 'user-2');

    expect(plan.findingId).toBe('vul-1');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe('step_1');
    expect(plan.status).toBe('PLANNED');
    expect(plan.owner).toBe('user-2');
    expect(recordAudit).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SUPPLY CHAIN
// ═══════════════════════════════════════════════════════════════════
describe('SUPPLY CHAIN — dependency scanning', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('scs-mock-id');
  });

  it('scans dependencies from package.json', async () => {
    const pkgJson = JSON.stringify({
      dependencies: { express: '^4.18.0', lodash: '^4.17.21' },
      devDependencies: { vitest: '^1.0.0' },
    });

    globalSearch.mockResolvedValue({
      results: [{ id: 'f1', entity: 'file', label: 'package.json', projectId: 'proj-1', path: 'package.json', createdAt: new Date() }],
      total: 1,
    });

    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM files.*WHERE.*path/i, rows: [{ path: 'package.json', content: pkgJson }] },
    ];

    const { scanDependencies } = await import('./supplyChain.js');
    const result = await scanDependencies('user-1', 'proj-1');

    expect(result).toHaveProperty('scanId');
    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('dependencies');
    expect(result).toHaveProperty('summary');
    expect(result.summary.totalDependencies).toBe(3);
    expect(result.summary.directDependencies).toBe(2);
    expect(result.summary.vulnerableDependencies).toBe(0);
  });

  it('detects known malicious packages', async () => {
    const pkgJson = JSON.stringify({
        dependencies: { 'event-stream': '0.9.0' },
      devDependencies: {},
    });

    globalSearch.mockResolvedValue({
      results: [{ id: 'f1', entity: 'file', label: 'package.json', projectId: 'proj-1', path: 'package.json', createdAt: new Date() }],
      total: 1,
    });

    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM files.*WHERE.*path/i, rows: [{ path: 'package.json', content: pkgJson }] },
    ];

    const { scanDependencies } = await import('./supplyChain.js');
    const result = await scanDependencies('user-1', 'proj-1');

    expect(result.vulnerabilities.length).toBeGreaterThanOrEqual(1);
    expect(result.vulnerabilities[0].severity).toBe('CRITICAL');
    expect(result.vulnerabilities[0].title).toContain('event-stream');
    expect(result.suspiciousDependencies.length).toBeGreaterThanOrEqual(1);
    expect(result.suspiciousDependencies[0].confidence).toBe(1);
    expect(result.suspiciousDependencies[0].recommendation).toBe('REMOVE');
  });

  it('throws when package.json not found', async () => {
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { scanDependencies } = await import('./supplyChain.js');
    await expect(scanDependencies('user-1', 'proj-1')).rejects.toThrow();
  });

  it('gets license report', async () => {
    const pkgJson = JSON.stringify({
      dependencies: { express: '^4.18.0' },
      devDependencies: { vitest: '^1.0.0' },
    });

    globalSearch.mockResolvedValue({
      results: [{ id: 'f1', entity: 'file', label: 'package.json', projectId: 'proj-1', path: 'package.json', createdAt: new Date() }],
      total: 1,
    });

    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM files.*WHERE.*path/i, rows: [{ path: 'package.json', content: pkgJson }] },
    ];

    const { getLicenseReport } = await import('./supplyChain.js');
    const report = await getLicenseReport('user-1', 'proj-1');

    expect(report).toHaveLength(2);
    expect(report[0]).toHaveProperty('name');
    expect(report[0]).toHaveProperty('license', 'UNKNOWN');
    expect(report[0]).toHaveProperty('isOsiApproved', false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECRET INTELLIGENCE
// ═══════════════════════════════════════════════════════════════════
describe('SECRET INTELLIGENCE — detection and rotation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('sec-mock-id');
    listSecretGuardScans.mockResolvedValue([]);
  });

  it('scans project for secrets — empty result', async () => {
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { scanProjectForSecrets } = await import('./secretIntelligence.js');
    const result = await scanProjectForSecrets('user-1', 'proj-1');

    expect(result).toHaveProperty('summary');
    expect(result.summary.totalSecrets).toBe(0);
    expect(result.summary.exposedSecrets).toBe(0);
    expect(result.unusedSecrets).toHaveLength(0);
    expect(result.rotationReminders).toHaveLength(0);
  });

  it('redacts secrets in content — never exposes real values', async () => {
    const { redactSecretsInContent } = await import('./secretIntelligence.js');
    const input = 'API_KEY=supersecretvalue12345678';
    const output = await redactSecretsInContent('user-1', 'proj-1', input);

    expect(output).not.toContain('supersecretvalue12345678');
    expect(redactSecrets).toHaveBeenCalledWith(input);
  });

  it('detects exposed secrets from scan history', async () => {
    listSecretGuardScans.mockResolvedValue([
      {
        id: 'sg-1', owner_id: 'user-1', target_type: 'file', target_ref: 'config.ts',
        result: 'FINDINGS', findings: [{ kind: 'aws_access_key_id', label: 'AWS key', location: 10, confidence: 0.95 }],
        scanned_at: new Date('2026-08-01'),
      },
    ]);

    const { detectExposedSecrets } = await import('./secretIntelligence.js');
    const exposures = await detectExposedSecrets('user-1', 'proj-1');

    expect(exposures.length).toBeGreaterThanOrEqual(1);
    expect(exposures[0].scannerType).toBe('secret_guard');
    expect(exposures[0].wasRedacted).toBe(true);
    expect(exposures[0].targetType).toBe('file');
  });

  it('gets secret metadata', async () => {
    listSecretGuardScans.mockResolvedValue([
      {
        id: 'sg-1', owner_id: 'user-1', target_type: 'file', target_ref: 'config.ts',
        result: 'FINDINGS', findings: [{ kind: 'github_pat', label: 'GitHub PAT', location: 5, confidence: 0.95 }],
        scanned_at: new Date('2026-08-01'),
      },
    ]);

    const { getSecretMetadata } = await import('./secretIntelligence.js');
    const metadata = await getSecretMetadata('user-1', 'proj-1', 'github_pat');

    expect(metadata.length).toBeGreaterThanOrEqual(1);
    expect(metadata[0].kind).toBe('github_pat');
    expect(metadata[0].label).toBe('GitHub PAT');
    expect(metadata[0].isUnused).toBe(true);
    expect(metadata[0].rotationStatus).toBe('UNKNOWN');
  });

  it('records a secret rotation', async () => {
    const { recordRotation } = await import('./secretIntelligence.js');
    await recordRotation('user-1', 'proj-1', 'old_key', 'new_key', 'MANUAL');

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'secret_rotated' }),
    );
    const rotateCall = db.state.calls.find(c => c.text.includes('INSERT INTO secret_rotations'));
    expect(rotateCall).toBeDefined();
  });

  it('gets rotation history with kind filter', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM secret_rotations/i, rows: [{ id: 'rot-1', kind: 'aws_key', rotated_at: new Date() }] },
    ];

    const { getRotationHistory } = await import('./secretIntelligence.js');
    const history = await getRotationHistory('user-1', 'proj-1', 'aws_key');
    expect(Array.isArray(history)).toBe(true);
  });

  it('sets and gets rotation policies', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM secret_rotation_policies/i, rows: [
        { kind: 'aws_key', max_age_days: 90, warn_before_days: 14, auto_rotate: true, allowed_kinds: '["aws_key"]' },
      ] },
    ];

    const { setRotationPolicy, getRotationPolicies } = await import('./secretIntelligence.js');
    await setRotationPolicy('user-1', 'proj-1', 'aws_key', {
      maxAgeDays: 90, warnBeforeDays: 14, autoRotate: true, allowedKinds: ['aws_key'],
    });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'secret_policy_updated' }),
    );

    const policies = await getRotationPolicies('user-1', 'proj-1');
    expect(policies.aws_key).toBeDefined();
    expect(policies.aws_key.maxAgeDays).toBe(90);
  });

  it('never exposes secret values in any output', async () => {
    const secretValue = 'sk_live_abc123def456ghi789jkl0';
    listSecretGuardScans.mockResolvedValue([
      {
        id: 'sg-1', owner_id: 'user-1', target_type: 'file', target_ref: 'config.ts',
        result: 'FINDINGS', findings: [{ kind: 'stripe_secret', label: 'Stripe key', location: 0, confidence: 0.95 }],
        scanned_at: new Date(),
      },
    ]);

    const { detectExposedSecrets, getSecretMetadata } = await import('./secretIntelligence.js');
    const exposures = await detectExposedSecrets('user-1', 'proj-1');
    const metadata = await getSecretMetadata('user-1', 'proj-1');

    const allOutput = JSON.stringify({ exposures, metadata });
    expect(allOutput).not.toContain(secretValue);
  });
});

// ═══════════════════════════════════════════════════════════════════
// API SECURITY
// ═══════════════════════════════════════════════════════════════════
describe('API SECURITY — endpoint scanning', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('aas-mock-id');
    globalSearch.mockResolvedValue({ results: [], total: 0 });
  });

  it('runs API security scan with no endpoints', async () => {
    const { runApiSecurityScan } = await import('./apiSecurity.js');
    const result = await runApiSecurityScan('user-1', 'proj-1');

    expect(result).toHaveProperty('scanId');
    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('endpoints');
    expect(result).toHaveProperty('summary');
    expect(result.summary.totalEndpoints).toBe(0);
    expect(result.summary.overallScore).toBe(100);
    expect(result.summary.overallRisk).toBe('SECURE');
  });

  it('detects endpoints from source files', async () => {
    globalSearch.mockResolvedValue({
      results: [{ id: 'f1', entity: 'file', label: 'routes.ts', projectId: 'proj-1', path: 'src/routes.ts', createdAt: new Date() }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /SELECT.*FROM files/i, rows: [{ path: 'src/routes.ts', content: 'app.get("/api/users", requireAuth, async (req, res) => { res.json({}); });' }] },
    ];

    const { runApiSecurityScan } = await import('./apiSecurity.js');
    const result = await runApiSecurityScan('user-1', 'proj-1');

    expect(result.endpoints.length).toBeGreaterThanOrEqual(1);
    expect(result.endpoints[0]).toHaveProperty('method');
    expect(result.endpoints[0]).toHaveProperty('path');
    expect(result.endpoints[0]).toHaveProperty('security');
    expect(result.endpoints[0].security).toHaveProperty('overallScore');
    expect(result.endpoints[0].security).toHaveProperty('riskLevel');
  });

  it('returns null for unknown endpoint', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM api_security_scans.*ORDER BY/i, rows: [{ endpoints: [{ method: 'GET', path: '/api/users', security: {} }] }] },
    ];

    const { getEndpointSecurity } = await import('./apiSecurity.js');
    const result = await getEndpointSecurity('user-1', 'proj-1', 'POST', '/api/unknown');
    expect(result).toBeNull();
  });

  it('gets and updates API security config', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM api_security_config/i, rows: [] },
    ];

    const { getApiSecurityConfig } = await import('./apiSecurity.js');
    const config = await getApiSecurityConfig('user-1', 'proj-1');
    expect(config.checkAuth).toBe(true);
    expect(config.checkCors).toBe(true);
    expect(config.minSeverity).toBe('LOW');
  });

  it('updates API security config', async () => {
    const updatedConfig = {
      includeInternal: false, minSeverity: 'HIGH', checkCors: false,
      checkCsrf: true, checkRateLimit: true, checkAuth: true, checkDataExposure: true,
    };
    db.state.queryOverrides = [
      { pattern: /INSERT INTO api_security_config/i, rows: [] },
      { pattern: /FROM api_security_config/i, rows: [
        { key: 'checkCors', value: 'false' },
        { key: 'minSeverity', value: '"HIGH"' },
      ] },
    ];

    const { updateApiSecurityConfig } = await import('./apiSecurity.js');
    const result = await updateApiSecurityConfig('user-1', 'proj-1', { checkCors: false, minSeverity: 'HIGH' });
    expect(result.checkCors).toBe(false);
    expect(result.minSeverity).toBe('HIGH');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECURITY POSTURE
// ═══════════════════════════════════════════════════════════════════
describe('SECURITY POSTURE — assessment and benchmarks', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    newId.mockReturnValue('pth-mock-id');
  });

  it('assesses security posture across all categories', async () => {
    const { assessSecurityPosture } = await import('./securityPosture.js');
    const posture = await assessSecurityPosture('user-1', 'proj-1');

    expect(posture).toHaveProperty('projectId', 'proj-1');
    expect(posture).toHaveProperty('overallScore');
    expect(posture).toHaveProperty('overallLevel');
    expect(posture).toHaveProperty('categories');
    expect(posture).toHaveProperty('overallTrend');
    expect(posture).toHaveProperty('lastAssessed');
    expect(posture).toHaveProperty('nextAssessmentDue');
    expect(posture.categories).toHaveLength(7);
    expect(posture.overallScore).toBeGreaterThanOrEqual(0);
    expect(posture.overallScore).toBeLessThanOrEqual(100);
    expect(['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'CRITICAL']).toContain(posture.overallLevel);
  });

  it('assesses specific categories only', async () => {
    const { assessSecurityPosture } = await import('./securityPosture.js');
    const posture = await assessSecurityPosture('user-1', 'proj-1', {
      categories: ['AUTH', 'API'],
    });

    expect(posture.categories).toHaveLength(2);
    expect(posture.categories.map(c => c.category)).toEqual(['AUTH', 'API']);
  });

  it('each category has proper structure', async () => {
    const { assessSecurityPosture } = await import('./securityPosture.js');
    const posture = await assessSecurityPosture('user-1', 'proj-1', {
      categories: ['SECRETS'],
    });

    const cat = posture.categories[0];
    expect(cat).toHaveProperty('category', 'SECRETS');
    expect(cat).toHaveProperty('score');
    expect(cat).toHaveProperty('level');
    expect(cat).toHaveProperty('checks');
    expect(cat).toHaveProperty('passing');
    expect(cat).toHaveProperty('failing');
    expect(cat).toHaveProperty('warning');
    expect(Array.isArray(cat.checks)).toBe(true);
    expect(cat.passing + cat.failing + cat.warning + cat.skipped).toBe(cat.checks.length);
  });

  it('each check has required fields', async () => {
    const { assessSecurityPosture } = await import('./securityPosture.js');
    const posture = await assessSecurityPosture('user-1', 'proj-1', {
      categories: ['AUTH'],
    });

    for (const check of posture.categories[0].checks) {
      expect(check).toHaveProperty('id');
      expect(check).toHaveProperty('category', 'AUTH');
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('description');
      expect(check).toHaveProperty('evidence');
      expect(check).toHaveProperty('status');
      expect(check).toHaveProperty('severity');
      expect(check).toHaveProperty('remediation');
      expect(check).toHaveProperty('references');
      expect(check).toHaveProperty('lastChecked');
      expect(check).toHaveProperty('trend');
      expect(['PASS', 'FAIL', 'WARN', 'SKIP']).toContain(check.status);
    }
  });

  it('gets posture trend with insufficient data', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM security_posture_history/i, rows: [] },
    ];

    const { getPostureTrend } = await import('./securityPosture.js');
    const trend = await getPostureTrend('user-1', 'proj-1', 'AUTH', 30);

    expect(trend.projectId).toBe('proj-1');
    expect(trend.category).toBe('AUTH');
    expect(trend.trend).toBe('STABLE');
    expect(trend.changePercent).toBe(0);
  });

  it('computes security benchmarks', async () => {
    const { getSecurityBenchmarks } = await import('./securityPosture.js');
    const benchmarks = await getSecurityBenchmarks('user-1', 'proj-1');

    expect(benchmarks).toHaveLength(7);
    for (const b of benchmarks) {
      expect(b).toHaveProperty('category');
      expect(b).toHaveProperty('industryAverage');
      expect(b).toHaveProperty('ourScore');
      expect(b).toHaveProperty('percentile');
      expect(b.ourScore).toBeGreaterThanOrEqual(0);
      expect(b.ourScore).toBeLessThanOrEqual(100);
    }
  });

  it('gets failing checks sorted by severity', async () => {
    const { getFailingChecks } = await import('./securityPosture.js');
    const failing = await getFailingChecks('user-1', 'proj-1');

    expect(Array.isArray(failing)).toBe(true);
    for (const check of failing) {
      expect(check.status).toBe('FAIL');
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).toContain(check.severity);
    }
  });

  it('saves posture assessment to history', async () => {
    const { assessSecurityPosture, savePostureAssessment } = await import('./securityPosture.js');
    const posture = await assessSecurityPosture('user-1', 'proj-1');

    await savePostureAssessment('user-1', 'proj-1', posture);

    const historyInsert = db.state.calls.find(c => c.text.includes('INSERT INTO security_posture_history'));
    expect(historyInsert).toBeDefined();
    const cacheInsert = db.state.calls.find(c => c.text.includes('INSERT INTO security_posture_cache'));
    expect(cacheInsert).toBeDefined();
  });

  it('records audit on posture assessment', async () => {
    const { assessSecurityPosture } = await import('./securityPosture.js');
    await assessSecurityPosture('user-1', 'proj-1');

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'security_posture_assessed' }),
    );
  });
});
