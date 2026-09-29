/**
 * CodeConClave — Settings: Profile, Security (MFA), Devices & Sessions,
 * Billing/payments, Preferences. Idempotent against the API contract.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { applyTheme, isTheme } from '../lib/theme';
import { setResponseSoundEnabled } from '../lib/responseSound';
import {
  browserNotificationCapability,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from '../lib/browserNotifications';
import type {
  AiModel,
  ApiKeyAccess,
  DeviceInfo,
  DigestStatus,
  Entitlement,
  Memory,
  NotificationPreferences,
  PaymentCapability,
  PaymentClaim,
  PaymentIntent,
  PaymentSession,
  PaymentStatusView,
  ProviderStatusEntry,
  ProviderStatusReport,
  SessionInfo,
  UsageOverview,
  UserApiKey,
} from '../lib/types';
import { useToast } from '../components/Toast';

type Tab = 'profile' | 'security' | 'devices' | 'billing' | 'preferences' | 'notifications' | 'providers' | 'apikeys' | 'memory';

const SETTINGS_TABS: readonly Tab[] = ['profile', 'security', 'devices', 'billing', 'preferences', 'notifications', 'providers', 'apikeys', 'memory'];

const PROVIDER_STATUS_LABEL: Record<ProviderStatusEntry['status'], string> = {
  AVAILABLE: 'Available',
  LIMITED: 'Limited',
  NOT_CONFIGURED: 'Not configured',
  REQUIRES_REAUTH: 'Re-authorization required',
  DEGRADED: 'Degraded',
  FAILED: 'Failed',
};

export function SettingsPage() {
  const { user, refresh, updateProfile, sendVerificationEmail } = useAuth();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState<string>(user?.displayName ?? '');
  const [role, setRole] = useState<string>(user?.role ?? '');
  const [useCase, setUseCase] = useState<string>(user?.primaryUseCase ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL is the single source of truth for the active tab: deep links,
  // refresh, back/forward, and in-page tab clicks all resolve identically with
  // no duplicated state to fall out of sync.
  const tabParam = searchParams.get('tab');
  const tab: Tab = (SETTINGS_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'profile';
  const selectTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'profile') {
        params.delete('tab');
      } else {
        params.set('tab', next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
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
  const [apiKeys, setApiKeys] = useState<UserApiKey[]>([]);
  const [apiKeysState, setApiKeysState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [apiAccess, setApiAccess] = useState<ApiKeyAccess | null>(null);
  const [apiAccessState, setApiAccessState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyName, setApiKeyName] = useState('');
  const [justCreatedKey, setJustCreatedKey] = useState<UserApiKey | null>(null);
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [claims, setClaims] = useState<PaymentClaim[]>([]);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimIntentId, setClaimIntentId] = useState('');
  const [claimPaymentId, setClaimPaymentId] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [mfaSetup, setMfaSetup] = useState<{ secretOtpAuthUrl: string; secretBase32: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [prefsText, setPrefsText] = useState('{}');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [themeBusy, setThemeBusy] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
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
  // Memory tab
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesState, setMemoriesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [memQ, setMemQ] = useState('');
  const [memType, setMemType] = useState('');
  const [memExportBusy, setMemExportBusy] = useState(false);

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
      const [c, e, p, u, ps, ax, it, cl] = await Promise.all([
        api<PaymentCapability>('/api/v1/payments/capabilities'),
        api<{ entitlements: Entitlement[] }>('/api/v1/payments/entitlements'),
        api<{ sessions: PaymentSession[] }>('/api/v1/payments/sessions'),
        api<{ overview: UsageOverview }>('/api/v1/workspace/usage/overview'),
        api<PaymentStatusView>('/api/v1/payments/status'),
        api<{ access: ApiKeyAccess }>('/api/v1/apikeys/access'),
        api<{ intents: PaymentIntent[] }>('/api/v1/payments/intents'),
        api<{ claims: PaymentClaim[] }>('/api/v1/payments/claims'),
      ]);
      setCapability(c);
      setEntitlements(e.entitlements);
      setPaySessions(p.sessions);
      setUsage(u.overview);
      setPayStatus(ps);
      setApiAccess(ax.access);
      setApiAccessState('ready');
      setIntents(it.intents ?? []);
      setClaims(cl.claims ?? []);
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

  const loadApiKeys = useCallback(async () => {
    setApiKeysState('loading');
    try {
      const res = await api<{ keys: UserApiKey[] }>('/api/v1/apikeys');
      setApiKeys(res.keys ?? []);
      setApiKeysState('ready');
    } catch {
      setApiKeysState('error');
    }
  }, []);

  const loadMemories = useCallback(async () => {
    setMemoriesState('loading');
    try {
      const params = new URLSearchParams();
      if (memType) params.set('type', memType);
      if (memQ.trim()) params.set('q', memQ.trim());
      const res = await api<{ memories: Memory[] }>(`/api/v1/memory?${params.toString()}`);
      setMemories(res.memories ?? []);
      setMemoriesState('ready');
    } catch {
      setMemories([]);
      setMemoriesState('error');
    }
  }, [memType, memQ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === 'memory') void loadMemories();
  }, [tab, loadMemories]);

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

  const upgrade = async (planId: 'pro' | 'team' | 'api' = 'pro') => {
    setBillingBusy(true);
    try {
      // Bumper: try the Payment Link-Pool rail first (automatic 24x7, POLICY B).
      try {
        const pool = await api<{ intent: { intentId: string; paymentUrl: string; expiresAt: string; amountInr: number; currency: string; plan: string; linkReferenceId: string } }>(
          '/api/pay/pool/intent',
          { method: 'POST', body: { planId } },
        );
        if (pool.intent?.paymentUrl) {
          // The account that initiated checkout and reserved the link slot is
          // the account entitled. A third party may pay as a gift. We never
          // prove the physical payer's identity to the UI.
          window.location.href = pool.intent.paymentUrl;
          toast(`Reserved a payment link — pay ${pool.intent.amountInr / 100} ${pool.intent.currency} to activate ${pool.intent.plan.toUpperCase()}`);
          return;
        }
      } catch {
        // pool disabled / all links busy -> fall through to the legacy session rail.
      }
      const res = await api<{ session: PaymentSession; redirectUrl: string | null; capability: PaymentCapability; note?: string }>(
        '/api/v1/payments/sessions',
        { method: 'POST', body: { planId } },
      );
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
      } else {
        toast(res.note ?? 'Session created — awaiting provider payment');
      }
      await load();
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'session failed', 'error');
    } finally {
      setBillingBusy(false);
    }
  };

  // The active base product as derived server-authoritatively. Solo (pro) and
  // Team are INDEPENDENT purchases: a Solo-active user must still be able to buy
  // Team, a Team-active user no longer sees the Solo/Team cards, and API Access
  // is a separate add-on never bundled with either.
  const activeBasePlan =
    payStatus && (payStatus.effectivePlan === 'pro' || payStatus.effectivePlan === 'team')
      ? payStatus.effectivePlan
      : user?.entitlementState === 'PRO_VERIFIED'
        ? 'pro'
        : 'free';

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

  const submitClaim = async () => {
    if (!claimIntentId) {
      setClaimError('Pick the checkout (intent) you paid for first.');
      return;
    }
    if (!claimPaymentId.trim()) {
      setClaimError('Enter the Razorpay Payment ID (format: pay_...).');
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
      await load();
      toast(`Claim ${res.claim.status.toLowerCase()} — you'll be notified when the founder verifies it.`);
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim submission failed');
      toast(err instanceof Error ? err.message : 'Claim submission failed', 'error');
    } finally {
      setClaimBusy(false);
    }
  };

  const createApiKey = async () => {
    if (!apiKeyName.trim()) { toast('Enter a name for this key', 'error'); return; }
    setApiKeyBusy(true);
    try {
      const res = await api<{ key: UserApiKey }>('/api/v1/apikeys', { method: 'POST', body: { name: apiKeyName } });
      setJustCreatedKey(res.key);
      setApiKeyName('');
      await loadApiKeys();
      toast('Key created — copy it now, the secret is never shown again');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Key creation failed', 'error');
    } finally {
      setApiKeyBusy(false);
    }
  };

  const revokeApiKey = async (id: string) => {
    if (!window.confirm('Revoke this API key? The key will immediately stop working.')) return;
    try {
      await api(`/api/v1/apikeys/${id}/revoke`, { method: 'POST' });
      await loadApiKeys();
      toast('API key revoked');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  const loadPrefs = useCallback(async () => {
    try {
      const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences');
      setPrefsText(JSON.stringify(res.prefs, null, 2));
      if (typeof res.prefs.current_model === 'string') setModelPref(res.prefs.current_model);
      if (typeof res.prefs.response_ready_sound === 'boolean') setSoundOn(res.prefs.response_ready_sound);
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
    if (tab === 'apikeys') void loadApiKeys();
  }, [tab, loadNotifPrefs, models.length, loadProviders, loadApiKeys]);

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

  const toggleSound = async (value: boolean) => {
    setSoundOn(value);
    setResponseSoundEnabled(value);
    try {
      const res = await api<{ prefs: Record<string, unknown> }>('/api/v1/workspace/preferences', {
        method: 'PUT',
        body: { prefs: { response_ready_sound: value } },
      });
      if (typeof res.prefs.response_ready_sound === 'boolean') setSoundOn(res.prefs.response_ready_sound);
      setPrefsText(JSON.stringify(res.prefs, null, 2));
      toast(`Response-ready sound ${value ? 'ON' : 'OFF'}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'sound pref failed', 'error');
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

  const saveName = async () => {
    const next = displayName.trim();
    if (next.length > 0 && next.length < 2) {
      toast('Display name must be at least 2 characters', 'error');
      return;
    }
    const changed =
      next !== (user?.displayName ?? '') ||
      role !== (user?.role ?? '') ||
      useCase !== (user?.primaryUseCase ?? '');
    if (!changed) {
      toast('No changes to save');
      return;
    }
    setNameBusy(true);
    try {
      await updateProfile({
        displayName: next === (user?.displayName ?? '') ? undefined : next || null,
        role: role === (user?.role ?? '') ? undefined : role || null,
        primaryUseCase: useCase === (user?.primaryUseCase ?? '') ? undefined : useCase || null,
      });
      toast('Profile updated');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update profile', 'error');
    } finally {
      setNameBusy(false);
    }
  };

  const tabs: readonly Tab[] = SETTINGS_TABS;

  return (
    <div className="cc-page">
      <h1>Settings</h1>
      <div className="cc-toggle" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t}
            className={tab === t ? 'on' : ''}
            role="tab"
            aria-selected={tab === t}
            onClick={() => selectTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="cc-card">
          <h3>Profile</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <input
              id="profile-display-name"
              className="cc-input"
              style={{ width: 240 }}
              value={displayName}
              aria-label="Display name"
              placeholder="Your display name"
              maxLength={80}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <button className="cc-btn cc-btn--sm" disabled={nameBusy} onClick={() => void saveName()}>
              {nameBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <label htmlFor="profile-role" className="cc-hint">Role</label>
            <select
              id="profile-role"
              className="cc-input"
              style={{ width: 160 }}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="">Select…</option>
              {['Developer', 'Founder', 'Student', 'Designer', 'Product', 'Other'].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <label htmlFor="profile-use-case" className="cc-hint">Primary use case</label>
            <select
              id="profile-use-case"
              className="cc-input"
              style={{ width: 200 }}
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
            >
              <option value="">Select…</option>
              {['Build software', 'Debug/code', 'AI cowork', 'Automation', 'Research', 'Learning', 'Other'].map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <p className="cc-hint">
            Address <strong>{user?.email}</strong> {user?.emailVerified ? '· verified' : '· not verified yet'}
          </p>
          <p className="cc-hint">
            Plan: {user?.planId} · Entitlement:{' '}
            <span style={{ color: user?.entitlementState === 'PRO_VERIFIED' ? 'var(--cc-accent)' : 'inherit' }}>
              {user?.entitlementState}
            </span>
          </p>
          <p className="cc-hint">
            MFA {user?.mfaEnabled ? 'enabled' : 'disabled'} · role {user?.rbacRole}
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
                <input className="cc-input" aria-label="MFA code" style={{ width: 160 }} placeholder="123456" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
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
              <div className="cc-table-wrap">
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
              </div>
              <p className="cc-hint" style={{ marginTop: 6 }}>
                Effective plan: <span className="cc-mono">{payStatus.effectivePlan}</span>. Intent
                status is server-authoritative — it changes only when the payment pipeline
                (evidence → matcher → activation) confirms it.
              </p>
            </div>
          )}
          {(capability && (activeBasePlan === 'free' || activeBasePlan === 'pro')) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12 }}>
              {activeBasePlan === 'free' && (
                <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontWeight: 600 }}>Solo</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                    ₹{capability.plans.pro ?? 999}
                    <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
                  </div>
                  <p className="cc-home__hint" style={{ flex: 1 }}>All AI capabilities, 200 messages/day, unlimited projects.</p>
                  <button
                    className="cc-btn cc-btn--primary"
                    disabled={billingBusy}
                    onClick={() => void upgrade('pro')}
                  >
                    {billingBusy ? 'Creating session…' : `Upgrade to PRO (₹${capability.plans.pro ?? 999})`}
                  </button>
                </div>
              )}
              <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Team</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                  ₹{capability.plans.team ?? 4999}
                  <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
                </div>
                <p className="cc-home__hint" style={{ flex: 1 }}>
                  Everything in Solo, plus team agents, shared DNA, and priority support for up to 30 team members.{' '}
                  {activeBasePlan === 'pro' && <span className="cc-hint">Team is a separate, independent purchase.</span>}
                </p>
                <button
                  className="cc-btn"
                  disabled={billingBusy}
                  onClick={() => void upgrade('team')}
                >
                  {billingBusy ? 'Creating session…' : `Upgrade to TEAM (₹${capability.plans.team ?? 4999})`}
                </button>
              </div>
            </div>
          )}
          {capability && activeBasePlan !== 'free' && (
            <p className="cc-hint" style={{ marginTop: 12 }}>
              <span className="cc-mono">{activeBasePlan.toUpperCase()}</span> plan active — billing and cancellation below.
            </p>
          )}
          {capability && (
            <div className="cc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>API Access</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--cc-accent)' }}>
                    ₹{capability.plans.api ?? 9999}
                    <span className="cc-hint" style={{ fontSize: 12, fontWeight: 400 }}> / month</span>
                  </div>
                  <p className="cc-home__hint" style={{ maxWidth: 460 }}>
                    Programmatic access to CodeConClave via API keys — a separate add-on, not
                    included with Solo or Team.
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                  {apiAccess?.entitled ? (
                    <button className="cc-btn" onClick={() => selectTab('apikeys')}>
                      Manage keys
                    </button>
                  ) : (
                    <button className="cc-btn cc-btn--primary" disabled={billingBusy} onClick={() => void upgrade('api')}>
                      {billingBusy ? 'Creating session…' : `Upgrade to API Access (₹${capability.plans.api ?? 9999})`}
                    </button>
                  )}
                  {apiAccessState !== 'idle' && (
                    <span className="cc-hint">
                      {apiAccess?.entitled
                        ? 'API Access active'
                        : apiAccess?.state === 'PRO_PENDING'
                          ? 'Payment pending — activation in progress.'
                          : apiAccessState === 'loading'
                            ? 'Checking access…'
                            : 'Not purchased yet.'}
                    </span>
                  )}
                </div>
              </div>
            </div>
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
                        {(s.state === 'FAILED' || s.state === 'EXPIRED' || s.state === 'CANCELLED') && (
                          <button
                            className="cc-btn cc-btn--sm"
                            disabled={billingBusy}
                            onClick={() => void upgrade(s.planId as 'pro' | 'team' | 'api')}
                          >
                            {billingBusy ? 'Retrying…' : `Retry payment (₹${s.amount})`}
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
          {capability?.unlockMode === 'MANUAL' && (
            <div className="cc-card" data-testid="manual-claims-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              <div>
                <div style={{ fontWeight: 600 }}>Pay &amp; confirm (manual review)</div>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Pays are verified manually by the founder. Pay at your checkout's link with the reference
                  (e.g. <span className="cc-mono">CCPRO-XXXXXX</span>), then paste the Razorpay Payment ID
                  (<span className="cc-mono">pay_...</span>) from your confirmation screen or e-mail. Startup
                  amounts are ₹{capability.plans.pro ?? 999} (Solo), ₹{capability.plans.team ?? 4999} (Team) and
                  ₹{capability.plans.api ?? 9999} (API Access).
                </p>
              </div>
              {(() => {
                const claimable = intents.filter((i) => i.status === 'PENDING' || i.status === 'REVIEW');
                if (claimable.length === 0) {
                  return <p className="cc-hint">No open checkout. Use the plan cards above to start one, then come back here to confirm the payment.</p>;
                }
                const selected = intents.find((i) => i.id === claimIntentId) ?? claimable[0]!;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <select
                        className="cc-input"
                        style={{ maxWidth: 320 }}
                        value={selected.id}
                        onChange={(ev) => { setClaimIntentId(ev.target.value); setClaimError(null); }}
                        aria-label="Checkout to confirm"
                      >
                        {claimable.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.planId.toUpperCase()} — ₹{i.amountInr} — {i.reference}
                          </option>
                        ))}
                      </select>
                      {selected.paymentLink && (
                        <a className="cc-btn cc-btn--ghost cc-btn--sm" href={selected.paymentLink} target="_blank" rel="noreferrer">
                          Open payment link
                        </a>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <input
                        className="cc-input"
                        style={{ maxWidth: 320 }}
                        placeholder={selected ? `pay_... (${selected.planId.toUpperCase()})` : 'Payment ID'}
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
                    {claimError && <p className="cc-hint" style={{ color: 'var(--cc-danger, #b3261e)' }}>{claimError}</p>}
                  </div>
                );
              })()}
              {claims.length > 0 && (
                <table className="cc-table" aria-label="Your payment claims">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Plan</th>
                      <th>Amount</th>
                      <th>Payment ID</th>
                      <th>Submitted</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {claims.map((cl) => (
                      <tr key={cl.id}>
                        <td>{cl.status}</td>
                        <td>{cl.planId.toUpperCase()}</td>
                        <td>₹{cl.amountInr}</td>
                        <td className="cc-mono">{cl.razorpayPaymentId}</td>
                        <td>{new Date(cl.createdAt).toLocaleString()}</td>
                        <td>
                          {cl.status === 'REJECTED' && cl.rejectionReason ? (
                            <span className="cc-hint" title={cl.rejectionReason}>{cl.rejectionReason}</span>
                          ) : (
                            <span className="cc-hint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
                    <td>Messages this window</td>
                    <td>{usage.rolling.used} / {usage.rolling.limit} used</td>
                    <td>{usage.rolling.remaining} left</td>
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
              <p className="cc-hint">
                Usage runs on a rolling window and{' '}
                {usage.rolling.resetsAt
                  ? `resets ${new Date(usage.rolling.resetsAt).toLocaleString()}`
                  : 'replenishes automatically after first use'}. Limits are enforced server-side by plan.
              </p>
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
          <div className="cc-field">
            <label htmlFor="pref-sound">
              <input
                id="pref-sound"
                type="checkbox"
                checked={soundOn}
                onChange={(e) => void toggleSound(e.target.checked)}
              />{' '}
              Response-ready sound
            </label>
            <p className="cc-hint">Chime when a response finishes. ON by default; generated in real time, never a static file.</p>
          </div>
          <textarea
            className="cc-textarea cc-mono"
            rows={10}
            aria-label="Workspace preferences JSON"
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

      {tab === 'apikeys' && (
        <div className="cc-card">
          <h3>API Keys</h3>
          <p className="cc-hint" style={{ marginTop: 4 }}>
            Create API keys to access CodeConClave programmatically. The secret is shown only once at creation.
            These keys control your CodeConClave account — they are not Gemini, Mistral, or Nemotron provider keys.
          </p>

          {justCreatedKey && (
            <div style={{ background: '#0d2f16', border: '1px solid #1e7d46', borderRadius: 6, padding: 12, marginTop: 12, position: 'relative' }}>
              <p style={{ margin: '0 0 6px', color: '#1e7d46', fontWeight: 600 }}>New API Key (copy now — never shown again)</p>
              <code style={{ display: 'block', wordBreak: 'break-all', color: '#d0e8d8' }}>{justCreatedKey.key}</code>
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                style={{ marginTop: 8 }}
                onClick={() => {
                  void copyText(justCreatedKey.key ?? '').then((ok) =>
                    toast(ok ? 'Copied to clipboard' : 'Copy failed — select the key text manually', ok ? 'info' : 'error'),
                  );
                }}
              >
                Copy
              </button>
              <button
                className="cc-btn cc-btn--ghost cc-btn--sm"
                style={{ position: 'absolute', top: 8, right: 8 }}
                aria-label="Dismiss new-key notice"
                onClick={() => setJustCreatedKey(null)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          )}

          {apiAccess && !apiAccess.entitled ? (
            <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--cc-border, #ddd)', borderRadius: 6, background: 'var(--cc-bg-soft, #fafafa)' }}>
              <p style={{ margin: 0 }}>
                {`API keys require the API Access add-on (₹${capability?.plans.api ?? 9999}/month). Solo and Team plans do not include API keys.`}
              </p>
              <button className="cc-btn cc-btn--sm" style={{ marginTop: 8 }} onClick={() => selectTab('billing')}>
                Go to Billing
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <input
                className="cc-input"
                style={{ width: 220 }}
                placeholder="Key name (e.g. CI, laptop)"
                aria-label="API key name"
                maxLength={80}
                value={apiKeyName}
                onChange={(e) => setApiKeyName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createApiKey(); }}
              />
              <button className="cc-btn cc-btn--sm" disabled={apiKeyBusy} onClick={() => void createApiKey()}>
                {apiKeyBusy ? 'Creating…' : 'Create key'}
              </button>
            </div>
          )}

          {apiKeysState === 'loading' && <p className="cc-hint" style={{ marginTop: 8 }}>Loading…</p>}
          {apiKeysState === 'error' && <p className="cc-hint" style={{ marginTop: 8 }}>Could not load API keys.</p>}
          {apiKeysState === 'ready' && (
            <div className="cc-table-wrap" style={{ marginTop: 8 }}>
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="cc-mono" style={{ fontSize: 12 }}>{k.keyPrefix}…</td>
                    <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : '—'}</td>
                    <td>
                      {k.revokedAt
                        ? <span style={{ color: '#c62828' }}>Revoked{k.revokeReason ? ` (${k.revokeReason})` : ''}</span>
                        : k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()
                          ? <span style={{ color: '#b26a00' }}>Expired</span>
                          : <span style={{ color: '#1e7d46' }}>Active</span>
                      }
                    </td>
                    <td>
                      {!k.revokedAt && (
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void revokeApiKey(k.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {apiKeys.length === 0 && (
                  <tr><td colSpan={6} className="cc-hint">No API keys yet.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {tab === 'memory' && (
        <div className="cc-card">
          <h3>Memory</h3>
          <p className="cc-hint" style={{ marginTop: 4 }}>
            Search, filter, and export your memories. Memories are persisted across sessions and used for context.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <select className="cc-select" style={{ width: 160 }} value={memType} onChange={(e) => setMemType(e.target.value)}>
              <option value="">All types</option>
              {['EPISODIC', 'SEMANTIC', 'PROCEDURAL', 'PROJECT', 'TEAM'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              className="cc-input"
              placeholder="Search memories…"
              aria-label="Search memories"
              style={{ flex: 1, minWidth: 200 }}
              value={memQ}
              onChange={(e) => setMemQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadMemories(); }}
            />
            <button className="cc-btn cc-btn--ghost" onClick={() => void loadMemories()}>
              Search
            </button>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={memExportBusy} onClick={async () => {
              setMemExportBusy(true);
              try {
                const params = new URLSearchParams();
                if (memType) params.set('type', memType);
                if (memQ.trim()) params.set('q', memQ.trim());
                params.set('export', '1');
                params.set('format', 'json');
                const res = await fetch(`/api/v1/memory?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
                if (res.ok) {
                  const data = await res.json();
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `codeconclave-memory-${new Date().toISOString().slice(0,10)}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast('Memory exported as JSON');
                } else {
                  toast('Export failed', 'error');
                }
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Export failed', 'error');
              } finally {
                setMemExportBusy(false);
              }
            }}>
              {memExportBusy ? 'Exporting…' : 'Export JSON'}
            </button>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={memExportBusy} onClick={async () => {
              setMemExportBusy(true);
              try {
                const params = new URLSearchParams();
                if (memType) params.set('type', memType);
                if (memQ.trim()) params.set('q', memQ.trim());
                params.set('export', '1');
                params.set('format', 'markdown');
                const res = await fetch(`/api/v1/memory?${params.toString()}`, { headers: { 'Accept': 'text/markdown' } });
                if (res.ok) {
                  const markdown = await res.text();
                  const blob = new Blob([markdown], { type: 'text/markdown' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `codeconclave-memory-${new Date().toISOString().slice(0,10)}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast('Memory exported as Markdown');
                } else {
                  toast('Export failed', 'error');
                }
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Export failed', 'error');
              } finally {
                setMemExportBusy(false);
              }
            }}>
              {memExportBusy ? 'Exporting…' : 'Export Markdown'}
            </button>
          </div>
          {memoriesState === 'loading' && <p className="cc-hint" style={{ marginTop: 8 }}>Loading memories…</p>}
          {memoriesState === 'error' && (
            <p className="cc-hint" style={{ marginTop: 8 }}>
              Could not load memories.
            </p>
          )}
          {memoriesState === 'ready' && memories.length === 0 && <div className="cc-card cc-empty">No memories.</div>}
          {memoriesState === 'ready' ? (
            memories.map((m) => (
              <div className="cc-card" key={m.id}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="cc-pill cc-pill--accent">{m.type}</span>
                  <span className="cc-pill">{m.source}</span>
                  <span className={`cc-pill--dot ${m.confidence === 'verified' ? 'ok' : m.confidence === 'low' ? 'warn' : ''}`} style={{ display: 'inline-block' }} />
                  <span className="cc-hint">{m.confidence}</span>
                  {m.flagged && <span className="cc-pill cc-pill--danger">flagged</span>}
                  {m.verificationState === 'VERIFIED' && <span className="cc-pill cc-pill--success">verified</span>}
                  {m.verificationState === 'REJECTED' && <span className="cc-pill cc-pill--danger">rejected</span>}
                </div>
                <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{m.content}</p>
              </div>
            ))
          ) : null}
        </div>
      )}

      <div className="cc-card" style={{ marginTop: 20 }}>
        <h3>Need help?</h3>
        <p className="cc-hint" style={{ margin: '6px 0 12px' }}>
          Stuck, have a bug, or want a plan change? Write to the founder directly.
        </p>
        <a className="cc-btn cc-btn--sm cc-btn--ghost" href="mailto:medidisaharsh@gmail.com">
          Contact the founder
        </a>
      </div>
    </div>
  );
}