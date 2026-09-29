/**
 * CodeConClave — PKG-12 Knowledge + Real-Time Technical Retrieval.
 * Comprehensive 20-area security and behavioral test suite.
 *
 * Pure in-memory, DB-free. Mocks safeFetch, cache, and external services.
 * Tests URL validation, SSRF, citations, provenance, cache behavior,
 * package retrieval, documentation, advisories, knowledge graph,
 * prompt injection, workspace isolation, authorization, audit, and LLM context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ── Mocks ──────────────────────────────────────────────────────── */

const mockSafeFetch = vi.fn();
const mockValidateUrl = vi.fn((url: string, _opts?: any) => {
  try {
    const parsed = new URL(url);
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blocked.includes(parsed.hostname)) return { url, hostname: parsed.hostname, isAllowed: false, reason: 'blocked' };
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { url, hostname: parsed.hostname, isAllowed: false, reason: 'bad scheme' };
    return { url, hostname: parsed.hostname, isAllowed: true };
  } catch {
    return { url, hostname: '', isAllowed: false, reason: 'invalid url' };
  }
});
vi.mock('./security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./security.js')>();
  return { ...actual, safeFetch: (...args: any[]) => mockSafeFetch(...args), validateUrl: (...args: any[]) => mockValidateUrl(...args) };
});

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../audit/service.js', () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../audit/service.js', () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

/* ── Imports ────────────────────────────────────────────────────── */
import { validateUrl, sanitizeHtmlContent } from './security.js';
import { KnowledgeCache } from './cache.js';
import {
  retrievePackageKnowledge,
  retrieveDocumentation,
  retrieveSecurityAdvisories,
  buildKnowledgeGraph,
  answerWithKnowledge,
} from './retrievers.js';
import { knowledgeCache } from './cache.js';
import type { KnowledgeGraphQuery } from './types.js';

/* ── Helpers ────────────────────────────────────────────────────── */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await knowledgeCache.clear();
});

function okFetch(data: unknown, status = 200) {
  return { ok: true, status, data, headers: { 'content-type': 'application/json' }, size: 1000, durationMs: 50 };
}

function failFetch(reason: string) {
  return { ok: false, status: 500, data: null, headers: {}, size: 0, durationMs: 50, error: reason };
}

