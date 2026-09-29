/**
 * CodeConClave — Security Operations Intelligence Tests (PKG-15).
 * Covers Security Incident Response (#21), API Rate Limit Awareness (#22),
 * Network Resilience Checker (#23), Workspace Compliance Checker (#24),
 * the DB-backed incident/compliance persistence, and the honest capability
 * report. The DB, audit service, files service, and security-intelligence
 * dependencies are all mocked deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ----------------------------- Mocks ----------------------------- */

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: any[];
    incidentRow: any;
    incidenceSeed: number;
    queryOverrides: { pattern: RegExp; rows: any[]; rowCount?: number }[];
  } = {
    calls: [],
    rows: [],
    incidentRow: null,
    incidenceSeed: 0,
    queryOverrides: [],
  };

  const PROJECT_ROW = { id: 'prj-1' };

  const resolveRows = (text: string): { rows: any[]; rowCount: number } => {
    for (const o of state.queryOverrides) {
      if (o.pattern.test(text)) return { rows: o.rows, rowCount: o.rowCount ?? o.rows.length };
    }
    if (/FROM projects/i.test(text)) return { rows: [PROJECT_ROW], rowCount: 1 };
    if (/FROM secops_incidents/i.test(text)) return { rows: [state.incidentRow], rowCount: 1 };
    if (state.rows.length) return { rows: state.rows, rowCount: state.rows.length };
    return { rows: [PROJECT_ROW], rowCount: 1 };
  };

  const query = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    if (/^\s*UPDATE secops_incidents/i.test(text)) {
      const p = params ?? [];
      state.incidentRow = {
        ...state.incidentRow,
        status: p[0] ?? state.incidentRow.status,
        severity: p[1] ?? state.incidentRow.severity,
        response_action: p[2] ?? state.incidentRow.response_action,
        assignee_id: p[3] ?? state.incidentRow.assignee_id,
        summary: p[4] ?? state.incidentRow.summary,
        timeline: p[5] ?? state.incidentRow.timeline,
        updated_at: p[6] ?? state.incidentRow.updated_at,
      };
    }
    return resolveRows(text);
  };
  const queryMany = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text).rows;
  };

  return {
    state,
    pool: { query },
    queryMany,
  };
});

const mocks = vi.hoisted(() => ({
  recordAudit: vi.fn(async () => {}),
  mockGetFileContent: vi.fn(),
  mockListFiles: vi.fn(),
  mockRunApiSecurityScan: vi.fn(),
  mockAssessSecurityPosture: vi.fn(),
}));

vi.mock('../../shared/db.js', async () => {
  const client = { query: db.pool.query, queryMany: db.queryMany };
  return {
    pool: db.pool,
    queryMany: db.queryMany,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
  };
});

vi.mock('../audit/service.js', () => ({
  recordAudit: mocks.recordAudit,
}));

vi.mock('../../shared/ids.js', async () => {
  return {
    newId: vi.fn((_p: string) => `secdyn-${(db.state.incidenceSeed += 1)}`),
    PREFIX: {
      SECOPS_INCIDENT: 'soi',
      SECOPS_INCIDENT_EVENT: 'soe',
      SECOPS_RATE_AWARENESS: 'sra',
      SECOPS_NETWORK: 'sor',
      COMPLIANCE_REPORT: 'crp',
    },
  };
});

vi.mock('../files/service.js', () => ({
  getFileContent: (...args: unknown[]) => mocks.mockGetFileContent(...args),
  listFiles: (...args: unknown[]) => mocks.mockListFiles(...args),
}));

vi.mock('../security-intelligence/apiSecurity.js', () => ({
  runApiSecurityScan: (...args: unknown[]) => mocks.mockRunApiSecurityScan(...args),
}));

vi.mock('../security-intelligence/securityPosture.js', () => ({
  assessSecurityPosture: (...args: unknown[]) => mocks.mockAssessSecurityPosture(...args),
}));

/* ----------------------------- Imports ----------------------------- */

import { SecurityIncidentService } from './incidents.js';
import { assessRateLimitAwareness } from './rateLimitAwareness.js';
import { checkNetworkResilience } from './networkResilience.js';
import { runComplianceCheck, getComplianceHistory } from './compliance.js';
import { securityOperationsService } from './service.js';
import { AppError } from '../../shared/errors.js';

