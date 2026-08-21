/**
 * CodeConClave — notifications routes.
 * All handlers are recipient-scoped server-side; client IDs are never
 * trusted beyond identifying the notification owned by the caller.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { notificationListQuerySchema, notificationPreferencesSchema } from '@codeconclave/shared';
import {
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  getNotificationPreferences,
  updateNotificationPreferences,
  returnToWorkSummary,
  toNotificationJson,
} from './service.js';
import { AppError } from '../../shared/errors.js';

export const notificationRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const query = notificationListQuerySchema.parse(req.query);
      const notifications = await listNotifications(req.ctx.user!.id, {
        unread: query.unread !== undefined,
        type: query.type,
        limit: query.limit,
      });
      res.json(jsonResult({ notifications: notifications.map(toNotificationJson) }));
    }),
  );

  router.get(
    '/unread-count',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ count: await unreadNotificationCount(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/read',
    asyncRoute(async (req, res) => {
      const { withIdempotency, idempotencyKeyFrom } = await import('../idempotency/route.js');
      const result = await withIdempotency({
        op: 'notifications.markRead',
        key: idempotencyKeyFrom(req),
        userId: req.ctx.user!.id,
        payload: {},
        run: async () => {
          const updated = await markAllNotificationsRead(req.ctx.user!.id);
          return { ok: true, updated };
        },
      });
      res.json(jsonResult(result.response));
    }),
  );

  router.get(
    '/preferences',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ prefs: await getNotificationPreferences(req.ctx.user!.id) }));
    }),
  );

  router.put(
    '/preferences',
    asyncRoute(async (req, res) => {
      const input = notificationPreferencesSchema.parse(req.body);
      if (Object.keys(input).length === 0) {
        throw AppError.badRequest('empty_update', 'Nothing to update');
      }
      res.json(jsonResult({ prefs: await updateNotificationPreferences(req.ctx.user!.id, input) }));
    }),
  );

  router.post(
    '/:id/read',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ notification: toNotificationJson(await markNotificationRead(req.ctx.user!.id, req.params.id!)) }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await deleteNotification(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/while-you-were-away',
    asyncRoute(async (req, res) => {
      const sinceMs = Number(req.query.since ?? Date.now() - 24 * 60 * 60 * 1000);
      if (!Number.isFinite(sinceMs) || sinceMs <= 0) throw AppError.badRequest('invalid_since', 'since must be a timestamp');
      res.json(jsonResult(await returnToWorkSummary(req.ctx.user!.id, sinceMs)));
    }),
  );

  return router;
};