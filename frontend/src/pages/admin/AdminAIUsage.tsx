import { useEffect, useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useAuth } from '../../auth/AuthProvider';
import type { User } from '../../lib/types';

interface AiUsageStats {
  provider: string;
  requests: number;
  estimatedCostUsd: number;
  date: string;
}

function isAdminOrOwner(user: User | null): user is User {
  return user !== null && ['admin', 'owner'].includes(user.rbacRole);
}

export function AdminAIUsage() {
  const { user } = useAuth();
  const [aiUsage, setAiUsage] = useState<AiUsageStats[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAiUsage();
  }, [days]);

  const fetchAiUsage = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/ai-usage?days=${days}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setAiUsage(data);
      }
    } catch (err) {
      console.error('Failed to fetch AI usage:', err);
    } finally {
      setLoading(false);
    }
  };

  const aiUsageData = aiUsage ?? [];

  const chartData = useMemo(() =>
    Object.entries(
      aiUsageData.reduce((acc: Record<string, { requests: number; cost: number }>, item) => {
        const key = item.provider;
        acc[key] ??= { requests: 0, cost: 0 };
        acc[key].requests += item.requests;
        acc[key].cost += item.estimatedCostUsd;
        return acc;
      }, {} as Record<string, { requests: number; cost: number }>)
    ).map(([provider, data]) => ({ provider, ...data })),
  [aiUsageData]);

  const dailyData = useMemo(() =>
    aiUsageData.reduce((acc: Record<string, { requests: number; cost: number }>, item) => {
      const key = item.date;
      acc[key] ??= { requests: 0, cost: 0 };
      acc[key].requests += item.requests;
      acc[key].cost += item.estimatedCostUsd;
      return acc;
    }, {} as Record<string, { requests: number; cost: number }>),
  [aiUsageData]);

  const dailyDataArray = useMemo(() =>
    Object.entries(dailyData)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  [dailyData]);

  const providerAgg = useMemo(() =>
    Object.entries(
      aiUsageData.reduce((acc: Record<string, { requests: number; cost: number }>, item) => {
        const key = item.provider;
        acc[key] ??= { requests: 0, cost: 0 };
        acc[key].requests += item.requests;
        acc[key].cost += item.estimatedCostUsd;
        return acc;
      }, {} as Record<string, { requests: number; cost: number }>)
    ),
  [aiUsageData]);

  const totalRequests = aiUsageData.reduce((sum, item) => sum + item.requests, 0);
  const totalCost = aiUsageData.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const activeProviders = aiUsageData.length > 0 ? new Set(aiUsageData.map((i) => i.provider)).size : 0;

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

  return (
    <div className="cc-admin">
      {/* Header & Filter */}
      <div className="cc-admin-panel">
        <div className="cc-admin-panel__header">
          <h1 className="cc-admin__title">AI Usage Analytics</h1>
          <div className="cc-admin-field" style={{ maxWidth: 220 }}>
            <label htmlFor="days" className="cc-sr-only">
              Time Range:
            </label>
            <select
              id="days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="cc-select"
            >
              <option value={7}>Last 7 Days</option>
              <option value={30}>Last 30 Days</option>
              <option value={90}>Last 90 Days</option>
            </select>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="cc-admin-stats">
        <div className="cc-admin-card">
          <div className="cc-admin-card__label">Total Requests</div>
          <div className="cc-admin-card__value">{totalRequests.toLocaleString()}</div>
        </div>
        <div className="cc-admin-card">
          <div className="cc-admin-card__label">Estimated Cost</div>
          <div className="cc-admin-card__value">${totalCost.toFixed(2)}</div>
        </div>
        <div className="cc-admin-card">
          <div className="cc-admin-card__label">Active Providers</div>
          <div className="cc-admin-card__value">{activeProviders}</div>
        </div>
        <div className="cc-admin-card">
          <div className="cc-admin-card__label">Avg Cost/Request</div>
          <div className="cc-admin-card__value">
            {totalRequests > 0 ? (totalCost / totalRequests).toFixed(4) : '0.0000'}
          </div>
        </div>
      </div>

      {/* Provider Breakdown Chart */}
      <div className="cc-admin-card">
        <h2 className="cc-admin__title">Requests by Provider</h2>
        {chartData.length > 0 ? (
          <div className="cc-admin-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="provider" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="requests" name="Requests" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="cc-empty">No AI usage data available</p>
        )}
      </div>

      {/* Daily Trend Chart */}
      <div className="cc-admin-card">
        <h2 className="cc-admin__title">Daily Usage Trend</h2>
        {dailyDataArray.length > 0 ? (
          <div className="cc-admin-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyDataArray}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ dy: 10 }} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="requests" name="Requests" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="cc-empty">No daily usage data available</p>
        )}
      </div>

      {/* Provider Breakdown Table */}
      <div className="cc-admin-panel">
        <div className="cc-admin-panel__header">
          <h2 className="cc-admin__title">Provider Breakdown</h2>
        </div>
        <div className="cc-table-wrap">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="cc-admin-num">Requests</th>
                <th className="cc-admin-num">Cost (USD)</th>
                <th className="cc-admin-num">Avg Cost/Request</th>
              </tr>
            </thead>
            <tbody>
              {providerAgg.map(([provider, data]) => (
                <tr key={provider}>
                  <td className="cc-admin-user">{provider}</td>
                  <td className="cc-admin-num">{data.requests.toLocaleString()}</td>
                  <td className="cc-admin-num">${data.cost.toFixed(2)}</td>
                  <td className="cc-admin-num">
                    ${(data.cost / (data.requests || 1)).toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}