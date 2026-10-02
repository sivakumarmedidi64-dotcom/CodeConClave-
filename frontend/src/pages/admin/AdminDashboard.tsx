import { useEffect, useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useAuth } from '../../auth/AuthProvider';
import type { User } from '../../lib/types';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';

interface AdminStats {
  totalUsers: number;
  totalProjects: number;
  totalMessagesToday: number;
  activeUsersToday: number;
  revenueToday: number;
  aiUsageBreakdown: { provider: string; requests: number; estimatedCostUsd: number }[];
}

interface AiUsageStats {
  provider: string;
  requests: number;
  estimatedCostUsd: number;
  date: string;
}

function isAdminOrOwner(user: User | null): user is User {
  return user !== null && ['admin', 'owner'].includes(user.rbacRole);
}

export function AdminDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const [statsRes, aiRes] = await Promise.all([
        fetch('/api/v1/admin/stats', { credentials: 'include' }),
        fetch('/api/v1/admin/ai-usage?days=30', { credentials: 'include' }),
      ]);

      if (statsRes.ok && aiRes.ok) {
        const [statsData, aiData] = await Promise.all([
          statsRes.json(),
          aiRes.json(),
        ]);
        setStats(statsData);
        setAiUsage(aiData);
      }
    } catch (err) {
      console.error('Failed to fetch admin stats:', err);
    } finally {
      setLoading(false);
    }
  };

  const aiUsageData = aiUsage ?? [];

  const chartData = useMemo(() => {
    const data = aiUsageData.reduce((acc: Record<string, { requests: number; cost: number }>, item) => {
      const key = item.provider;
      acc[key] ??= { requests: 0, cost: 0 };
      acc[key].requests += item.requests;
      acc[key].cost += item.estimatedCostUsd;
      return acc;
    }, {} as Record<string, { requests: number; cost: number }>);
    return Object.entries(data).map(([provider, data]) => ({ provider, ...data }));
  }, [aiUsageData]);

  if (!isAdminOrOwner(user)) {
    return null;
  }

  if (loading) {
    return (
      <div className="cc-admin-loading">
        <div className="cc-spinner" />
      </div>
    );
  }

  const statsData = stats ?? {
    totalUsers: 0,
    totalProjects: 0,
    totalMessagesToday: 0,
    activeUsersToday: 0,
    revenueToday: 0,
    aiUsageBreakdown: [],
  };

  const statsCards: { label: string; value: string | number; icon: IconName }[] = [
    { label: 'Total Users', value: statsData.totalUsers, icon: 'users' },
    { label: 'Total Projects', value: statsData.totalProjects, icon: 'folder' },
    { label: 'Messages Today', value: statsData.totalMessagesToday, icon: 'chat' },
    { label: 'Active Users Today', value: statsData.activeUsersToday, icon: 'check' },
    { label: 'Revenue Today', value: `$${statsData.revenueToday}`, icon: 'chart' },
    { label: 'AI Requests Today', value: statsData.aiUsageBreakdown.reduce((sum, p) => sum + p.requests, 0), icon: 'spark' },
  ];

  return (
    <div className="cc-admin">
      {/* Stats Grid */}
      <div className="cc-admin-stats">
        {statsCards.map((stat) => (
          <div key={stat.label} className="cc-admin-card cc-admin-card--stat">
            <div>
              <div className="cc-admin-card__label">{stat.label}</div>
              <div className="cc-admin-card__value">{stat.value}</div>
            </div>
            <div className="cc-admin-card__icon"><Icon name={stat.icon} size={18} /></div>
          </div>
        ))}
      </div>

      {/* AI Usage Chart */}
      <div className="cc-admin-card">
        <h2 className="cc-admin__title">AI Usage (Last 30 Days)</h2>
        {chartData.length > 0 ? (
          <div className="cc-admin-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="provider" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="requests" name="Requests" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="cc-empty">No AI usage data available</p>
        )}
      </div>
    </div>
  );
}