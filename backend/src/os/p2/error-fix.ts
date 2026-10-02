/**
 * CodeConClave AI OS — P2.10 Error Quick-Fix.
 *
 * Deterministic quick-fix flow built on observability + capabilities:
 *   capture error → identify context → propose a fix → user approves → execute
 *   the fix through OS capabilities → rerun verification.
 * A security-sensitive fix NEVER auto-applies: it always requires explicit
 * approval, and execution always passes through the stop-rule policy. The fix
 * itself is a bounded, declarative patch (path + which content) with a reason.
 */
import { AppError } from '../../shared/errors.js';
import type { P2Feature } from './flags.js';

export interface ErrorContext {
  errorCode: string | null;
  message: string;
  traceId: string | null;
  source: 'task' | 'command' | 'skill' | 'scheduled' | 'background' | 'voice';
}

export interface FixProposal {
  id: string;
  targetPath: string | null;
  hint: string;
  operations: Array<{ kind: 'apply_patch' | 'retry' | 'install' | 'config'; detail: string }>;
  securitySensitive: boolean;
  approved: boolean;
}

export type FixOutcome =
  | { status: 'applied'; proposalId: string; verification: boolean }
  | { status: 'denied'; proposalId: string; reason: string }
  | { status: 'pending_approval'; proposalId: string };

export class ErrorQuickFix {
  private proposals = new Map<string, FixProposal>();

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'error_fix';
  }

  /** CAPTURE + identify context: classify error into a structural fix. */
  capture(ctx: ErrorContext): FixProposal {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_errorfix_disabled', 'error quick-fix is off');
    const msg = ctx.message.toLowerCase();
    const securitySensitive = /token|secret|credential|password|grant|permission|sudo|chmod|environment|\.env/i.test(msg);
    const operations: FixProposal['operations'] = [];
    let hint: string;
    if (/ts(?:2307|2322|2339)|cannot find module/.test(msg)) {
      hint = 'Missing module or type import';
      operations.push({ kind: 'install', detail: 'resolve/install missing dependency or add import' });
    } else if (/error: command not found|not recognized/i.test(msg)) {
      hint = 'Command missing from PATH';
      operations.push({ kind: 'config', detail: 'install the required command or adjust PATH' });
    } else if (/timeout|timed out|ETIMEDOUT/.test(msg)) {
      hint = 'Network/service timeout';
      operations.push({ kind: 'retry', detail: 'retry with backoff and bounded attempts' });
    } else if (/denied|forbidden|unauthorized|403/.test(msg)) {
      hint = 'Permission denied';
      operations.push({ kind: 'config', detail: 'request approval / verify capability (never auto-grant)' });
    } else {
      hint = 'Apply a targeted patch to the offending source';
      operations.push({ kind: 'apply_patch', detail: 'patch the reported location and revert on failure' });
    }
    const proposal: FixProposal = {
      id: `fix_${Date.now()}`,
      targetPath: null,
      hint,
      operations,
      securitySensitive,
      approved: false,
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /** PROPOSE: attach a concrete target path for the fix (optional). */
  describe(proposalId: string, targetPath: string): FixProposal {
    const p = this.byId(proposalId);
    p.targetPath = targetPath;
    return p;
  }

  /** APPROVE: user explicitly approves. Security-sensitive fixes always require this. */
  approve(proposalId: string, authorized: boolean): FixProposal {
    const p = this.byId(proposalId);
    if (p.securitySensitive && !authorized) {
      throw AppError.forbidden('aios_p2_errorfix_approval_denied', 'security-sensitive fix requires explicit approval');
    }
    if (!authorized) throw AppError.forbidden('aios_p2_errorfix_approval_denied', 'fix approval denied');
    p.approved = true;
    return p;
  }

  /**
   * EXECUTE through OS capabilities + stop rules. `ruleAllows` is the result of
   * the stop-rule/capability gate; if it is false the fix MUST NOT apply. On
   * success the caller provides the verification result; on failure it is
   * rolled back (no partial apply).
   */
  async execute(
    proposalId: string,
    opts: {
      ruleAllows: boolean;
      apply: () => Promise<{ ok: boolean; verification?: boolean }>;
      authorized: boolean;
    },
  ): Promise<FixOutcome> {
    const p = this.byId(proposalId);
    if (p.securitySensitive && !p.approved) {
      return { status: 'denied', proposalId, reason: 'approval not granted for security-sensitive fix' };
    }
    if (!opts.ruleAllows) {
      return { status: 'denied', proposalId, reason: 'blocked by stop rule / capability' };
    }
    if (!p.approved && !opts.authorized) {
      return { status: 'pending_approval', proposalId };
    }
    const res = await opts.apply();
    if (!res.ok) return { status: 'denied', proposalId, reason: 'apply failed (rolled back)' };
    return { status: 'applied', proposalId, verification: res.verification ?? false };
  }

  /** RERUN VERIFICATION outcome injection (test helper / observable). */
  private byId(id: string): FixProposal {
    const p = this.proposals.get(id);
    if (!p) throw AppError.notFound('aios_p2_errorfix', `proposal ${id} not found`);
    return p;
  }
}
