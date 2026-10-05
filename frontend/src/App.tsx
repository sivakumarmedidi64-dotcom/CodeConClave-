/**
 * CodeConClave — application shell + routing.
 * Sidebar is the canonical frozen 22-item navigation (see Sidebar.tsx +
 * Sidebar.test.tsx EXPECTED_ORDER); /login,/register,/mfa are standalone auth
 * routes. The shell hosts the command palette, focus mode (collapsed sidebar,
 * persisted server-side) and the mobile drawer.
 */
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ToastProvider } from './components/Toast';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { OfflineBanner } from './components/OfflineBanner';
import { CommandPalette } from './components/CommandPalette';
import { ProCelebration } from './components/ProCelebration';
import { PaymentGateModal } from './components/PaymentGateModal';
import type { AccessMode, WorkspaceAccess } from './lib/types';
import { api } from './lib/api';
import { initOfflineSync } from './lib/offline';
import { applyTheme, isTheme } from './lib/theme';
import { LoginPage } from './pages/LoginPage';
import { LandingPage } from './pages/LandingPage';
import { RegisterPage } from './pages/RegisterPage';
import { MfaPage } from './pages/MfaPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { HomePage } from './pages/HomePage';
import { ChatPage } from './pages/ChatPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { AgentsPage } from './pages/AgentsPage';
import { MemoryPage } from './pages/MemoryPage';
import { DnaPage } from './pages/DnaPage';
import { FilesPage } from './pages/FilesPage';
import { TerminalPage } from './pages/TerminalPage';
import { WorkPage } from './pages/WorkPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AutomationPage } from './pages/AutomationPage';
import { RecoveryPage } from './pages/RecoveryPage';
import { DemoPaymentActivatePage } from './pages/DemoPaymentActivatePage';
import { ControlPage } from './pages/ControlPage';
import { CoworkersPage } from './pages/CoworkersPage';
import { TeamsPage } from './pages/TeamsPage';
import { PluginsPage } from './pages/PluginsPage';
import { RemotePage } from './pages/RemotePage';
import { IdeasPage } from './pages/IdeasPage';
import { DataPage } from './pages/DataPage';
import { TrashPage } from './pages/TrashPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { ReviewListPage } from './pages/ReviewListPage';
import { ReviewDetailPage } from './pages/ReviewDetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { IntelligencePage } from './pages/IntelligencePage';
import { ProductionPage } from './pages/ProductionPage';
import { DeploymentPage } from './pages/DeploymentPage';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { AdminUsers } from './pages/admin/AdminUsers';
import { AdminAIUsage } from './pages/admin/AdminAIUsage';
import { AdminPayments } from './pages/admin/AdminPayments';

