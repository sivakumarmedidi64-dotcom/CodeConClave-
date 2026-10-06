/**
 * CodeConClave — unified navigation (AI-OS IA).
 * Primary destinations lead the navigation: Chat, Projects, Agents, Tasks,
 * Activity, Approvals, Connectors, Settings. Everything else lives under the
 * collapsible "More" group; admin routes are appended for operators. Labels
 * are short OS-style names, no marketing or feature-catalog language.
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { BrandLogo } from './BrandLogo';
import type { User } from '../lib/types';
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
      { to: '/chat', label: 'Chat', icon: 'chat' },
      { to: '/projects', label: 'Projects', icon: 'folder' },
      { to: '/agents', label: 'Agents', icon: 'layers' },
      { to: '/work', label: 'Tasks', icon: 'bolt' },
      { to: '/history', label: 'Activity', icon: 'clock' },
      { to: '/plugins', label: 'Connectors', icon: 'puzzle' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const MORE_ITEMS: NavItem[] = [
  { to: '/memory', label: 'Memory', icon: 'brain' },
  { to: '/dna', label: 'DNA', icon: 'dna' },
  { to: '/files', label: 'Files', icon: 'file' },
  { to: '/terminal', label: 'Terminal', icon: 'terminal' },
  { to: '/automation', label: 'Automation', icon: 'cog' },
  { to: '/workspace', label: 'Repo Workspace', icon: 'monitor' },
  { to: '/coworkers', label: 'Coworkers', icon: 'users' },
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

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

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
      return 'Free';
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

  const name = user.displayName ?? user.email ?? 'Account';

  return (
    <aside className="cc-sidebar">
      <NavLink className="cc-sidebar__brand" to="/home" title="Home — command CodeConClave">
        <BrandLogo variant="mark" height={22} />
        <span style={{ fontWeight: 700 }}>CodeConClave</span>
      </NavLink>
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
        {moreOpen && MORE_ITEMS.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

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
        <span className="cc-moon cc-moon--sm" title={name} aria-hidden="true">
          {initialsOf(name)}
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