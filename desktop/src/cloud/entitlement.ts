/**
 * CodeConClave Desktop — entitlement read (cloud, READ-ONLY).
 * Customer payment/plan state ALWAYS comes from the canonical backend via the
 * SAME endpoint the web app's auth bootstrap uses (`GET /api/v1/auth/me`).
 * There is no desktop-specific activation path and nothing is ever written.
 * Mapping rules are honest:
 *   - 200 + user         → the server-authoritative plan/entitlement state
 *   - 401 (no session)   → anon/free
 *   - network failure    → online:false + entitlement UNKNOWN (never invented)
 */
import type { BackendClient } from './client.js';
import { BackendError, OfflineError } from './client.js';
import type { EntitlementRead } from '../types.js';

export interface MeUser {
  id?: string;
  planId?: string;
  entitlementState?: string;
}

export class EntitlementReader {
  constructor(private readonly client: BackendClient) {}

  async read(): Promise<EntitlementRead> {
    try {
      const { data } = await this.client.getJson<{ user?: MeUser }>('/api/v1/auth/me');
      const user = data?.user;
      if (!user) return { online: true, authed: false, planId: null, entitlementState: 'FREE' };
      const planId = normalizePlan(user.planId);
      const state = normalizeState(user.entitlementState);
      return { online: true, authed: true, planId, entitlementState: state };
    } catch (err) {
      if (err instanceof BackendError && err.status === 401) {
        return { online: true, authed: false, planId: null, entitlementState: 'FREE' };
      }
      if (err instanceof OfflineError) {
        return { online: false, authed: false, planId: null, entitlementState: 'UNKNOWN' };
      }
      // Unexpected backend errors still hold the truth: do not invent state.
      return { online: false, authed: false, planId: null, entitlementState: 'UNKNOWN' };
    }
  }
}

function normalizePlan(raw: string | undefined): EntitlementRead['planId'] {
  if (raw === 'pro' || raw === 'team' || raw === 'enterprise' || raw === 'free') return raw;
  return null;
}

function normalizeState(raw: string | undefined): EntitlementRead['entitlementState'] {
  switch (raw) {
    case 'FREE':
    case 'PRO_PENDING':
    case 'PRO_VERIFIED':
    case 'PRO_EXPIRED':
    case 'PRO_REFUNDED':
      return raw;
    default:
      return 'UNKNOWN';
  }
}