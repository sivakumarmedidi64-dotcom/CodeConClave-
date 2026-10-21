/**
 * CodeConClave — unified navigation (AI-OS IA).
 * Primary destinations lead the navigation: Chat, Projects, Agents, Tasks,
 * Activity, Approvals, Connectors, Settings. Everything else lives under the
 * collapsible "More" group; admin routes are appended for operators. Labels
 * are short OS-style names, no marketing or feature-catalog language.
 */
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { BrandLogo } from './BrandLogo';
import { api } from '../lib/api';
import { CONVERSATIONS_CHANGED, TOGGLE_SIDEBAR } from '../lib/appEvents';
import { UserAvatar } from './UserAvatar';
import type { Conversation, User } from '../lib/types';
import { useEarlyAccess } from '../lib/accessMode';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

const PRIMARY_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/home', label: 'Home', icon: 'home' },
      { to: '/projects', label: 'Projects', icon: 'folder' },
      { to: '/agents', label: 'Agents', icon: 'layers' },
      { to: '/work', label: 'Tasks', icon: 'bolt' },
      { to: '/beyond', label: 'Beyond', icon: 'rocket' },
      { to: '/code-review', label: 'Code review', icon: 'eye' },
      { to: '/local', label: 'Local files', icon: 'monitor' },
      { to: '/skills', label: 'Plugins', icon: 'puzzle' },
      { to: '/plugins', label: 'Connectors', icon: 'plug' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const MORE_ITEMS: NavItem[] = [
  { to: '/coworker', label: 'Coworker', icon: 'sparkle' },
  { to: '/coworker#email', label: 'Email', icon: 'mail' },
  { to: '/coworker#scan', label: 'Code Map', icon: 'search' },
  { to: '/files', label: 'Files', icon: 'file' },
  { to: '/terminal', label: 'Terminal', icon: 'terminal' },
  { to: '/browser', label: 'Browser', icon: 'compass' },
  { to: '/automation', label: 'Automation', icon: 'cog' },
  { to: '/workspace', label: 'Repo Workspace', icon: 'monitor' },
  { to: '/coworkers', label: 'Coworkers', icon: 'users' },
  { to: '/teams', label: 'Teams', icon: 'users' },
  { to: '/pipeline', label: 'Pipeline', icon: 'shield-check' },
  { to: '/control', label: 'Control', icon: 'sliders' },
  { to: '/remote', label: 'Remote', icon: 'radio' },
  { to: '/ideas', label: 'Ideas', icon: 'bulb' },
  { to: '/data', label: 'Data', icon: 'database' },
  { to: '/recovery', label: 'Recovery', icon: 'refresh' },
  { to: '/trash', label: 'Trash', icon: 'trash' },
];

const ADMIN_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: 'chart' },
  { to: '/admin/users', label: 'Users', icon: 'user' },
  { to: '/admin/ai-usage', label: 'AI Usage', icon: 'sparkle' },
];

/** Friendly plan pill label (customer names, not internal ids). */
function planLabel(user: User): string {
  switch (user.planId) {
    case 'pro':
      return user.entitlementState === 'PRO_VERIFIED' ? 'Solo' : 'Solo pending';
    case 'team':
      return user.entitlementState === 'PRO_VERIFIED' ? 'Team' : 'Team pending';
    case 'api':
      return 'API';
    case 'enterprise':
      return 'Enterprise';
    default:
      // There is no free tier: an unpaid account has no plan yet.
      return 'No plan';
  }
}

const RECENTS_LIMIT = 8;

/** Most recent non-archived conversations; refreshed when the route changes. */
function useRecentConversations(): Conversation[] {
  const location = useLocation();
  const [recents, setRecents] = useState<Conversation[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(CONVERSATIONS_CHANGED, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, bump);
  }, []);
  useEffect(() => {
    let alive = true;
    api<{ conversations: Conversation[] }>('/api/v1/conversations')
      .then((res) => {
        if (!alive || !Array.isArray(res?.conversations)) return;
        const sorted = [...res.conversations]
          .filter((c) => !c.archived && !c.deletedAt)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        setRecents(sorted.slice(0, RECENTS_LIMIT));
      })
      .catch(() => {
        if (alive) setRecents([]);
      });
    return () => {
      alive = false;
    };
  }, [location.pathname, tick]);
  return recents;
}

