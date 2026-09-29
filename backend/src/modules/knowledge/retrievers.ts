/**
 * CodeConClave — Knowledge Retrievers (PKG-12).
 * Concrete implementations for web, documentation, package registry, and security advisory retrieval.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import {
  safeFetch,
  validateUrl,
  sanitizeHtmlContent,
  extractTitleFromHtml,
  extractMetaDescription,
} from './security.js';
import { knowledgeCache } from './cache.js';
import type {
  KnowledgeSource,
  KnowledgeSourceType,
  KnowledgeResult,
  KnowledgeCitation,
  KnowledgeFreshness,
  RetrievalOptions,
  PackageKnowledgeQuery,
  PackageKnowledgeResult,
  DocumentationQuery,
  DocumentationResult,
  SecurityAdvisoryQuery,
  SecurityAdvisoryResult,
  SecurityAdvisory,
  KnowledgeGraphQuery,
  KnowledgeGraphResult,
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeEdge,
  LLMKnowledgeRequest,
  LLMKnowledgeResponse,
} from './types.js';
import { completeWithFallback, type GatewayContext } from '../ai/gateway.js';
import { routeModels } from '../ai/gateway.js';

const OFFICIAL_DOC_SOURCES: Record<string, { baseUrl: string; type: KnowledgeSourceType }> = {
  'node.js': { baseUrl: 'https://nodejs.org/docs/latest/api/', type: 'OFFICIAL_DOCUMENTATION' },
  'typescript': { baseUrl: 'https://www.typescriptlang.org/docs/', type: 'OFFICIAL_DOCUMENTATION' },
  'react': { baseUrl: 'https://react.dev/learn/', type: 'OFFICIAL_DOCUMENTATION' },
  'next.js': { baseUrl: 'https://nextjs.org/docs/', type: 'OFFICIAL_DOCUMENTATION' },
  'python': { baseUrl: 'https://docs.python.org/3/', type: 'OFFICIAL_DOCUMENTATION' },
  'go': { baseUrl: 'https://go.dev/doc/', type: 'OFFICIAL_DOCUMENTATION' },
  'rust': { baseUrl: 'https://doc.rust-lang.org/', type: 'OFFICIAL_DOCUMENTATION' },
  'postgresql': { baseUrl: 'https://www.postgresql.org/docs/current/', type: 'OFFICIAL_DOCUMENTATION' },
  'redis': { baseUrl: 'https://redis.io/docs/', type: 'OFFICIAL_DOCUMENTATION' },
  'docker': { baseUrl: 'https://docs.docker.com/', type: 'OFFICIAL_DOCUMENTATION' },
  'kubernetes': { baseUrl: 'https://kubernetes.io/docs/home/', type: 'OFFICIAL_DOCUMENTATION' },
  'terraform': { baseUrl: 'https://developer.hashicorp.com/terraform/docs/', type: 'OFFICIAL_DOCUMENTATION' },
  'aws': { baseUrl: 'https://docs.aws.amazon.com/', type: 'OFFICIAL_DOCUMENTATION' },
  'gcp': { baseUrl: 'https://cloud.google.com/docs/', type: 'OFFICIAL_DOCUMENTATION' },
  'azure': { baseUrl: 'https://learn.microsoft.com/azure/', type: 'OFFICIAL_DOCUMENTATION' },
};

const PACKAGE_REGISTRIES: Record<string, { apiUrl: string; type: KnowledgeSourceType }> = {
  npm: { apiUrl: 'https://registry.npmjs.org/', type: 'PACKAGE_REGISTRY' },
  pypi: { apiUrl: 'https://pypi.org/pypi/', type: 'PACKAGE_REGISTRY' },
  cargo: { apiUrl: 'https://crates.io/api/v1/crates/', type: 'PACKAGE_REGISTRY' },
  go: { apiUrl: 'https://proxy.golang.org/', type: 'PACKAGE_REGISTRY' },
  maven: { apiUrl: 'https://search.maven.org/solrsearch/select?q=', type: 'PACKAGE_REGISTRY' },
};

const SECURITY_ADVISORY_SOURCES = {
  github: 'https://api.github.com/advisories',
  npm: 'https://registry.npmjs.org/-/npm/v1/security/advisories',
  osv: 'https://api.osv.dev/v1/query',
};

function generateCorrelationId(): string {
  return `knw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createCitation(
  sourceId: string,
  sourceType: KnowledgeSourceType,
  url: string,
  title: string,
  snippet: string,
  relevanceScore: number
): KnowledgeCitation {
  return {
    sourceId,
    sourceType,
    url,
    title,
    snippet,
    retrievedAt: new Date(),
    relevanceScore,
  };
}

export async function retrieveWebKnowledge(opts: RetrievalOptions): Promise<KnowledgeResult> {
  const correlationId = opts.correlationId ?? generateCorrelationId();
  const cacheKey = `web:${opts.query}:${opts.sourceTypes?.join(',') ?? 'all'}`;

  const cached = await knowledgeCache.get<KnowledgeResult>(cacheKey);
  if (cached && (!opts.requireFresh || cached.freshness !== 'STALE')) {
    return { ...cached.value, correlationId, cacheAgeMs: Date.now() - cached.value.retrievedAt.getTime() };
  }

  // For web retrieval, we'd typically use a search API
  // Since we don't have a configured search API, we return a structured "not available" result
  const result: KnowledgeResult = {
    id: correlationId,
    query: opts.query,
    answer: 'Live web retrieval is not configured. Configure a search API provider (e.g., SerpAPI, Brave Search, Google Custom Search) to enable this capability.',
    sources: [],
    retrievedAt: new Date(),
    freshness: 'UNAVAILABLE',
    retrievalStatus: 'SOURCE_UNAVAILABLE',
    correlationId,
  };

  await knowledgeCache.set(cacheKey, result, {
    type: 'GENERAL_WEB_SOURCE',
    url: 'internal://web-retrieval',
    title: 'Web Retrieval (Not Configured)',
    trustScore: 0,
  }, 5 * 60 * 1000); // 5 min cache for unavailable status

  return result;
}

export async function retrieveDocumentation(opts: DocumentationQuery): Promise<DocumentationResult> {
  const correlationId = generateCorrelationId();
  const cacheKey = `doc:${opts.technology}:${opts.topic ?? 'overview'}:${opts.version ?? 'latest'}`;

  const cached = await knowledgeCache.get<DocumentationResult>(cacheKey);
  if (cached) {
    return { ...cached.value, correlationId };
  }

  const techKey = opts.technology.toLowerCase();
  const docSource = OFFICIAL_DOC_SOURCES[techKey];

  if (!docSource) {
    const result: DocumentationResult = {
      technology: opts.technology,
      topic: opts.topic,
      content: `No official documentation source configured for ${opts.technology}. Add to OFFICIAL_DOC_SOURCES to enable.`,
      sections: [],
      source: { type: 'OFFICIAL_DOCUMENTATION', url: '', title: 'Not Configured', trustScore: 0 },
      retrievedAt: new Date(),
      freshness: 'UNAVAILABLE',
    };
    await knowledgeCache.set(cacheKey, result, { type: 'OFFICIAL_DOCUMENTATION', url: '', title: 'Not Configured', trustScore: 0 }, 60 * 60 * 1000);
    return result;
  }

  const targetUrl = opts.topic ? `${docSource.baseUrl}${encodeURIComponent(opts.topic)}` : docSource.baseUrl;
  const validation = validateUrl(targetUrl);

  if (!validation.isAllowed) {
    const result: DocumentationResult = {
      technology: opts.technology,
      topic: opts.topic,
      content: `Documentation URL blocked by security policy: ${validation.reason}`,
      sections: [],
      source: { type: docSource.type, url: targetUrl, title: opts.technology, trustScore: 0.8 },
      retrievedAt: new Date(),
      freshness: 'UNAVAILABLE',
    };
    return result;
  }

  const fetchResult = await safeFetch<string>(targetUrl, { maxSize: 5 * 1024 * 1024, timeoutMs: 15000 });

  if (!fetchResult.ok) {
    const result: DocumentationResult = {
      technology: opts.technology,
      topic: opts.topic,
      content: `Failed to retrieve documentation: ${fetchResult.error}`,
      sections: [],
      source: { type: docSource.type, url: targetUrl, title: opts.technology, trustScore: 0.8 },
      retrievedAt: new Date(),
      freshness: 'UNAVAILABLE',
    };
    return result;
  }

  const html = fetchResult.data!;
  const title = extractTitleFromHtml(html) ?? opts.technology;
  const description = extractMetaDescription(html) ?? '';

  // Extract main content (simplified - would use proper HTML parsing in production)
  const textContent = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000);

  const sections: DocumentationResult['sections'] = [];
  if (description) sections.push({ title: 'Description', content: description });
  sections.push({ title: 'Content', content: textContent });

  const result: DocumentationResult = {
    technology: opts.technology,
    topic: opts.topic,
    content: textContent,
    sections,
    source: { type: docSource.type, url: targetUrl, title, trustScore: 0.9 },
    retrievedAt: new Date(),
    freshness: 'FRESH',
  };

  await knowledgeCache.set(cacheKey, result, result.source, 60 * 60 * 1000);
  return result;
}

export async function retrievePackageKnowledge(opts: PackageKnowledgeQuery): Promise<PackageKnowledgeResult> {
  const correlationId = generateCorrelationId();
  const cacheKey = `pkg:${opts.registry ?? 'npm'}:${opts.packageName}:${opts.version ?? 'latest'}`;

  const cached = await knowledgeCache.get<PackageKnowledgeResult>(cacheKey);
  if (cached) {
    return { ...cached.value, correlationId };
  }

  const registry = opts.registry ?? 'npm';
  const registryInfo = PACKAGE_REGISTRIES[registry];

  if (!registryInfo) {
    throw AppError.badRequest('knowledge_unsupported_registry', `Registry ${registry} not supported`);
  }

  let apiUrl = `${registryInfo.apiUrl}${opts.packageName}`;
  if (opts.version && opts.version !== 'latest') {
    if (registry === 'npm') apiUrl += `/${opts.version}`;
  }

  const validation = validateUrl(apiUrl);
  if (!validation.isAllowed) {
    throw AppError.forbidden('knowledge_registry_blocked', `Registry URL blocked: ${validation.reason}`);
  }

  const fetchResult = await safeFetch<any>(apiUrl, { maxSize: 2 * 1024 * 1024, timeoutMs: 10000 });

  if (!fetchResult.ok) {
    throw AppError.unavailable('knowledge_package_fetch_failed', `Failed to fetch package info: ${fetchResult.error}`);
  }

  const data = fetchResult.data!;
  let result: PackageKnowledgeResult;

  if (registry === 'npm') {
    const version = opts.version ?? data['dist-tags']?.latest ?? Object.keys(data.versions ?? {})[0] ?? 'unknown';
    const versionData = data.versions?.[version] ?? {};
    result = {
      packageName: opts.packageName,
      version,
      latestVersion: data['dist-tags']?.latest,
      description: versionData.description ?? data.description ?? '',
      homepage: versionData.homepage ?? data.homepage,
      repository: versionData.repository?.url ?? data.repository?.url,
      license: versionData.license ?? data.license,
      keywords: versionData.keywords ?? data.keywords ?? [],
      dependencies: versionData.dependencies ?? {},
      devDependencies: versionData.devDependencies ?? {},
      documentationUrl: versionData.homepage,
      retrievedAt: new Date(),
      source: { type: registryInfo.type, url: apiUrl, title: opts.packageName, trustScore: 0.95 },
      freshness: 'FRESH',
      correlationId,
    };
  } else if (registry === 'pypi') {
    const info = data.info ?? {};
    const version = opts.version ?? info.version ?? 'unknown';
    result = {
      packageName: opts.packageName,
      version,
      latestVersion: info.version,
      description: info.summary ?? info.description ?? '',
      homepage: info.home_page,
      repository: info.project_urls?.Repository ?? info.project_urls?.Source,
      license: info.license,
      keywords: (info.keywords?.split(',').map((k: string) => k.trim()) ?? []) as string[],
      dependencies: (info.requires_dist?.reduce((acc: Record<string, string>, dep: string) => {
        const firstPart = dep.split(';')[0];
        if (!firstPart) return acc;
        const [name, ver] = firstPart.trim().split(/[<>!=]=?/);
        if (name) acc[name.trim()] = ver?.trim() ?? '*';
        return acc;
      }, {}) ?? {}) as Record<string, string>,
      documentationUrl: info.docs_url ?? info.home_page,
      retrievedAt: new Date(),
      source: { type: registryInfo.type, url: apiUrl, title: opts.packageName, trustScore: 0.95 },
      freshness: 'FRESH',
      correlationId,
    };
  } else if (registry === 'cargo') {
    const crate = data.crate ?? data;
    result = {
      packageName: opts.packageName,
      version: opts.version ?? crate.max_version ?? 'unknown',
      latestVersion: crate.max_version,
      description: crate.description ?? '',
      homepage: crate.homepage,
      repository: crate.repository,
      license: crate.license ?? null,
      keywords: crate.keywords ?? [],
      dependencies: {},
      documentationUrl: crate.documentation ?? crate.homepage,
      retrievedAt: new Date(),
      source: { type: registryInfo.type, url: apiUrl, title: opts.packageName, trustScore: 0.95 },
      freshness: 'FRESH',
      correlationId,
    };
  } else if (registry === 'go') {
    const modulePath = opts.packageName;
    const version = opts.version ?? 'latest';
    const infoUrl = version === 'latest'
      ? `${registryInfo.apiUrl}${modulePath}/@v/list`
      : `${registryInfo.apiUrl}${modulePath}/@v/${version}.info`;
    const infoValidation = validateUrl(infoUrl);
    if (!infoValidation.isAllowed) {
      throw AppError.forbidden('knowledge_registry_blocked', `Registry URL blocked: ${infoValidation.reason}`);
    }
    const infoResult = await safeFetch<any>(infoUrl, { maxSize: 512 * 1024, timeoutMs: 10000 });
    let resolvedVersion = version;
    if (infoResult.ok && typeof infoResult.data === 'string') {
      const lines = infoResult.data.trim().split('\n');
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const vMatch = lastLine?.match(/^v(.+)/);
        if (vMatch?.[1]) resolvedVersion = vMatch[1];
      }
    }
    result = {
      packageName: opts.packageName,
      version: resolvedVersion,
      latestVersion: resolvedVersion,
      description: `Go module ${modulePath}`,
      homepage: `https://pkg.go.dev/${modulePath}`,
      repository: modulePath.startsWith('github.com/') ? `https://${modulePath}` : undefined,
      license: undefined,
      keywords: [],
      dependencies: {},
      documentationUrl: `https://pkg.go.dev/${modulePath}@${resolvedVersion}`,
      retrievedAt: new Date(),
      source: { type: registryInfo.type, url: apiUrl, title: opts.packageName, trustScore: 0.9 },
      freshness: 'FRESH',
      correlationId,
    };
  } else if (registry === 'maven') {
    const [group, artifact] = opts.packageName.split(':');
    if (!group || !artifact) {
      throw AppError.badRequest('knowledge_invalid_maven_coords', 'Maven coordinates must be group:artifact');
    }
    const mavenUrl = `${registryInfo.apiUrl}g:${group}+AND+a:${artifact}&rows=1&wt=json`;
    const mavenValidation = validateUrl(mavenUrl);
    if (!mavenValidation.isAllowed) {
      throw AppError.forbidden('knowledge_registry_blocked', `Registry URL blocked: ${mavenValidation.reason}`);
    }
    const mavenResult = await safeFetch<any>(mavenUrl, { maxSize: 512 * 1024, timeoutMs: 10000 });
    if (!mavenResult.ok || !mavenResult.data?.response?.docs?.length) {
      throw AppError.unavailable('knowledge_package_fetch_failed', `Maven package not found: ${opts.packageName}`);
    }
    const doc = mavenResult.data.response.docs[0];
    result = {
      packageName: opts.packageName,
      version: opts.version ?? doc.latestVersion ?? 'unknown',
      latestVersion: doc.latestVersion,
      description: doc.description ?? `${group}:${artifact}`,
      homepage: `https://central.sonatype.com/artifact/${group}/${artifact}`,
      repository: `https://github.com/${group}/${artifact}`,
      license: undefined,
      keywords: [],
      dependencies: {},
      documentationUrl: `https://central.sonatype.com/artifact/${group}/${artifact}`,
      retrievedAt: new Date(),
      source: { type: registryInfo.type, url: mavenUrl, title: opts.packageName, trustScore: 0.9 },
      freshness: 'FRESH',
      correlationId,
    };
  } else {
    throw AppError.badRequest('knowledge_unsupported_registry', `Registry ${registry} not supported`);
  }

  await knowledgeCache.set(cacheKey, result, result.source, 2 * 60 * 60 * 1000); // 2 hours
  return result;
}

export async function retrieveSecurityAdvisories(opts: SecurityAdvisoryQuery): Promise<SecurityAdvisoryResult> {
  const correlationId = generateCorrelationId();
  const cacheKey = `sec:${opts.ecosystem ?? 'npm'}:${opts.packageName}:${opts.version ?? 'all'}`;

  const cached = await knowledgeCache.get<SecurityAdvisoryResult>(cacheKey);
  if (cached) {
    return { ...cached.value, correlationId };
  }

  const ecosystem = opts.ecosystem ?? 'npm';
  const sourceUrl = SECURITY_ADVISORY_SOURCES[ecosystem as keyof typeof SECURITY_ADVISORY_SOURCES] ?? SECURITY_ADVISORY_SOURCES.npm;

  let queryUrl = sourceUrl;
  if (ecosystem === 'github') {
    queryUrl = `${sourceUrl}?package=${opts.packageName}&ecosystem=${opts.ecosystem}`;
    if (opts.version) queryUrl += `&version=${opts.version}`;
  } else if (ecosystem === 'osv') {
    queryUrl = `${sourceUrl}?package=${opts.packageName}`;
  }

  const validation = validateUrl(queryUrl);
  if (!validation.isAllowed) {
    const result: SecurityAdvisoryResult = {
      packageName: opts.packageName,
      version: opts.version,
      advisories: [],
      retrievedAt: new Date(),
      source: { type: 'SECURITY_ADVISORY', url: queryUrl, title: 'Security Advisory', trustScore: 0.9 },
      freshness: 'UNAVAILABLE',
    };
    return result;
  }

  const fetchResult = await safeFetch<any>(queryUrl, { maxSize: 1 * 1024 * 1024, timeoutMs: 15000 });

  if (!fetchResult.ok) {
    const result: SecurityAdvisoryResult = {
      packageName: opts.packageName,
      version: opts.version,
      advisories: [],
      retrievedAt: new Date(),
      source: { type: 'SECURITY_ADVISORY', url: queryUrl, title: 'Security Advisory', trustScore: 0.9 },
      freshness: 'UNAVAILABLE',
    };
    return result;
  }

  const data = fetchResult.data!;
  const advisories: SecurityAdvisory[] = [];

  if (ecosystem === 'github' && Array.isArray(data)) {
    for (const adv of data.slice(0, 20)) {
      advisories.push({
        id: adv.ghsa_id ?? adv.id ?? 'unknown',
        summary: adv.summary ?? '',
        severity: adv.severity?.toUpperCase() as SecurityAdvisory['severity'] ?? 'MEDIUM',
        cves: adv.cve_ids ?? [],
        affectedVersions: adv.vulnerable_version_range ?? '',
        patchedVersions: adv.patched_version_range,
        references: adv.references?.map((r: any) => r.url) ?? [],
        publishedAt: new Date(adv.published_at ?? Date.now()),
        updatedAt: adv.updated_at ? new Date(adv.updated_at) : undefined,
      });
    }
  } else if (ecosystem === 'npm' && Array.isArray(data)) {
    for (const adv of data.slice(0, 20)) {
      advisories.push({
        id: adv.id ?? 'unknown',
        summary: adv.title ?? '',
        severity: adv.severity?.toUpperCase() as SecurityAdvisory['severity'] ?? 'MEDIUM',
        cves: adv.cves ?? [],
        affectedVersions: adv.vulnerable_versions ?? '',
        patchedVersions: adv.patched_versions,
        references: adv.references?.map((r: any) => r.url) ?? [],
        publishedAt: new Date(adv.created ?? Date.now()),
        updatedAt: adv.updated ? new Date(adv.updated) : undefined,
      });
    }
  } else if (ecosystem === 'osv' && data.vulns) {
    for (const adv of data.vulns.slice(0, 20)) {
      advisories.push({
        id: adv.id ?? 'unknown',
        summary: adv.summary ?? '',
        severity: adv.severity?.[0]?.type === 'CVSS_V3' ? 'HIGH' : 'MEDIUM',
        cves: adv.aliases?.filter((a: string) => a.startsWith('CVE-')) ?? [],
        affectedVersions: adv.affected?.[0]?.ranges?.[0]?.events?.[0]?.introduced ?? '',
        patchedVersions: adv.affected?.[0]?.ranges?.[0]?.events?.[1]?.fixed,
        references: adv.references?.map((r: any) => r.url) ?? [],
        publishedAt: new Date(adv.published ?? Date.now()),
        updatedAt: adv.modified ? new Date(adv.modified) : undefined,
      });
    }
  }

  const result: SecurityAdvisoryResult = {
    packageName: opts.packageName,
    version: opts.version,
    advisories,
    retrievedAt: new Date(),
    source: { type: 'SECURITY_ADVISORY', url: queryUrl, title: `${ecosystem} Security Advisories`, trustScore: 0.95 },
    freshness: 'FRESH',
  };

  await knowledgeCache.set(cacheKey, result, result.source, 4 * 60 * 60 * 1000); // 4 hours
  return result;
}

export async function buildKnowledgeGraph(opts: KnowledgeGraphQuery): Promise<KnowledgeGraphResult> {
  const correlationId = generateCorrelationId();
  const maxNodes = opts.maxNodes ?? 50;
  const maxDepth = opts.maxDepth ?? 2;
  const cacheKey = `graph:${opts.centerNode}:${maxDepth}:${maxNodes}:${opts.nodeTypes?.join(',') ?? 'all'}`;

  const cached = await knowledgeCache.get<KnowledgeGraphResult>(cacheKey);
  if (cached) {
    return { ...cached.value, correlationId };
  }

  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(node: KnowledgeNode): boolean {
    if (nodeIds.size >= maxNodes || nodeIds.has(node.id)) return false;
    const allowedTypes = opts.nodeTypes;
    if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(node.type)) return false;
    nodeIds.add(node.id);
    nodes.push(node);
    return true;
  }

  addNode({
    id: opts.centerNode,
    type: 'package',
    label: opts.centerNode,
    properties: { name: opts.centerNode },
    source: { type: 'KNOWN_TECHNICAL_SOURCE', url: 'internal://knowledge-graph', title: 'Knowledge Graph Center', trustScore: 0.9 },
  });

  if (maxDepth >= 1) {
    try {
      const pkgResult = await retrievePackageKnowledge({ packageName: opts.centerNode, projectId: opts.projectId, userId: opts.userId });
      const depEntries = Object.entries(pkgResult.dependencies ?? {});
      for (const [depName, depVersion] of depEntries.slice(0, maxNodes - nodes.length)) {
        if (addNode({
          id: depName,
          type: 'dependency',
          label: depName,
          properties: { name: depName, version: depVersion, parent: opts.centerNode },
          source: pkgResult.source,
        })) {
          edges.push({
            from: opts.centerNode,
            to: depName,
            relationship: 'depends_on',
            confidence: 0.95,
            source: pkgResult.source,
          });
        }
      }

      if (pkgResult.homepage) {
        if (addNode({
          id: `${opts.centerNode}:homepage`,
          type: 'documentation',
          label: `${opts.centerNode} Homepage`,
          properties: { url: pkgResult.homepage, packageName: opts.centerNode },
          source: pkgResult.source,
        })) {
          edges.push({
            from: opts.centerNode,
            to: `${opts.centerNode}:homepage`,
            relationship: 'has_documentation',
            confidence: 0.9,
            source: pkgResult.source,
          });
        }
      }

      if (pkgResult.repository) {
        if (addNode({
          id: `${opts.centerNode}:repo`,
          type: 'api',
          label: `${opts.centerNode} Repository`,
          properties: { url: pkgResult.repository, packageName: opts.centerNode },
          source: pkgResult.source,
        })) {
          edges.push({
            from: opts.centerNode,
            to: `${opts.centerNode}:repo`,
            relationship: 'has_repository',
            confidence: 0.9,
            source: pkgResult.source,
          });
        }
      }
    } catch { /* package not found or blocked — skip */ }
  }

  if (maxDepth >= 2 && nodeIds.size < maxNodes) {
    try {
      const advisoryResult = await retrieveSecurityAdvisories({ packageName: opts.centerNode, projectId: opts.projectId, userId: opts.userId });
      for (const adv of advisoryResult.advisories.slice(0, maxNodes - nodes.length)) {
        if (addNode({
          id: `adv:${adv.id}`,
          type: 'advisory',
          label: `Advisory: ${adv.id}`,
          properties: {
            id: adv.id,
            severity: adv.severity,
            cves: adv.cves,
            affectedVersions: adv.affectedVersions,
            patchedVersions: adv.patchedVersions,
            summary: adv.summary,
          },
          source: advisoryResult.source,
        })) {
          edges.push({
            from: opts.centerNode,
            to: `adv:${adv.id}`,
            relationship: 'has_advisory',
            confidence: 0.85,
            source: advisoryResult.source,
          });
        }
      }
    } catch { /* advisory query failed — skip */ }
  }

  if (maxDepth >= 1 && nodeIds.size < maxNodes) {
    const docKey = opts.centerNode.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.');
    const docSource = OFFICIAL_DOC_SOURCES[docKey];
    if (docSource) {
      if (addNode({
        id: `${opts.centerNode}:docs`,
        type: 'documentation',
        label: `${opts.centerNode} Documentation`,
        properties: { url: docSource.baseUrl, packageName: opts.centerNode },
        source: { type: docSource.type, url: docSource.baseUrl, title: `${opts.centerNode} Docs`, trustScore: 0.95 },
      })) {
        edges.push({
          from: opts.centerNode,
          to: `${opts.centerNode}:docs`,
          relationship: 'has_documentation',
          confidence: 0.95,
          source: { type: docSource.type, url: docSource.baseUrl, title: `${opts.centerNode} Docs`, trustScore: 0.95 },
        });
      }
    }
  }

  const result: KnowledgeGraphResult = {
    nodes,
    edges,
    centerNode: opts.centerNode,
    retrievedAt: new Date(),
    correlationId,
  };

  await knowledgeCache.set(cacheKey, result, {
    type: 'KNOWN_TECHNICAL_SOURCE',
    url: 'internal://knowledge-graph',
    title: `Knowledge Graph: ${opts.centerNode}`,
    trustScore: 0.85,
  }, 60 * 60 * 1000);

  return result;
}

