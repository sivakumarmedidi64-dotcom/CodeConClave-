/**
 * CodeConClave — application shell + routing.
 * Sidebar is the canonical frozen 22-item navigation (see Sidebar.tsx +
 * routes. Registration is a zero-domain flow (identifier -> handle -> keyword
 * -> 32-character account key) with no third-party identity provider. The
 * shell hosts the command palette, focus mode (collapsed sidebar, persisted
 * server-side) and the mobile drawer.
 */
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TOGGLE_SIDEBAR } from './lib/appEvents';
import { UsageLimitHost } from './components/UsageLimitDialog';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { HoldBanner } from './components/EmergencyStop';
import { GlobalShortcuts } from './components/GlobalShortcuts';
import { ToastProvider } from './components/Toast';
import { Sidebar } from './components/Sidebar';
import { ArtifactPanel } from './components/ArtifactPanel';
import { Topbar } from './components/Topbar';
import { OfflineBanner } from './components/OfflineBanner';
import { CommandPalette } from './components/CommandPalette';
import { ProCelebration } from './components/ProCelebration';
import { PaymentGateModal } from './components/PaymentGateModal';
import type { AccessMode, WorkspaceAccess } from './lib/types';
import { AccessModeProvider, useEarlyAccess } from './lib/accessMode';
import { api } from './lib/api';
import { initOfflineSync } from './lib/offline';
import { applyTheme, isTheme } from './lib/theme';
const LoginPage = lazy(() => import('./pages/LoginPage').then(({ LoginPage }) => ({ default: LoginPage })));
const LandingPage = lazy(() => import('./pages/LandingPage').then(({ LandingPage }) => ({ default: LandingPage })));
const MfaPage = lazy(() => import('./pages/MfaPage').then(({ MfaPage }) => ({ default: MfaPage })));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage').then(({ VerifyEmailPage }) => ({ default: VerifyEmailPage })));
const HomePage = lazy(() => import('./pages/HomePage').then(({ HomePage }) => ({ default: HomePage })));
const ChatPage = lazy(() => import('./pages/ChatPage').then(({ ChatPage }) => ({ default: ChatPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then(({ ProjectsPage }) => ({ default: ProjectsPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then(({ AgentsPage }) => ({ default: AgentsPage })));
const MemoryPage = lazy(() => import('./pages/MemoryPage').then(({ MemoryPage }) => ({ default: MemoryPage })));
const DnaPage = lazy(() => import('./pages/DnaPage').then(({ DnaPage }) => ({ default: DnaPage })));
const FilesPage = lazy(() => import('./pages/FilesPage').then(({ FilesPage }) => ({ default: FilesPage })));
const TerminalPage = lazy(() => import('./pages/TerminalPage').then(({ TerminalPage }) => ({ default: TerminalPage })));
const BrowserPage = lazy(() => import('./pages/BrowserPage').then(({ BrowserPage }) => ({ default: BrowserPage })));
const McpPage = lazy(() => import('./pages/McpPage').then(({ McpPage }) => ({ default: McpPage })));
const BeyondPage = lazy(() => import('./pages/BeyondPage').then(({ BeyondPage }) => ({ default: BeyondPage })));
const SaiPage = lazy(() => import('./pages/SaiPage').then(({ SaiPage }) => ({ default: SaiPage })));
const DesktopBrowserLinks = lazy(() => import('./pages/BrowserPage').then(({ DesktopBrowserLinks }) => ({ default: DesktopBrowserLinks })));
const WorkPage = lazy(() => import('./pages/WorkPage').then(({ WorkPage }) => ({ default: WorkPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then(({ WorkspacePage }) => ({ default: WorkspacePage })));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage').then(({ WorkbenchPage }) => ({ default: WorkbenchPage })));
const AutomationPage = lazy(() => import('./pages/AutomationPage').then(({ AutomationPage }) => ({ default: AutomationPage })));
const RecoveryPage = lazy(() => import('./pages/RecoveryPage').then(({ RecoveryPage }) => ({ default: RecoveryPage })));
const ControlPage = lazy(() => import('./pages/ControlPage').then(({ ControlPage }) => ({ default: ControlPage })));
const PipelinePage = lazy(() => import('./pages/PipelinePage').then(({ PipelinePage }) => ({ default: PipelinePage })));
const CoworkersPage = lazy(() => import('./pages/CoworkersPage').then(({ CoworkersPage }) => ({ default: CoworkersPage })));
const CoworkerPage = lazy(() => import('./pages/CoworkerPage').then(({ CoworkerPage }) => ({ default: CoworkerPage })));
const TeamsPage = lazy(() => import('./pages/TeamsPage').then(({ TeamsPage }) => ({ default: TeamsPage })));
const PluginsPage = lazy(() => import('./pages/PluginsPage').then(({ PluginsPage }) => ({ default: PluginsPage })));
const SessionsPage = lazy(() => import('./pages/SessionsPage').then(({ SessionsPage }) => ({ default: SessionsPage })));
const LocalFilesPage = lazy(() => import('./pages/LocalFilesPage').then(({ LocalFilesPage }) => ({ default: LocalFilesPage })));
const CodeReviewPage = lazy(() => import('./pages/CodeReviewPage').then(({ CodeReviewPage }) => ({ default: CodeReviewPage })));
const SkillPluginsPage = lazy(() => import('./pages/SkillPluginsPage').then(({ SkillPluginsPage }) => ({ default: SkillPluginsPage })));
const RemotePage = lazy(() => import('./pages/RemotePage').then(({ RemotePage }) => ({ default: RemotePage })));
const IdeasPage = lazy(() => import('./pages/IdeasPage').then(({ IdeasPage }) => ({ default: IdeasPage })));
const DataPage = lazy(() => import('./pages/DataPage').then(({ DataPage }) => ({ default: DataPage })));
const TrashPage = lazy(() => import('./pages/TrashPage').then(({ TrashPage }) => ({ default: TrashPage })));
const HistoryPage = lazy(() => import('./pages/HistoryPage').then(({ HistoryPage }) => ({ default: HistoryPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage').then(({ ApprovalsPage }) => ({ default: ApprovalsPage })));
const ReviewListPage = lazy(() => import('./pages/ReviewListPage').then(({ ReviewListPage }) => ({ default: ReviewListPage })));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetailPage').then(({ ReviewDetailPage }) => ({ default: ReviewDetailPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then(({ NotFoundPage }) => ({ default: NotFoundPage })));
const IntelligencePage = lazy(() => import('./pages/IntelligencePage').then(({ IntelligencePage }) => ({ default: IntelligencePage })));
const ProductionPage = lazy(() => import('./pages/ProductionPage').then(({ ProductionPage }) => ({ default: ProductionPage })));
const DeploymentPage = lazy(() => import('./pages/DeploymentPage').then(({ DeploymentPage }) => ({ default: DeploymentPage })));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard').then(({ AdminDashboard }) => ({ default: AdminDashboard })));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers').then(({ AdminUsers }) => ({ default: AdminUsers })));
const AdminAIUsage = lazy(() => import('./pages/admin/AdminAIUsage').then(({ AdminAIUsage }) => ({ default: AdminAIUsage })));
const AdminPayments = lazy(() => import('./pages/admin/AdminPayments').then(({ AdminPayments }) => ({ default: AdminPayments })));

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
  // endpoint is unreachable we fail closed to the Early Access notice instead
  // of the commercial surface, so an unknown mode can never leak prices or
  // checkout chrome; every workspace call is still gated server-side.
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
        // No authoritative signal (endpoint unreachable surface zero): fail
        // CLOSED to the Early Access notice — never to paid/commercial chrome.
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
  // Ctrl/Cmd+B and the sidebar's own close button.
  const toggleSidebarRef = useRef(toggleSidebar);
  toggleSidebarRef.current = toggleSidebar;
  useEffect(() => {
    const onToggle = () => toggleSidebarRef.current();
    window.addEventListener(TOGGLE_SIDEBAR, onToggle);
    return () => window.removeEventListener(TOGGLE_SIDEBAR, onToggle);
  }, []);

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

  // Server-authoritative workspace gate: no free application tier. A locked
  // account is held on a single full-screen notice (backend independently 402s
  // every gated router; this is chrome, not authority) and it is non-dismissible
  // until unlocked.
  //
  // While the server reports temporary demo / early access there is no
  // commercial surface to sell, so a locked reply renders the Early Access
  // notice instead. The payment gate is only reached once the server explicitly
  // reports demo mode off — so a transient access-fetch failure (mode unknown)
  // can never leak prices, checkout or plan upgrade chrome onto the public build.
  if (access && !access.unlocked) {
    if (mode && !mode.temporaryDemoMode) return <PaymentGateModal />;
    return (
      <div className="cc-early-access-gate" data-testid="early-access-gate" style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="cc-card" style={{ maxWidth: 500, padding: 24 }}>
          <h1 style={{ fontSize: 20, marginTop: 0 }}>CodeConClave is currently available in Early Access</h1>
          <p className="cc-hint">Workspace access is open for early-access accounts, so no plan or payment is required. No payment has been taken and no plan has been purchased.</p>
          <p className="cc-hint">If this screen persists, reload the page.</p>
        </div>
      </div>
    );
  }

  return (
    <AccessModeProvider earlyAccess={Boolean(mode?.temporaryDemoMode)}>
      <div className={`cc-shell${collapsed ? ' cc-shell--collapsed' : ''}${drawerOpen ? ' cc-shell--drawer-open' : ''}`}>
        <Sidebar user={user} />
        {drawerOpen && <button className="cc-drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" />}
        <OfflineBanner />
        <Topbar onMenuClick={toggleSidebar} />
        <HoldBanner />
        <GlobalShortcuts />
        <UsageLimitHost />
        {typeof window !== 'undefined' && (window as unknown as { codeconclave?: unknown }).codeconclave ? (
          <Suspense fallback={null}>
            <DesktopBrowserLinks />
          </Suspense>
        ) : null}
        <a className="cc-skip-link" href="#main">
          Skip to content
        </a>
        <main id="main" className="cc-main">
          <Suspense fallback={<div className="cc-page" role="status" aria-live="polite">Loading page…</div>}>
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
            <Route path="/browser" element={<BrowserPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/beyond" element={<BeyondPage />} />
            <Route path="/sai" element={<SaiPage />} />
            <Route path="/work" element={<WorkPage />} />
            <Route path="/automation" element={<AutomationPage />} />
            <Route path="/recovery" element={<RecoveryPage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
            <Route path="/workbench" element={<WorkbenchPage />} />
            <Route path="/workbench/:projectId" element={<WorkbenchPage />} />
            <Route path="/coworkers" element={<CoworkersPage />} />
            <Route path="/coworker" element={<CoworkerPage />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/skills" element={<SkillPluginsPage />} />
            <Route path="/code-review" element={<CodeReviewPage />} />
            <Route path="/local" element={<LocalFilesPage />} />
            <Route path="/chats" element={<SessionsPage />} />
            <Route path="/control" element={<ControlPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/remote" element={<RemotePage />} />
            <Route path="/ideas" element={<IdeasPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
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
          </Suspense>
        </main>
        <ArtifactPanel />
        <CommandPalette onToggleFocus={toggleSidebar} />
        <ProCelebration />
      </div>
    </AccessModeProvider>
  );
}

/**
 * TEMPORARY DEMO BUILD entry gate.
 *
 * In the demo build the silent demo auto-login means there is no landing,
 * login or register step: every public entry point funnels straight into
 * /home. It waits for the auth bootstrap (so an already-demo-logged-in user
 * never flashes the marketing page) and, if the demo sign-in is unavailable
 * (for example the flag is off), falls back to rendering the normal page.
 * In a non-demo build this is a transparent passthrough — production routing
 * is unchanged.
 */
function DemoEntry({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  // Dev parity: the demo build flag is only inlined by `vite build` (define is
  // not applied by the dev server here), so a local demo would otherwise fall
  // through to the landing/login pages even though the silent demo sign-in
  // succeeded. In dev, honour the same demo entry — it only ever redirects an
  // already-authenticated session, so a non-demo server (demo-login 404s) still
  // renders the children untouched. Production keeps the strict build gate.
  if (!__DEMO_BUILD__ && !import.meta.env.DEV) return <>{children}</>;
  if (status === 'loading') {
    return (
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="cc-spinner" />
      </div>
    );
  }
  if (status === 'authed') return <Navigate to="/home" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Suspense fallback={<div className="cc-page" role="status" aria-live="polite">Loading page…</div>}>
        <Routes>
          <Route path="/" element={<DemoEntry><LandingPage /></DemoEntry>} />
          <Route path="/login" element={<DemoEntry><LoginPage /></DemoEntry>} />

          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/*" element={<Shell />} />
        </Routes>
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  );
}
