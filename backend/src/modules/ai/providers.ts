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
import { providerGateReason } from './gate.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /**
   * Canonical content: either plain text or a normalized part list enabling
   * multimodal requests. TEXT / IMAGE_INPUT / TEXT_PLUS_IMAGE are expressed as
   * part lists; every adapter normalizes them into its provider wire format.
   */
  content: string | ChatContentPart[];
}

/** Canonical multimodal content parts (TEXT / IMAGE_INPUT / TEXT_PLUS_IMAGE). */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'image_base64'; data: string; mimeType: string };

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatChunk {
  delta: string;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Generated image output (e.g. Gemini image-generation adapter). dataB64 is a
   * base64 payload; the gateway carries it through the normalized completion
   * summary — never logged.
   */
  image?: { mimeType: string; dataB64: string };
  /**
   * External-agent run state (EXTERNAL_AGENT adapters). Carries the
   * provider-side run identity (Devin session id / Manus task id) and its
   * lifecycle state through the SAME normalized stream. This is the honest
   * representation the UI renders — the UI never claims an external agent
   * executed something absent this id + status pair.
   */
  externalRun?: ExternalRunInfo;
}

/** Normalized external-agent run facts (EXTERNAL_AGENT capability). */
export interface ExternalRunInfo {
  /** Provider-side run id (Devin session id, Manus task id). */
  externalId: string;
  /** Provider-side lifecycle state (running / finished / blocked / failed). */
  status: string;
  /** Run start time (ISO) as reported when the session was created. */
  startedAt: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** Character count of a message's textual content (token estimation only). */
export function messageTextChars(message: ChatMessage): number {
  if (typeof message.content === 'string') return message.content.length;
  return message.content.reduce((n, part) => (part.type === 'text' ? n + part.text.length : n), 0);
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
const QWEN_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ZAI_URL = 'https://api.z.ai/api/v1/chat/completions';
/**
 * Meta Muse Spark (Model API) — OpenAI-compatible Chat Completions.
 * Official docs: https://dev.meta.ai/docs/protocols/chat-completions
 * POST {base}/chat/completions with Bearer auth, `model: muse-spark-1.3`,
 * OpenAI-shaped messages/streaming/usage. Only behaviours stated in those
 * docs are used here (text, streaming SSE, tool calling, response_format
 * structured output, usage with reasoning tokens counted as output).
 * Gated by MUSE_SPARK_ENABLED (default OFF) — see museSparkEnabled().
 */
const MUSE_SPARK_BASE = 'https://api.meta.ai/v1';
const MUSE_SPARK_CHAT_URL = `${MUSE_SPARK_BASE}/chat/completions`;
export const MUSE_SPARK_DEFAULT_MODEL = 'muse-spark-1.3';

const MANUS_V2_BASE = 'https://api.manus.ai/v2';

/**
 * Documented Gemini image-generation model ids. getAdapter selects the image
 * adapter ONLY for these ids — any other google model uses the text/multimodal
 * adapter. The registry keeps the authoritative enabled row (image_generation =
 * true), so routing can never reach an image id that was not really served.
 * The set is confirmed against the live models list during real verification.
 */
export const GEMINI_IMAGE_MODEL_IDS: ReadonlySet<string> = new Set<string>([
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3-pro-image-preview',
  'gemini-3-pro-image',
  'nano-banana-image-generation',
]);

const DEVIN_V1_BASE = 'https://api.devin.ai/v1';
const DEVIN_V3_BASE = 'https://api.devin.ai/v3';
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
  const isBilling = /insufficient_quota|billing|credit balance|payment|out of credits|insufficient[ _-]?balance/i.test(bodyHint);
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
  if (status === 402) {
    return AppError.unavailable('provider_billing', `${provider} rejected the request for payment (402)`, details);
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
          ...(env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : {}),
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

/**
 * Normalize a canonical CodeConClave part into a Gemini `Part`. TEXT stays text;
 * IMAGE_INPUT arrives as inline inline_data (base64) or a URL as fileData.
 * Unknown parts are skipped (never fabricated).
 */
function geminiPart(part: ChatContentPart): { text?: string; inlineData?: { data: string; mimeType: string }; fileData?: { fileUri: string } } | null {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image_base64':
      return { inlineData: { data: part.data, mimeType: part.mimeType || 'image/png' } };
    case 'image_url':
      return { fileData: { fileUri: part.url } };
    default:
      return null;
  }
}

function geminiContents(messages: ChatMessage[]): {
  contents: { role: 'user' | 'model'; parts: Array<Record<string, unknown>> }[];
  systemParts: Array<Record<string, unknown>> | null;
} {
  const systemParts: Array<Record<string, unknown>> = [];
  const contents: { role: 'user' | 'model'; parts: Array<Record<string, unknown>> }[] = [];
  const last = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'system') {
      const parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => geminiPart(p)).filter((p) => p !== null);
      systemParts.push(...parts);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => geminiPart(p)).filter((p) => p !== null);
    const prevIdx = last.get(role);
    if (prevIdx !== undefined) {
      contents[prevIdx]!.parts.push(...parts);
    } else {
      last.set(role, contents.length);
      contents.push({ role, parts });
    }
  }
  return { contents, systemParts: systemParts.length ? systemParts : null };
}

function geminiAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'google',
    supportsToolCalls: false,
    async *complete(req, signal) {
      const { contents, systemParts } = geminiContents(req.messages);
      const response = await fetch(GEMINI_URL(model), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          systemInstruction: systemParts ? { parts: systemParts } : undefined,
          generationConfig: { maxOutputTokens: req.maxTokens ?? 4096, temperature: req.temperature ?? 0.7 },
        }),
      });
      yield* sseReader(response, 'Gemini', (json: unknown) => {
        const data = json as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
        const usage = data.usageMetadata;
        return text || usage
          ? { delta: text ?? '', inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount }
          : null;
      }, signal);
    },
  };
}

/**
 * Gemini image-generation adapter (canonical IMAGE_GENERATION capability).
 * Non-streaming generateContent with responseModalities TEXT+IMAGE; every
 * returned part is normalized — text parts become text deltas, inline image
 * parts become ChatChunk.image payloads. Reuses the SAME route + API key as the
 * text adapter; nothing here is a separate AI engine.
 */
function geminiImageAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'google',
    supportsToolCalls: false,
    async *complete(req, signal) {
      const { contents, systemParts } = geminiContents(req.messages);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          systemInstruction: systemParts ? { parts: systemParts } : undefined,
          generationConfig: {
            maxOutputTokens: req.maxTokens ?? 4096,
            temperature: req.temperature ?? 0.7,
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
      });
      if (!response.ok) {
        const bodyHint = await response.text().catch(() => '').then((t) => t.slice(0, 300));
        throw httpError(response.status, 'Gemini Image', bodyHint);
      }
      const data = (await response.json()) as {
        candidates?: {
          content?: {
            parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }>;
          };
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const part = data.candidates?.[0]?.content?.parts ?? [];
      const usage = data.usageMetadata;
      let emitted = false;
      for (const p of part) {
        if (p.text) {
          emitted = true;
          yield { delta: p.text, inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount };
        } else if (p.inlineData?.data) {
          emitted = true;
          yield {
            delta: '',
            image: { mimeType: p.inlineData.mimeType ?? 'image/png', dataB64: p.inlineData.data },
            inputTokens: usage?.promptTokenCount,
            outputTokens: usage?.candidatesTokenCount,
          };
        }
      }
      if (!emitted) throw AppError.unavailable('provider_error', 'Gemini image generation returned no image parts');
    },
  };
}

