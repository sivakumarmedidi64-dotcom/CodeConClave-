/**
 * CodeConClave — payment gate popup.
 * Shown immediately after login/signup while GET /api/v1/access says the
 * workspace is locked (no free application tier — pay to enter). This modal is
 * UNAUTHORITATIVE chrome: the backend decides entitlement (402
 * entitlement_required on every gated router). Users pay from here via the
 * same rails as Settings → Billing (payment-link pool first, legacy session
 * fallback, MANUAL claims when configured). Non-dismissible: the workspace
 * stays locked until a verified paid entitlement is active.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { useToast } from './Toast';
import type {
  PaymentCapability,
  PaymentIntent,
  PaymentClaim,
  PaymentStatusView,
  WorkspaceAccess,
} from '../lib/types';

const REASON_TEXT: Record<string, string> = {
  NO_ENTITLEMENT:
    'CodeConClave has no free application tier — a paid Solo or Team plan is required to use the workspace.',
  PENDING:
    'Your payment is pending verification. Access unlocks automatically once the payment is verified.',
  EXPIRED: 'Your paid plan expired. Renew to continue using the workspace.',
  REVOKED: 'Your access was revoked. Purchase a plan to continue.',
  API_ONLY:
    'API Access unlocks the AI API only. Choose Solo or Team to use the workspace itself.',
};

export function PaymentGateModal() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [access, setAccess] = useState<WorkspaceAccess | null>(null);
  const [capability, setCapability] = useState<PaymentCapability | null>(null);
  const [payStatus, setPayStatus] = useState<PaymentStatusView | null>(null);
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [claims, setClaims] = useState<PaymentClaim[]>([]);
  const [billingBusy, setBillingBusy] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimIntentId, setClaimIntentId] = useState('');
  const [claimPaymentId, setClaimPaymentId] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c, p, it, cl] = await Promise.all([
        api<{ access: WorkspaceAccess }>('/api/v1/access'),
        api<PaymentCapability>('/api/v1/payments/capabilities'),
        api<PaymentStatusView>('/api/v1/payments/status'),
        api<{ intents: PaymentIntent[] }>('/api/v1/payments/intents'),
        api<{ claims: PaymentClaim[] }>('/api/v1/payments/claims'),
      ]);
      setAccess(a.access);
      setCapability(c);
      setPayStatus(p);
      setIntents(it.intents ?? []);
      setClaims(cl.claims ?? []);
    } catch {
      /* the server stays authoritative; keep the current surface */
    }
  }, []);

  const checkStatus = useCallback(() => {
    void load();
    void refresh();
  }, [load, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const upgrade = async (planId: 'pro' | 'team' | 'api') => {
    setBillingBusy(true);
    try {
      try {
        const pool = await api<{
          intent: { intentId: string; paymentUrl: string; expiresAt: string; amountInr: number; currency: string; plan: string; linkReferenceId: string };
        }>('/api/pay/pool/intent', { method: 'POST', body: { planId } });
        if (pool.intent?.paymentUrl) {
          window.location.href = pool.intent.paymentUrl;
          toast(
            `Reserved a payment link — pay ${pool.intent.amountInr / 100} ${pool.intent.currency} to activate ${String(pool.intent.plan ?? 'plan').toUpperCase()}`,
          );
          return;
        }
      } catch {
        // pool disabled / links busy -> legacy session rail
      }
      const res = await api<{ session: { id: string }; redirectUrl: string | null; note?: string }>(
        '/api/v1/payments/sessions',
        { method: 'POST', body: { planId } },
      );
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
      } else {
        toast(res.note ?? 'Checkout started — awaiting payment');
      }
      await load();
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'checkout failed', 'error');
    } finally {
      setBillingBusy(false);
    }
  };

  const submitClaim = async () => {
    if (!claimIntentId) {
      setClaimError('Pick the checkout you paid, then confirm.');
      return;
    }
    if (!claimPaymentId.trim()) {
      setClaimError('Enter the Razorpay Payment ID (pay_...).');
      return;
    }
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await api<{ claim: PaymentClaim }>('/api/v1/payments/claims', {
        method: 'POST',
        body: { intentId: claimIntentId, paymentId: claimPaymentId.trim() },
      });
      setClaimPaymentId('');
      toast(`Claim ${res.claim.status.toLowerCase()} — you'll be notified once verified.`);
      await load();
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'claim failed');
    } finally {
      setClaimBusy(false);
    }
  };

  const unlocked = access?.unlocked ?? false;
  useEffect(() => {
    if (unlocked) navigate('/home', { replace: true });
  }, [unlocked, navigate]);
  if (unlocked) return null;

  const reasonKey = access?.reason ?? 'NO_ENTITLEMENT';
  const claimable = intents.filter((i) => i.status === 'PENDING' || i.status === 'REVIEW');
  const manual = capability?.unlockMode === 'MANUAL';
  const activePlan =
    payStatus && (payStatus.effectivePlan === 'pro' || payStatus.effectivePlan === 'team')
      ? payStatus.effectivePlan
      : user?.entitlementState === 'PRO_VERIFIED'
        ? 'pro'
        : 'free';

  return (
    <div className="cc-overlay" data-testid="payment-gate-modal">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a CodeConClave plan"
        className="cc-card"
        style={{ width: 'min(680px, 92vw)', maxHeight: '88vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>Welcome to CodeConClave — activate your plan</h1>
          <p className="cc-hint" style={{ margin: 0 }}>
            {REASON_TEXT[reasonKey] ?? REASON_TEXT.NO_ENTITLEMENT}
          </p>
          {payStatus && payStatus.accountEmail && (
            <p className="cc-hint" style={{ margin: 0 }}>
              Account: <span className="cc-mono">{payStatus.accountEmail}</span>
            </p>
          )}
        </header>

        <div>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={billingBusy} onClick={() => void checkStatus()}>
            Check payment status
          </button>
        </div>

        {(activePlan === 'free' || activePlan === 'pro') && capability && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {activePlan === 'free' && (
              <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Solo</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                  ₹{capability.plans?.pro ?? 999}
                  <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
                </div>
                <p className="cc-hint" style={{ flex: 1 }}>
                  Full workspace: chat, projects, agents, tasks, memory, DNA and connectors.
                </p>
                <button className="cc-btn cc-btn--primary" disabled={billingBusy} onClick={() => void upgrade('pro')}>
                  {billingBusy ? 'Starting checkout…' : `Upgrade (₹${capability.plans?.pro ?? 999})`}
                </button>
              </div>
            )}
            <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>Team</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                ₹{capability.plans?.team ?? 4999}
                <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
              </div>
              <p className="cc-hint" style={{ flex: 1 }}>
                Everything in Solo plus team agents, shared DNA and team memory.
              </p>
              <button className="cc-btn" disabled={billingBusy} onClick={() => void upgrade('team')}>
                {billingBusy ? 'Starting checkout…' : `Upgrade (₹${capability.plans?.team ?? 4999})`}
              </button>
            </div>
          </div>
        )}

        {capability && (
          <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600 }}>API Access</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                  ₹{capability.plans?.api ?? 9999}
                  <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
                </div>
                <p className="cc-hint" style={{ maxWidth: 460 }}>
                  Programmatic access via API keys — a separate add-on, not included with Solo or Team.
                </p>
              </div>
              <button className="cc-btn" disabled={billingBusy} onClick={() => void upgrade('api')}>
                {billingBusy ? 'Starting checkout…' : `Upgrade (₹${capability.plans?.api ?? 9999})`}
              </button>
            </div>
          </div>
        )}

        {payStatus && (payStatus.plans ?? []).some((pl) => pl.intentStatus !== null) && (
          <div className="cc-card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Payment status</div>
            {payStatus.plans.map((pl) => (
              <div key={pl.planId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{pl.planId}</span>
                <span className="cc-hint">
                  intent <span className="cc-mono">{pl.intentStatus ?? '—'}</span> · confidence{' '}
                  {pl.confidence === null ? '—' : `${(pl.confidence * 100).toFixed(0)}%`} · entitlement{' '}
                  <span className="cc-mono">{pl.entitlementState ?? '—'}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {manual && (
          <div className="cc-card" data-testid="payment-gate-modal-manual" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 600 }}>Paid the link? Confirm the payment</div>
            <p className="cc-hint" style={{ margin: 0 }}>
              Your payment is reviewed before access unlocks. Use the reference (e.g.{' '}
              <span className="cc-mono">CCPRO-XXXXXX</span>) when paying, then paste your Razorpay Payment ID (
              <span className="cc-mono">pay_...</span>).
            </p>
            {claimable.length === 0 ? (
              <p className="cc-hint">No open checkout yet. Use a plan card above to reserve one.</p>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <select
                    className="cc-input"
                    style={{ maxWidth: 320 }}
                    value={claimIntentId || claimable[0]!.id}
                    onChange={(ev) => { setClaimIntentId(ev.target.value); setClaimError(null); }}
                    aria-label="Checkout to confirm"
                  >
                    {claimable.map((i) => (
                      <option key={i.id} value={i.id}>
                        {String(i.planId ?? 'free').toUpperCase()} — ₹{i.amountInr} — {i.reference}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const selected = claimable.find((i) => i.id === claimIntentId) ?? claimable[0]!;
                    return selected.paymentLink ? (
                      <a className="cc-btn cc-btn--ghost cc-btn--sm" href={selected.paymentLink} target="_blank" rel="noreferrer">
                        Open payment link
                      </a>
                    ) : null;
                  })()}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <input
                    className="cc-input"
                    style={{ maxWidth: 320 }}
                    placeholder="pay_..."
                    value={claimPaymentId}
                    onChange={(ev) => { setClaimPaymentId(ev.target.value); setClaimError(null); }}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Razorpay Payment ID"
                  />
                  <button className="cc-btn cc-btn--primary cc-btn--sm" disabled={claimBusy} onClick={() => void submitClaim()}>
                    {claimBusy ? 'Submitting…' : 'Confirm my payment'}
                  </button>
                </div>
              </>
            )}
            {claimError && <p className="cc-hint" style={{ color: 'var(--cc-danger, #b3261e)' }}>{claimError}</p>}
          </div>
        )}

        <p className="cc-hint" style={{ margin: 0, textAlign: 'center' }}>
          The workspace unlocks automatically once your payment is verified.
        </p>
      </div>
    </div>
  );
}