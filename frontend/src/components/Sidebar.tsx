/**
 * CodeConClave — navigation, kept minimal like Claude: a search, a prominent
 * "New" chat, a short primary list, and everything else tucked under "More".
 * No chat list clutters the rail — Home is the one chat; past chats live on
 * the Chats page (reachable from More). Labels are short OS-style names.
 */
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { BrandLogo } from './BrandLogo';
import { NEW_CHAT, TOGGLE_SIDEBAR } from '../lib/appEvents';
import { UserAvatar } from './UserAvatar';
import type { User } from '../lib/types';
import { useEarlyAccess } from '../lib/accessMode';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

/** The few things most people use — kept short on purpose. */
const PRIMARY_ITEMS: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/agents', label: 'Agents', icon: 'layers' },
  { to: '/beyond', label: 'Beyond', icon: 'rocket' },
  { to: '/sai', label: 'Agent Sai', icon: 'search' },
  { to: '/settings', label: 'Customize', icon: 'sliders' },
];

/** Everything else, one click away under "More". */
const MORE_ITEMS: NavItem[] = [
  { to: '/work', label: 'Tasks', icon: 'bolt' },
  { to: '/code-review', label: 'Code review', icon: 'eye' },
  { to: '/files', label: 'Files', icon: 'file' },
  { to: '/local', label: 'Local files', icon: 'monitor' },
  { to: '/terminal', label: 'Terminal', icon: 'terminal' },
  { to: '/browser', label: 'Browser', icon: 'compass' },
  { to: '/automation', label: 'Automation', icon: 'cog' },
  { to: '/teams', label: 'Teams', icon: 'users' },
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
  const navigate = useNavigate();
  const name = user.displayName ?? user.email ?? 'Account';

  const startNewChat = () => {
    navigate('/home');
    // Let Home mount if we navigated, then wipe the board for a fresh chat.
    requestAnimationFrame(() => window.dispatchEvent(new Event(NEW_CHAT)));
  };

  return (
    <aside className="cc-sidebar">
      <div className="cc-sidebar__top">
        <NavLink className="cc-sidebar__brand" to="/home" title="Home — CodeConClave">
          <BrandLogo variant="mark" height={20} />
          <span style={{ fontWeight: 650 }}>CodeConClave</span>
        </NavLink>
        <button
          type="button"
          className="cc-icon-btn cc-sidebar__collapse"
          aria-label="Close sidebar"
          title="Close sidebar (Ctrl+B)"
          onClick={() => window.dispatchEvent(new Event(TOGGLE_SIDEBAR))}
        >
          <Icon name="panel-left" size={17} />
        </button>
      </div>

      <button type="button" className="cc-sidebar__search" onClick={() => window.dispatchEvent(new Event('cc:open-palette'))}>
        <Icon name="search" size={15} />
        <span>Search</span>
      </button>

      <button type="button" className="cc-sidebar__new" onClick={startNewChat} title="Start a new chat">
        <Icon name="plus" size={16} />
        <span className="cc-sidebar__label">New chat</span>
      </button>

      <nav className="cc-sidebar__nav" aria-label="Workspace navigation">
        {PRIMARY_ITEMS.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

        <button
          type="button"
          className="cc-sidebar__more-toggle"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          aria-label={moreOpen ? 'More navigation, expanded' : 'More navigation, collapsed'}
        >
          <Icon name="dots" size={16} />
          <span className="cc-sidebar__label">More</span>
          <Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={13} />
        </button>
        <div className={`cc-sidebar__more-list${moreOpen ? ' cc-sidebar__more-list--open' : ''}`}>
          {MORE_ITEMS.map((item) => (
            <NavRow key={item.to} item={item} />
          ))}
        </div>

        {isAdmin && (
          <div>
            <div className="cc-sidebar__section">Admin</div>
            {ADMIN_ITEMS.map((item) => (
              <NavRow key={item.to} item={item} />
            ))}
          </div>
        )}
      </nav>

      <NavLink to="/settings" className="cc-sidebar__foot" title={name}>
        <UserAvatar name={name} size={26} />
        <span className="cc-sidebar__label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {name}
        </span>
        <span
          className={`cc-plan-pill${!earlyAccess && user.entitlementState === 'PRO_VERIFIED' ? ' cc-plan-pill--pro' : ''}`}
          style={{ padding: '1px 8px', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em' }}
        >
          {earlyAccess ? 'Early Access' : planLabel(user)}
        </span>
      </NavLink>
    </aside>
  );
}