function mistralAdapter(model: string, apiKey: string): ProviderAdapter {
  const MISTRAL_WIRE_ID_ALIASES: Record<string, string> = {
    'mistral-small-4': 'mistral-small-latest',
  };
  const wireModel = MISTRAL_WIRE_ID_ALIASES[model] ?? model;
  return {
    providerId: 'mistral',
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(MISTRAL_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: wireModel,
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

/** Normalize canonical messages to OpenAI-compatible wire messages. */
function openAiMessages(messages: ChatMessage[]): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((p) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image_base64') return { type: 'image_url', image_url: { url: `data:${p.mimeType || 'image/png'};base64,${p.data}` } };
        return { type: 'image_url', image_url: { url: p.url, detail: p.detail ?? 'auto' } };
      }),
    };
  });
}

/** OpenAI-compatible SSE adapter shared by grok, deepseek, kimi, NVIDIA NIM, Ox Alpha and Z Code. */
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
          messages: openAiMessages(req.messages),
        }),
      });
      let outputTokens = 0;
      let sawDelta = false;
      for await (const chunk of sseReader(response, label, (json) => {
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
      }, signal)) {
        if (chunk.delta) sawDelta = true;
        yield chunk;
      }
      // Honest guard: some OpenAI-compatible endpoints (e.g. Z.ai) answer
      // HTTP 200 with a JSON error body that is not SSE; swallowing it as an
      // empty successful completion would be fabrication. Surface it instead.
      if (!sawDelta && outputTokens === 0) {
        throw AppError.unavailable('provider_error', `${label} returned an empty completion (HTTP 200)`, { status: 200 });
      }
    },
  };
}

/**
 * Meta Muse Spark adapter (Model API Chat Completions).
 * Dedicated adapter (not the generic OpenAI-compat one) so the documented
 * Muse Spark wire facts stay explicit: Bearer auth, `model: muse-spark-1.3`,
 * OpenAI-shaped SSE deltas + usage. Timeout/cancellation/429 classification
 * reuse the shared sseReader + httpError + gateway fallback rails — nothing
 * billable is retried blindly and an HTTP-200 non-SSE error body is never
 * swallowed as an empty success.
 */
function museSparkAdapter(model: string, apiKey: string): ProviderAdapter {
  return {
    providerId: 'muse_spark',
    // Documented: Chat Completions covers tool calling + structured output
    // (response_format). The gateway's typed tool-call flow sends a JSON-only
    // instruction and parses JSON — supported by this endpoint.
    supportsToolCalls: true,
    async *complete(req, signal) {
      const response = await fetch(MUSE_SPARK_CHAT_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0.7,
          stream: true,
          messages: openAiMessages(req.messages),
        }),
      });
      let outputTokens = 0;
      let sawDelta = false;
      for await (const chunk of sseReader(response, 'Muse Spark', (json) => {
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
      }, signal)) {
        if (chunk.delta) sawDelta = true;
        yield chunk;
      }
      // Honest guard: an HTTP 200 with a JSON error body that is not SSE must
      // surface as a failure, never as an empty successful completion.
      if (!sawDelta && outputTokens === 0) {
        throw AppError.unavailable('provider_error', 'Muse Spark returned an empty completion (HTTP 200)', { status: 200 });
      }
    },
  };
}