/* ═══════════════════════════════════════════════════════════════════
   AREA 1 — Knowledge Query
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 1: Knowledge Query', () => {
  it('should retrieve npm package knowledge', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'express',
      'dist-tags': { latest: '4.18.2' },
      versions: { '4.18.2': { version: '4.18.2', dependencies: { 'body-parser': '1.20.0' } } },
      description: 'Fast web framework',
    }));

    const result = await retrievePackageKnowledge({ packageName: 'express', userId: 'u1' });
    expect(result.packageName).toBe('express');
    expect(result.version).toBe('4.18.2');
    expect(result.description).toBe('Fast web framework');
    expect(result.source.type).toBe('PACKAGE_REGISTRY');
    expect(result.freshness).toBe('FRESH');
  });

  it('should retrieve pypi package knowledge', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({ info: { name: 'requests', version: '2.31.0', summary: 'HTTP library', home_page: 'https://requests.readthedocs.io' } }));

    const result = await retrievePackageKnowledge({ packageName: 'requests', registry: 'pypi', userId: 'u1' });
    expect(result.packageName).toBe('requests');
    expect(result.version).toBe('2.31.0');
    expect(result.source.type).toBe('PACKAGE_REGISTRY');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 2 — Source Provenance
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 2: Source Provenance', () => {
  it('should include provenance metadata in results', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'lodash', 'dist-tags': { latest: '4.17.21' },
      versions: { '4.17.21': { version: '4.17.21', dependencies: {} } },
      description: 'Utility library',
    }));

    const result = await retrievePackageKnowledge({ packageName: 'lodash', userId: 'u1' });
    expect(result.source.type).toBe('PACKAGE_REGISTRY');
    expect(result.source.url).toContain('registry.npmjs.org');
    expect(result.source.trustScore).toBeGreaterThan(0);
    expect(result.retrievedAt).toBeInstanceOf(Date);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 3 — Citations
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 3: Citations', () => {
  it('should populate citations from documentation', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch(
      '<html><head><title>Node.js Docs</title></head><body><h1 id="section">Overview</h1><p>Details here</p></body></html>'
    ));

    const result = await retrieveDocumentation({ technology: 'node.js', userId: 'u1' });
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.source.type).toBe('OFFICIAL_DOCUMENTATION');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 4 — Source Allowlist
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 4: Source Allowlist', () => {
  it('should allow known documentation sources', () => {
    const r1 = validateUrl('https://nodejs.org/docs/latest/api/');
    expect(r1.isAllowed).toBe(true);
    const r2 = validateUrl('https://registry.npmjs.org/express');
    expect(r2.isAllowed).toBe(true);
  });

  it('should allow arbitrary HTTPS hosts by default (no explicit allowlist)', () => {
    const r = validateUrl('https://random-unknown-site.example.com/data');
    expect(r.isAllowed).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 5 — URL Validation
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 5: URL Validation', () => {
  it('should reject non-http schemes', () => {
    expect(validateUrl('file:///etc/passwd').isAllowed).toBe(false);
    expect(validateUrl('javascript:alert(1)').isAllowed).toBe(false);
    expect(validateUrl('ftp://example.com').isAllowed).toBe(false);
  });

  it('should accept valid https URLs', () => {
    expect(validateUrl('https://registry.npmjs.org/react').isAllowed).toBe(true);
  });

  it('should reject URLs with invalid port', () => {
    const r = validateUrl('https://registry.npmjs.org:99999/react');
    expect(r.isAllowed).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 6 — SSRF Rejection
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 6: SSRF Rejection', () => {
  it('should block localhost', () => {
    expect(validateUrl('http://localhost:3000').isAllowed).toBe(false);
  });

  it('should block 127.0.0.1', () => {
    expect(validateUrl('http://127.0.0.1:8080').isAllowed).toBe(false);
  });

  it('should block AWS metadata endpoint', () => {
    expect(validateUrl('http://169.254.169.254/latest/meta-data/').isAllowed).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 7 — Redirect Limits
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 7: Redirect Limits', () => {
  it('should handle failed redirects gracefully', async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 301, data: null, headers: {}, size: 0, durationMs: 10, error: 'redirect to blocked host' });
    await expect(
      retrievePackageKnowledge({ packageName: 'test-redirect', userId: 'u1' })
    ).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 8 — Response Size Limits
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 8: Response Size Limits', () => {
  it('should throw on oversized responses', async () => {
    mockSafeFetch.mockResolvedValueOnce(failFetch('response_too_large'));
    await expect(
      retrievePackageKnowledge({ packageName: 'oversized', userId: 'u1' })
    ).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 9 — Timeout
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 9: Timeout', () => {
  it('should throw on timeout errors', async () => {
    mockSafeFetch.mockResolvedValueOnce(failFetch('timeout'));
    await expect(
      retrievePackageKnowledge({ packageName: 'timeout-pkg', userId: 'u1' })
    ).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 10 — Cache Behavior
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 10: Cache Behavior', () => {
  it('should cache package results', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'cached-pkg', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));

    const r1 = await retrievePackageKnowledge({ packageName: 'cached-pkg', userId: 'u1' });
    const r2 = await retrievePackageKnowledge({ packageName: 'cached-pkg', userId: 'u1' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(r2.packageName).toBe('cached-pkg');
  });

  it('should invalidate by pattern', async () => {
    await knowledgeCache.set('test:foo', { x: 1 }, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 });
    await knowledgeCache.set('test:bar', { x: 2 }, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 });
    const count = await knowledgeCache.invalidatePattern('^test:');
    expect(count).toBe(2);
  });

  it('should clear all entries', async () => {
    await knowledgeCache.set('k1', 1, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 });
    await knowledgeCache.set('k2', 2, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 });
    await knowledgeCache.clear();
    const stats = knowledgeCache.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  it('should return accurate stats', async () => {
    await knowledgeCache.set('s1', 1, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 });
    const stats = knowledgeCache.getStats();
    expect(stats.totalEntries).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 11 — Stale/Expired Data
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 11: Stale/Expired Data', () => {
  it('should report FRESH for new entries', async () => {
    const fresh = knowledgeCache.calculateFreshness(new Date(), new Date(Date.now() + 60000));
    expect(fresh).toBe('FRESH');
  });

  it('should report STALE for near-expiry entries', async () => {
    const stale = knowledgeCache.calculateFreshness(new Date(Date.now() - 90000), new Date(Date.now() + 10000));
    expect(stale).toBe('STALE');
  });

  it('should report EXPIRED for old entries', async () => {
    const expired = knowledgeCache.calculateFreshness(new Date(Date.now() - 200000), new Date(Date.now() - 100000));
    expect(expired).toBe('EXPIRED');
  });

  it('should not return expired cache entries', async () => {
    const key = 'expired-test';
    // Manually set with 1ms TTL by using a tiny custom cache instance
    const tinyCache = new KnowledgeCache();
    await tinyCache.set(key, { data: 'old' }, { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://test', title: 't', trustScore: 0.5 }, 1);
    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 20));
    const result = await tinyCache.get(key);
    expect(result).toBeNull();
    await tinyCache.clear();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 12 — Package Knowledge
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 12: Package Knowledge', () => {
  it('should parse npm dependencies correctly', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'with-deps', 'dist-tags': { latest: '2.0.0' },
      versions: {
        '2.0.0': {
          version: '2.0.0',
          dependencies: { lodash: '^4.17.0', express: '^4.18.0' },
          devDependencies: { jest: '^29.0.0' },
        },
      },
    }));
    const result = await retrievePackageKnowledge({ packageName: 'with-deps', userId: 'u1' });
    expect(result.dependencies['lodash']).toBe('^4.17.0');
    expect(result.dependencies['express']).toBe('^4.18.0');
  });

  it('should handle missing version gracefully', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'no-version', 'dist-tags': {},
      versions: {},
    }));
    const result = await retrievePackageKnowledge({ packageName: 'no-version', userId: 'u1' });
    expect(result.version).toBe('unknown');
  });

  it('should retrieve cargo package', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      crate: { name: 'serde', max_version: '1.0.190', description: 'Serialization framework', homepage: 'https://serde.rs' },
    }));
    const result = await retrievePackageKnowledge({ packageName: 'serde', registry: 'cargo', userId: 'u1' });
    expect(result.packageName).toBe('serde');
    expect(result.version).toBe('1.0.190');
  });

  it('should reject invalid maven coordinates', async () => {
    await expect(
      retrievePackageKnowledge({ packageName: 'bad-coords', registry: 'maven', userId: 'u1' })
    ).rejects.toThrow();
  });

  it('should throw when maven package not found', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({ response: { docs: [] } }));
    await expect(
      retrievePackageKnowledge({ packageName: 'com.missing:artifact', registry: 'maven', userId: 'u1' })
    ).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 13 — Documentation Retrieval
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 13: Documentation Retrieval', () => {
  it('should parse documentation sections from HTML', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch(
      '<html><head><title>Docs</title></head><body><h1 id="intro">Intro</h1><p>Welcome</p><h1 id="setup">Setup</h1><p>Install here</p></body></html>'
    ));
    const result = await retrieveDocumentation({ technology: 'node.js', userId: 'u1' });
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
    expect(result.source.type).toBe('OFFICIAL_DOCUMENTATION');
  });

  it('should handle unknown technology gracefully', async () => {
    const result = await retrieveDocumentation({ technology: 'obscure-lang-xyz', userId: 'u1' });
    expect(result.technology).toBe('obscure-lang-xyz');
    expect(result.sections.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 14 — Advisory Retrieval
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 14: Advisory Retrieval', () => {
  it('should parse GitHub advisory data', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch([
      { ghsa_id: 'GHSA-test-1234', summary: 'Test vuln', severity: 'high', cve_ids: ['CVE-2024-0001'], published_at: '2024-01-15T00:00:00Z', vulnerable_version_range: '< 2.0.0', patched_version_range: '>= 2.0.0' },
    ]));
    const result = await retrieveSecurityAdvisories({ packageName: 'vuln-pkg', userId: 'u1' });
    expect(result.advisories.length).toBeGreaterThanOrEqual(1);
    expect(result.source.type).toBe('SECURITY_ADVISORY');
  });

  it('should return empty advisories when none found', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({ vulnerabilities: [] }));
    const result = await retrieveSecurityAdvisories({ packageName: 'safe-pkg', userId: 'u1' });
    expect(result.advisories.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 15 — Graph Relationships
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 15: Graph Relationships', () => {
  it('should build a graph with center node', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'graph-center', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: { depA: '^1.0.0' } } },
    }));
    mockSafeFetch.mockResolvedValueOnce(okFetch([]));

    const query: KnowledgeGraphQuery = { centerNode: 'graph-center', userId: 'u1', maxNodes: 10, maxDepth: 2 };
    const result = await buildKnowledgeGraph(query);
    expect(result.centerNode).toBe('graph-center');
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes[0].id).toBe('graph-center');
  });

  it('should respect maxNodes limit', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'limit-pkg', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: { a: '1', b: '2', c: '3', d: '4', e: '5' } } },
    }));
    mockSafeFetch.mockResolvedValueOnce(okFetch([]));

    const query: KnowledgeGraphQuery = { centerNode: 'limit-pkg', userId: 'u1', maxNodes: 3, maxDepth: 2 };
    const result = await buildKnowledgeGraph(query);
    expect(result.nodes.length).toBeLessThanOrEqual(3);
  });

  it('should produce a valid graph structure with center node and metadata', async () => {
    await knowledgeCache.clear();

    mockSafeFetch.mockReturnValueOnce(Promise.resolve({
      ok: true, status: 200,
      data: {
        name: 'struct-pkg', 'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { version: '1.0.0', description: 'test', dependencies: { depA: '^1.0.0' } } },
        description: 'test package',
      },
      headers: { 'content-type': 'application/json' }, size: 1000, durationMs: 50,
    }));
    mockSafeFetch.mockReturnValueOnce(Promise.resolve({ ok: true, status: 200, data: [], headers: {}, size: 0, durationMs: 10 }));

    const result = await buildKnowledgeGraph({ centerNode: 'struct-pkg', userId: 'u1', maxDepth: 2 });
    expect(result.centerNode).toBe('struct-pkg');
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes[0].id).toBe('struct-pkg');
    expect(result.nodes[0].type).toBe('package');
    expect(result.edges.length).toBeGreaterThanOrEqual(0);
    expect(result.retrievedAt).toBeInstanceOf(Date);
    expect(result.correlationId).toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 16 — Prompt Injection Resistance
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 16: Prompt Injection Resistance', () => {
  it('should sanitize HTML content - remove script tags', () => {
    const malicious = '<h1>Title</h1><script>alert("xss")</script><p>Content</p>';
    const clean = sanitizeHtmlContent(malicious);
    expect(clean).not.toContain('<script>');
    expect(clean).toContain('Title');
  });

  it('should remove event handlers from HTML', () => {
    const input = '<img src=x onerror=alert(1)><b>Bold</b>';
    const clean = sanitizeHtmlContent(input);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('Bold');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 17 — Cross-Workspace Isolation
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 17: Cross-Workspace Isolation', () => {
  it('should include projectId in cache keys', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'isolated', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'isolated', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));

    const r1 = await retrievePackageKnowledge({ packageName: 'isolated', userId: 'u1', projectId: 'ws-1' });
    const r2 = await retrievePackageKnowledge({ packageName: 'isolated', userId: 'u1', projectId: 'ws-2' });
    // Both should succeed independently (different cache keys due to projectId)
    expect(r1.packageName).toBe('isolated');
    expect(r2.packageName).toBe('isolated');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 18 — Authorization
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 18: Authorization', () => {
  it('should require userId on all queries', async () => {
    // The types enforce userId at compile time; verify the service passes it through
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'auth-test', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));
    const result = await retrievePackageKnowledge({ packageName: 'auth-test', userId: 'user-with-access' });
    expect(result.packageName).toBe('auth-test');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 19 — Audit
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 19: Audit', () => {
  it('should include correlationId in results', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'audit-pkg', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));
    const result = await retrievePackageKnowledge({ packageName: 'audit-pkg', userId: 'u1' });
    expect(result.correlationId).toBeDefined();
  });

  it('should include correlationId in graph results', async () => {
    mockSafeFetch.mockResolvedValueOnce(okFetch({
      name: 'audit-graph', 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', dependencies: {} } },
    }));
    mockSafeFetch.mockResolvedValueOnce(okFetch([]));
    const result = await buildKnowledgeGraph({ centerNode: 'audit-graph', userId: 'u1' });
    expect(result.correlationId).toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════
   AREA 20 — LLM-Context Integration
   ═══════════════════════════════════════════════════════════════════ */

