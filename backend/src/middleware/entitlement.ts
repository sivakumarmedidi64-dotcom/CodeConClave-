/**
 * CodeConClave — server-authoritative workspace entitlement gate.
 * Commercial rule: there is NO free application tier. An authenticated user
 * may use the CodeConClave workspace (chat, projects, agents, tasks,
 * execution, connectors, paid AI) only while they hold an ACTIVE VERIFIED
 * paid entitlement for the Solo (pro) or Team (team) plan. API Access is a
 * separate entitlement that unlocks /api/v1/ai for cc_live_* keys — it does
 * NOT unlock the workspace.
 *
 * The frontend hiding pages is cosmetic; the authority is enforced here, at
 * the router mount, in front of every protected workspace router.
 */
import type { NextFunction, Request, Response } from 'express';
import { withTenant } from '../shared/db.js';
import { AppError } from '../shared/errors.js';
import {
  isFounderAccount,
  hasVerifiedEntitlement,
  isPaymentTestUser,
  temporaryDemoModeEnabled,
} from '../modules/entitlements/service.js';

export type WorkspaceReason =
  | 'NO_ENTITLEMENT'
  | 'PENDING'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'API_ONLY'
  | 'TEMPORARY_DEMO_MODE';

export interface WorkspaceAccess {
  /** true when the workspace may be used right now (paid grant OR demo mode). */
  unlocked: boolean;
  effectivePlan: 'free' | 'pro' | 'team';
  /** Mirrored users.plan_id (free/pro/team/api/enterprise). */
  planId: string;
  /** Mirrored users.entitlement_state (FREE/PRO_PENDING/PRO_VERIFIED/...). */
  entitlementState: string;
  reason: WorkspaceReason;
  /**
   * TEST-ONLY payment bypass marker (PAYMENT_TEST_USER_IDS). True only for
   * explicitly allowlisted user IDs; always false otherwise. Surfaced so the
   * bypass is visible, never silent.
   */
  testBypass: boolean;
  /**
   * TEMPORARY: the server-side TEMPORARY_DEMO_MODE flag is currently on. This is
   * the global mode indicator, surfaced through GET /api/v1/access.
   */
  demoMode: boolean;
  /**
   * True ONLY when a real, verified paid Solo/Team entitlement backs this access.
   * Demo mode, the founder grant and the test-user bypass all report false: the
   * system never claims a payment happened when none did.
   */
  paidEntitlement: boolean;
  /**
   * True when the user would be refused by the commercial paywall right now.
   * This is deliberately independent of `paidEntitlement`: under demo mode a
   * user has paymentRequired=false WITHOUT having paid anything.
   */
  paymentRequired: boolean;
}

/**
 * Resolve the workspace access state for a user. Source of truth is the
 * verified `entitlements` row for the mirrored users.plan_id — the same rule
 * `effectivePlan()` uses for feature limits, so the workspace gate can never
 * diverge from the rest of the plan-enforcement layer.
 *
 * The founder/VIP email (PAYMENT_FOUNDER_EMAIL) always holds a full team
 * workspace — no payment is ever required for the founder's own account.
 */