/* ----------------------------- Helpers ----------------------------- */

function makeIncidentRow(over: Record<string, unknown> = {}) {
  db.state.incidentRow = {
    id: 'soi-1',
    project_id: 'prj-1',
    title: 'Open secret in config',
    severity: 'HIGH',
    status: 'OPEN',
    response_action: 'REMEDIATE',
    description: 'Exposed API key',
    source: 'security scan',
    finding_ids: '["find-1"]',
    assignee_id: null,
    summary: null,
    created_by: 'usr-1',
    created_by_email: 'me@example.com',
    timeline: JSON.stringify([{ id: 'soe-1', at: '2026-01-01T00:00:00Z', actorId: 'usr-1', kind: 'CREATED', detail: 'created' }]),
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.calls = [];
  db.state.queryOverrides = [];
  db.state.rows = [];
  makeIncidentRow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* #21 Security Incident Response                                      */
/* ------------------------------------------------------------------ */

describe('#21 Security Incident Response', () => {
  it('creates an incident with audit logging and default status OPEN', async () => {
    const view = await SecurityIncidentService.create('usr-1', {
      projectId: 'prj-1',
      title: 'Open secret',
      severity: 'HIGH',
      responseAction: 'REMEDIATE',
    });
    expect(view.id).toBeTruthy();
    expect(view.status).toBe('OPEN');
    expect(view.severity).toBe('HIGH');
    expect(view.timeline[0].kind).toBe('CREATED');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO secops_incidents'))).toBe(true);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'security_incident.created', resourceType: 'security_incident' }),
    );
  });

  it('rejects an unknown project', async () => {
    db.state.queryOverrides.push({ pattern: /FROM projects/i, rows: [], rowCount: 0 });
    await expect(
      SecurityIncidentService.create('usr-1', { projectId: 'nope', title: 'x' }),
    ).rejects.toThrow(AppError);
  });

  it('lists incidents and filters by project', async () => {
    db.state.queryOverrides.push({ pattern: /SELECT i\.\*/i, rows: [db.state.incidentRow] });
    db.state.queryOverrides.push({ pattern: /ORDER BY created_at DESC/i, rows: [db.state.incidentRow] });
    const list = await SecurityIncidentService.list('usr-1', { projectId: 'prj-1' });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].projectId).toBe('prj-1');
  });

  it('updates status/severity/assignee/summary and appends timeline events', async () => {
    db.state.queryOverrides.push({ pattern: /ORDER BY created_at DESC/i, rows: [db.state.incidentRow] });
    const view = await SecurityIncidentService.update('usr-1', {
      projectId: 'prj-1',
      incidentId: 'soi-1',
      status: 'IN_PROGRESS',
      assigneeId: 'usr-2',
      summary: 'confirmed reproducible',
    });
    expect(view.status).toBe('IN_PROGRESS');
    expect(view.assigneeId).toBe('usr-2');
    const kinds = view.timeline.map((t) => t.kind);
    expect(kinds).toContain('STATUS');
    expect(kinds).toContain('ASSIGN');
    expect(kinds).toContain('NOTE');
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'security_incident.updated' }),
    );
  });

  it('rejects an incident id that does not belong to the project', async () => {
    db.state.incidentRow.project_id = 'other-prj';
    await expect(
      SecurityIncidentService.get('usr-1', 'prj-1', 'soi-1'),
    ).rejects.toThrow(AppError);
  });

  it('reports honest incident stats including open high/critical count', async () => {
    db.state.queryOverrides.push({ pattern: /GROUP BY status/i, rows: [] });
    db.state.queryOverrides.push({ pattern: /GROUP BY severity/i, rows: [] });
    db.state.queryOverrides.push({ pattern: /severity IN \(\$2,\$3\)/i, rows: [{ count: '2' }] });
    db.state.queryOverrides.push({ pattern: /COUNT\(\*\)::text AS count FROM secops_incidents WHERE project_id/i, rows: [{ count: '5' }] });
    const stats = await SecurityIncidentService.stats('usr-1', 'prj-1');
    expect(stats.total).toBe(5);
    expect(stats.openHighCritical).toBe(2);
    expect(stats.byStatus.OPEN).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* #22 API Rate Limit Awareness                                        */
/* ------------------------------------------------------------------ */

describe('#22 API Rate Limit Awareness', () => {
  it('builds an awareness report from the apiSecurity scan', async () => {
    mocks.mockRunApiSecurityScan.mockResolvedValueOnce({
      scanId: 's1',
      projectId: 'prj-1',
      endpoints: [
        {
          method: 'GET',
          path: '/v1/orders',
          security: {
            riskLevel: 'LOW',
            rateLimit: { enabled: true, strategy: 'token_bucket', limits: [{ endpoint: '/v1/orders', limit: 100, window: '1s' }], failClosed: true },
          },
        },
        {
          method: 'POST',
          path: '/v1/pay',
          security: { riskLevel: 'CRITICAL', rateLimit: { enabled: false, strategy: 'none', limits: [], failClosed: false } },
        },
      ],
      summary: { totalEndpoints: 2 },
    });
    const report = await assessRateLimitAwareness('usr-1', { projectId: 'prj-1' });
    expect(report.totalEndpoints).toBe(2);
    expect(report.rateLimitedEndpoints).toBe(1);
    expect(report.uncoveredEndpoints).toBe(1);
    expect(report.coveragePercent).toBe(50);
    expect(report.overall).toBe('PARTIAL');
    expect(report.failClosedEndpoints).toBe(1);
    expect(report.endpoints[0].state).toBe('VERIFIED');
    expect(report.endpoints[1].state).toBe('HEURISTIC');
    expect(mocks.mockRunApiSecurityScan).toHaveBeenCalled();
  });

  it('marks fully covered scan as COVERED', async () => {
    mocks.mockRunApiSecurityScan.mockResolvedValueOnce({
      scanId: 's1',
      projectId: 'prj-1',
      endpoints: [
        { method: 'GET', path: '/a', security: { riskLevel: 'LOW', rateLimit: { enabled: true, strategy: 'fixed_window', limits: [], failClosed: true } } },
      ],
      summary: { totalEndpoints: 1 },
    });
    const report = await assessRateLimitAwareness('usr-1', { projectId: 'prj-1' });
    expect(report.coveragePercent).toBe(100);
    expect(report.overall).toBe('COVERED');
  });
});

/* ------------------------------------------------------------------ */
/* #23 Network Resilience Checker                                      */
/* ------------------------------------------------------------------ */

describe('#23 Network Resilience Checker', () => {
  function textFile(fileId: string, path: string, code: string, mimeType = 'text/typescript') {
    mocks.mockGetFileContent.mockResolvedValueOnce({ buffer: Buffer.from(code, 'utf8'), mimeType, name: path });
    return { id: fileId, path, mimeType, projectId: 'prj-1', sizeBytes: code.length } as never;
  }

  it('detects resilient facets as PASS and reports a score', async () => {
    const code = `
      const circuit = new CircuitBreaker(fetch, { timeout: 5000 });
      const fallback = () => cached(order);
      await fetchWithRetry('/api/x', { retries: 3, exponentialBackoff: true });
      router.get('/health', handler);
      const c = new AbortController(); c.abort();
    `;
    mocks.mockListFiles.mockResolvedValueOnce([textFile('f1', 'src/net.ts', code)]);
    const rep = await checkNetworkResilience('usr-1', { projectId: 'prj-1' });
    const byFacet = rep.byFacet;
    expect(byFacet.CIRCUIT_BREAKER?.status).toBe('PASS');
    expect(byFacet.RETRY_BACKOFF?.status).toBe('PASS');
    expect(byFacet.TIMEOUTS?.status).toBe('PASS');
    expect(byFacet.HEALTH_CHECKS?.status).toBe('PASS');
    expect(byFacet.DEPENDENCY_RESILIENCE?.status).toBe('PASS');
    expect(rep.filesScanned).toBe(1);
    expect(rep.score).toBeGreaterThanOrEqual(0);
  });

  it('reports FAIL when no resilience markers are present', async () => {
    mocks.mockListFiles.mockResolvedValueOnce([textFile('f1', 'src/x.ts', 'export const x = 1;')]);
    const rep = await checkNetworkResilience('usr-1', { projectId: 'prj-1' });
    expect(rep.byFacet.CIRCUIT_BREAKER?.status).toBe('FAIL');
    expect(rep.byFacet.TIMEOUTS?.status).toBe('FAIL');
  });

  it('skips non-text and empty files and reports them', async () => {
    mocks.mockListFiles.mockResolvedValueOnce([
      { id: 'bin', path: 'a.png', mimeType: 'image/png', projectId: 'prj-1' } as never,
      { id: 'f2', path: 'src/e.ts', mimeType: 'text/typescript', projectId: 'prj-1' } as never,
    ]);
    mocks.mockGetFileContent.mockResolvedValueOnce({ buffer: Buffer.from('', 'utf8'), mimeType: 'text/typescript', name: 'src/e.ts' });
    const rep = await checkNetworkResilience('usr-1', { projectId: 'prj-1' });
    expect(rep.filesSkipped).toBe(2);
    expect(rep.byFacet.CIRCUIT_BREAKER?.status).toBe('SKIP');
  });
});

/* ------------------------------------------------------------------ */
/* #24 Workspace Compliance Checker                                    */
/* ------------------------------------------------------------------ */

function makePosture() {
  return {
    projectId: 'prj-1',
    overallScore: 72,
    overallLevel: 'FAIR',
    categories: [
      {
        category: 'API',
        score: 80,
        checks: [
          { id: 'c1', category: 'API', name: 'Rate limit', description: 'd', evidence: 'e', status: 'PASS', severity: 'LOW', remediation: 'none' },
        ],
      },
      {
        category: 'SECRETS',
        score: 50,
        checks: [
          { id: 'c2', category: 'SECRETS', name: 'No secrets', description: 'd', evidence: 'e', status: 'FAIL', severity: 'HIGH', remediation: 'rotate' },
        ],
      },
    ],
  };
}

describe('#24 Workspace Compliance Checker', () => {
  it('aggregates a compliance report and persists it', async () => {
    mocks.mockAssessSecurityPosture.mockResolvedValueOnce(makePosture());
    const rep = await runComplianceCheck('usr-1', { projectId: 'prj-1' });
    expect(rep.projectId).toBe('prj-1');
    expect(rep.overallScore).toBe(72);
    expect(rep.overallStatus).toBe('PARTIAL');
    expect(rep.items.some((i) => i.title === 'No secrets')).toBe(true);
    expect(rep.items[0].state).toBe('VERIFIED');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO secops_compliance_reports'))).toBe(true);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'compliance.check.completed' }),
    );
  });

  it('keeps compliance history bounded', async () => {
    db.state.queryOverrides.push({ pattern: /ORDER BY generated_at DESC/i, rows: [{
      id: 'crp-1', project_id: 'prj-1', overall_score: 72, overall_status: 'PARTIAL',
      posture_score: 72, posture_level: 'FAIR', categories: '[]', items: '[]', generated_at: new Date(),
    }] });
    const history = await getComplianceHistory('usr-1', 'prj-1', 5);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].overallStatus).toBe('PARTIAL');
  });

  it('reports UNKNOWN compliance status for a zero/empty aggregate', async () => {
    mocks.mockAssessSecurityPosture.mockResolvedValueOnce({ ...makePosture(), overallScore: 0, categories: [] });
    const rep = await runComplianceCheck('usr-1', { projectId: 'prj-1' });
    expect(rep.overallStatus).toBe('UNKNOWN');
  });
});

/* ------------------------------------------------------------------ */
/* Capability report                                                   */
/* ------------------------------------------------------------------ */

describe('capability report', () => {
  it('reports the four capabilities as available and deterministic', () => {
    const report = securityOperationsService.getCapabilities();
    expect(Object.keys(report.capabilities)).toEqual(['SECURITY_INCIDENT', 'RATE_LIMIT_AWARENESS', 'NETWORK_RESILIENCE', 'COMPLIANCE']);
    for (const cap of Object.values(report.capabilities)) {
      expect(cap.status).toBe('AVAILABLE');
      expect(cap.deterministic).toBe(true);
      expect(cap.needsProvider).toBe(false);
    }
  });

  it('asserts known kinds and rejects unknown ones', () => {
    expect(securityOperationsService.assertKind('COMPLIANCE')).toBe('COMPLIANCE');
    expect(() => securityOperationsService.assertKind('NOPE')).toThrow(AppError);
  });
});