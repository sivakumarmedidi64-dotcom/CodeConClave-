/**
 * CodeConClave — user routing preferences (Model Routing 2026).
 *
 * Stored in the existing `user_preferences` JSONB under a scoped key so routing
 * settings never collide with other workspace preferences. Server-authoritative:
 * the server validates RoutingPreference values and always re-validates the
 * requested model against availability/health/capability/entitlement at routing
 * time (a stale/invalid choice is ignored, never silently downgraded on a
 * sensitive task).
 */
import { RoutingPreference, type RoutingPreference as RoutingPreferenceType } from '@codeconclave/shared';
import { AppError } from '../../shared/errors.js';import { getPreferences, updatePreferences } from '../workspace/service.js';

export const ROUTING_PREFS_KEY = 'aiRouting';

export interface RoutingPreferences {
  routingPreference: RoutingPreferenceType;
  preferredModelId: string | null;
}

export const DEFAULT_ROUTING_PREFERENCES: RoutingPreferences = {
  routingPreference: RoutingPreference.AUTO,
  preferredModelId: null,
};

/** Valid RoutingPreference values (server-validated, never client-invented). */
export const ROUTING_PREFERENCE_VALUES: RoutingPreferenceType[] = [
  RoutingPreference.AUTO,
  RoutingPreference.QUALITY,
  RoutingPreference.BALANCED,
  RoutingPreference.FAST,
  RoutingPreference.COST_SAVER,
];

export function isRoutingPreferenceValue(v: unknown): v is RoutingPreferenceType {
  return typeof v === 'string' && (ROUTING_PREFERENCE_VALUES as string[]).includes(v);
}

/** Load and sanitize a user's routing preferences (never throws for bad stored data). */
export async function loadRoutingPreferences(userId: string): Promise<RoutingPreferences> {
  const prefs = await getPreferences(userId);
  const block = (prefs[ROUTING_PREFS_KEY] ?? {}) as Partial<RoutingPreferences>;
  const routingPreference =
    block.routingPreference !== undefined && isRoutingPreferenceValue(block.routingPreference)
      ? block.routingPreference
      : DEFAULT_ROUTING_PREFERENCES.routingPreference;
  const preferredModelId =
    typeof block.preferredModelId === 'string' && block.preferredModelId.trim().length > 0
      ? block.preferredModelId.trim()
      : null;
  return { routingPreference, preferredModelId };
}

/** Persist (merge) routing preferences. Optional preferred model is nullable. */
export async function saveRoutingPreferences(
  userId: string,
  patch: { routingPreference?: unknown; preferredModelId?: unknown },
  baseVersion?: number,
): Promise<RoutingPreferences> {
  const current = await loadRoutingPreferences(userId);

  let routingPreference = current.routingPreference;
  if (patch.routingPreference !== undefined) {
    if (!isRoutingPreferenceValue(patch.routingPreference)) {
      throw AppError.badRequest('invalid_routing_preference', 'Unsupported routing preference.');
    }
    routingPreference = patch.routingPreference;
  }

  let preferredModelId = current.preferredModelId;
  if (patch.preferredModelId !== undefined) {
    if (patch.preferredModelId === null || patch.preferredModelId === '') {
      preferredModelId = null;
    } else if (typeof patch.preferredModelId === 'string') {
      preferredModelId = patch.preferredModelId.trim();
    } else {
      throw AppError.badRequest('invalid_preferred_model', 'Invalid preferred model id.');
    }
  }

  const next: RoutingPreferences = { routingPreference, preferredModelId };
  await updatePreferences(userId, { [ROUTING_PREFS_KEY]: next }, baseVersion);
  return next;
}
