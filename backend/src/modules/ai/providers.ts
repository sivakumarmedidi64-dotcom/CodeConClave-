/**
 * CodeConClave — provider adapters (Phase 5 hardened).
 * One normalized interface; providers are configuration, never hardcoded
 * application logic. Each adapter reports latency + health honestly, classifies
 * failures into the shared fallback-reason taxonomy, and reports whether it can
 * participate in normalized typed tool-call requests. Nothing is faked.
 */
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatChunk {
  delta: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ProviderAdapter {
  providerId: string;
  /**
   * Honest capability flag: whether this adapter can participate in the
   * normalized typed tool-call request flow. Adapters that cannot report
   * `false`; the router chooses a qualified alternative or reports
   * `unsupported_feature` — never a fake tool call.
   */
  supportsToolCalls: boolean;
  complete(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GEMINI_URL = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const KIMI_URL = 'https://api.moonshot.cn/v1/chat/completions';
const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const COHERE_URL = 'https://api.cohere.com/v2/chat';

/**
 * Classify a provider failure into the shared fallback-reason taxonomy.
 * Used by the gateway to record honest fallback reasons and by tests.
 */
export function classifyProviderError(
  err: unknown,
  timedOut = false,
): import('@codeconclave/shared').AiFallbackReason {
  if (err instanceof AppError) {
    switch (err.errorCode) {
      case 'rate_limited':
        return 'rate_limited';
      case 'provider_billing':
        return 'billing';
      case 'invalid_credentials':
        return 'invalid_credentials';
      case 'provider_timeout':
        return 'timeout';
      case 'unsupported_feature':
        return 'unsupported_feature';
      case 'provider_not_configured':
        return 'provider_not_configured';
      case 'stream_interrupted':
        return 'stream_interrupted';
      default:
        return 'provider_unavailable';
    }
  }
  if (err instanceof Error && err.name === 'AbortError') return timedOut ? 'timeout' : 'stream_interrupted';
  if (typeof err === 'string') {
    // Message-string classification (stored provider_health.last_error). Only
    // the messages this gateway generates itself are classified; everything
    // else is honestly reported as provider_unavailable.
    const msg = err.toLowerCase();
    if (/quota|billing|credit|out of credits/.test(msg)) return 'billing';
    if (/rate limit|429/.test(msg)) return 'rate_limited';
    if (/credentials|api key|401|403/.test(msg)) return 'invalid_credentials';
    if (/timed out|timeout|408|504/.test(msg)) return 'timeout';
    if (/not configured/.test(msg)) return 'provider_not_configured';
    return 'provider_unavailable';
  }
  return 'provider_unavailable';
}

/**
 * Map an HTTP failure into the shared taxonomy. The response body hint and
 * Retry-After header (when present) are surfaced in error details so callers
 * can respect rate limits honestly — never by sleeping for them.
 */
function httpError(status: number, provider: string, bodyHint = '', retryAfterSec?: number): AppError {
  const details: Record<string, unknown> = { status, provider };
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    details.retryAfterSec = Math.ceil(retryAfterSec);
  }
  const isBilling = /insufficient_quota|billing|credit balance|payment|out of credits/i.test(bodyHint);
  if (status === 401 || status === 403) {
    return AppError.unavailable('invalid_credentials', `${provider} rejected the configured credentials`, details);
  }
  if (status === 429) {
    if (isBilling) {
      return AppError.unavailable('provider_billing', `${provider} billing quota exhausted (429)`, details);
    }
    const retry = details.retryAfterSec ? ` — retry after ~${details.retryAfterSec}s` : '';
    return AppError.unavailable('rate_limited', `${provider} rate limit reached${retry}`, details);
  }
  if (status === 400 && isBilling) {
    return AppError.unavailable('provider_billing', `${provider} rejected the request for billing reasons (400)`, details);
  }
  if (status === 408 || status === 504) {
    return AppError.unavailable('provider_timeout', `${provider} request timed out`, details);
  }
  return AppError.unavailable('provider_error', `${provider} error ${status}`, details);
}

/** Shared SSE reader: yields parsed chunks; classifies interruption honestly. */
async function* sseReader(
  response: Response,
  provider: string,
  parse: (json: unknown) => ChatChunk | null,
  signal?: AbortSignal,
): AsyncGenerator<ChatChunk> {
  if (!response.ok || !response.body) {
    // Capture the reason before the body is lost: a capped body hint and the
    // Retry-After header feed honest billing/rate-limit classification.
    const bodyHint = await response
      .text()
      .catch(() => '')
      .then((t) => t.slice(0, 300));
    const retryHeader = response.headers.get('retry-after');
    const retryAfterSec = retryHeader === null ? undefined : Number(retryHeader);
    throw httpError(
      response.status,
      provider,
      bodyHint,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emitted = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n');
      buffer = events.pop() ?? '';
      for (const line of events) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = parse(JSON.parse(data));
          if (chunk) {
            emitted = true;
            yield chunk;
          }
        } catch {
          /* partial JSON line — skip */
        }
      }
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    throw emitted
      ? AppError.unavailable('stream_interrupted', `${provider} stream interrupted mid-response`)
      : httpError(response.status, provider);
  }
}

function anthropicAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'anthropic',
    supportsToolCalls: false,
    async *complete(req, signal) {
      const response = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          messages: req.messages.filter((m) => m.role !== 'system'),
          system: req.messages.find((m) => m.role === 'system')?.content,
        }),
      });
      let inputTokens: number | undefined;
      let outputTokens = 0;
      yield* sseReader(response, 'Anthropic', (json) => {
        const data = json as {
          type?: string;
          delta?: { text?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        if (data.type === 'message_start' && data.message?.usage) {
          inputTokens = data.message.usage.input_tokens;
          return null;
        }
        if (data.type === 'message_delta' && data.usage) {
          outputTokens = data.usage.output_tokens ?? outputTokens;
          return null;
        }
        if (data.type === 'content_block_delta' && data.delta?.text) {
          outputTokens += 1;
          return { delta: data.delta.text, inputTokens, outputTokens };
        }
        return null;
      }, signal);
    },
  };
}

function openaiAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'openai',
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(OPENAI_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          stream: true,
          messages: req.messages,
        }),
      });
      let outputTokens = 0;
      yield* sseReader(response, 'OpenAI', (json) => {
        const data = json as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          outputTokens += 1;
          return { delta, inputTokens: data.usage?.prompt_tokens, outputTokens };
        }
        return null;
      }, signal);
    },
  };
}

function geminiAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'google',
    supportsToolCalls: false,
    async *complete(req, signal) {
      const contents = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const systemInstruction = req.messages.find((m) => m.role === 'system')?.content;
      const response = await fetch(GEMINI_URL(model), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: { maxOutputTokens: req.maxTokens ?? 4096, temperature: req.temperature ?? 0.7 },
        }),
      });
      yield* sseReader(response, 'Gemini', (json: unknown) => {
        const data = json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
        return text ? { delta: text } : null;
      }, signal);
    },
  };
}

function mistralAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'mistral',
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(MISTRAL_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          stream: true,
          messages: req.messages,
        }),
      });
      let outputTokens = 0;
      yield* sseReader(response, 'Mistral', (json) => {
        const data = json as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          outputTokens += 1;
          return { delta, inputTokens: data.usage?.prompt_tokens, outputTokens };
        }
        return null;
      }, signal);
    },
  };
}

/** OpenAI-compatible SSE adapter shared by grok, deepseek, kimi and NVIDIA NIM. */
function openaiCompatAdapter(providerId: string, label: string, baseUrl: string, model: string, apiKey: string): ProviderAdapter {
  return {
    providerId,
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(baseUrl, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          stream: true,
          messages: req.messages,
        }),
      });
      let outputTokens = 0;
      yield* sseReader(response, label, (json) => {
        const data = json as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          outputTokens += 1;
          return { delta, inputTokens: data.usage?.prompt_tokens, outputTokens };
        }
        return null;
      }, signal);
    },
  };
}

/**
 * Cohere v2 SSE adapter (north models). v2 emits `message-start` events and
 * `content-delta` events with `type: 'text'`; usage arrives on `message-end`.
 */
function cohereAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'north',
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(COHERE_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          stream: true,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      let outputTokens = 0;
      yield* sseReader(response, 'Cohere', (json) => {
        const data = json as {
          type?: string;
          delta?: { message?: { content?: { text?: string }[] } };
          message?: { usage?: { tokens?: { input_tokens?: number; output_tokens?: number } } };
        };
        if (data.type === 'message-start' && data.message?.usage) {
          return { delta: '', inputTokens: data.message.usage.tokens?.input_tokens, outputTokens: 0 };
        }
        if (data.type === 'content-delta' && data.delta?.message?.content?.[0]?.text) {
          outputTokens += 1;
          return { delta: data.delta.message.content[0].text, outputTokens };
        }
        return null;
      }, signal);
    },
  };
}

