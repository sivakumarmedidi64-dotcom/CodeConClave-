/**
 * CodeConClave — teams routes (Phase 9).
 * Full team collaboration API surface. Keeps the pre-existing paths used by
 * the frontend (GET/POST /, /:id, /:id/members, DELETE /:id/members/:userId,
 * /:id/stats) and adds invitations, role/status management, lifecycle,
 * activity, settings and shared resources.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { jsonResult } from '../auth/schemas.js';
import {
  acceptInvitation,
  archiveTeam,
  attachProjectToTeam,
  cancelInvitation,
  changeMemberRole,
  createTeam,
  detachProjectFromTeam,
  getTeam,
  inviteMember,
  listInvitations,
  listMyInvitations,
  listTeamActivity,
  listTeamConversations,
  listTeamProjects,
  listTeams,
  rejectInvitation,
  removeTeamMember,
  renameTeam,
  restoreTeam,
  revokeMembership,
  shareConversationWithTeam,
  suspendMember,
  teamMembers,
  teamStats,
  unshareConversationFromTeam,
  updateTeamDescription,
  updateTeamSettings,
} from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { TeamRole, MAX_TEAM_NAME_LENGTH, MAX_TEAM_DESCRIPTION_LENGTH } from '@codeconclave/shared';
import { effectivePlan } from '../entitlements/service.js';

/**
 * Team plan gate. Bug fix: `/api/v1/teams` was mounted behind
 * requireWorkspaceEntitlement(), which is satisfied by a SOLO (pro) purchase.
 * That let a Solo customer create teams, invite members, and share projects and
 * conversations with other users — receiving the Team product (₹4,999) for the
 * Solo price (₹999). Team collaboration is now gated on the Team plan
 * specifically. Read-only listing stays open so a downgraded customer can still
 * see (and export/leave) the teams they were a member of.
 */
export function requireTeamPlan(): RequestHandler {
  // Named so the route stack is introspectable in tests (a regression guard that
  // every escalatory team endpoint actually carries this gate).
  return async function requireTeamPlan(req, _res, next) {
    try {
      const userId = req.ctx?.user?.id;
      if (!userId) {
        next(AppError.unauthorized());
        return;
      }
      if ((await effectivePlan(userId)) === 'team') {
        next();
        return;
      }
      next(
        AppError.paymentRequired(
          'team_plan_required',
          'Team collaboration requires the Team plan (₹4,999). Solo (₹999) is a single-user plan and cannot create teams, invite members, or share work.',
        ),
      );
    } catch {
      next(AppError.unavailable('entitlement_check_failed', 'Could not verify entitlement. Try again.'));
    }
  };
}