function Shell() {
  const { status, user } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [access, setAccess] = useState<WorkspaceAccess | null>(null);
  const [accessState, setAccessState] = useState<'loading' | 'ready' | 'error'>('loading');
  // TEMPORARY DEMO / EARLY ACCESS MODE. Purely informational chrome: it is
  // driven only by the server's /api/v1/access reply and grants nothing. The
  // backend gate is the authority, so there is deliberately no client-side flag
  // that can unlock anything.
  const [mode, setMode] = useState<AccessMode | null>(null);

  useEffect(() => initOfflineSync(), []);

  // Server-authoritative workspace gate. PaymentGateModal is cosmetic chrome;
  // the backend re-enforces 402 on every /api/v1/* router. When the access
  // endpoint is unreachable we fail closed to the payment gate so nothing
  // overexposes paid-only chrome; every workspace call still gets gated.
  useEffect(() => {
    if (status !== 'authed' || !user) return;
    let cancelled = false;
    setAccessState('loading');
    void api<{ access?: WorkspaceAccess; mode?: AccessMode }>('/api/v1/access')
      .then((res) => {
        if (cancelled) return;
        setMode(res?.mode ?? null);
        const acc = res?.access;
        if (acc && typeof acc.unlocked === 'boolean') {
          setAccess(acc);
          setAccessState('ready');
          return;
        }
        // No authoritative signal (endpoint unreachable surface zero):
        // fail CLOSED to the payment gate. The backend also 402s gated routers.
        setAccess({ unlocked: false, effectivePlan: 'free', planId: 'free', entitlementState: 'FREE', reason: 'NO_ENTITLEMENT' });
        setAccessState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setMode(null);
        setAccess({ unlocked: false, effectivePlan: 'free', planId: 'free', entitlementState: 'FREE', reason: 'NO_ENTITLEMENT' });
        setAccessState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [status, user]);

  useEffect(() => {
    if (status !== 'authed' || !user) return;
    let cancelled = false;
    void api<{ prefs: Record<string, unknown>; state: { key: string; value: Record<string, unknown> }[] }>(
      '/api/v1/workspace/preferences',
    )
      .then((res) => {
        if (!cancelled && isTheme(res.prefs.theme)) applyTheme(res.prefs.theme);
      })
      .catch(() => {
        /* theme stays default */
      });
    void api<{ state: { key: string; value: Record<string, unknown> }[] }>('/api/v1/workspace/state')
      .then((res) => {
        if (cancelled) return;
        const sidebar = res.state.find((s) => s.key === 'sidebar_state');
        if (sidebar?.value && typeof (sidebar.value as { collapsed?: unknown }).collapsed === 'boolean') {
          setCollapsed(Boolean((sidebar.value as { collapsed: boolean }).collapsed));
        }
      })
      .catch(() => {
        /* sidebar stays expanded */
      });
    return () => {
      cancelled = true;
    };
  }, [status, user]);

  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (prevPath.current !== location.pathname) {
      prevPath.current = location.pathname;
      setDrawerOpen(false);
    }
  }, [location.pathname]);

  /* Presence heartbeat: last_active drives the server-side
     "While you were away" absence window. Client-side only, every 60s
     while the tab is visible; server state is authoritative. */
  useEffect(() => {
    if (status !== 'authed') return;
    const beat = () => {
      if (document.visibilityState === 'visible') {
        void api('/api/v1/workspace/state/last_active', {
          method: 'PUT',
          body: { value: { at: new Date().toISOString() } },
        }).catch(() => {
          /* best-effort */
        });
      }
    };
    beat();
    const timer = window.setInterval(beat, 60_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [status]);

  const toggleSidebar = () => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setDrawerOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      const next = !c;
      void api(`/api/v1/workspace/state/sidebar_state`, { method: 'PUT', body: { value: { collapsed: next } } }).catch(
        () => {
          /* best-effort continuity */
        },
      );
      return next;
    });
  };

  if (status === 'loading') {
    return (
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="cc-spinner" />
      </div>
    );
  }
  if (status === 'anon' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Server-authoritative workspace gate: no free application tier. After
  // login/signup a locked account gets the payment popup — the only surface a
  // non-paying user sees (backend independently 402s every gated router; this
  // is chrome, not authority). The popup is non-dismissible until unlocked.
  if (access && !access.unlocked) {
    return <PaymentGateModal />;
  }

  return (
    <div className={`cc-shell${collapsed ? ' cc-shell--collapsed' : ''}${drawerOpen ? ' cc-shell--drawer-open' : ''}`}>
      <Sidebar user={user} />
      {drawerOpen && <button className="cc-drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" />}
      <OfflineBanner />
      {/* TEMPORARY DEMO / EARLY ACCESS MODE — informational only. Rendered from
          the server's authoritative /api/v1/access reply; it unlocks nothing and
          must never imply a purchase happened. */}
      {mode?.temporaryDemoMode ? (
        <div className="cc-demo-mode-banner" role="status">
          <strong>CodeConClave is currently available in Early Access</strong> — workspace access is open
          for early-access users. No payment has been taken and no plan has been purchased.
        </div>
      ) : null}
      <Topbar onMenuClick={toggleSidebar} />
      <a className="cc-skip-link" href="#main">
        Skip to content
      </a>
      <main id="main" className="cc-main">
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/dna" element={<DnaPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/terminal" element={<TerminalPage />} />
<Route path="/work" element={<WorkPage />} />
<Route path="/automation" element={<AutomationPage />} />
          <Route path="/recovery" element={<RecoveryPage />} />
          <Route path="/demo/payment/activate" element={<DemoPaymentActivatePage />} />
<Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/coworkers" element={<CoworkersPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/control" element={<ControlPage />} />
          <Route path="/remote" element={<RemotePage />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/billing" element={<Navigate to="/settings?tab=billing" replace />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/reviews" element={<ReviewListPage />} />
          <Route path="/reviews/:id" element={<ReviewDetailPage />} />
          <Route path="/intelligence" element={<IntelligencePage />} />
          <Route path="/production" element={<ProductionPage />} />
          <Route path="/deployment" element={<DeploymentPage />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/ai-usage" element={<AdminAIUsage />} />
          <Route path="/admin/payments" element={<AdminPayments />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <CommandPalette onToggleFocus={toggleSidebar} />
      <ProCelebration />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/*" element={<Shell />} />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}