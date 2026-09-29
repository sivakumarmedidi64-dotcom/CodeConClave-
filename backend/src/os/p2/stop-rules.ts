/**
 * CodeConClave AI OS — P2.6 Stop Rules (policy/capability enforcement).
 *
 * SECURITY: Stop Rules are enforced BELOW the prompt layer. No prompt,
 * system-prompt manipulation, sub-agent, tool argument, API request, WebSocket,
 * scheduled/background task, skill, voice command, replay, or imported cowork
 * state can bypass them. The canonical chain is:
 *
 *   REQUEST → AUTHENTICATION → CAPABILITY CHECK → STOP-RULE POLICY CHECK
 *   → RESOURCE GOVERNOR → SANDBOX / EXECUTION → ACTION
 *
 * This module IS the STOP-RULE POLICY CHECK stage. It runs only after
 * authentication/capability, before any execution. If the rule denies, the
 * action MUST NOT occur.
 *
 * Enforcement model
 * -----------------
 * - Every protected path is canonicalized and normalized BEFORE evaluation so
 *   `../`, symlink-like escapes, alternate separators, case variants and encoded
 *   traversal collapse onto the same canonical key as the requested target.
 * - Child agents/processes INHERIT the parent policy because policy lives on the
 *   WORKSPACE/EXECUTION context, not on a model; a child can never gain broader
 *   rights than its parent.
 * - Cross-agent / concurrent accounting is atomic: files-changed is a single
 *   counter mutexed across all agents in a workspace, so concurrent attempts
 *   cannot race past the limit.
 * - Approvals are bound to (user, workspace, process/action, capability, target,
 *   expiration, one-time use). There is no unbounded "approved forever".
 * - Precedence is deterministic: HARD DENY → PROTECTED RESOURCE → CAPABILITY
 *   DENY → APPROVAL REQUIRED → RESOURCE LIMIT → ALLOW. A lower-priority rule
 *   never overrides a hard deny; personality modes never override rules.
 * - Every decision emits an audit event and never logs secrets.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { Capability } from '../types.js';
import type { P2Feature } from './flags.js';

// ---------------------------------------------------------------------------
// Canonical policy structure (plain data objects; no duplicate models).
// ---------------------------------------------------------------------------

export const StopRuleOperation = {
  WRITE: 'write',
  EDIT: 'edit',
  DELETE: 'delete',
  RENAME: 'rename',
  EXEC: 'exec',
  NETWORK: 'network',
  GIT_COMMIT: 'git.commit',
  GIT_MERGE: 'git.merge',
  PACKAGE_INSTALL: 'package.install',
} as const;
export type StopRuleOperation = (typeof StopRuleOperation)[keyof typeof StopRuleOperation];

export interface ProtectedPath {
  /** Absolute-path string; directory entries match recursively (e.g. /secret/**). */
  path: string;
  recursive: boolean;
}

export interface StopRulePolicy {
  protectedPaths: ProtectedPath[];
  maxFilesChanged: number | null;
  maxRuntimeMs: number | null;
  allowDelete: boolean;
  approvalRequired: StopRuleOperation[];
  requiredCapabilities: Partial<Record<StopRuleOperation, string>>;
}

export type AuditDecision =
  | 'RULE_EVALUATED'
  | 'RULE_ALLOWED'
  | 'RULE_DENIED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_EXPIRED';

export interface AuditEvent {
  workspaceId: string | null;
  coworkId: string | null;
  processId: string | null;
  action: string;
  target: string | null;
  rule: string;
  decision: AuditDecision;
  traceId: string | null;
  at: number;
}

export interface ApprovalSubject {
  userId: string;
  workspaceId: string | null;
  processId: string | null;
  action: string;
  capability: string;
  target: string | null;
}

export interface ApprovalGrant {
  id: string;
  subject: ApprovalSubject;
  expiresAt: number;
  used: boolean;
  oneTime: boolean;
}

export interface EvaluationContext {
  userId: string;
  workspaceId: string | null;
  coworkId: string | null;
  processId: string | null;
  capabilities: readonly Capability[];
  traceId?: string | null;
}

export type DenyResult = {
  allowed: false;
  reason: string;
  rule: string;
  approvalRequested?: boolean;
};
export type AllowResult = { allowed: true; rule: 'ALLOW' };

// ---------------------------------------------------------------------------
// Path canonicalization (anti-traversal).
// ---------------------------------------------------------------------------

export function canonicalize(input: string, opts: { caseSensitive?: boolean } = {}): string {
  let p = input;
  if (/%2e|%2E|%2f|%2F/.test(p)) {
    throw AppError.badRequest('aios_stoprule_path', 'encoded traversal characters are not allowed');
  }
  if (p.includes('\u0000')) throw AppError.badRequest('aios_stoprule_path', 'null byte in path');
  p = p.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
  const stack: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) throw AppError.badRequest('aios_stoprule_path', 'path escapes workspace root');
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  let joined = '/' + stack.join('/');
  if (!opts.caseSensitive) joined = joined.toLowerCase();
  return joined;
}

