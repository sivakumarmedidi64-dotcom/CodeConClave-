import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  rbacRole: string;
  createdAt: string;
  lastActive: string | null;
  projectCount: number;
}

interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

function rolePillClass(role: string): string {
  if (role === 'owner') return 'cc-pill cc-pill--warn';
  if (role === 'admin') return 'cc-pill cc-pill--danger';
  return 'cc-pill';
}

export function AdminUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsers();
  }, [page, search]);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '20',
        ...(search && { search }),
      });
      const res = await fetch(`/api/v1/admin/users?${params}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!user || !['admin', 'owner'].includes(user.rbacRole)) {
    return null;
  }

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="cc-admin">
      {/* Search & Filter */}
      <div className="cc-admin-panel">
        <div className="cc-admin-panel__body">
          <div className="cc-admin__header">
            <div className="cc-admin-field" style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="search" className="cc-sr-only">Search users</label>
              <input
                id="search"
                type="text"
                placeholder="Search by email or name..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="cc-input"
              />
            </div>
            <div className="cc-admin-hint">{total} users</div>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="cc-admin-panel">
        {loading ? (
          <div className="cc-admin-loading">
            <div className="cc-spinner" />
          </div>
        ) : users.length === 0 ? (
          <div className="cc-empty">No users found</div>
        ) : (
          <>
            <div className="cc-table-wrap">
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Projects</th>
                    <th>Last Active</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div>
                          <div className="cc-admin-user">{u.displayName || '—'}</div>
                          <div className="cc-admin-hint">{u.email}</div>
                        </div>
                      </td>
                      <td>
                        <span className={rolePillClass(u.rbacRole)}>{u.rbacRole}</span>
                      </td>
                      <td>{u.projectCount}</td>
                      <td className="cc-admin-hint">
                        {u.lastActive
                          ? new Date(u.lastActive).toLocaleDateString()
                          : 'Never'}
                      </td>
                      <td className="cc-admin-hint">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        <button className="cc-btn cc-btn--sm cc-btn--ghost">
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            <div className="cc-admin-pagination">
              <p className="cc-admin-hint">
                Page {page} of {Math.ceil(total / 20)} — {total} total
              </p>
              <div className="cc-admin-pagination__actions">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="cc-btn cc-btn--sm cc-btn--ghost"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(Math.ceil(total / 20), p + 1))}
                  disabled={page === Math.ceil(total / 20)}
                  className="cc-btn cc-btn--sm cc-btn--ghost"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}