/** Master flag: Muse Spark is opt-in and OFF by default. */
export function museSparkEnabled(): boolean {
  return String(env.MUSE_SPARK_ENABLED ?? 'false').toLowerCase() === 'true';
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

/**
 * Devin v1 adapter — external autonomous engineering agent.
 * NOT a chat/completion model. Wraps the Devin session lifecycle into the
 * ProviderAdapter interface so it integrates with the same gateway, cost
 * tracking, health monitoring, and audit path.
 *
 * Flow: POST /v1/sessions → poll GET /v1/sessions/{id} → stream result.
 * Requires DEVIN_API_KEY (cog_ prefix) and DEVIN_ORG_ID in env.
 */
function devinAdapter(apiKey: string, orgId: string | undefined): ProviderAdapter {
  return {
    providerId: 'devin',
    supportsToolCalls: true,
    async *complete(req, signal) {
      const prompt = req.messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
      const createUrl = orgId
        ? `${DEVIN_V3_BASE}/organizations/${orgId}/sessions`
        : `${DEVIN_V1_BASE}/sessions`;
      const createResp = await fetch(createUrl, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ prompt, title: 'CodeConClave AI task' }),
      });
      if (!createResp.ok) {
        const body = await createResp.text().catch(() => '').then((t) => t.slice(0, 300));
        throw httpError(createResp.status, 'Devin', body);
      }
      const createData = (await createResp.json()) as { session_id: string; url?: string };
      const sessionId = createData.session_id;
      const startedAt = new Date().toISOString();
      yield { delta: '', inputTokens: 0, outputTokens: 0, externalRun: { externalId: sessionId, status: 'running', startedAt } };

      const pollIntervalMs = 5000;
      const maxPollMs = 300_000;
      const deadline = Date.now() + maxPollMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const statusUrl = orgId
          ? `${DEVIN_V3_BASE}/organizations/${orgId}/sessions/${sessionId}`
          : `${DEVIN_V1_BASE}/sessions/${sessionId}`;
        const statusResp = await fetch(statusUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!statusResp.ok) {
          throw httpError(statusResp.status, 'Devin', `poll ${statusResp.status}`);
        }
        const session = (await statusResp.json()) as {
          status_enum?: string;
          session_url?: string;
          structured_output?: Record<string, unknown>;
          messages?: { sender_type: string; message: string }[];
        };
        if (session.status_enum === 'finished') {
          const lastAssistant = session.messages?.filter((m) => m.sender_type !== 'human').pop();
          const resultText = lastAssistant?.message ?? JSON.stringify(session.structured_output ?? {});
          yield { delta: resultText, inputTokens: prompt.length / 4, outputTokens: resultText.length / 4, externalRun: { externalId: sessionId, status: 'finished', startedAt } };
          return;
        }
        if (session.status_enum === 'blocked') {
          throw AppError.unavailable('provider_error', 'Devin session blocked', { sessionId });
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      throw AppError.unavailable('provider_timeout', `Devin session ${sessionId} did not complete within ${maxPollMs}ms`);
    },
  };
}

/**
 * Manus v2 adapter — external autonomous agent capability (EXTERNAL_AGENT).
 * NOT a chat/completion model. Wraps the v2 async task lifecycle into the
 * ProviderAdapter interface so Manus flows through the SAME gateway, health,
 * cost, and audit rails as every other provider.
 *
 * Flow: POST /v2/task.create → {task_id} → poll /v2/task.listMessages
 * until task status is terminal → normalized result text.
 *
 * Safety: the external agent is ALWAYS opt-in. The router never auto-picks an
 * EXTERNAL_AGENT for chat; CodeConClave tasks stay authoritative and every
 * external action passes the existing permission/approval/budget/audit gates.
 * Auth: x-manus-api-key header (MANUS_API_KEY).
 */