export function getAdapter(providerId: string, model: string): ProviderAdapter {
  switch (providerId) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw AppError.unavailable('provider_not_configured', 'Anthropic is not configured');
      return anthropicAdapter(model, env.ANTHROPIC_API_KEY);
    case 'openai':
      if (!env.OPENAI_API_KEY) throw AppError.unavailable('provider_not_configured', 'OpenAI is not configured');
      return openaiAdapter(model, env.OPENAI_API_KEY);
    case 'google':
      if (!env.GEMINI_API_KEY) throw AppError.unavailable('provider_not_configured', 'Google is not configured');
      return geminiAdapter(model, env.GEMINI_API_KEY);
    case 'mistral':
      if (!env.MISTRAL_API_KEY) throw AppError.unavailable('provider_not_configured', 'Mistral is not configured');
      return mistralAdapter(model, env.MISTRAL_API_KEY);
    case 'grok':
      if (!env.GROK_API_KEY) throw AppError.unavailable('provider_not_configured', 'Grok is not configured');
      return openaiCompatAdapter('grok', 'Grok', GROK_URL, model, env.GROK_API_KEY);
    case 'deepseek':
      if (!env.DEEPSEEK_API_KEY) throw AppError.unavailable('provider_not_configured', 'DeepSeek is not configured');
      return openaiCompatAdapter('deepseek', 'DeepSeek', DEEPSEEK_URL, model, env.DEEPSEEK_API_KEY);
    case 'kimi':
      if (!env.KIMI_API_KEY) throw AppError.unavailable('provider_not_configured', 'Kimi is not configured');
      return openaiCompatAdapter('kimi', 'Kimi', KIMI_URL, model, env.KIMI_API_KEY);
    case 'nemotron':
      if (!env.NVIDIA_API_KEY) throw AppError.unavailable('provider_not_configured', 'NVIDIA NIM is not configured');
      return openaiCompatAdapter('nemotron', 'NVIDIA NIM', NIM_URL, model, env.NVIDIA_API_KEY);
    case 'north':
      if (!env.COHERE_API_KEY) throw AppError.unavailable('provider_not_configured', 'Cohere is not configured');
      return cohereAdapter(model, env.COHERE_API_KEY);
    default:
      throw AppError.badRequest('unknown_provider', `Unknown provider ${providerId}`);
  }
}

/**
 * Stage 26 AI transparency — map a classified failure (or raw error/message)
 * to the honest provider status taxonomy. The mapping is pure and unit-tested;
 * the resulting status is persisted to provider_health.state and surfaced by
 * the AI transparency endpoints. BLOCKED is never derived here — it requires an
 * explicit administrative block (see provider_health.state = 'BLOCKED').
 */
export function deriveStatusFromFailure(err: unknown): import('@codeconclave/shared').ProviderStatus {
  const reason = classifyProviderError(err);
  switch (reason) {
    case 'rate_limited':
      return 'RATE_LIMITED';
    case 'billing':
      return 'QUOTA_EXHAUSTED';
    case 'invalid_credentials':
      return 'REQUIRES_REAUTH';
    case 'timeout':
      return 'DEGRADED';
    case 'stream_interrupted':
      return 'DEGRADED';
    case 'unsupported_feature':
      return 'LIMITED';
    case 'provider_not_configured':
      return 'NOT_CONFIGURED';
    default:
      return 'OFFLINE';
  }
}

export function updateProviderHealth(providerId: string, ok: boolean, durationMs: number, error?: string | unknown): void {
  const state = ok ? 'HEALTHY' : error === undefined ? 'DOWN' : deriveStatusFromFailure(error);
  const lastError = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  import('../../shared/db.js')
    .then(({ pool: db }) =>
      db.query(
        `INSERT INTO provider_health (provider_id, state, last_check_at, last_error, success_count, failure_count, avg_latency_ms, consecutive_failures)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7)
         ON CONFLICT (provider_id) DO UPDATE SET
           state = $2,
           last_check_at = now(),
           last_error = $3,
           success_count = provider_health.success_count + $4,
           failure_count = provider_health.failure_count + $5,
           avg_latency_ms = CASE WHEN $8 THEN $6 ELSE (provider_health.avg_latency_ms * 4 + $6) / 5 END,
           consecutive_failures = CASE WHEN $2 = 'HEALTHY' THEN 0 ELSE provider_health.consecutive_failures + 1 END,
           updated_at = now()`,
        [
          providerId,
          state,
          lastError ?? null,
          ok ? 1 : 0,
          ok ? 0 : 1,
          durationMs,
          ok ? 0 : 1,
          false,
        ],
      ),
    )
    .catch((err) => logger.warn('provider health update failed', { error: (err as Error).message }));
}