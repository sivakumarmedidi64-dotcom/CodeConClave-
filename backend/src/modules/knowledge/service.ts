/**
 * CodeConClave — Knowledge Service (PKG-12).
 * Canonical knowledge retrieval service integrating web, documentation, package,
 * security advisory, and LLM-cited answers.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { knowledgeCache } from './cache.js';
import {
  retrieveWebKnowledge,
  retrieveDocumentation,
  retrievePackageKnowledge,
  retrieveSecurityAdvisories,
  buildKnowledgeGraph,
  answerWithKnowledge,
} from './retrievers.js';
import type {
  KnowledgeSource,
  KnowledgeSourceType,
  KnowledgeResult,
  RetrievalOptions,
  PackageKnowledgeQuery,
  PackageKnowledgeResult,
  DocumentationQuery,
  DocumentationResult,
  SecurityAdvisoryQuery,
  SecurityAdvisoryResult,
  KnowledgeGraphQuery,
  KnowledgeGraphResult,
  LLMKnowledgeRequest,
  LLMKnowledgeResponse,
  KnowledgeCacheStats,
} from './types.js';
import { completeWithFallback, type GatewayContext, routeModels } from '../ai/gateway.js';
import { env } from '../../config/env.js';

function generateCorrelationId(): string {
  return `knw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface KnowledgeServiceConfig {
  enabledSources: KnowledgeSourceType[];
  webRetrievalEnabled: boolean;
  defaultTtlMs: number;
  maxConcurrentRetrievals: number;
}

const DEFAULT_CONFIG: KnowledgeServiceConfig = {
  enabledSources: [
    'OFFICIAL_DOCUMENTATION',
    'OFFICIAL_API_DOCUMENTATION',
    'PACKAGE_REGISTRY',
    'SECURITY_ADVISORY',
    'KNOWN_TECHNICAL_SOURCE',
    'GENERAL_WEB_SOURCE',
    'INTERNAL_DOCUMENTATION',
  ],
  webRetrievalEnabled: false, // Requires search API configuration
  defaultTtlMs: 60 * 60 * 1000,
  maxConcurrentRetrievals: 5,
};

export class KnowledgeService {
  private config: KnowledgeServiceConfig;

  constructor(config: Partial<KnowledgeServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isSourceEnabled(type: KnowledgeSourceType): boolean {
    return this.config.enabledSources.includes(type);
  }

  async searchWeb(opts: RetrievalOptions): Promise<KnowledgeResult> {
    if (!this.config.webRetrievalEnabled) {
      return retrieveWebKnowledge(opts);
    }
    if (!this.isSourceEnabled('GENERAL_WEB_SOURCE')) {
      throw AppError.forbidden('knowledge_source_disabled', 'General web source is disabled');
    }
    return retrieveWebKnowledge(opts);
  }

  async getDocumentation(opts: DocumentationQuery): Promise<DocumentationResult> {
    if (!this.isSourceEnabled('OFFICIAL_DOCUMENTATION')) {
      throw AppError.forbidden('knowledge_source_disabled', 'Official documentation source is disabled');
    }
    return retrieveDocumentation(opts);
  }

  async getPackageInfo(opts: PackageKnowledgeQuery): Promise<PackageKnowledgeResult> {
    if (!this.isSourceEnabled('PACKAGE_REGISTRY')) {
      throw AppError.forbidden('knowledge_source_disabled', 'Package registry source is disabled');
    }
    return retrievePackageKnowledge(opts);
  }

  async getSecurityAdvisories(opts: SecurityAdvisoryQuery): Promise<SecurityAdvisoryResult> {
    if (!this.isSourceEnabled('SECURITY_ADVISORY')) {
      throw AppError.forbidden('knowledge_source_disabled', 'Security advisory source is disabled');
    }
    return retrieveSecurityAdvisories(opts);
  }

  async getKnowledgeGraph(opts: KnowledgeGraphQuery): Promise<KnowledgeGraphResult> {
    if (!this.isSourceEnabled('KNOWN_TECHNICAL_SOURCE')) {
      throw AppError.forbidden('knowledge_source_disabled', 'Knowledge graph source is disabled');
    }
    return buildKnowledgeGraph(opts);
  }

  async askWithCitations(request: LLMKnowledgeRequest): Promise<LLMKnowledgeResponse> {
    const correlationId = generateCorrelationId();

    const userId = request.userId;
    const context: GatewayContext = {
      userId,
      sessionId: correlationId,
      conversationId: null,
      taskId: null,
      planId: 'pro', // Would be looked up from user
      tenantId: userId,
      coworkerType: null,
    };

    try {
      const response = await answerWithKnowledge(request, context);

      await recordAudit({
        action: AuditAction.SEARCH_PERFORMED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'knowledge_llm_answer',
        correlationId,
        detail: {
          question: request.question.slice(0, 200),
          sourcesUsed: response.sourcesUsed.length,
          modelUsed: response.modelUsed,
          providerUsed: response.providerUsed,
          freshness: response.freshness,
        },
      });

      return response;
    } catch (err) {
      logger.error('knowledge.ask_failed', { error: (err as Error).message, correlationId });
      throw err instanceof AppError ? err : AppError.unavailable('knowledge_ask_failed', (err as Error).message);
    }
  }

  async searchAllSources(query: string, userId: string, projectId?: string): Promise<{
    web: KnowledgeResult;
    documentation: DocumentationResult[];
    packages: PackageKnowledgeResult[];
  }> {
    const correlationId = generateCorrelationId();

    // Extract potential technology/package names from query
    const techTerms = extractTechnologyTerms(query);
    const packageTerms = extractPackageTerms(query);

    const webResult = await this.searchWeb({ query, userId, projectId, correlationId });
    const docResults = await Promise.allSettled<DocumentationResult>(
      techTerms.map(t => this.getDocumentation({ technology: t, userId, projectId }))
    );
    const pkgResults = await Promise.allSettled<PackageKnowledgeResult>(
      packageTerms.map(p => this.getPackageInfo({ packageName: p, userId, projectId }))
    );

    const documentation = docResults
      .filter((r): r is PromiseFulfilledResult<DocumentationResult> => r.status === 'fulfilled')
      .map(r => r.value);

    const packages = pkgResults
      .filter((r): r is PromiseFulfilledResult<PackageKnowledgeResult> => r.status === 'fulfilled')
      .map(r => r.value);

    return {
      web: webResult,
      documentation,
      packages,
    };
  }

  getCacheStats(): KnowledgeCacheStats {
    return knowledgeCache.getStats();
  }

  async clearCache(): Promise<void> {
    await knowledgeCache.clear();
  }

  getConfig(): KnowledgeServiceConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<KnowledgeServiceConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getLiveSourceStatus(): { web: boolean; documentation: boolean; packages: boolean; advisories: boolean } {
    return {
      web: this.config.webRetrievalEnabled && this.isSourceEnabled('GENERAL_WEB_SOURCE'),
      documentation: this.isSourceEnabled('OFFICIAL_DOCUMENTATION'),
      packages: this.isSourceEnabled('PACKAGE_REGISTRY'),
      advisories: this.isSourceEnabled('SECURITY_ADVISORY'),
    };
  }
}

function extractTechnologyTerms(query: string): string[] {
  const terms = new Set<string>();
  const lowerQuery = query.toLowerCase();

  for (const tech of Object.keys(OFFICIAL_DOC_SOURCES)) {
    if (lowerQuery.includes(tech.toLowerCase())) {
      terms.add(tech);
    }
  }

  return Array.from(terms).slice(0, 3);
}

function extractPackageTerms(query: string): string[] {
  const terms = new Set<string>();
  // Simple heuristic: words that look like package names
  const words = query.match(/[@\w][\w\-\.]*/g) ?? [];
  for (const word of words) {
    if (word.length > 2 && !word.match(/^(the|and|for|with|from|how|what|when|where|why)$/i)) {
      terms.add(word.replace(/^@/, ''));
    }
  }
  return Array.from(terms).slice(0, 5);
}

// Official doc sources (defined in retrievers.ts but re-exported for service config)
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

export const knowledgeService = new KnowledgeService();