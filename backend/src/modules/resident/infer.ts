/**
 * CodeConClave AI — Resident inference client (v3 arc, no change).
 * Calls your 5 tuned Hub weights via HuggingFace Serverless Inference
 * (zero GPU on Render). Dispatch picks 1 driver · 1 run; receipt logs
 * Hub ID + hash. Needs HF_DRIVER_TOKEN (free, read-only is enough for
 * public models; write never needed at serving time).
 */
import { driverForRole } from '../ingest/drivers.js';

const HF_API = 'https://api-inference.huggingface.co/models';

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
      return undefined;
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

export async function residentComplete(role: string, prompt: string, maxTokens = 512): Promise<ResidentAnswer> {
  const driver = driverForRole(role);
  if (!driver) throw new Error(`unknown_role:${role}`);
  const token = process.env.HF_DRIVER_TOKEN;
  if (!token) throw new Error('HF_DRIVER_TOKEN_missing');
  const capped = Math.min(maxTokens, driver.maxTokens);
  const res = await fetch(`${HF_API}/${driver.hubId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: capped, temperature: 0.7 } }),
  });
  if (!res.ok) throw new Error(`resident_infer_failed:${res.status}`);
  const json = (await res.json()) as Array<{ generated_text?: string }> | { generated_text?: string };
  const text = Array.isArray(json) ? (json[0]?.generated_text ?? '') : (json.generated_text ?? '');
  if (driver.box === 'SCOUT' && !guardScout(text)) throw new Error('scout_contract_break_escalate');
  return { hubId: driver.hubId, role, text, tokens: text.length >> 2 };
}
