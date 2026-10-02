/**
 * CodeConClave — Knowledge Module Types (PKG-12).
 * Canonical types for knowledge retrieval, citations, and source provenance.
 */
import { z } from 'zod';

export const KnowledgeSourceType = z.enum([
  'OFFICIAL_DOCUMENTATION',
  'OFFICIAL_API_DOCUMENTATION',
  'PACKAGE_REGISTRY',
  'SECURITY_ADVISORY',
  'KNOWN_TECHNICAL_SOURCE',
  'GENERAL_WEB_SOURCE',
  'INTERNAL_DOCUMENTATION',
]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceType>;

export const KnowledgeFreshness = z.enum(['FRESH', 'STALE', 'EXPIRED', 'UNAVAILABLE']);
export type KnowledgeFreshness = z.infer<typeof KnowledgeFreshness>;

export const KnowledgeRetrievalStatus = z.enum([
  'SUCCESS',
  'PARTIAL',
  'SOURCE_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'MALFORMED_CONTENT',
  'SECURITY_REJECTED',
  'INTERNAL_ERROR',
]);
export type KnowledgeRetrievalStatus = z.infer<typeof KnowledgeRetrievalStatus>;

export interface KnowledgeSource {
  type: KnowledgeSourceType;
  url: string;
  title: string;
  trustScore: number;
  lastVerifiedAt?: Date;
}

export interface KnowledgeResult {
  id: string;
  query: string;
  answer: string;
  sources: KnowledgeCitation[];
  retrievedAt: Date;
  freshness: KnowledgeFreshness;
  cacheAgeMs?: number;
  retrievalStatus: KnowledgeRetrievalStatus;
  correlationId: string;
}

export interface KnowledgeCitation {
  sourceId: string;
  sourceType: KnowledgeSourceType;
  url: string;
  title: string;
  snippet: string;
  retrievedAt: Date;
  relevanceScore: number;
  trustScore?: number;
}

export interface RetrievalOptions {
  query: string;
  userId: string;
  projectId?: string;
  sourceTypes?: KnowledgeSourceType[];
  maxResults?: number;
  maxAgeMs?: number;
  requireFresh?: boolean;
  correlationId?: string;
}

export interface PackageKnowledgeQuery {
  packageName: string;
  registry?: 'npm' | 'pypi' | 'cargo' | 'go' | 'maven';
  version?: string;
  userId: string;
  projectId?: string;
}

export interface PackageKnowledgeResult {
  packageName: string;
  version: string;
  latestVersion?: string;
  description: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  documentationUrl?: string;
  retrievedAt: Date;
  source: KnowledgeSource;
  freshness: KnowledgeFreshness;
  correlationId?: string;
}

export interface DocumentationQuery {
  technology: string;
  topic?: string;
  version?: string;
  userId: string;
  projectId?: string;
}

export interface DocumentationResult {
  technology: string;
  topic?: string;
  content: string;
  sections: DocumentationSection[];
  source: KnowledgeSource;
  retrievedAt: Date;
  freshness: KnowledgeFreshness;
  correlationId?: string;
}

export interface DocumentationSection {
  title: string;
  content: string;
  anchor?: string;
}

export interface SecurityAdvisoryQuery {
  packageName: string;
  version?: string;
  ecosystem?: string;
  userId: string;
  projectId?: string;
}

export interface SecurityAdvisoryResult {
  packageName: string;
  version?: string;
  advisories: SecurityAdvisory[];
  retrievedAt: Date;
  source: KnowledgeSource;
  freshness: KnowledgeFreshness;
  correlationId?: string;
}

export interface SecurityAdvisory {
  id: string;
  summary: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cves: string[];
  affectedVersions: string;
  patchedVersions?: string;
  references: string[];
  publishedAt: Date;
  updatedAt?: Date;
}

export interface KnowledgeGraphQuery {
  centerNode: string;
  nodeTypes?: KnowledgeNodeType[];
  maxDepth?: number;
  maxNodes?: number;
  userId: string;
  projectId?: string;
}

export type KnowledgeNodeType = 'package' | 'version' | 'documentation' | 'api' | 'dependency' | 'advisory' | 'technology';

export interface KnowledgeGraphResult {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  centerNode: string;
  retrievedAt: Date;
  correlationId?: string;
}

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  properties: Record<string, unknown>;
  source?: KnowledgeSource;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  relationship: string;
  confidence: number;
  source?: KnowledgeSource;
}

export interface LLMKnowledgeRequest {
  question: string;
  userId: string;
  projectId?: string;
  context?: string;
  modelOptions?: {
    temperature?: number;
    maxTokens?: number;
  };
}

export interface LLMKnowledgeResponse {
  answer: string;
  citations: KnowledgeCitation[];
  sourcesUsed: KnowledgeSource[];
  retrievedAt: Date;
  freshness: KnowledgeFreshness;
  modelUsed: string;
  providerUsed: string;
}

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: Date;
  expiresAt: Date;
  source: KnowledgeSource;
  accessCount: number;
}

export interface KnowledgeCacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  evictions: number;
}