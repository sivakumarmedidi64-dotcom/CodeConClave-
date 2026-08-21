/**
 * CodeConClave — STAGE 26H: evidence ingestion pipeline.
 *
 * EVIDENCE SOURCE -> NORMALIZE -> DEDUPE -> FRAUD -> STORE -> MATCH -> APPLY.
 * Every step is server-authoritative: client-supplied values only enter the
 * pipeline as signals to be scored, never as facts. A screenshot/OCR text can
 * raise confidence but can never, by itself, activate a plan.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError, errorCodeOf } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { getIntent, type PaymentIntentRow } from './intents.js';
import { evidenceSource26H, signalSha256, type EvidenceSignals } from './evidence.js';
import { checkFraud } from './fraud.js';
import { scoreEvidence } from './matcher.js';
import { applyDecision } from './activation.js';
import { getUserEmail } from './service.js';

export interface EvidenceRecord {
  id: string;
  intent_id: string | null;
  owner_id: string;
  source: string;
  provider_payment_id: string | null;
  utr: string | null;
  reference: string | null;
  amount_inr: number | null;
  payer_email: string | null;
  paid_at: Date | null;
  sha256: string;
  signals: Record<string, unknown>;
  matched: boolean;
  fraud_flags: string[] | null;
  created_at: Date;
}

export interface IngestResult {
  evidence: EvidenceRecord[];
  matched: number;
  replayed: number;
  result: {
    confidence: number;
    decision: string;
    flags: string[];
    intentStatus: string;
  } | null;
}

/**
 * Ingest evidence from a registered source for a user's intent.
 * Cross-tenant/cross-user safety is guaranteed by the intent owner check.
 */
export async function ingestEvidence(
  userId: string,
  intentId: string,
  sourceId: string,
  payload: unknown,
): Promise<IngestResult> {
  const source = evidenceSource26H(sourceId);
  if (!source.available()) {
    throw AppError.conflict('evidence_source_blocked', source.unavailableReason() ?? 'Source not configured');
  }
  const intent = await getIntent(userId, intentId);

  const collected = await source.collect(intent.reference, payload);
  if (!collected || collected.length === 0) {
    throw AppError.conflict('no_evidence', `No ${source.label} evidence matched the reference`);
  }

  const userEmail = await getUserEmail(userId);
  const stored: EvidenceRecord[] = [];
  const seenShas = new Set<string>();
  let matchedCount = 0;
  let replayCount = 0;
  let lastResult: IngestResult['result'] = null;

  for (const signals of collected) {
    if (!hasAnySignal(signals)) continue;
    const sha = signalSha256(signals);
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);

    // Replay guard: identical evidence already stored for another intent/owner.
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM payment_evidence WHERE sha256 = $1 AND intent_id IS DISTINCT FROM $2`,
      [sha, intent.id],
    );
    if (existing) {
      replayCount += 1;
      await recordAudit({
        action: 'payment.fraud_flagged',
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'payment_intent',
        resourceId: intent.id,
        detail: { flag: 'screenshot_replay', sha, existing: existing.id, source: sourceId },
      });
      continue;
    }

    const prior = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_evidence WHERE owner_id = $1`,
      [userId],
    );
    const fraud = await checkFraud(userId, intent, signals, sha, prior?.n ?? 0);

    const id = newId(PREFIX.PAYMENT_EVIDENCE);
    await pool.query(
      `INSERT INTO payment_evidence (id, intent_id, owner_id, source, provider_payment_id, utr, reference, amount_inr, payer_email, paid_at, sha256, signals, matched, fraud_flags, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)`,
      [
        id,
        intent.id,
        userId,
        sourceId,
        signals.paymentId ?? null,
        signals.utr ?? null,
        signals.reference ?? null,
        signals.amountInr ?? null,
        signals.payerEmail ?? null,
        signals.paidAt ? new Date(signals.paidAt) : null,
        sha,
        JSON.stringify(signals),
        false,
        JSON.stringify(fraud.flags),
        userId,
      ],
    );

    const match = scoreEvidence(intent, signals, userEmail);
    const applied = await applyDecision(userId, intent, match, fraud);
    matchedCount += 1;
    lastResult = {
      confidence: match.confidence,
      decision: match.decision,
      flags: [...fraud.flags, ...(applied.intent.fraud_flags ?? [])],
      intentStatus: applied.intent.status,
    };

    stored.push(await evidenceById(id));
  }

  if (stored.length === 0 && replayCount > 0) {
    return { evidence: [], matched: 0, replayed: replayCount, result: lastResult };
  }
  if (stored.length === 0) {
    throw AppError.conflict('no_evidence', 'No usable signals were extracted from the evidence');
  }

  return { evidence: stored, matched: matchedCount, replayed: replayCount, result: lastResult };
}

/** Refresh: pull from every available passive source (gmail / razorpay api). */
export async function refreshIntentEvidence(userId: string, intentId: string): Promise<IngestResult> {
  const intent = await getIntent(userId, intentId);
  const sources = ['gmail', 'razorpay_api'];
  const failures: string[] = [];
  let last: IngestResult | null = null;
  for (const sourceId of sources) {
    try {
      last = await ingestEvidence(userId, intentId, sourceId, undefined);
    } catch (err) {
      const code = errorCodeOf(err);
      if (code === 'evidence_source_blocked' || code === 'no_evidence') failures.push(sourceId);
      else throw err;
    }
  }
  if (!last) {
    throw AppError.conflict(
      'no_passive_evidence',
      failures.length > 0
        ? `No passive evidence sources available (${failures.join(', ')})`
        : 'No passive evidence matched',
    );
  }
  return last;
}

async function evidenceById(id: string): Promise<EvidenceRecord> {
  const row = await queryOne<EvidenceRecord>('SELECT * FROM payment_evidence WHERE id = $1', [id]);
  if (!row) throw AppError.notFound('Evidence');
  return row;
}

export function listEvidenceForIntent(userId: string, intentId: string): Promise<EvidenceRecord[]> {
  return queryMany<EvidenceRecord>(
    `SELECT e.* FROM payment_evidence e JOIN payment_intents i ON i.id = e.intent_id
      WHERE i.id = $1 AND i.owner_id = $2 ORDER BY e.created_at DESC`,
    [intentId, userId],
  );
}

function hasAnySignal(signals: EvidenceSignals): boolean {
  return Boolean(
    signals.reference ||
      signals.amountInr ||
      signals.payerEmail ||
      signals.paidAt ||
      signals.paymentId ||
      signals.utr,
  );
}