/**
 * CodeConClave — navigation, kept minimal, and SEPARATED BY PLAN.
 * Each plan sees only its own features: Free = just chat; Solo = personal power
 * tools; Team = Solo + the shared workspace; API = keys + live usage. Nothing is
 * shown to a plan that can't use it. Agent Sai is backend-only and never listed.
 */
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { BrandLogo } from './BrandLogo';
import { NEW_CHAT, TOGGLE_SIDEBAR } from '../lib/appEvents';
import { UserAvatar } from './UserAvatar';
import type { User } from '../lib/types';
import { useEarlyAccess } from '../lib/accessMode';

/** The plans a user can be on (customer-facing buckets, not internal ids). */
type PlanKey = 'free' | 'solo' | 'team' | 'api' | 'enterprise';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Which plans see this item. Omitted = every paid plan (not free). */
  plans?: PlanKey[];
}

const PAID: PlanKey[] = ['solo', 'team', 'api', 'enterprise'];
const SOLO_UP: PlanKey[] = ['solo', 'team', 'enterprise']; // personal power tools
const ALL: PlanKey[] = ['free', 'solo', 'team', 'api', 'enterprise'];

/** The few things most people use. */
const PRIMARY_ITEMS: NavItem[] = [
  { to: '/chats', label: 'Chats', icon: 'chat', plans: ALL }, // your past conversations
  { to: '/projects', label: 'Projects', icon: 'folder', plans: SOLO_UP },
  { to: '/agents', label: 'Agents', icon: 'layers', plans: SOLO_UP },
  { to: '/beyond', label: 'Beyond', icon: 'rocket', plans: SOLO_UP },
  { to: '/settings', label: 'Customize', icon: 'sliders', plans: ALL },
];

/** Everything else, one click away under "More". */
const MORE_ITEMS: NavItem[] = [
  { to: '/work', label: 'Tasks', icon: 'bolt', plans: SOLO_UP },
  { to: '/code-review', label: 'Code review', icon: 'eye', plans: SOLO_UP },
  { to: '/files', label: 'Files', icon: 'file', plans: SOLO_UP },
  { to: '/local', label: 'Local files', icon: 'monitor', plans: SOLO_UP },
  { to: '/terminal', label: 'Terminal', icon: 'terminal', plans: SOLO_UP },
  { to: '/browser', label: 'Browser', icon: 'compass', plans: SOLO_UP },
  { to: '/automation', label: 'Automation', icon: 'cog', plans: SOLO_UP },
  { to: '/teams', label: 'Teams', icon: 'users', plans: ['team', 'enterprise'] },
  { to: '/control', label: 'Control', icon: 'sliders', plans: SOLO_UP },
  { to: '/remote', label: 'Remote', icon: 'radio', plans: SOLO_UP },
  { to: '/ideas', label: 'Ideas', icon: 'bulb', plans: SOLO_UP },
  { to: '/data', label: 'Data', icon: 'database', plans: ['api', 'team', 'enterprise'] },
  { to: '/recovery', label: 'Recovery', icon: 'refresh', plans: SOLO_UP },
  { to: '/trash', label: 'Trash', icon: 'trash', plans: ALL },
];

const ADMIN_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: 'chart' },
  { to: '/admin/users', label: 'Users', icon: 'user' },
  { to: '/admin/ai-usage', label: 'AI Usage', icon: 'sparkle' },
];

/** Map an internal plan id to the customer-facing bucket the sidebar gates on. */
function mapPlan(planId: string | undefined): PlanKey {
  switch (planId) {
    case 'pro':
      return 'solo';
    case 'team':
      return 'team';
    case 'api':
      return 'api';
    case 'enterprise':
      return 'enterprise';
    default:
      // Claude-style free tier: chat with a token limit, no paid features.
      return 'free';
  }
}

/**
 * The plan bucket that decides what this user may SEE.
 * We follow the server's authoritative *effective* plan (from /api/v1/access)
 * when the shell has it, not the static planId on the profile — a free-id
 * account that the backend has unlocked to Pro must see its Pro tools.
 */
function planKey(user: User, effectivePlan?: string): PlanKey {
  return mapPlan(effectivePlan ?? user.planId);
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

/** Keep only the items this plan is allowed to see. */
function forPlan(items: NavItem[], plan: PlanKey): NavItem[] {
  return items.filter((it) => (it.plans ?? PAID).includes(plan));
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

export function Sidebar({ user, effectivePlan }: { user: User; effectivePlan?: string }) {
  const isAdmin = user && ['admin', 'owner'].includes(user.rbacRole);
  // Early access: the account pill reports the access stage, never a plan tier.
  const earlyAccess = useEarlyAccess();
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();
  const name = user.displayName ?? user.email ?? 'Account';

  // While early access is open there is no commercial gating yet, so everyone
  // sees every feature; once it closes, we gate on the server's effective plan.
  const plan: PlanKey = earlyAccess ? 'enterprise' : planKey(user, effectivePlan);
  const primary = forPlan(PRIMARY_ITEMS, plan);
  const more = forPlan(MORE_ITEMS, plan);

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
        {primary.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

        {more.length > 0 && (
          <>
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
              {more.map((item) => (
                <NavRow key={item.to} item={item} />
              ))}
            </div>
          </>
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