export const teamRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const teamPlan = requireTeamPlan();

  router.get(
    '/',
    asyncRoute(async (req, res) => res.json(jsonResult({ teams: await listTeams(req.ctx.user!.id) }))),
  );

  router.post(
    '/',
    teamPlan,
    asyncRoute(async (req, res) => {
      const name = String(req.body.name ?? '').trim().slice(0, MAX_TEAM_NAME_LENGTH);
      if (!name) throw AppError.badRequest('name_required', 'Team name is required');
      const description = req.body.description ? String(req.body.description).slice(0, MAX_TEAM_DESCRIPTION_LENGTH) : undefined;
      const team = await createTeam(req.ctx.user!.id, name, description);
      res.status(201).json(jsonResult({ team }));
    }),
  );

  router.get(
    '/my-invitations',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ invitations: await listMyInvitations(req.ctx.user!.id) })),
    ),
  );

  router.post(
    '/invitations/:id/accept',
    asyncRoute(async (req, res) => {
      const invitation = await acceptInvitation(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ invitation }));
    }),
  );

  router.post(
    '/invitations/:id/reject',
    asyncRoute(async (req, res) => {
      const invitation = await rejectInvitation(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ invitation }));
    }),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      const team = await getTeam(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ team }));
    }),
  );

  router.patch(
    '/:id',
    teamPlan,
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const teamId = req.params.id!;
      let team = await getTeam(userId, teamId);
      if (req.body.name !== undefined) {
        const name = String(req.body.name ?? '').trim().slice(0, MAX_TEAM_NAME_LENGTH);
        if (!name) throw AppError.badRequest('name_required', 'Team name is required');
        team = await renameTeam(userId, teamId, name);
      }
      if (req.body.description !== undefined) {
        team = await updateTeamDescription(userId, teamId, String(req.body.description).slice(0, MAX_TEAM_DESCRIPTION_LENGTH));
      }
      if (req.body.settings !== undefined) {
        team = await updateTeamSettings(userId, teamId, req.body.settings);
      }
      res.json(jsonResult({ team }));
    }),
  );

  router.post(
    '/:id/archive',
    teamPlan,
    asyncRoute(async (req, res) => res.json(jsonResult({ team: await archiveTeam(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/:id/restore',
    teamPlan,
    asyncRoute(async (req, res) => res.json(jsonResult({ team: await restoreTeam(req.ctx.user!.id, req.params.id!) }))),
  );

  router.get(
    '/:id/members',
    asyncRoute(async (req, res) => res.json(jsonResult({ members: await teamMembers(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/:id/members',
    teamPlan,
    asyncRoute(async (req, res) => {
      const email = String(req.body.email ?? '');
      const role = String(req.body.role ?? TeamRole.EDITOR);
      const invitation = await inviteMember(req.ctx.user!.id, req.params.id!, email, role);
      res.status(201).json(jsonResult({ invitation }));
    }),
  );

  router.patch(
    '/:id/members/:userId',
    teamPlan,
    asyncRoute(async (req, res) => {
      const role = String(req.body.role ?? '');
      await changeMemberRole(req.ctx.user!.id, req.params.id!, req.params.userId!, role);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/members/:userId/suspend',
    teamPlan,
    asyncRoute(async (req, res) => {
      await suspendMember(req.ctx.user!.id, req.params.id!, req.params.userId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // De-escalation is deliberately NOT plan-gated. revoke / remove / detach /
  // unshare all *reduce* access, so a customer who downgrades or expires must
  // still be able to strip access; gating these would trap collaborators in a
  // team the paying customer can no longer manage.
  router.post(
    '/:id/members/:userId/revoke',
    asyncRoute(async (req, res) => {
      await revokeMembership(req.ctx.user!.id, req.params.id!, req.params.userId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:id/members/:userId',
    asyncRoute(async (req, res) => {
      await removeTeamMember(req.ctx.user!.id, req.params.id!, req.params.userId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/:id/invitations',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ invitations: await listInvitations(req.ctx.user!.id, req.params.id!) })),
    ),
  );

  router.post(
    '/:id/invitations/:invitationId/cancel',
    teamPlan,
    asyncRoute(async (req, res) => {
      const invitation = await cancelInvitation(req.ctx.user!.id, req.params.id!, req.params.invitationId!);
      res.json(jsonResult({ invitation }));
    }),
  );

  router.get(
    '/:id/activity',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ activity: await listTeamActivity(req.ctx.user!.id, req.params.id!) })),
    ),
  );

  router.get(
    '/:id/stats',
    asyncRoute(async (req, res) => res.json(jsonResult(await teamStats(req.ctx.user!.id, req.params.id!)))),
  );

  router.get(
    '/:id/projects',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ projects: await listTeamProjects(req.ctx.user!.id, req.params.id!) })),
    ),
  );

  router.post(
    '/:id/projects/:projectId',
    teamPlan,
    asyncRoute(async (req, res) => {
      const project = await attachProjectToTeam(req.ctx.user!.id, req.params.id!, req.params.projectId!);
      res.status(201).json(jsonResult({ project }));
    }),
  );

  router.delete(
    '/:id/projects/:projectId',
    asyncRoute(async (req, res) => {
      await detachProjectFromTeam(req.ctx.user!.id, req.params.id!, req.params.projectId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/:id/conversations',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ conversations: await listTeamConversations(req.ctx.user!.id, req.params.id!) })),
    ),
  );

  router.post(
    '/:id/conversations/:conversationId',
    teamPlan,
    asyncRoute(async (req, res) => {
      await shareConversationWithTeam(req.ctx.user!.id, req.params.id!, req.params.conversationId!);
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:id/conversations/:conversationId',
    asyncRoute(async (req, res) => {
      await unshareConversationFromTeam(req.ctx.user!.id, req.params.id!, req.params.conversationId!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  return router;
};