function NavRow({ item }: { item: NavItem }) {
  return (
    <NavLink
      key={item.to}
      to={item.to}
      end
      className={({ isActive }) => `cc-sidebar__item${isActive ? ' active' : ''}`}
      title={item.label}
      aria-label={item.label}
    >
      <Icon name={item.icon} />
      <span className="cc-sidebar__label">{item.label}</span>
    </NavLink>
  );
}

export function Sidebar({ user }: { user: User }) {
  const isAdmin = user && ['admin', 'owner'].includes(user.rbacRole);
  // Early access: the account pill reports the access stage, never a plan tier.
  const earlyAccess = useEarlyAccess();
  const [moreOpen, setMoreOpen] = useState(false);
  const recents = useRecentConversations();
  const location = useLocation();
  const [params] = useSearchParams();
  const activeConv = location.pathname === '/chat' ? params.get('c') : null;

  const name = user.displayName ?? user.email ?? 'Account';

  return (
    <aside className="cc-sidebar">
      <NavLink className="cc-sidebar__brand" to="/home" title="Home — command CodeConClave">
        <BrandLogo variant="mark" height={22} />
        <span style={{ fontWeight: 700 }}>CodeConClave</span>
      </NavLink>
      <button
        type="button"
        className="cc-sidebar__close"
        aria-label="Close sidebar"
        title="Close sidebar (Ctrl+B)"
        onClick={() => window.dispatchEvent(new Event(TOGGLE_SIDEBAR))}
      >
        <Icon name="panel-left" size={16} />
      </button>
      <Link to="/chat?new=1" className="cc-sidebar__new" title="Start a new conversation">
        <span className="cc-sidebar__new-icon" aria-hidden="true">
          <Icon name="plus" size={14} />
        </span>
        <span className="cc-sidebar__label">New chat</span>
      </Link>
      <nav className="cc-sidebar__nav" aria-label="Workspace navigation">
        {PRIMARY_SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="cc-sidebar__section">{section.label}</div>
            {section.items.map((item) => (
              <NavRow key={item.to} item={item} />
            ))}
          </div>
        ))}

        <button
          type="button"
          className="cc-sidebar__more-toggle"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          aria-label={moreOpen ? 'More navigation, expanded' : 'More navigation, collapsed'}
        >
          <span className="cc-sidebar__label">More</span>
          <Icon name={moreOpen ? 'close' : 'plus'} size={12} />
        </button>
        <div className={`cc-sidebar__more-list${moreOpen ? ' cc-sidebar__more-list--open' : ''}`}>
          {MORE_ITEMS.map((item) => (
            <NavRow key={item.to} item={item} />
          ))}
        </div>

        {recents.length > 0 && (
          <div className="cc-sidebar__recents" aria-label="Recent conversations">
            <div className="cc-sidebar__section">Recents</div>
            {recents.map((c) => (
              <Link
                key={c.id}
                to={`/chat?c=${encodeURIComponent(c.id)}`}
                className={`cc-sidebar__recent${activeConv === c.id ? ' active' : ''}`}
                title={c.title}
              >
                <span className="cc-sidebar__label">{c.title || 'Untitled conversation'}</span>
              </Link>
            ))}
            <Link to="/chats" className="cc-sidebar__recent cc-sidebar__recent--all">
              <span className="cc-sidebar__label">All chats →</span>
            </Link>
          </div>
        )}

        {isAdmin && (
          <div>
            <div className="cc-sidebar__section">Admin</div>
            {ADMIN_ITEMS.map((item) => (
              <NavRow key={item.to} item={item} />
            ))}
          </div>
        )}
      </nav>
      <div className="cc-sidebar__foot">
        <span title={name}>
          <UserAvatar name={name} size={26} />
        </span>
        <span className="cc-sidebar__label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {name}
        </span>
        <span
          className={`cc-plan-pill${!earlyAccess && user.entitlementState === 'PRO_VERIFIED' ? ' cc-plan-pill--pro' : ''}`}
          style={{ padding: '1px 8px', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em' }}
        >
          {earlyAccess ? 'Early Access' : planLabel(user)}
        </span>
      </div>
    </aside>
  );
}