function manusAdapter(apiKey: string): ProviderAdapter {
  return {
    providerId: 'manus',
    supportsToolCalls: false,
    async *complete(req, signal) {
      const prompt = req.messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
      const createResp = await fetch(`${MANUS_V2_BASE}/task.create`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-manus-api-key': apiKey,
        },
        body: JSON.stringify({ prompt, ai_profile: 'manus-1.6' }),
      });
      if (!createResp.ok) {
        const body = await createResp.text().catch(() => '').then((t) => t.slice(0, 300));
        throw httpError(createResp.status, 'Manus', body);
      }
      const createData = (await createResp.json()) as { task_id?: string; id?: string };
      const taskId = createData.task_id ?? createData.id;
      if (!taskId) throw AppError.unavailable('provider_error', 'Manus did not return a task id', { status: createResp.status });
      const startedAt = new Date().toISOString();
      yield { delta: '', inputTokens: 0, outputTokens: 0, externalRun: { externalId: taskId, status: 'running', startedAt } };

      const pollIntervalMs = 5000;
      const maxPollMs = 600_000;
      const deadline = Date.now() + maxPollMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const statusResp = await fetch(`${MANUS_V2_BASE}/task.listMessages`, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'x-manus-api-key': apiKey,
          },
          body: JSON.stringify({ task_id: taskId }),
        });
        if (!statusResp.ok) {
          throw httpError(statusResp.status, 'Manus', `poll ${statusResp.status}`);
        }
        const msg = (await statusResp.json()) as {
          status?: string;
          data?: {
            status?: string;
            result?: { result_text?: string };
            messages?: Array<{ type: string; text?: string }>;
          };
        };
        const status = msg.status ?? msg.data?.status;
        if (status === 'completed' || status === 'finished') {
          const resultText =
            msg.data?.result?.result_text ??
            msg.data?.messages?.filter((m) => m.type === 'message').map((m) => m.text ?? '').join('\n') ??
            '';
          yield { delta: resultText || 'Manus task completed.', inputTokens: prompt.length / 4, outputTokens: (resultText || prompt).length / 4, externalRun: { externalId: taskId, status: 'finished', startedAt } };
          return;
        }
        if (status === 'blocked') {
          throw AppError.unavailable('provider_error', 'Manus task blocked, awaiting human decision', { taskId });
        }
        if (status === 'failed' || status === 'cancelled') {
          throw AppError.unavailable('provider_error', `Manus task ${status}`, { taskId });
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      throw AppError.unavailable('provider_timeout', `Manus task ${taskId} did not complete within ${maxPollMs}ms`);
    },
  };
}