export async function answerWithKnowledge(
  request: LLMKnowledgeRequest,
  context: GatewayContext
): Promise<LLMKnowledgeResponse> {
  const correlationId = generateCorrelationId();

  // First, retrieve relevant knowledge
  const knowledgeResult = await retrieveWebKnowledge({
    query: request.question,
    userId: request.userId,
    projectId: request.projectId,
    maxResults: 5,
    correlationId,
  });

  // Build context from retrieved knowledge
  const sourcesContext = knowledgeResult.sources
    .map((c, i) => `[${i + 1}] ${c.title} (${c.url}): ${c.snippet}`)
    .join('\n\n');

  const prompt = `You are a technical knowledge assistant. Answer the user's question using ONLY the provided sources.
If the sources don't contain the answer, say so clearly. Do not use your training knowledge for current facts.

Question: ${request.question}

Sources:
${sourcesContext || 'No live sources available.'}

Answer with citations in format [1], [2], etc.`;

  const messages = [
    { role: 'system' as const, content: 'You are a precise technical assistant. Cite sources for every factual claim.' },
    { role: 'user' as const, content: prompt },
  ];

  try {
    const completion = await completeWithFallback({
      ctx: context,
      messages,
      temperature: request.modelOptions?.temperature ?? 0.1,
      maxTokens: request.modelOptions?.maxTokens ?? 2000,
      opts: {},
    });

    const citations: KnowledgeCitation[] = knowledgeResult.sources.map((s, i) => ({
      sourceId: s.sourceId,
      sourceType: s.sourceType,
      url: s.url,
      title: s.title,
      snippet: s.snippet,
      retrievedAt: s.retrievedAt,
      relevanceScore: s.relevanceScore,
    }));

    return {
      answer: completion.text,
      citations,
      sourcesUsed: knowledgeResult.sources.map(s => ({
        type: s.sourceType,
        url: s.url,
        title: s.title,
        trustScore: s.trustScore ?? 0,
      })),
      retrievedAt: new Date(),
      freshness: knowledgeResult.freshness,
      modelUsed: completion.modelId,
      providerUsed: completion.providerId,
    };
  } catch (err) {
    logger.error('knowledge.llm_answer_failed', { error: (err as Error).message });
    throw AppError.unavailable('knowledge_llm_failed', `LLM completion failed: ${(err as Error).message}`);
  }
}