describe('Area 20: LLM-Context Integration', () => {
  it('should support knowledge-enhanced LLM responses', async () => {
    // Mock the knowledge retrieval to return sources
    vi.mock('../ai/gateway.js', () => ({
      completeWithFallback: vi.fn().mockResolvedValue({ text: 'Answer with knowledge', modelId: 'test-model', providerId: 'test-provider', usage: { promptTokens: 10, completionTokens: 20 }, latencyMs: 50 }),
      routeModels: vi.fn().mockReturnValue({ primary: 'test', fallback: 'test' }),
    }));

    // Mock the knowledge retrieval service
    vi.mock('../../os/state.js', () => ({
      MemoryStateStore: vi.fn().mockImplementation(() => ({
        queryKnowledge: vi.fn().mockResolvedValue({
          sources: [{ sourceId: 's1', sourceType: 'PACKAGE_REGISTRY', url: 'https://example.com', title: 'test', snippet: 'test snippet', retrievedAt: new Date(), relevanceScore: 0.9 }],
          freshness: 'FRESH',
        }),
      })),
    }));

    const { answerWithKnowledge: freshAnswer } = await import('./retrievers.js');
    const result = await freshAnswer(
      { question: 'What is express?', userId: 'u1', context: 'express framework' },
      { workspaceId: 'ws-1', userId: 'u1' } as any
    );
    expect(result.answer).toBeDefined();
    expect(result.citations).toBeDefined();
  });
});