export async function workspaceAccess(userId: string): Promise<WorkspaceAccess> {
  // TEMPORARY: read on every call so flipping the env var takes effect on the
  // next request (see temporaryDemoModeEnabled).
  const demoMode = temporaryDemoModeEnabled();
  const user = await withTenant<{ plan_id: string; entitlement_state: string } | null>(userId, async (q) =>
    (
      await q.query<{ plan_id: string; entitlement_state: string }>(
        'SELECT plan_id, entitlement_state FROM users WHERE id = $1',
        [userId],
      )
    ).rows[0] ?? null,
  );
  const planId = user?.plan_id ?? 'free';
  const entitlementState = user?.entitlement_state ?? 'FREE';

  // Security fix: the founder grant used to be decided by comparing the email
  // string to PAYMENT_FOUNDER_EMAIL. Registration accepts an unverified
  // address, so anyone could claim the founder inbox and receive a permanent
  // Team workspace for free. isFounderAccount additionally requires a VERIFIED
  // email and the explicitly provisioned is_founder flag.
  if (await isFounderAccount(userId)) {
    return {
      unlocked: true,
      effectivePlan: 'team',
      planId,
      entitlementState,
      reason: 'ACTIVE',
      testBypass: false,
      demoMode,
      paidEntitlement: false,
      paymentRequired: false,
    };
  }

  // TEST-ONLY payment bypass (PAYMENT_TEST_USER_IDS): development/manual
  // validation for explicitly allowlisted user IDs. Read-time override only —
  // writes no entitlement or payment rows and never marks any payment
  // successful. Ordinary users can never reach this branch: matching is by
  // exact server-side user ID, never email, never client input.
  if (isPaymentTestUser(userId)) {
    return {
      unlocked: true,
      effectivePlan: 'team',
      planId,
      entitlementState,
      reason: 'ACTIVE',
      testBypass: true,
      demoMode,
      paidEntitlement: false,
      paymentRequired: false,
    };
  }

  let unlocked = false;
  let paidEntitlement = false;
  let effectivePlan: WorkspaceAccess['effectivePlan'] = 'free';
  let reason: WorkspaceReason;

  if (planId === 'pro' || planId === 'team') {
    // Security fix: also honour entitlements.expires_at so an expired plan is
    // denied at request time rather than waiting for the sweep worker.
    if (await hasVerifiedEntitlement(userId, planId)) {
      unlocked = true;
      paidEntitlement = true;
      effectivePlan = planId;
      reason = 'ACTIVE';
    } else if (entitlementState === 'PRO_PENDING') {
      reason = 'PENDING';
    } else {
      reason = 'EXPIRED';
    }
  } else {
    if (entitlementState === 'REVOKED') {
      reason = 'REVOKED';
    } else if (planId === 'api') {
      reason = 'API_ONLY';
    } else {
      reason = 'NO_ENTITLEMENT';
    }
  }

  // ---------------------------------------------------------------------
  // TEMPORARY DEMO / EARLY ACCESS MODE (TEMPORARY_DEMO_MODE=true)
  //
  // Read-time allowance ONLY. It grants workspace access to an authenticated
  // user with no paid entitlement and:
  //   - writes nothing (no payment, intent, webhook or entitlement row),
  //   - never sets plan_id / entitlement_state, so no surface can show a plan as
  //     purchased or PRO_VERIFIED (they keep mirroring the truthful 'free'),
  //   - never unlocks API Access — /api/v1/ai keeps its own apiKeyAuth gate.
  //
  // REVOKED is intentionally EXCLUDED. Revocation is a security decision
  // (refund/abuse), not a payment state, so demo mode must not undo it.
  // ---------------------------------------------------------------------
  if (!unlocked && demoMode && reason !== 'REVOKED') {
    return {
      unlocked: true,
      effectivePlan,
      planId,
      entitlementState,
      reason: 'TEMPORARY_DEMO_MODE',
      testBypass: false,
      demoMode: true,
      paidEntitlement: false,
      paymentRequired: false,
    };
  }

  return {
    unlocked,
    effectivePlan,
    planId,
    entitlementState,
    reason,
    testBypass: false,
    demoMode,
    paidEntitlement,
    paymentRequired: !unlocked,
  };
}

export function workspaceReasonMessage(reason: WorkspaceReason): string {
  switch (reason) {
    case 'ACTIVE':
      return 'Active paid plan';
    case 'PENDING':
      return 'Payment is pending verification — it becomes active once verified.';
    case 'EXPIRED':
      return 'Your paid plan has expired — renew to continue using the workspace.';
    case 'REVOKED':
      return 'Your access was revoked — purchase a plan to continue.';
    case 'API_ONLY':
      return 'API Access unlocks the AI API only. Choose Solo or Team to use the workspace.';
    case 'TEMPORARY_DEMO_MODE':
      return 'Temporary demo / early access mode — workspace access is open, no payment was taken.';
    default:
      return 'A paid CodeConClave plan (Solo = ₹999 or Team = ₹4,999) is required to use the workspace.';
  }
}

/**
 * Express middleware: an authenticated user must hold an active verified paid
 * entitlement before any router mounted behind this gate is reached. Unpaid /
 * pending / expired / revoked and API-only users receive 402 payment_required.
 *
 * TEMPORARY DEMO MODE: when the server-side TEMPORARY_DEMO_MODE flag is on,
 * `workspaceAccess()` reports unlocked=true with reason TEMPORARY_DEMO_MODE, so
 * this middleware lets the request through WITHOUT any entitlement and WITHOUT
 * writing any payment/entitlement row. With the flag off (the default) the gate
 * behaves exactly as before — this is the only behavioural difference.
 *
 * API Access is NOT affected: /api/v1/ai is mounted with apiKeyAuth(), not
 * behind this gate, so its ₹9,999 entitlement requirement is untouched.
 */
export function requireWorkspaceEntitlement() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.ctx?.user;
    if (!user) {
      next(AppError.unauthorized());
      return;
    }
    try {
      const access = await workspaceAccess(user.id);
      if (access.unlocked) {
        next();
        return;
      }
      next(
        AppError.paymentRequired(
          'entitlement_required',
          `Workspace access requires an active paid plan. ${workspaceReasonMessage(access.reason)}`,
        ),
      );
    } catch (err) {
      next(AppError.unavailable('entitlement_check_failed', 'Could not verify entitlement. Try again.'));
    }
  };
}