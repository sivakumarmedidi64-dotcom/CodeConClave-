/**
 * CodeConClave — real embedding pipeline (Phase 6).
 *
 * EmbeddingProvider: OpenAI text-embedding-3-small (1536 dimensions) when a
 * key is configured; otherwise the provider is NULL and memories stay in
 * QUEUED/FAILED state. We NEVER fabricate vectors — pgvector requires a real
 * embedding pipeline, and search degrades honestly to FULL_TEXT/HYBRID.
 */
import { env } from '../../config/env.js';

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    // A real network-call timeout: a stalled provider connection can never
    // hold the embedding pipeline (and thus the chat stream) open forever.
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8000) }),
    });
    if (!response.ok) throw new Error(`embedding provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: { embedding?: number[] }[] };
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding) throw new Error('embedding provider returned an empty result');
    if (embedding.length !== this.dimensions) {
      throw new Error(`embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`);
    }
    return embedding;
  }
}

let cachedProvider: EmbeddingProvider | null | undefined;

/** Honest provider lookup: null when no API key is configured. */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;
  cachedProvider = env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : null;
  return cachedProvider;
}

/** Test hook: clear the cached provider so env changes take effect. */
export function resetEmbeddingProvider(): void {
  cachedProvider = undefined;
}

/** Embed a single text; throws when no provider is configured or the call fails. */
export async function embedText(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error('no embedding provider configured');
  return provider.embed(text);
}

/** Dimension + numeric sanity check for any vector before it touches pgvector. */
export function isVectorValid(embedding: number[]): boolean {
  return (
    Array.isArray(embedding) &&
    embedding.length === EMBEDDING_DIMENSIONS &&
    embedding.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}