export function getAdapter(providerId: string, model: string): ProviderAdapter {
  // Stage 81 provider quality gate — fail closed BEFORE any key lookup: gated
  // providers can never construct an adapter, even when a key is present.
  const gateReason = providerGateReason(providerId);
  if (gateReason) {
    throw AppError.unavailable('provider_quality_gate', `Provider ${providerId} is blocked by the provider quality gate (${gateReason})`);
  }
  switch (providerId) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw AppError.unavailable('provider_not_configured', 'Anthropic is not configured');
      return anthropicAdapter(model, env.ANTHROPIC_API_KEY);
    case 'openai':
      if (!env.OPENAI_API_KEY) throw AppError.unavailable('provider_not_configured', 'OpenAI is not configured');
      return openaiAdapter(model, env.OPENAI_API_KEY);
    case 'google':
      if (!env.GEMINI_API_KEY) throw AppError.unavailable('provider_not_configured', 'Google is not configured');
      return GEMINI_IMAGE_MODEL_IDS.has(model)
        ? geminiImageAdapter(model, env.GEMINI_API_KEY)
        : geminiAdapter(model, env.GEMINI_API_KEY);
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
    case 'qwen':
      if (!env.QWEN_API_KEY) throw AppError.unavailable('provider_not_configured', 'Qwen is not configured');
      return openaiCompatAdapter('qwen', 'Qwen', QWEN_URL, model, env.QWEN_API_KEY);
    case 'gemma':
      if (!env.GEMINI_API_KEY) throw AppError.unavailable('provider_not_configured', 'Gemma (Google) is not configured');
      return geminiAdapter(model, env.GEMINI_API_KEY);
    case 'devin':
      if (!env.DEVIN_API_KEY) throw AppError.unavailable('provider_not_configured', 'Devin is not configured');
      return devinAdapter(env.DEVIN_API_KEY, env.DEVIN_ORG_ID);
    case 'ox_alpha':
      if (!env.OX_ALPHA_API_KEY) {
        throw AppError.unavailable('provider_not_configured', 'Ox Alpha (OpenRouter) is not configured');
      }
      // Ox Alpha has NO first-party endpoint — the stored OX_ALPHA_API_KEY is an
      // OpenRouter key and the model is the stealth/ox-alpha listing.
      return openaiCompatAdapter('ox_alpha', 'OpenRouter (Ox Alpha)', OPENROUTER_URL, model, env.OX_ALPHA_API_KEY);
    case 'z_code_5_3':
      if (!env.Z_AI_API_KEY) throw AppError.unavailable('provider_not_configured', 'Z Code 5.3 (Z.ai) is not configured');
      return openaiCompatAdapter('z_code_5_3', 'Z Code 5.3 (Z.ai GLM-5.3)', ZAI_URL, model, env.Z_AI_API_KEY);
    case 'manus':
      if (!env.MANUS_API_KEY) throw AppError.unavailable('provider_not_configured', 'Manus is not configured');
      return manusAdapter(env.MANUS_API_KEY);
    case 'muse_spark':
      // Feature-flag gate FIRST: default OFF. A disabled Muse Spark reports
      // CONFIGURATION REQUIRED (provider_not_configured) — never a fake
      // success and never a billable call.
      if (!museSparkEnabled()) {
        throw AppError.unavailable('provider_not_configured', 'Muse Spark is disabled (MUSE_SPARK_ENABLED=false)');
      }
      if (!env.MUSE_SPARK_API_KEY) throw AppError.unavailable('provider_not_configured', 'Muse Spark is not configured');
      return museSparkAdapter(model, env.MUSE_SPARK_API_KEY);
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

/**
 * Consecutive failures required before a provider is downgraded off the active
 * rotation. Free-tier APIs return transient 429/5xx (rate-limit / overload) all
 * the time — a single blip must never permanently kill a provider.
 */
export const HEALTH_DOWNGRADE_THRESHOLD = 2;

/**
 * How long a provider stays excluded after a failure before the registry marks
 * it tentatively retryable again (lazy recovery on the next request).
 */
export const HEALTH_RETRY_COOLDOWN_MS = 60_000;

export function updateProviderHealth(providerId: string, ok: boolean, durationMs: number, error?: string | unknown): void {
  const state = ok ? 'HEALTHY' : error === undefined ? 'DOWN' : deriveStatusFromFailure(error);
  const lastError = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  import('../../shared/db.js')
    .then(async ({ pool: db }) => {
      await db.query(
        `INSERT INTO provider_health (provider_id, state, last_check_at, last_error, success_count, failure_count, avg_latency_ms, consecutive_failures)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7)
         ON CONFLICT (provider_id) DO UPDATE SET
           -- Only downgrade after HEALTH_DOWNGRADE_THRESHOLD consecutive
           -- failures; the first blip is kept healthy (retryable) so a single
           -- transient 429/503 from a free tier cannot disable the provider.
           state = CASE
             WHEN $2 = 'HEALTHY' OR $8 <= 1 THEN $2
             WHEN provider_health.consecutive_failures >= ($8 - 1) THEN $2
             ELSE 'HEALTHY'
           END,
           last_check_at = now(),
           last_error = $3,
           success_count = provider_health.success_count + $4,
           failure_count = provider_health.failure_count + $5,
           avg_latency_ms = CASE WHEN $2 = 'HEALTHY' THEN $6 ELSE (provider_health.avg_latency_ms * 4 + $6) / 5 END,
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
          HEALTH_DOWNGRADE_THRESHOLD,
        ],
      );
      // The registry caches health verdicts for AI_MODEL_REFRESH_MINUTES — a
      // stale DOWN would outlive the retry cooldown, so bust it on every write.
      const { cache } = await import('../../shared/cache.js');
      await cache.del('ai:registry');
    })
    .catch((err) => logger.warn('provider health update failed', { error: (err as Error).message }));
}