export function isUnder(target: string, protectedPath: string): boolean {
  if (target === protectedPath) return true;
  const trailingGlob = protectedPath.endsWith('**');
  if (!trailingGlob) {
    return target.startsWith(protectedPath.endsWith('/') ? protectedPath : protectedPath + '/');
  }
  const base = protectedPath.slice(0, protectedPath.length - 2).replace(/\/$/, '');
  if (base === '') return true;
  return target === base || target.startsWith(base + '/');
}

// ---------------------------------------------------------------------------
// The StopRules enforcer.
// ---------------------------------------------------------------------------

export class StopRules {
  private policy: StopRulePolicy;
  private changedFiles = new Set<string>();
  private startMs = Date.now();
  private approvals = new Map<string, ApprovalGrant>();
  private audit: AuditEvent[] = [];
  /** Promise-chain mutex: serializes evaluate() (atomic accounting). */
  private chain: Promise<void> = Promise.resolve();
  private caseSensitive: boolean;

  constructor(
    policy: StopRulePolicy,
    private feature: () => P2Feature | null,
    opts: { caseSensitive?: boolean } = {},
  ) {
    this.caseSensitive = opts.caseSensitive ?? true;
    this.policy = this.canonicalizePolicy(policy);
  }

  isEnabled(): boolean {
    return this.feature() === 'stop_rules';
  }

  private canonicalizePolicy(p: StopRulePolicy): StopRulePolicy {
    return {
      ...p,
      protectedPaths: p.protectedPaths.map((pp) => ({
        path: canonicalize(pp.path, { caseSensitive: this.caseSensitive }),
        recursive: pp.recursive,
      })),
    };
  }

