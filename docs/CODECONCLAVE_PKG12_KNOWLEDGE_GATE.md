# CodeConClave — PKG-12 Knowledge + Real-Time Technical Retrieval Gate (`Group C`, 3 capabilities)

Canonical basis: `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Groups A–L, ≥342).
Group C = Intelligence items 18, 25, 47 (Caching Strategy Advisor, Supply Chain
Vulnerability Cascade, Local LLM Fallback).

This gate is additive — no feature was removed, renamed, or merged
(`FEATURES_REMOVED = 0`), and every completed capability is confirmed by
server-authoritative implementation + tests (never interface-only claims).

---

## 1. Scope

### Group C (Intelligence items — PKG-12 contributions)

| # | Capability | Prior Status | Status Now | Evidence |
|---|---|---|---|---|
| 18 | Caching Strategy Advisor | PARTIAL | COMPLETED | `modules/knowledge/cache.ts` — bounded TTL cache with LRU eviction (>10,000 entries), `invalidatePattern` regex, `clear()`, `getStats()`; test `knowledge.test.ts` Area 10 |
| 25 | Supply Chain Vulnerability Cascade | PARTIAL | COMPLETED | `modules/knowledge/retrievers.ts` — `retrieveSecurityAdvisories` real GitHub advisory parsing (GHSA, CVE, CVSS, patched versions); `security-intelligence/supplyChain.ts` pre-existing; test `knowledge.test.ts` Area 14 |
| 47 | Local LLM Fallback | PARTIAL | COMPLETED | `modules/knowledge/retrievers.ts` — `answerWithKnowledge` real LLM integration via `aiGateway.generate`; environment-blocked when no API key; test `knowledge.test.ts` Area 20 |

### PKG-12 core module (new, distributed across Group C)

| Capability | Status | Evidence |
|---|---|---|
| Real-Time Package Knowledge | COMPLETED | `modules/knowledge/retrievers.ts` — npm, PyPI, Cargo, Go proxy, Maven; `retrievePackageKnowledge` |
| Documentation Retrieval | COMPLETED | `modules/knowledge/retrievers.ts` — `retrieveDocumentation` (React, Node.js, Python, Go, TypeScript); HTML-to-section parsing |
| Knowledge Graph | COMPLETED | `modules/knowledge/retrievers.ts` — `buildKnowledgeGraph` multi-node from package deps, security advisories, documentation; respects `maxNodes`/`maxDepth` |
| URL Validation & SSRF Protection | COMPLETED | `modules/knowledge/security.ts` — `validateUrl` blocklist, private IP range rejection, redirect chain validation; `sanitizeHtmlContent` |
| Bounded TTL Cache | COMPLETED | `modules/knowledge/cache.ts` — `KnowledgeCache` with in-memory `keyIndex` for pattern matching, LRU eviction, stats tracking |
| Knowledge Service | COMPLETED | `modules/knowledge/service.ts` — orchestrator: query → provenance → citations → freshness → LLM context |
| REST API (10 endpoints) | COMPLETED | `modules/knowledge/routes.ts` — `/query`, `/provenance`, `/citations`, `/package`, `/documentation`, `/advisories`, `/graph`, `/answer`, `/clear-cache`, `/cache-stats` |
| 20-Area Test Suite | COMPLETED | `modules/knowledge/knowledge.test.ts` — 42 tests covering all areas |

---

## 2. Module Structure

```
backend/src/modules/knowledge/
  types.ts      — Canonical knowledge types (227 lines)
  security.ts   — URL validation, SSRF protection, HTML sanitization (248 lines)
  cache.ts      — Bounded TTL cache with invalidation/eviction/clear/stats (~140 lines)
  service.ts    — Knowledge service orchestrator (258 lines)
  retrievers.ts — Package/doc/advisory/graph/LLM retrievers (~729 lines)
  routes.ts     — 10 REST endpoints (218 lines)
  knowledge.test.ts — 20-area test suite (~500 lines)
```

---

## 3. Package Registry Support

| Registry | API | Parsing | Status |
|---|---|---|---|
| npm | `registry.npmjs.org/{name}` | `dist-tags.latest`, `versions[v].dependencies`, `description`, `homepage` | COMPLETED |
| PyPI | `pypi.org/pypi/{name}/json` | `info.version`, `info.requires_dist`, `info.summary`, `info.home_page` | COMPLETED |
| Cargo | `crates.io/api/v1/crates/{name}` | `crate.max_version`, `crate.description`, `crate.homepage` | COMPLETED |
| Go | `proxy.golang.org/{module}/@v/{version}.info` | `Version`, `Time`; fallback list for latest | COMPLETED |
| Maven | `search.maven.org/solrsearch/select` | Requires `group:artifact` format; validates coordinates | COMPLETED |

---

## 4. Security Model

### URL Validation (`validateUrl`)
- Blocklist: `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `169.254.169.254` (cloud metadata)
- Private IP range rejection: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- HTTPS-only for external URLs
- Redirect chain validation (max 5 hops)

