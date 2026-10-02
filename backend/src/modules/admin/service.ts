/**
 * CodeConClave — Admin Dashboard API Service.
 * Provides admin-level statistics and user management data.
 */
import { pool } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';

export interface AdminStats {
  totalUsers: number;
  totalProjects: number;
  totalMessagesToday: number;
  activeUsersToday: number;
  revenueToday: number;
  aiUsageBreakdown: { provider: string; requests: number; estimatedCostUsd: number }[];
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  rbacRole: string;
  createdAt: string;
  lastActive: string | null;
  projectCount: number;
}

export interface AiUsageStats {
  provider: string;
  requests: number;
  estimatedCostUsd: number;
  date: string;
}

export async function getAdminStats(): Promise<any> {
  const [users, projects, messages, activeUsers, revenue, aiUsage] = await Promise.all([
    pool.query(`SELECT COUNT(*) as count FROM users`),
    pool.query(`SELECT COUNT(*) as count FROM projects`),
    pool.query(`SELECT COUNT(*) as count FROM messages WHERE created_at >= CURRENT_DATE`),
    pool.query(`SELECT COUNT(DISTINCT user_id) as count FROM messages WHERE created_at >= CURRENT_DATE`),
    pool.query(`SELECT COALESCE(SUM(amount_usd), 0) as total FROM payments WHERE created_at >= CURRENT_DATE AND state = 'VERIFIED'`),
    pool.query(`
      SELECT provider, COUNT(*) as requests, COALESCE(SUM(cost_usd), 0) as cost
      FROM ai_usage
      WHERE created_at >= CURRENT_DATE
      GROUP BY provider
    `),
  ]);

  const aiUsageBreakdown = aiUsage.rows.map((row: any) => ({
    provider: row.provider,
    requests: parseInt(row.requests, 10),
    estimatedCostUsd: parseFloat(row.cost) || 0,
  }));

  return {
    totalUsers: parseInt(users.rows[0].count, 10),
    totalProjects: parseInt(projects.rows[0].count, 10),
    totalMessagesToday: parseInt(messages.rows[0].count, 10),
    activeUsersToday: parseInt(activeUsers.rows[0].count, 10),
    revenueToday: parseFloat(revenue.rows[0].total) || 0,
    aiUsageBreakdown,
  };
}

export async function getAdminUsers(
  page: number = 1,
  limit: number = 20,
  search?: string
): Promise<{ users: any[]; total: number; page: number; limit: number }> {
  const offset = (page - 1) * limit;
  let whereClause = '';
  const params: any[] = [];

  if (search) {
    whereClause = `WHERE email ILIKE $1 OR display_name ILIKE $1`;
    params.push(`%${search}%`);
  }

  const [totalResult, usersResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) as count FROM users ${whereClause}`,
      params,
    ),
    pool.query(
      `SELECT
         id, email, display_name, rbac_role, created_at,
         (SELECT MAX(created_at) FROM messages WHERE user_id = users.id) as last_active,
         (SELECT COUNT(*) FROM projects WHERE owner_id = users.id) as project_count
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    users: usersResult.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      rbacRole: row.rbac_role,
      createdAt: row.created_at,
      lastActive: row.last_active,
      projectCount: parseInt(row.project_count, 10),
    })),
    total: parseInt(totalResult.rows[0].count, 10),
    page,
    limit,
  };
}

export async function getAiUsageStats(days: number = 30): Promise<any[]> {
  const result = await pool.query(
    `SELECT provider, DATE(created_at) as date, COUNT(*) as requests, COALESCE(SUM(cost_usd), 0) as cost
     FROM ai_usage
     WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
     GROUP BY provider, DATE(created_at)
     ORDER BY date DESC, provider`,
  );
  return result.rows.map((row: any) => ({
    provider: row.provider,
    requests: parseInt(row.requests, 10),
    estimatedCostUsd: parseFloat(row.cost) || 0,
    date: row.date,
  }));
}