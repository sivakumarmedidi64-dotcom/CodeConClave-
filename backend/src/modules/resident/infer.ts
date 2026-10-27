/**
 * CodeConClave AI — Resident inference client (v3 arc).
 * Dispatch picks 1 driver · 1 run; the receipt logs the Hub ID that really
 * answered. Two transports, chosen from the environment:
 *
 *   1. RESIDENT_OPENAI_BASE_URL — any OpenAI-compatible server hosting the
 *      tuned weights: Ollama (http://localhost:11434/v1), vLLM, LM Studio, TGI
 *      or a Hugging Face Inference Endpoint (…/v1). Optional RESIDENT_API_KEY;
 *      RESIDENT_MODEL_MAP (JSON {hubId: servedName}) when the server names
 *      models differently (default: the repo name, e.g. codeconclave-coder-lite).
 *   2. HF_DRIVER_TOKEN — Hugging Face's serverless router
 *      (router.huggingface.co/hf-inference). Only models HF has deployed for
 *      serverless can answer there; custom fine-tunes usually are not, and
 *      the status probe says so instead of pretending.
 *
 * The legacy api-inference.huggingface.co host no longer resolves (verified
 * 2026-10-20), so it is not used. A driver that failed recently is skipped
 * for a cool-down window so a dead host never adds latency to every chat.
 */
import { driverForRole, RESIDENT_DRIVERS, type ResidentDriver } from '../ingest/drivers.js';

const HF_ROUTER = 'https://router.huggingface.co/hf-inference/models';
const HF_MODEL_API = 'https://huggingface.co/api/models';
const CALL_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;
const PROBE_TTL_MS = 5 * 60_000;

export interface ResidentAnswer {
  hubId: string;
  role: string;
  text: string;
  tokens: number;
}

/**
 * v3 task-type → resident role. Only task types with a real tuned driver
 * attempt resident; everything else falls through to the gateway.
 * Returns undefined = gateway handles it.
 */
export function residentRoleForTask(taskType?: string): string | undefined {
  switch (taskType) {
    case 'CODING':
    case 'DEBUGGING':
    case 'REFACTORING':
    case 'TEST_GENERATION':
      return 'Coder';
    case 'CODE_REVIEW':
      return 'Reviewer';
    case 'ARCHITECTURE':
    case 'PLANNING':
    case 'TASK_PLANNING':
      return 'Architect';
    default:
      // Everything else answers on the founder's OWN tuned model too — "our AI"
      // for all chat, not just coding. Gateway still checks residentReady() and
      // falls back honestly if the resident is down or not configured.
      return 'Coder';
  }
}