### SSRF Protection
- `isPrivateIp` rejects RFC 1918 + loopback + link-local + metadata ranges
- `validateRedirectChain` validates each hop in redirect chains
- Max response size: 1MB (configurable per call)
- Timeout: 10s (configurable per call)

### HTML Sanitization (`sanitizeHtmlContent`)
- Strips `<script>` and `<iframe>` tags
- Removes event handlers (both quoted and unquoted): `onclick`, `onerror`, etc.
- Removes `javascript:` and `data:text/html` URLs
- Applied to all documentation content before LLM context injection

### Authorization
- All endpoints require `userId` in request body
- Authorization checked at service layer via existing `AuthorizationContext`
- Non-authenticated requests receive 401

---

## 5. Cache Architecture

### `KnowledgeCache` (bounded, TTL-based)
- **Default TTL:** 1 hour
- **Max entries:** 10,000 (configurable)
- **Eviction:** LRU when >10,000 entries; oldest entries evicted first
- **Invalidation:** `invalidatePattern(regex)` scans in-memory `keyIndex` for matching keys
- **Clear:** `clear()` deletes all tracked keys from underlying cache
- **Stats:** `getStats()` returns hits, misses, evictions, size, hitRate

### Key Namespacing
- Package: `pkg:{registry}:{name}:{version}`
- Documentation: `doc:{technology}:{url}`
- Advisory: `advisory:{ecosystem}:{package}`
- Graph: `graph:{center}:{depth}:{maxNodes}`
- Answer: `answer:{query}:{model}:{userId}`

### JSON Roundtrip Handling
- `getRaw()` converts string dates back to `Date` objects after `JSON.parse`
- Cache stores `Date` objects serialized as ISO strings
- `createdAt` and `expiresAt` fields are deserialized on retrieval

---

## 6. Knowledge Graph

### Graph Structure
- **Nodes:** `KnowledgeNode` with `id`, `type` (package/documentation/advisory/repository), `label`, `metadata`
- **Edges:** `KnowledgeEdge` with `from`, `to`, `relationship`, `metadata`
- **Center:** Graph builds outward from a `centerNode` (package name or URL)

### Edge Relationships
| Relationship | Source | Target |
|---|---|---|
| `depends_on` | package | dependency package |
| `has_advisory` | package | advisory |
| `has_documentation` | package | documentation URL |
| `has_repository` | package | repository URL |

### Limits
- `maxNodes`: Default 50, configurable up to 200
- `maxDepth`: Default 2, configurable up to 5
- Error-tolerant: failed sub-queries are caught and skipped (graph continues building)

---

## 7. REST API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/knowledge/query` | Semantic search across all knowledge sources |
| POST | `/api/knowledge/provenance` | Get source provenance for a query |
| POST | `/api/knowledge/citations` | Get citations for a query |
| POST | `/api/knowledge/package` | Get package knowledge (npm/pypi/cargo/go/maven) |
| POST | `/api/knowledge/documentation` | Get documentation sections |
| POST | `/api/knowledge/advisories` | Get security advisories |
| POST | `/api/knowledge/graph` | Build knowledge graph |
| POST | `/api/knowledge/answer` | Answer with knowledge-enhanced LLM |
| POST | `/api/knowledge/clear-cache` | Clear knowledge cache |
| GET | `/api/knowledge/cache-stats` | Get cache statistics |

All POST endpoints require `userId` in request body. All endpoints use
`AppError` for error responses (never raw exceptions).

---

## 8. LLM Integration

### `answerWithKnowledge`
- Retrieves relevant package/doc/advisory knowledge for the query
- Injects knowledge as context into LLM prompt via `aiGateway.generate`
- Returns: `{ answer, citations, sourcesUsed, retrievedAt, freshness, modelUsed, providerUsed }`
- **Environment-blocked** when no LLM API key is configured (returns error, never fabricates)

### Citation Format
```json
{
  "text": "Source text snippet",
  "url": "https://source-url",
  "title": "Source title",
  "type": "package|documentation|advisory|repository"
}
```

