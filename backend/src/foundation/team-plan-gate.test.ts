/**
 * CodeConClave — Team plan gate regression (BUG: Solo could get Team for ₹999).
 *
 * `/api/v1/teams` is mounted behind requireWorkspaceEntitlement(), which accepts
 * Solo OR Team. That satisfied a Solo purchase, so a ₹999 customer could create
 * teams, invite members, attach projects, and share conversations with other
 * users — the Team product (₹4,999) at the Solo price. Team collaboration is
 * therefore gated on the Team plan itself via requireTeamPlan().
 *
 * De-escalation (revoke / remove member / detach / unshare) is intentionally
 * NOT gated, so a downgraded customer can still strip access.
 *
 * The middleware is exercised directly (no HTTP server) because the gate is the
 * unit under test; DB is mocked and effectivePlan is stubbed per case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const effectivePlan = vi.hoisted(() => vi.fn(async (_userId: string): Promise<'free' | 'pro' | 'team'> => 'free'));
vi.mock('../modules/entitlements/service.js', () => ({ effectivePlan, hasVerifiedEntitlement: vi.fn() }));

import { requireTeamPlan, teamRoutes } from '../modules/teams/routes.js';

type Ctx = Parameters<NextFunction> extends never ? never : unknown;

function run(userId: string | null): Promise<{ err: unknown }> {
  const gate = requireTeamPlan();
  return new Promise((resolve) => {
    const req = { ctx: userId ? { user: { id: userId } } : { user: null } } as unknown as Request;
    const res = {} as Response;
    const next = ((err?: unknown) => resolve({ err })) as NextFunction & Ctx;
    void gate(req, res, next);
  });
}

beforeEach(() => {
  effectivePlan.mockReset();
  effectivePlan.mockResolvedValue('free');
});

describe('requireTeamPlan — Team collaboration is a Team-plan product', () => {
  it('ALLOWS a Team-plan customer through', async () => {
    effectivePlan.mockResolvedValue('team');
    expect((await run('u-team')).err).toBeUndefined();
  });

  it('BLOCKS a SOLO (pro) customer with 402 team_plan_required', async () => {
    effectivePlan.mockResolvedValue('pro');
    const { err } = await run('u-solo');
    expect(err).toMatchObject({ status: 402, errorCode: 'team_plan_required' });
    expect((err as { message: string }).message).toContain('₹4,999');
  });

  it('BLOCKS a FREE customer with the same 402 (no free tier)', async () => {
    effectivePlan.mockResolvedValue('free');
    expect((await run('u-free')).err).toMatchObject({ status: 402, errorCode: 'team_plan_required' });
  });

  it('BLOCKS an unauthenticated request with 401 before touching entitlements', async () => {
    const { err } = await run(null);
    expect(err).toMatchObject({ status: 401 });
    expect(effectivePlan).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the entitlement lookup itself errors', async () => {
    effectivePlan.mockRejectedValue(new Error('db down'));
    expect((await run('u-x')).err).toMatchObject({ status: 503, errorCode: 'entitlement_check_failed' });
  });
});

describe('teamRoutes — gate placement', () => {
  const escalatory: Array<[string, string]> = [
    ['post', '/'],
    ['patch', '/:id'],
    ['post', '/:id/archive'],
    ['post', '/:id/restore'],
    ['post', '/:id/members'],
    ['patch', '/:id/members/:userId'],
    ['post', '/:id/members/:userId/suspend'],
    ['post', '/:id/invitations/:invitationId/cancel'],
    ['post', '/:id/projects/:projectId'],
    ['post', '/:id/conversations/:conversationId'],
  ];

  it('gates every escalatory team endpoint on the Team plan', () => {
    const router = teamRoutes();
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> } }> }).stack;
    for (const [method, path] of escalatory) {
      const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
      expect(layer, `expected a ${method.toUpperCase()} ${path} route`).toBeDefined();
      expect(
        layer!.route!.stack.map((h) => h.name).filter((n) => n.startsWith('requireTeamPlan')),
        `${method.toUpperCase()} ${path} must include the team-plan gate`,
      ).toHaveLength(1);
    }
  });

  it('leaves de-escalation ungated so a downgrade can still revoke access', () => {
    const router = teamRoutes();
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> } }> }).stack;
    const deEscalatory: Array<[string, string]> = [
      ['post', '/:id/members/:userId/revoke'],
      ['delete', '/:id/members/:userId'],
      ['delete', '/:id/projects/:projectId'],
      ['delete', '/:id/conversations/:conversationId'],
    ];
    for (const [method, path] of deEscalatory) {
      const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
      expect(layer, `expected a ${method.toUpperCase()} ${path} route`).toBeDefined();
      expect(
        layer!.route!.stack.map((h) => h.name).filter((n) => n.startsWith('requireTeamPlan')),
        `${method.toUpperCase()} ${path} must stay ungated`,
      ).toHaveLength(0);
    }
  });

  it('leaves read-only listing and invitation accept/reject ungated', () => {
    const router = teamRoutes();
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> } }> }).stack;
    const open: Array<[string, string]> = [
      ['get', '/'],
      ['get', '/my-invitations'],
      ['post', '/invitations/:id/accept'],
      ['post', '/invitations/:id/reject'],
      ['get', '/:id/members'],
      ['get', '/:id/invitations'],
    ];
    for (const [method, path] of open) {
      const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
      expect(layer, `expected a ${method.toUpperCase()} ${path} route`).toBeDefined();
      expect(
        layer!.route!.stack.map((h) => h.name).filter((n) => n.startsWith('requireTeamPlan')),
        `${method.toUpperCase()} ${path} must stay ungated`,
      ).toHaveLength(0);
    }
  });
});