/** Strict scout output guard: must stay valid JSON lane/risk. */
export function guardScout(text: string): boolean {
  try {
    const o = JSON.parse(text.trim()) as { lane?: string; risk?: string };
    return ['CODER', 'PLANNER', 'FASTQA'].includes(String(o.lane)) &&
      ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(o.risk));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ transport

export type ResidentTransport =
  | { kind: 'openai'; baseUrl: string; apiKey?: string; modelMap: Record<string, string> }
  | { kind: 'hf'; token: string }
  | { kind: 'none' };

export function residentTransport(env: NodeJS.ProcessEnv = process.env): ResidentTransport {
  const base = env.RESIDENT_OPENAI_BASE_URL?.trim();
  if (base) {
    let modelMap: Record<string, string> = {};
    try {
      const parsed = env.RESIDENT_MODEL_MAP ? (JSON.parse(env.RESIDENT_MODEL_MAP) as unknown) : {};
      if (parsed && typeof parsed === 'object') modelMap = parsed as Record<string, string>;
    } catch {
      /* malformed map → defaults */
    }
    return { kind: 'openai', baseUrl: base.replace(/\/+$/, ''), apiKey: env.RESIDENT_API_KEY?.trim() || undefined, modelMap };
  }
  const token = env.HF_DRIVER_TOKEN?.trim();
  if (token) return { kind: 'hf', token };
  return { kind: 'none' };
}

/** Name the OpenAI-compatible server knows the driver by. */
export function servedModelName(hubId: string, modelMap: Record<string, string>): string {
  return modelMap[hubId] ?? hubId.split('/').pop() ?? hubId;
}

// ------------------------------------------------------------- health memory

interface Health {
  ok: boolean;
  at: number;
  reason: string | null;
}

const lastCall = new Map<string, Health>();
let probeCache: { at: number; result: Map<string, Health> } | null = null;

function record(hubId: string, ok: boolean, reason: string | null): void {
  lastCall.set(hubId, { ok, at: Date.now(), reason });
}

/** Test seam. */
export function _resetResidentHealth(): void {
  lastCall.clear();
  probeCache = null;
}

/**
 * Should the gateway try this role's driver now? Never when nothing is
 * configured, and not while a recent failure or a probe says it can't answer.
 */
export function residentReady(role: string): { ok: true } | { ok: false; reason: string } {
  const driver = driverForRole(role);
  if (!driver) return { ok: false, reason: `unknown_role:${role}` };
  if (residentTransport().kind === 'none') return { ok: false, reason: 'not_configured' };
  const recent = lastCall.get(driver.hubId);
  if (recent && !recent.ok && Date.now() - recent.at < FAILURE_COOLDOWN_MS) {
    return { ok: false, reason: recent.reason ?? 'recent_failure' };
  }
  const probed = probeCache && Date.now() - probeCache.at < PROBE_TTL_MS ? probeCache.result.get(driver.hubId) : undefined;
  if (probed && !probed.ok) return { ok: false, reason: probed.reason ?? 'probe_failed' };
  return { ok: true };
}

// ------------------------------------------------------------------ calls

async function callOpenAi(
  t: Extract<ResidentTransport, { kind: 'openai' }>,
  driver: ResidentDriver,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${t.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: servedModelName(driver.hubId, t.modelMap),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resident_infer_failed:${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

async function callHf(t: Extract<ResidentTransport, { kind: 'hf' }>, driver: ResidentDriver, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch(`${HF_ROUTER}/${driver.hubId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: prompt,
      // return_full_text=false: text-generation otherwise echoes the prompt back.
      parameters: { max_new_tokens: maxTokens, temperature: 0.7, return_full_text: false },
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resident_infer_failed:${res.status}`);
  const json = (await res.json()) as Array<{ generated_text?: string }> | { generated_text?: string };
  return Array.isArray(json) ? (json[0]?.generated_text ?? '') : (json.generated_text ?? '');
}

export async function residentComplete(role: string, prompt: string, maxTokens = 512): Promise<ResidentAnswer> {
  const driver = driverForRole(role);
  if (!driver) throw new Error(`unknown_role:${role}`);
  const t = residentTransport();
  if (t.kind === 'none') throw new Error('resident_not_configured');
  const capped = Math.min(maxTokens, driver.maxTokens);
  let text: string;
  try {
    text = t.kind === 'openai' ? await callOpenAi(t, driver, prompt, capped) : await callHf(t, driver, prompt, capped);
  } catch (err) {
    record(driver.hubId, false, err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!text.trim()) {
    record(driver.hubId, false, 'resident_empty_answer');
    throw new Error('resident_empty_answer');
  }
  if (driver.box === 'SCOUT' && !guardScout(text)) throw new Error('scout_contract_break_escalate');
  record(driver.hubId, true, null);
  return { hubId: driver.hubId, role, text, tokens: text.length >> 2 };
}

// ------------------------------------------------------------------ status

export type DriverState = 'READY' | 'UNVERIFIED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

export interface DriverStatus {
  hubId: string;
  box: string;
  roles: string[];
  state: DriverState;
  reason: string | null;
}

export interface ResidentStatus {
  transport: ResidentTransport['kind'];
  /** Host only (never a path with credentials or a token). */
  host: string | null;
  drivers: DriverStatus[];
  anyReady: boolean;
  checkedAt: string;
}

async function probeOpenAi(t: Extract<ResidentTransport, { kind: 'openai' }>): Promise<Map<string, Health>> {
  const out = new Map<string, Health>();
  try {
    const res = await fetch(`${t.baseUrl}/models`, {
      headers: t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`models_http_${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const served = new Set((json.data ?? []).map((m) => String(m.id ?? '')));
    // Ollama reports "name:tag"; accept a match with or without the tag.
    const has = (name: string) => served.has(name) || [...served].some((s) => s.split(':')[0] === name);
    for (const d of RESIDENT_DRIVERS) {
      const name = servedModelName(d.hubId, t.modelMap);
      out.set(d.hubId, has(name) ? { ok: true, at: Date.now(), reason: null } : { ok: false, at: Date.now(), reason: `not_served_by_host:${name}` });
    }
  } catch (err) {
    const reason = `host_unreachable:${err instanceof Error ? err.message : String(err)}`;
    for (const d of RESIDENT_DRIVERS) out.set(d.hubId, { ok: false, at: Date.now(), reason });
  }
  return out;
}

async function probeHf(): Promise<Map<string, Health>> {
  const out = new Map<string, Health>();
  await Promise.all(
    RESIDENT_DRIVERS.map(async (d) => {
      try {
        const res = await fetch(`${HF_MODEL_API}/${d.hubId}?expand%5B%5D=inferenceProviderMapping`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 404) {
          out.set(d.hubId, { ok: false, at: Date.now(), reason: 'repo_missing_or_private' });
          return;
        }
        if (!res.ok) throw new Error(`hub_http_${res.status}`);
        const json = (await res.json()) as { inferenceProviderMapping?: Record<string, unknown> };
        const mapped = json.inferenceProviderMapping && Object.keys(json.inferenceProviderMapping).length > 0;
        out.set(
          d.hubId,
          mapped ? { ok: true, at: Date.now(), reason: null } : { ok: false, at: Date.now(), reason: 'not_hosted_by_any_hf_inference_provider' },
        );
      } catch (err) {
        out.set(d.hubId, { ok: false, at: Date.now(), reason: `hub_unreachable:${err instanceof Error ? err.message : String(err)}` });
      }
    }),
  );
  return out;
}

/** Honest per-driver status. Probes the host (cached) unless `probe` is false. */
export async function residentStatus(probe = true): Promise<ResidentStatus> {
  const t = residentTransport();
  if (probe && t.kind !== 'none' && (!probeCache || Date.now() - probeCache.at >= PROBE_TTL_MS)) {
    probeCache = { at: Date.now(), result: t.kind === 'openai' ? await probeOpenAi(t) : await probeHf() };
  }
  const drivers: DriverStatus[] = RESIDENT_DRIVERS.map((d) => {
    const base = { hubId: d.hubId, box: d.box, roles: d.roles };
    if (t.kind === 'none') return { ...base, state: 'NOT_CONFIGURED', reason: 'Set RESIDENT_OPENAI_BASE_URL or HF_DRIVER_TOKEN' };
    const recent = lastCall.get(d.hubId);
    const probed = probeCache?.result.get(d.hubId);
    if (recent && Date.now() - recent.at < FAILURE_COOLDOWN_MS) {
      return { ...base, state: recent.ok ? 'READY' : 'UNAVAILABLE', reason: recent.reason };
    }
    if (probed) return { ...base, state: probed.ok ? 'READY' : 'UNAVAILABLE', reason: probed.reason };
    return { ...base, state: 'UNVERIFIED', reason: null };
  });
  let host: string | null = null;
  if (t.kind === 'openai') {
    try {
      host = new URL(t.baseUrl).host;
    } catch {
      host = null;
    }
  } else if (t.kind === 'hf') {
    host = 'router.huggingface.co';
  }
  return {
    transport: t.kind,
    host,
    drivers,
    anyReady: drivers.some((d) => d.state === 'READY'),
    checkedAt: new Date().toISOString(),
  };
}
