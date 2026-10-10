/**
 * CodeConClave — P2 desktop-control policy (server side).
 *
 * Deterministic, deny-by-default. Validates a desktop instruction BEFORE it is
 * stored on a task and BEFORE it is dispatched to a device:
 *   - a strict, minimal surface: inspect windows, launch an allow-listed app,
 *     focus an already-open window. There is NO free-form desktop execution;
 *   - every launched application must appear on the server-side allowlist
 *     (`DESKTOP_ALLOWED_APPS`), never an arbitrary path or command line;
 *   - a strict, tested action shape and a bound on action count (anti-loop).
 * The local agent re-checks the same rules at execution time: this module is
 * the contract, both sides enforce it.
 */
import { env } from '../../config/env.js';
import { DesktopActionOp, DesktopCapability } from '@codeconclave/shared';
import type { DesktopActionOp as Op, DesktopCapability as Cap } from '@codeconclave/shared';

export const DESKTOP_PERMISSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const DESKTOP_MAX_ACTIONS = 10;
export const DESKTOP_MAX_APP_ID_LENGTH = 64;
export const DESKTOP_MAX_WINDOW_TITLE_LENGTH = 256;

/** Master gate — default OFF; a disabled capability must never appear enabled. */
export function desktopControlEnabled(): boolean {
  return String(env.DESKTOP_CONTROL_ENABLED).toLowerCase() === 'true';
}

/** Server-side launch allowlist. Empty means nothing may be launched. */
export function desktopAllowedApps(): string[] {
  return String(env.DESKTOP_ALLOWED_APPS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------- action contracts

/** Strict op → capability mapping. Every op requires exactly one grant. */
export const DESKTOP_OP_TO_CAPABILITY: Readonly<Record<Op, Cap>> = {
  [DesktopActionOp.LIST_WINDOWS]: DesktopCapability.INSPECT,
  [DesktopActionOp.OPEN_APP]: DesktopCapability.OPEN_APP,
  [DesktopActionOp.FOCUS_WINDOW]: DesktopCapability.FOCUS_WINDOW,
};

export interface DesktopAction {
  op: Op;
  /** Allow-listed application id (from DESKTOP_ALLOWED_APPS). */
  app?: string;
  /** Window title to focus (matched case-insensitively by the local agent). */
  title?: string;
}

export interface DesktopInstruction {
  type: 'desktop';
  grants: { capabilities: Cap[]; lifetimeMs: number };
  actions: DesktopAction[];
  pinnedDeviceId?: string;
}

export type DesktopParseResult = { ok: true; instruction: DesktopInstruction } | { ok: false; reason: string };

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function validCapability(v: unknown): v is Cap {
  return typeof v === 'string' && (Object.values(DesktopCapability) as string[]).includes(v);
}

function stringField(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) return undefined;
  return v;
}

/** Normalize an app id: lower-case, trimmed, printable single token. */
function normalizeAppId(v: unknown): string | undefined {
  const s = stringField(v, DESKTOP_MAX_APP_ID_LENGTH);
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return undefined;
  return t;
}

/** Validate and normalize an instruction. Returns the canonical form or a reason. */
export function parseDesktopInstruction(raw: unknown): DesktopParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'instruction_not_object' };
  const r = raw as Record<string, unknown>;
  if (r.type !== 'desktop') return { ok: false, reason: 'instruction_type_not_desktop' };
  const grants = (r.grants ?? {}) as Record<string, unknown>;
  if (!Array.isArray(grants.capabilities)) return { ok: false, reason: 'grants_capabilities_required' };
  const capabilities = dedupe((grants.capabilities as unknown[]).filter(validCapability));
  if (capabilities.length === 0) return { ok: false, reason: 'grants_capabilities_empty' };
  const lifetimeMs =
    typeof grants.lifetimeMs === 'number' && Number.isFinite(grants.lifetimeMs)
      ? Math.min(Math.max(grants.lifetimeMs, 0), DESKTOP_PERMISSION_MAX_LIFETIME_MS)
      : DESKTOP_PERMISSION_MAX_LIFETIME_MS;
  if (!Array.isArray(r.actions)) return { ok: false, reason: 'actions_required' };
  if (r.actions.length === 0) return { ok: false, reason: 'actions_empty' };
  if (r.actions.length > DESKTOP_MAX_ACTIONS) return { ok: false, reason: 'actions_too_many' };

  const allowlist = desktopAllowedApps();
  const instruction: DesktopInstruction = { type: 'desktop', grants: { capabilities, lifetimeMs }, actions: [] };
  for (const rawAction of r.actions as unknown[]) {
    if (!rawAction || typeof rawAction !== 'object') return { ok: false, reason: 'action_not_object' };
    const act = rawAction as Record<string, unknown>;
    const op = act.op;
    if (typeof op !== 'string' || !(Object.values(DesktopActionOp) as string[]).includes(op)) return { ok: false, reason: 'action_unknown_op' };
    const o = op as Op;
    const required = DESKTOP_OP_TO_CAPABILITY[o];
    if (!capabilities.includes(required)) return { ok: false, reason: `capability_not_granted_${o}` };
    const action: DesktopAction = { op: o };
    switch (o) {
      case DesktopActionOp.LIST_WINDOWS:
        break;
      case DesktopActionOp.OPEN_APP: {
        const app = normalizeAppId(act.app);
        if (!app) return { ok: false, reason: 'op_open_app_requires_app' };
        if (!allowlist.includes(app)) return { ok: false, reason: 'op_open_app_not_allowlisted' };
        action.app = app;
        break;
      }
      case DesktopActionOp.FOCUS_WINDOW: {
        const title = stringField(act.title, DESKTOP_MAX_WINDOW_TITLE_LENGTH);
        if (!title) return { ok: false, reason: 'op_focus_window_requires_title' };
        action.title = title;
        if (act.app !== undefined) {
          const app = normalizeAppId(act.app);
          if (!app) return { ok: false, reason: 'op_focus_window_invalid_app' };
          action.app = app;
        }
        break;
      }
    }
    instruction.actions.push(action);
  }
  if (typeof r.pinnedDeviceId === 'string' && r.pinnedDeviceId.length > 0 && r.pinnedDeviceId.length <= 128) {
    instruction.pinnedDeviceId = r.pinnedDeviceId;
  }
  return { ok: true, instruction };
}

/** Capabilities a desktop task actually REQUIRES to execute its actions. */
export function desktopInstructionRequiredCapabilities(instruction: unknown): Cap[] | null {
  if (!instruction || typeof instruction !== 'object') return null;
  const i = instruction as DesktopInstruction;
  if (i.type !== 'desktop' || !Array.isArray(i.actions)) return null;
  const caps = new Set<Cap>();
  for (const action of i.actions) {
    const c = DESKTOP_OP_TO_CAPABILITY[action.op];
    if (c) caps.add(c);
  }
  return [...caps];
}

/** Risk class of an action for the deterministic risk model (approvals/UI). */
export function desktopActionRisk(op: Op): 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (op) {
    case DesktopActionOp.OPEN_APP:
    case DesktopActionOp.FOCUS_WINDOW:
      return 'MEDIUM';
    default:
      return 'LOW';
  }
}
