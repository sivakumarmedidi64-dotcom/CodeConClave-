/**
 * CodeConClave — Settings: Profile, Security (MFA), Devices & Sessions,
 * Billing/payments, Preferences. Idempotent against the API contract.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { applyTheme, isTheme } from '../lib/theme';
import {
  browserNotificationCapability,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from '../lib/browserNotifications';
import type {
  AiModel,
  DeviceInfo,
  DigestStatus,
  Entitlement,
  NotificationPreferences,
  PaymentCapability,
  PaymentSession,
  PaymentStatusView,
  ProviderStatusEntry,
  ProviderStatusReport,
  SessionInfo,
  UsageOverview,
} from '../lib/types';
import { useToast } from '../components/Toast';

type Tab = 'profile' | 'security' | 'devices' | 'billing' | 'preferences' | 'notifications' | 'providers';

const PROVIDER_STATUS_LABEL: Record<ProviderStatusEntry['status'], string> = {
  AVAILABLE: 'Available',
  LIMITED: 'Limited',
  NOT_CONFIGURED: 'Not configured',
  REQUIRES_REAUTH: 'Re-authorization required',
  DEGRADED: 'Degraded',
  FAILED: 'Failed',
};

export function SettingsPage() {
  const { user, sendVerificationEmail } = useAuth();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(
    initialTab === 'billing' || initialTab === 'notifications' || initialTab === 'providers' ? initialTab : 'profile',
  );
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [capability, setCapability] = useState<PaymentCapability | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [payStatus, setPayStatus] = useState<PaymentStatusView | null>(null);
  const [sessions2, setPaySessions] = useState<PaymentSession[]>([]);
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [digestStatus, setDigestStatus] = useState<DigestStatus | null>(null);
  const [providers, setProviders] = useState<ProviderStatusEntry[]>([]);
  const [providersState, setProvidersState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [mfaSetup, setMfaSetup] = useState<{ secretOtpAuthUrl: string; secretBase32: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [prefsText, setPrefsText] = useState('{}');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [themeBusy, setThemeBusy] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({});
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifState, setNotifState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [browserPerm, setBrowserPerm] = useState<BrowserNotificationPermission>(() => browserNotificationCapability().permission);
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelPref, setModelPref] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api<{ sessions: SessionInfo[] }>('/api/v1/auth/sessions'),
        api<{ devices: DeviceInfo[] }>('/api/v1/auth/devices'),
      ]);
      setSessions(s.sessions);
      setDevices(d.devices);
    } catch {
      /* ignore */
    }
    try {
      const [c, e, p, u, ps] = await Promise.all([
        api<PaymentCapability>('/api/v1/payments/capabilities'),
        api<{ entitlements: Entitlement[] }>('/api/v1/payments/entitlements'),
        api<{ sessions: PaymentSession[] }>('/api/v1/payments/sessions'),
        api<{ overview: UsageOverview }>('/api/v1/workspace/usage/overview'),
        api<PaymentStatusView>('/api/v1/payments/status'),
      ]);
      setCapability(c);
      setEntitlements(e.entitlements);
      setPaySessions(p.sessions);
      setUsage(u.overview);
      setPayStatus(ps);
    } catch {
      /* ignore */
    }
  }, []);

  const loadProviders = useCallback(async () => {
    setProvidersState('loading');
    try {
      const res = await api<ProviderStatusReport>('/api/v1/operations/providers');
      setProviders(res.providers);
      setProvidersState('ready');
    } catch {
      setProvidersState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setupMfa = async () => {
    try {
      const res = await api<{ secretOtpAuthUrl: string; secretBase32: string }>('/api/v1/auth/mfa/setup', { method: 'POST' });
      setMfaSetup(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'setup failed', 'error');
    }
  };

  const confirmMfa = async () => {
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/confirm', {
        method: 'POST',
        body: { code: mfaCode },
      });
      setRecovery(res.recoveryCodes);
      setMfaSetup(null);
      setMfaCode('');
      toast('MFA enabled — store your recovery codes');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'confirm failed', 'error');
    }
  };

  const upgrade = async () => {
    setBillingBusy(true);
    try {
      const res = await api<{ session: PaymentSession; redirectUrl: string | null; capability: PaymentCapability; note?: string }>(
        '/api/v1/payments/sessions',
        { method: 'POST', body: { planId: 'pro' } },
      );
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
      } else {
        toast(res.note ?? 'Session created — awaiting provider payment');
      }
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'session failed', 'error');
    } finally {
      setBillingBusy(false);
    }
  };

  const requestCancellation = async (sessionId: string) => {
    setCancelBusy(true);
    try {
      const res = await api<{ approval: { id: string; status: string } }>(
        `/api/v1/payments/sessions/${sessionId}/cancel-request`,
        { method: 'POST', body: { reason: 'Requested by the account owner' } },
      );
      toast(`Cancellation requested — approval ${res.approval.status.toLowerCase()} (review in the Approval Center)`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'cancellation request failed', 'error');
    } finally {
      setCancelBusy(false);
    }
  };

  const enableBrowserNotifications = async () => {
    const permission = await requestBrowserNotificationPermission();
    setBrowserPerm(permission);
    if (permission === 'granted') toast('Browser notifications enabled while CodeConClave is open');
    else if (permission === 'denied') toast('Permission denied by the browser', 'error');
  };

  const loadPrefs = useCallback(async () => {
    try {
      const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences');
      setPrefsText(JSON.stringify(res.prefs, null, 2));
      if (typeof res.prefs.current_model === 'string') setModelPref(res.prefs.current_model);
      if (isTheme(res.prefs.theme)) {
        setTheme(res.prefs.theme);
        applyTheme(res.prefs.theme);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (tab === 'preferences') void loadPrefs();
  }, [tab, loadPrefs]);

  const loadNotifPrefs = useCallback(async () => {
    setNotifState('loading');
    try {
      const res = await api<{ prefs: NotificationPreferences }>('/api/v1/notifications/preferences');
      setNotifPrefs(res.prefs ?? {});
      setNotifState('ready');
    } catch {
      setNotifState('error');
    }
  }, []);

  useEffect(() => {
    if (tab === 'notifications') {
      void loadNotifPrefs();
      void api<{ models: AiModel[]; defaultModel: string | null }>('/api/v1/ai/models')
        .then((res) => setModels(res.models ?? []))
        .catch(() => undefined);
      void api<DigestStatus>('/api/v1/digests/status')
        .then((res) => setDigestStatus(res && typeof res.frequency === 'string' ? res : null))
        .catch(() => undefined);
    }
    if (tab === 'preferences' && models.length === 0) {
      void api<{ models: AiModel[]; defaultModel: string | null }>('/api/v1/ai/models')
        .then((res) => setModels(res.models ?? []))
        .catch(() => undefined);
    }
    if (tab === 'providers') void loadProviders();
  }, [tab, loadNotifPrefs, models.length, loadProviders]);

  const saveNotifPrefs = async () => {
    setNotifBusy(true);
    try {
      const res = await api<{ prefs: NotificationPreferences }>('/api/v1/notifications/preferences', {
        method: 'PUT',
        body: notifPrefs,
      });
      setNotifPrefs(res.prefs ?? {});
      toast('Notification preferences saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'prefs failed', 'error');
    } finally {
      setNotifBusy(false);
    }
  };

  const setNotifFlag = (key: keyof NotificationPreferences, value: boolean) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
  };

  const savePrefs = async () => {
    try {
      const parsed = JSON.parse(prefsText) as Record<string, unknown>;
      const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences', {
        method: 'PUT',
        body: { prefs: parsed },
      });
      setPrefsText(JSON.stringify(res.prefs, null, 2));
      if (isTheme(res.prefs.theme)) {
        setTheme(res.prefs.theme);
        applyTheme(res.prefs.theme);
      }
      toast('Preferences saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'prefs failed', 'error');
    }
  };

  const changeTheme = async (next: 'light' | 'dark') => {
    setThemeBusy(true);
    try {
      const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences', {
        method: 'PUT',
        body: { prefs: { theme: next } },
      });
      setTheme(res.prefs.theme as 'light' | 'dark');
      applyTheme(res.prefs.theme as 'light' | 'dark');
      setPrefsText(JSON.stringify(res.prefs, null, 2));
      toast(`Theme set to ${next}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'theme failed', 'error');
    } finally {
      setThemeBusy(false);
    }
  };

  const saveModelPref = async (modelId: string) => {
    setModelPref(modelId);
    try {
      await api('/api/v1/workspace/preferences', {
        method: 'PUT',
        body: { prefs: { current_model: modelId || null } },
      });
      toast('Default model saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'model pref failed', 'error');
    }
  };

  const sendVerify = async () => {
    setVerifyBusy(true);
    setVerifyError(null);
    setVerifySent(false);
    try {
      const res = await sendVerificationEmail();
      if (res.alreadyVerified) {
        toast('Email already verified');
      } else {
        setVerifySent(true);
        toast('Verification email sent');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send verification email';
      setVerifyError(message);
      toast(message, 'error');
    } finally {
      setVerifyBusy(false);
    }
  };

  const tabs: Tab[] = ['profile', 'security', 'devices', 'billing', 'preferences', 'notifications', 'providers'];

  return (
    <div className="cc-page">
      <h1>Settings</h1>
      <div className="cc-toggle">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="cc-card">
          <h3>Profile</h3>
          <p>
            <strong>{user?.displayName ?? '—'}</strong> · <span className="cc-hint">{user?.email}</span>
          </p>
          <p className="cc-hint">
            Plan: {user?.planId} · Entitlement:{' '}
            <span style={{ color: user?.entitlementState === 'PRO_VERIFIED' ? '#1e7d46' : 'inherit' }}>
              {user?.entitlementState}
            </span>
          </p>
          <p className="cc-hint">
            Email {user?.emailVerified ? 'verified' : 'not verified yet'} · MFA {user?.mfaEnabled ? 'enabled' : 'disabled'} ·{' '}
            role {user?.rbacRole}
          </p>
          {!user?.emailVerified && (
            <div style={{ marginTop: 12 }}>
              <p className="cc-hint">
                Confirm your address to unlock account recovery and keep notifications flowing.
              </p>
              <button className="cc-btn" disabled={verifyBusy} onClick={() => void sendVerify()}>
                {verifyBusy ? 'Sending…' : 'Send verification email'}
              </button>
              {verifySent && <p className="cc-hint" style={{ marginTop: 8 }}>Verification email sent — check your inbox (expires in 24h, single use).</p>}
              {verifyError && <p className="cc-error" style={{ marginTop: 8 }}>{verifyError}</p>}
            </div>
          )}
        </div>
      )}

      {tab === 'security' && (
        <div className="cc-card">
          <h3>Two-factor authentication</h3>
          {!mfaSetup && !user?.mfaEnabled && (
            <>
              <p className="cc-hint">TOTP (RFC 6238) with recovery codes; enforced at sign-in when enabled.</p>
              <button className="cc-btn" onClick={() => void setupMfa()}>
                Enable MFA
              </button>
            </>
          )}
          {mfaSetup && (
            <div>
              <p className="cc-hint">
                Scan with any authenticator app (ticket URL):{' '}
                <span className="cc-mono" style={{ wordBreak: 'break-all' }}>{mfaSetup.secretOtpAuthUrl}</span>
              </p>
              <p className="cc-hint">
                Secret (base32): <span className="cc-mono">{mfaSetup.secretBase32}</span>
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="cc-input" style={{ width: 160 }} placeholder="123456" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
                <button className="cc-btn" disabled={!mfaCode.trim()} onClick={() => void confirmMfa()}>
                  Confirm
                </button>
              </div>
            </div>
          )}
          {(!mfaSetup && user?.mfaEnabled) && (
            <p className="cc-hint">
              MFA is enabled. To disable or rotate recovery codes, use the API
              (<span className="cc-mono">POST /mfa/disable</span> with your current code).
            </p>
          )}
          {recovery.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong>Recovery codes (copy now, shown once):</strong>
              <div className="cc-mono" style={{ background: '#111', color: '#fff', padding: 12, borderRadius: 8, marginTop: 6 }}>
                {recovery.map((c) => (
                  <div key={c}>{c}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'devices' && (
        <div className="cc-card">
          <h3>Devices & sessions</h3>
          {devices.length > 0 && (
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{d.state}</td>
                    <td>{new Date(d.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sessions.length > 0 && (
            <>
              <h4 style={{ marginTop: 16 }}>Active sessions</h4>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="cc-mono">{s.id.slice(0, 12)}…</td>
                      <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="cc-hint">
            Pair a Local Agent under <em>Remote Control</em>; this page manages devices and
            active sessions for this account.
          </p>
        </div>
      )}

      {tab === 'billing' && (
        <div className="cc-card">
          <h3>Payments & plan</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
              ↻ Refresh
            </button>
          </div>
          {capability && (
            <p className="cc-hint" style={{ marginTop: 8 }}>
              Razorpay ({capability.mode}) · {capability.currency} —{' '}
              {capability.razorpayConfigured ? 'configured' : 'payment-link mode'}
            </p>
          )}
          {capability && (
            <p className="cc-hint" style={{ marginTop: 4 }}>
              Evidence providers —{' '}
              <span className="cc-mono">
                link {capability.evidence.link.enabled ? 'ON' : 'OFF'}
              </span>
              {' · '}
              <span className="cc-mono">
                api {capability.evidence.api.enabled ? 'ON' : 'OFF'}
              </span>
              {' · '}
              <span className="cc-mono">
                webhook {capability.evidence.webhook.enabled ? 'ON' : 'OFF'}
              </span>
            </p>
          )}
          {entitlements.length === 0 && <p className="cc-hint">No entitlements yet.</p>}
          {entitlements.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>
                {e.planId} · <span className="cc-mono">{e.state}</span>
                {e.reason && <span className="cc-hint"> ({e.reason})</span>}
                {e.expiresAt && <span className="cc-hint"> · expires {new Date(e.expiresAt).toLocaleDateString()}</span>}
              </span>
              {e.activatedAt && <span className="cc-hint">activated {new Date(e.activatedAt).toLocaleDateString()}</span>}
            </div>
          ))}
          {payStatus && (payStatus.plans ?? []).some((pl) => pl.intentStatus !== null) && (
            <div style={{ marginTop: 16 }}>
              <h4>Payment intent status</h4>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Intent</th>
                    <th>Confidence</th>
                    <th>Entitlement</th>
                  </tr>
                </thead>
                <tbody>
                  {payStatus.plans.map((pl) => (
                    <tr key={pl.planId}>
                      <td>{pl.planId}</td>
                      <td>
                        {pl.intentStatus === null ? (
                          '—'
                        ) : (
                          <span className="cc-mono">{pl.intentStatus}</span>
                        )}
                      </td>
                      <td>{pl.confidence === null ? '—' : `${(pl.confidence * 100).toFixed(0)}%`}</td>
                      <td>{pl.entitlementState ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="cc-hint" style={{ marginTop: 6 }}>
                Effective plan: <span className="cc-mono">{payStatus.effectivePlan}</span>. Intent
                status is server-authoritative — it changes only when the payment pipeline
                (evidence → matcher → activation) confirms it.
              </p>
            </div>
          )}
          {capability && (
            <button className="cc-btn" style={{ marginTop: 12 }} disabled={billingBusy} onClick={() => void upgrade()}>
              {billingBusy ? 'Creating session…' : `Upgrade to PRO (₹${capability.plans.pro ?? 999})`}
            </button>
          )}
          {sessions2.length > 0 && (
            <>
              <h4 style={{ marginTop: 16 }}>Payment sessions</h4>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>State</th>
                    <th>Amount</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions2.map((s) => (
                    <tr key={s.id}>
                      <td>{s.planId}</td>
                      <td>{s.state}</td>
                      <td>{s.amount}</td>
                      <td>{new Date(s.createdAt).toLocaleString()}</td>
                      <td>
                        {(s.state === 'PENDING' || s.state === 'VERIFIED') && (
                          <button
                            className="cc-btn cc-btn--ghost cc-btn--sm"
                            disabled={cancelBusy}
                            onClick={() => void requestCancellation(s.id)}
                            title="Request cancellation (reviewed in the Approval Center)"
                          >
                            Request cancellation
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {sessions2.some((s) => s.state === 'PENDING') && (
            <p className="cc-hint" data-testid="billing-pending-note" style={{ marginTop: 8 }}>
              Payment received at the payment provider. CodeConClave is waiting for independent
              verification.
            </p>
          )}
          {usage && (
            <div style={{ marginTop: 16 }}>
              <h4>Usage</h4>
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Measured</th>
                    <th>Estimated</th>
                    <th>Configured limit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Messages today</td>
                    <td>{usage.measured.messagesToday}</td>
                    <td>—</td>
                    <td>{usage.limits.dailyMessages}</td>
                  </tr>
                  <tr>
                    <td>Tasks today</td>
                    <td>{usage.measured.tasksToday}</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>Storage</td>
                    <td>{(usage.measured.storageBytes / (1024 * 1024)).toFixed(1)} MB</td>
                    <td>—</td>
                    <td>{usage.limits.storageGb} GB</td>
                  </tr>
                  <tr>
                    <td>Compute cost</td>
                    <td>—</td>
                    <td>${usage.estimated.computeCostUsd.toFixed(4)} ({usage.estimated.sources} sources)</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>AI tokens</td>
                    <td>{usage.measured.aiInputTokens.toLocaleString()} in / {usage.measured.aiOutputTokens.toLocaleString()} out</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
              <p className="cc-hint">Resets {new Date(usage.resetDate).toLocaleDateString()}. Limits are enforced server-side by plan.</p>
            </div>
          )}
          <p className="cc-hint" style={{ marginTop: 8 }}>
            Sessions stay <span className="cc-mono">PENDING</span> until the payment provider
            independently confirms capture (webhook or API verification). No client-side
            confirmation is ever trusted. Pro access is granted only after server-side
            verification.
          </p>
        </div>
      )}

      {tab === 'preferences' && (
        <div className="cc-card">
          <h3>Workspace preferences</h3>
          <div className="cc-field">
            <label htmlFor="pref-theme">Theme</label>
            <select id="pref-theme" className="cc-input" style={{ width: 220 }} value={theme} disabled={themeBusy} onChange={(e) => void changeTheme(e.target.value as 'light' | 'dark')}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <p className="cc-hint">Saved on the server and applied everywhere you sign in.</p>
          </div>
          <div className="cc-field">
            <label htmlFor="pref-model">Default model</label>
            <select id="pref-model" className="cc-input" style={{ width: 280 }} value={modelPref} onChange={(e) => void saveModelPref(e.target.value)}>
              <option value="">server default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.providerId}) — {m.tier}
                </option>
              ))}
            </select>
            <p className="cc-hint">Applied when the composer has no model selected.</p>
          </div>
          <textarea
            className="cc-textarea cc-mono"
            rows={10}
            value={prefsText}
            onChange={(e) => setPrefsText(e.target.value)}
          />
          <button className="cc-btn" style={{ marginTop: 8 }} onClick={() => void savePrefs()}>
            Save preferences
          </button>
        </div>
      )}

      {tab === 'notifications' && (
        <div className="cc-card">
          <h3>Notification preferences</h3>
          {notifState === 'loading' && <p className="cc-hint">Loading…</p>}
          {notifState === 'error' && (
            <div className="cc-error-state" style={{ padding: 16 }}>
              <p className="cc-hint">Could not load notification preferences.</p>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadNotifPrefs()}>
                Retry
              </button>
            </div>
          )}
          {notifState === 'ready' && (
            <>
              {(
                [
                  ['in_app', 'In-app notifications'],
                  ['push', 'Push notifications'],
                  ['email', 'Email notifications'],
                  ['daily_digest', 'Daily digest'],
                  ['weekly_digest', 'Weekly digest'],
                  ['dnd', 'Do not disturb'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(notifPrefs[key])}
                    onChange={(e) => setNotifFlag(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <div className="cc-field" style={{ marginTop: 8 }}>
                <label htmlFor="notif-timezone">Timezone (IANA, used for quiet hours & digests)</label>
                <input
                  id="notif-timezone"
                  className="cc-input"
                  style={{ width: 240 }}
                  placeholder="Asia/Kolkata"
                  value={notifPrefs.timezone ?? ''}
                  onChange={(e) => setNotifPrefs((prev) => ({ ...prev, timezone: e.target.value || undefined }))}
                />
                <p className="cc-hint">Quiet hours and daily/weekly digest periods are computed in this timezone.</p>
              </div>
              {notifPrefs.dnd && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <div className="cc-field" style={{ marginBottom: 0 }}>
                    <label htmlFor="quiet-start">Quiet hours start</label>
                    <input
                      id="quiet-start"
                      className="cc-input"
                      style={{ width: 140 }}
                      type="time"
                      value={notifPrefs.quiet_hours?.start ?? '22:00'}
                      onChange={(e) =>
                        setNotifPrefs((prev) => ({
                          ...prev,
                          quiet_hours: { start: e.target.value, end: prev.quiet_hours?.end ?? '08:00', timezone: prev.quiet_hours?.timezone ?? prev.timezone },
                        }))
                      }
                    />
                  </div>
                  <div className="cc-field" style={{ marginBottom: 0 }}>
                    <label htmlFor="quiet-end">Quiet hours end</label>
                    <input
                      id="quiet-end"
                      className="cc-input"
                      style={{ width: 140 }}
                      type="time"
                      value={notifPrefs.quiet_hours?.end ?? '08:00'}
                      onChange={(e) =>
                        setNotifPrefs((prev) => ({
                          ...prev,
                          quiet_hours: { start: prev.quiet_hours?.start ?? '22:00', end: e.target.value, timezone: prev.quiet_hours?.timezone ?? prev.timezone },
                        }))
                      }
                    />
                  </div>
                </div>
              )}
              <button className="cc-btn" style={{ marginTop: 12 }} disabled={notifBusy} onClick={() => void saveNotifPrefs()}>
                {notifBusy ? 'Saving…' : 'Save notification preferences'}
              </button>
            </>
          )}
          <h4 style={{ marginTop: 20 }}>Browser notifications</h4>
          <p className="cc-hint">
            Native notifications appear while CodeConClave is open in this browser. There is no
            push infrastructure: closing the app or going offline means nothing is delivered —
            this page never claims otherwise.
          </p>
          {browserPerm === 'unsupported' && (
            <p className="cc-hint">This browser does not support the Notification API.</p>
          )}
          {browserPerm === 'granted' && <p className="cc-hint" style={{ color: '#1e7d46' }}>Permission granted — new notifications will appear.</p>}
          {browserPerm === 'denied' && (
            <p className="cc-hint">Permission denied — enable it in the browser's site settings to use browser notifications.</p>
          )}
          {(browserPerm === 'default' || browserPerm === 'unsupported') && (
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void enableBrowserNotifications()}>
              Enable browser notifications
            </button>
          )}
          {digestStatus && (
            <>
              <h4 style={{ marginTop: 20 }}>Digest status</h4>
              <p className="cc-hint">
                Frequency: <span className="cc-mono">{digestStatus.frequency}</span> · Timezone:{' '}
                <span className="cc-mono">{digestStatus.timezone ?? 'UTC'}</span> · DND:{' '}
                <span className="cc-mono">{digestStatus.dnd ? 'on' : 'off'}</span>
              </p>
              {digestStatus.lastDelivery && (
                <p className="cc-hint">
                  Last delivered: {new Date(digestStatus.lastDelivery.deliveredAt).toLocaleString()} ·{' '}
                  {digestStatus.lastDelivery.aiGenerated ? 'AI summary' : 'deterministic summary'}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'providers' && (
        <div className="cc-card">
          <h3>Provider status</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadProviders()}>
              ↻ Refresh
            </button>
          </div>
          {providersState === 'loading' && <p className="cc-hint" style={{ marginTop: 8 }}>Checking providers…</p>}
          {providersState === 'error' && (
            <p className="cc-hint" style={{ marginTop: 8 }}>
              Could not load provider status.
            </p>
          )}
          {providersState === 'ready' && (
            <table className="cc-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name} <span className="cc-hint">({p.category})</span>
                    </td>
                    <td>
                      <span
                        className="cc-mono"
                        style={{
                          color:
                            p.status === 'AVAILABLE'
                              ? '#1e7d46'
                              : p.status === 'REQUIRES_REAUTH' || p.status === 'FAILED'
                                ? '#c62828'
                                : p.status === 'LIMITED' || p.status === 'DEGRADED'
                                  ? '#b26a00'
                                  : 'inherit',
                        }}
                      >
                        {PROVIDER_STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td>
                      {p.reason && <div className="cc-hint">{p.reason}</div>}
                      {p.capabilities && p.capabilities.length > 0 && (
                        <div className="cc-hint">
                          {p.capabilities
                            .map((c) => `${c.id} ${c.available ? 'ON' : 'OFF'}`)
                            .join(' · ')}
                        </div>
                      )}
                      {p.lastKnownState && p.status !== 'AVAILABLE' && (
                        <div className="cc-hint">last known: {p.lastKnownState}</div>
                      )}
                      {p.status === 'REQUIRES_REAUTH' && (
                        <a className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginTop: 4, display: 'inline-block' }} href="/plugins">
                          Re-authorize
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="cc-hint" style={{ marginTop: 8 }}>
            Status is derived server-side from the actual configuration — never claimed from
            client state. Secrets are never shown.
          </p>
        </div>
      )}
    </div>
  );
}