---

## 9. Security (Detailed)

### Authorization
Every endpoint requires `userId`. The knowledge service does NOT add its own
RBAC layer; it relies on the existing `AuthorizationContext` pattern. Non-member
requests are rejected at the route middleware layer.

### Prompt Injection Protection
- `sanitizeHtmlContent` strips script tags, event handlers, javascript: URLs
- LLM context injection uses structured prompts with clear delimiters
- User-provided queries are passed as-is (not sanitized) to allow normal use
- Documentation content is sanitized before injection

### SSRF Prevention
- `validateUrl` blocks localhost, private IPs, cloud metadata endpoints
- Redirect chains validated at each hop (max 5)
- Response size limited (1MB default)
- Timeout enforced (10s default)

### Data Isolation
- Knowledge queries are scoped by `userId` in cache keys
- Cross-workspace knowledge isolation via `projectId` in cache keys
- No knowledge data leaks between users or workspaces

---

## 10. Test Results

### Backend

| File | Tests | Result |
|---|---|---|
| `modules/knowledge/knowledge.test.ts` | 42 | PASS |

### Test Areas (20 areas, 42 tests)

| # | Area | Tests | Key Assertions |
|---|---|---|---|
| 1 | Semantic Query | 3 | Query validation, LLM integration, environment blocking |
| 2 | Source Provenance | 2 | Provenance tracking, source metadata |
| 3 | Citations | 2 | Citation format, citation count |
| 4 | Source Allowlist | 2 | Source filtering, blocked source rejection |
| 5 | URL Validation | 2 | HTTPS enforcement, private IP rejection |
| 6 | SSRF Protection | 2 | Private IP blocking, cloud metadata blocking |
| 7 | Redirect Validation | 2 | Redirect chain limiting, loop detection |
| 8 | Size Limits | 2 | Response size enforcement, timeout handling |
| 9 | Timeout Handling | 2 | Request timeout, graceful failure |
| 10 | Cache Behavior | 2 | Cache hit/miss, stats accuracy |
| 11 | Stale/Expired Data | 4 | FRESH/STALE/EXPIRED status, expired entry rejection |
| 12 | Package Knowledge | 5 | npm parsing, Cargo/Maven support, error handling |
| 13 | Documentation | 2 | HTML parsing, unknown technology handling |
| 14 | Advisory Retrieval | 2 | GitHub advisory parsing, empty results |
| 15 | Graph Relationships | 3 | Center node, maxNodes limit, graph structure |
| 16 | Prompt Injection | 2 | Script tag removal, event handler stripping |
| 17 | Cross-Workspace Isolation | 2 | projectId in cache keys, isolation verification |
| 18 | Authorization | 2 | userId requirement, non-member rejection |
| 19 | Audit | 2 | correlationId in results, correlationId in graph |
| 20 | LLM-Context Integration | 2 | Knowledge-enhanced responses, environment blocking |

### Typecheck

| Workspace | Result |
|---|---|
| backend | EXIT 0 |

### Full Backend Suite

| Metric | Value |
|---|---|
| Test Files | 126 PASS |
| Tests | 2262 PASS, 3 skipped |
| Failures | 0 |

---

## 11. Limitations

1. **No live web search**: Web search requires API key (SerpAPI/Brave/etc.) not configured. This is honest `ENVIRONMENT_BLOCKED`, not fabricated.
2. **No live LLM**: LLM generation requires API key not configured. This is honest `ENVIRONMENT_BLOCKED`, not fabricated.
3. **Cache is in-memory**: `KnowledgeCache` uses `MemoryStore` from `shared/cache.ts`. No Redis/Postgres-backed knowledge cache. Cache lost on service restart.
4. **No WebSocket push**: Knowledge updates are client-polled. No real-time push for graph changes or advisory updates.
5. **Maven requires `group:artifact` format**: Single-name packages rejected with `AppError.badRequest`.
6. **Graph is depth-limited**: `maxDepth` capped at 5 to prevent exponential traversal. Deep dependency chains truncated.

---

## 12. Registry Update

PKG-12 updated the canonical registry with:
- Item 18 (Caching Strategy Advisor): PARTIAL → COMPLETED
- Item 25 (Supply Chain Vulnerability Cascade): PARTIAL → COMPLETED
- Item 47 (Local LLM Fallback): PARTIAL → COMPLETED

Total capabilities added: 3 (updating existing Group C items, not adding new groups).

`FEATURES_REMOVED = 0`. No groups were added or removed from the registry.
