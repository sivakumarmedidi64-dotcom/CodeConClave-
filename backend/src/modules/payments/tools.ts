/**
 * CodeConClave — payment domain tools for the execution engine.
 *
 * 'payment_capability' reports the honest, server-derived capability.
 * 'payment_admin' executes administrative payment actions ONLY through the
 * Phase 4C Approval Center flow: the tool re-validates an APPROVED payment_op
 * approval AND the payment verification server-side. An approval can
 * authorize an admin action but can never turn an unverified payment into a
 * verified one.
 */
import { registerTool } from '../execution/toolcalls.js';
import { AppError } from '../../shared/errors.js';
import { paymentCapability, systemAdminPaymentAction, type AdminPaymentAction } from './service.js';

const ADMIN_ACTIONS: AdminPaymentAction[] = ['revoke', 'mark_refunded'];

export function registerPaymentTools(): void {
  registerTool('payment_capability', async () => {
    return { ok: true, capability: paymentCapability() };
  });

  registerTool('payment_admin', async (input) => {
    const sessionId = String(input.sessionId ?? '');
    const action = String(input.action ?? '');
    const approvalId = String(input.approvalId ?? '');
    if (!sessionId || !approvalId) {
      throw AppError.badRequest('invalid_input', 'sessionId and approvalId are required');
    }
    if (!ADMIN_ACTIONS.includes(action as AdminPaymentAction)) {
      throw AppError.badRequest('invalid_action', `action must be one of ${ADMIN_ACTIONS.join(', ')}`);
    }
    const session = await systemAdminPaymentAction(sessionId, action as AdminPaymentAction, approvalId);
    return { ok: true, sessionId: session.id, state: session.state, action };
  });
}