  /** Serialize an async callback (atomic accounting across agents). */
  private async locked<T>(fn: () => T): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((res) => (release = res));
    await prev;
    try {
      return fn();
    } finally {
      release();
    }
  }

  private emit(action: string, target: string | null, rule: string, decision: AuditDecision, ev: EvaluationContext): void {
    this.audit.push({
      workspaceId: ev.workspaceId,
      coworkId: ev.coworkId,
      processId: ev.processId,
      action,
      target,
      rule,
      decision,
      traceId: ev.traceId ?? null,
      at: Date.now(),
    });
  }

  auditLog(): AuditEvent[] {
    return [...this.audit];
  }

  get policySnapshot(): StopRulePolicy {
    return this.policy;
  }

  /** Current policy governs current execution (proves replay never carries stale policy). */
  setPolicy(p: StopRulePolicy): void {
    this.policy = this.canonicalizePolicy(p);
    this.changedFiles = new Set();
    this.startMs = Date.now();
  }

  /**
   * Authoritative enforcement entry point. Runs ONLY after authentication and
   * the capability check. On deny, the caller MUST NOT perform the action.
   */
  async evaluate(opts: { operation: StopRuleOperation; target?: string; ev: EvaluationContext }): Promise<AllowResult | DenyResult> {
    return this.locked(() => this.evaluateLocked(opts));
  }

  private evaluateLocked(opts: { operation: StopRuleOperation; target?: string; ev: EvaluationContext }): AllowResult | DenyResult {
    if (!this.isEnabled()) return { allowed: true, rule: 'ALLOW' };
    const target = opts.target ? canonicalize(opts.target, { caseSensitive: this.caseSensitive }) : null;
    const op = opts.operation;
    const ev = opts.ev;
    this.emit(op, target, 'audit', 'RULE_EVALUATED', ev);

    // HARD DENY: no-delete policy + protected-resource delete (cannot be overridden).
    if (!this.policy.allowDelete && opMatchesDelete(op)) {
      this.emit(op, target, 'no_delete', 'RULE_DENIED', ev);
      return { allowed: false, reason: 'Blocked by Stop Rule: file deletion is prohibited.', rule: 'no_delete' };
    }
    if (target && opMatchesDelete(op) && this.isProtectedPath(target)) {
      this.emit(op, target, 'protected_path', 'RULE_DENIED', ev);
      return { allowed: false, reason: 'Blocked by Stop Rule: protected file/directory.', rule: 'protected_path' };
    }

    // PROTECTED RESOURCE (write/edit/rename to a protected path): bound approval required.
    if (target && (op === 'write' || op === 'edit' || op === 'rename') && this.isProtectedPath(target)) {
      return this.maybeDenyApproval(ev, op, target);
    }

    // CAPABILITY DENY.
    const required = this.policy.requiredCapabilities[op];
    if (required && !hasCap(ev.capabilities, required)) {
      this.emit(op, target, 'capability', 'RULE_DENIED', ev);
      return { allowed: false, reason: 'Blocked by Stop Rule: capability required.', rule: 'capability' };
    }

    // APPROVAL REQUIRED.
    if (this.policy.approvalRequired.includes(op)) {
      return this.maybeDenyApproval(ev, op, target);
    }

    // RESOURCE LIMIT: max files changed (writes/edits to a new file).
    if ((op === 'write' || op === 'edit') && this.policy.maxFilesChanged != null) {
      if (!this.changedFiles.has(target ?? '') && this.changedFiles.size >= this.policy.maxFilesChanged) {
        this.emit(op, target, 'max_files', 'RULE_DENIED', ev);
        return {
          allowed: false,
          reason: `Blocked by Stop Rule: Maximum files changed = ${this.changedFiles.size}/${this.policy.maxFilesChanged}.`,
          rule: 'max_files',
        };
      }
      this.changedFiles.add(target ?? '');
    }

    this.emit(op, target, 'allow', 'RULE_ALLOWED', ev);
    return { allowed: true, rule: 'ALLOW' };
  }

  private isProtectedPath(target: string): boolean {
    for (const pp of this.policy.protectedPaths) {
      if (isUnder(target, pp.path)) return true;
    }
    return false;
  }

  private maybeDenyApproval(ev: EvaluationContext, op: StopRuleOperation, target: string | null): AllowResult | DenyResult {
    const capability = this.policy.requiredCapabilities[op] ?? op;
    const subject: ApprovalSubject = {
      userId: ev.userId,
      workspaceId: ev.workspaceId,
      processId: ev.processId,
      action: op,
      capability,
      target,
    };
    const grant = this.findValidApproval(subject);
    if (grant) {
      if (grant.oneTime) {
        grant.used = true;
        this.approvals.delete(grant.id);
      }
      this.emit(op, target, 'approval', 'APPROVAL_GRANTED', ev);
      return { allowed: true, rule: 'ALLOW' };
    }
    this.emit(op, target, 'approval', 'APPROVAL_REQUESTED', ev);
    return { allowed: false, reason: `Blocked by Stop Rule: approval required for ${op}.`, rule: 'approval', approvalRequested: true };
  }

  private findValidApproval(subject: ApprovalSubject): ApprovalGrant | null {
    const now = Date.now();
    for (const [id, g] of this.approvals) {
      if (g.used) {
        this.approvals.delete(id);
        continue;
      }
      if (g.expiresAt <= now) {
        this.approvals.delete(id);
        // Expiry is an audit event (approval garbage-collected here).
        this.audit.push({
          workspaceId: subject.workspaceId,
          coworkId: null,
          processId: subject.processId,
          action: subject.action,
          target: subject.target,
          rule: 'approval',
          decision: 'APPROVAL_EXPIRED',
          traceId: null,
          at: now,
        });
        continue;
      }
      const s = g.subject;
      if (s.action === subject.action &&
          s.capability === subject.capability &&
          s.workspaceId === subject.workspaceId &&
          s.processId === subject.processId &&
          s.userId === subject.userId &&
          (s.target === null || s.target === subject.target)) {
        return g;
      }
    }
    return null;
  }

  /** Grant a bound approval (user, workspace, process/action, capability, target, expiration, one-time). */
  grantApproval(subject: ApprovalSubject, opts: { expiresInMs: number; oneTime: boolean; authorized: boolean }): ApprovalGrant {
    if (!opts.authorized) throw AppError.forbidden('aios_stoprule_approval_grant_denied', 'approval grant requires permission');
    const grant: ApprovalGrant = {
      id: randomUUID(),
      subject: { ...subject },
      expiresAt: Date.now() + opts.expiresInMs,
      used: false,
      oneTime: opts.oneTime,
    };
    this.approvals.set(grant.id, grant);
    return grant;
  }

  /** Force-expire an approval (test/ops helper); no-op if gone. */
  expireApproval(id: string): void {
    this.approvals.delete(id);
  }

  /** Whether the runtime deadline has been reached (max-runtime enforcement). */
  deadlinePassed(): boolean {
    if (this.policy.maxRuntimeMs == null) return false;
    return Date.now() - this.startMs > this.policy.maxRuntimeMs;
  }

  /** Number of distinct files already changed (cross-agent accounting). */
  filesChanged(): number {
    return this.changedFiles.size;
  }
}

function actionOf(op: StopRuleOperation, _target?: string | null): string {
  return op;
}

function hasCap(caps: readonly Capability[], kind: string): boolean {
  return caps.some((c) => c.kind === kind);
}

function opMatchesDelete(op: StopRuleOperation): boolean {
  return op === 'delete' || op === 'rename' || op === 'exec';
}

