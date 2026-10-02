/**
 * CodeConClave — STAGE 26H: reconciliation.
 *
 * Detects drift between intents, evidence, entitlements and capture records.
 * Reconciliation REPORTS drift — it never auto-fixes anything. Every run is
 * persisted and audited; a run with drift is marked COMPLETED_WITH_DRIFT.
 */
import { withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

export interface DriftRow {
  type: string;
  ref: string;
  detail: string;
}

export interface ReconciliationRow {
  id: string;
  run_by: string | null;
  intents: number;
  evidence: number;
  entitlements: number;
  drift: DriftRow[];
  status: 'COMPLETED' | 'COMPLETED_WITH_DRIFT' | 'FAILED';
  created_at: Date;
}

export async function runReconciliation(runBy: string | null = null): Promise<ReconciliationRow> {
  const drift: DriftRow[] = [];

  const intents = await withSystem<Array<{ id: string; owner_id: string; plan_id: string; status: string }>>((db) =>
    db
      .query<{ id: string; owner_id: string; plan_id: string; status: string }>(
        `SELECT id, owner_id, plan_id, status FROM payment_intents WHERE status IN ('ACTIVE','GRACE')`,
      )
      .then((r) => r.rows),
  );
  for (const intent of intents) {
    const ent = await withSystem<Array<{ id: string }>>((db) =>
      db
        .query<{ id: string }>(
          `SELECT id FROM entitlements WHERE user_id = $1 AND plan_id = $2 AND state = 'PRO_VERIFIED'`,
          [intent.owner_id, intent.plan_id],
        )
        .then((r) => r.rows),
    );
    if (ent.length === 0) {
      drift.push({
        type: 'intent_without_entitlement',
        ref: intent.id,
        detail: `${intent.plan_id} intent is ${intent.status} but no PRO_VERIFIED entitlement exists`,
      });
    }
  }

  const entitlements = await withSystem<Array<{ id: string; user_id: string; plan_id: string; state: string }>>((db) =>
    db
      .query<{ id: string; user_id: string; plan_id: string; state: string }>(
        `SELECT id, user_id, plan_id, state FROM entitlements WHERE state = 'PRO_VERIFIED'`,
      )
      .then((r) => r.rows),
  );
  for (const ent of entitlements) {
    const [intentsHit, sessionsHit] = await withSystem<[Array<{ id: string }>, Array<{ id: string }>]>((db) =>
      Promise.all([
        db
          .query<{ id: string }>(
            `SELECT id FROM payment_intents WHERE owner_id = $1 AND plan_id = $2 AND status IN ('ACTIVE','GRACE')`,
            [ent.user_id, ent.plan_id],
          )
          .then((r) => r.rows),
        db
          .query<{ id: string }>(
            `SELECT id FROM payment_sessions WHERE user_id = $1 AND plan_id = $2 AND state = 'VERIFIED'`,
            [ent.user_id, ent.plan_id],
          )
          .then((r) => r.rows),
      ]),
    );
    if (intentsHit.length === 0 && sessionsHit.length === 0) {
      drift.push({
        type: 'entitlement_without_payment',
        ref: ent.id,
        detail: `${ent.plan_id} entitlement is PRO_VERIFIED but has no ACTIVE intent or VERIFIED session`,
      });
    }
  }

  const evidence = await withSystem<Array<{ id: string; intent_id: string | null; created_at: Date }>>((db) =>
    db
      .query<{ id: string; intent_id: string | null; created_at: Date }>(
        `SELECT id, intent_id, created_at FROM payment_evidence WHERE intent_id IS NULL`,
      )
      .then((r) => r.rows),
  );
  for (const ev of evidence) {
    drift.push({
      type: 'orphan_evidence',
      ref: ev.id,
      detail: 'evidence row is not linked to any payment intent',
    });
  }

  const id = newId(PREFIX.PAYMENT_RECONCILIATION);
  const status = drift.length > 0 ? 'COMPLETED_WITH_DRIFT' : 'COMPLETED';
  await withSystem((db) =>
    db.query(
      `INSERT INTO payment_reconciliations (id, run_by, intents, evidence, entitlements, drift, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, runBy, intents.length, evidence.length, entitlements.length, JSON.stringify(drift), status],
    ),
  );
  await recordAudit({
    action: 'payment.reconciled',
    actorUserId: runBy,
    scope: runBy ? 'USER' : 'SYSTEM',
    tenantId: runBy,
    resourceType: 'payment_reconciliation',
    resourceId: id,
    detail: { driftCount: drift.length, status },
  });

  const row = await withSystem<ReconciliationRow[]>((db) =>
    db.query<ReconciliationRow>(`SELECT * FROM payment_reconciliations WHERE id = $1`, [id]).then((r) => r.rows),
  );
  return row[0]!;
}

export async function listReconciliations(userId: string, limit = 20): Promise<ReconciliationRow[]> {
  return withSystem<ReconciliationRow[]>((db) =>
    db
      .query<ReconciliationRow>(
        `SELECT * FROM payment_reconciliations WHERE run_by = $1 OR run_by IS NULL ORDER BY created_at DESC LIMIT $2`,
        [userId, limit],
      )
      .then((r) => r.rows),
  );
}