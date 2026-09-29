import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Icon, type IconName } from '../../components/Icon';

export function AdminLayout() {
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems: Array<{ path: string; label: string; icon: IconName }> = [
    { path: '/admin', label: 'Dashboard', icon: 'chart' },
    { path: '/admin/users', label: 'Users', icon: 'users' },
    { path: '/admin/payments', label: 'Payments', icon: 'wallet' },
    { path: '/admin/ai-usage', label: 'AI Usage', icon: 'spark' },
  ];

  if (!user || !['admin', 'owner'].includes(user.rbacRole)) {
    return null;
  }

  return (
    <div className={`cc-admin-layout${sidebarOpen ? ' cc-admin-layout--open' : ''}`}>
      {/* Mobile sidebar toggle */}
      <button
        className="cc-admin-layout__toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
      >
        <Icon name="menu" size={18} />
      </button>

      {/* Sidebar */}
      <aside className={`cc-admin-layout__aside${sidebarOpen ? ' cc-admin-layout__aside--open' : ''}`}>
        <div className="cc-admin-layout__brand">Admin</div>
        <nav className="cc-admin-layout__nav" aria-label="Admin navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `cc-admin-layout__item${isActive ? ' active' : ''}`
              }
            >
              <span>
                <Icon name={item.icon} size={16} />
              </span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="cc-admin-layout__backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="cc-admin-layout__main">
        <h1 className="cc-admin__title">Admin Dashboard</h1>
        <Outlet />
      </div>
    </div>
  );
}