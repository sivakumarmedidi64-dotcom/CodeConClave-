/**
 * CodeConClave — STAGE 26H: evidence ingestion pipeline.
 *
 * EVIDENCE SOURCE -> NORMALIZE -> DEDUPE -> FRAUD -> STORE -> MATCH -> APPLY.
 * Every step is server-authoritative: client-supplied values only enter the
 * pipeline as signals to be scored, never as facts. A screenshot/OCR text can
 * raise confidence but can never, by itself, activate a plan.
 */
import { withTenant } from '../../shared/db.js';
import { AppError, errorCodeOf } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { getIntent, type PaymentIntentRow } from './intents.js';
import { evidenceSource26H, signalSha256, type EvidenceSignals } from './evidence.js';
import { checkFraud, type FraudCheck } from './fraud.js';
import { scoreEvidence, type MatcherResult } from './matcher.js';
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
 * Trust boundary: only genuinely server/rail-authoritative sources may drive
 * an intent to ACTIVE. User-asserted sources (manual entry, uploaded OCR
 * screenshots) are evidence for review but can NEVER grant a paid entitlement.
 */
const TRUSTED_EVIDENCE_SOURCES = new Set(['gmail', 'gmail_imap', 'razorpay_api', 'razorpay_webhook', 'razorpay_callback', 'razorpay_autopilot']);

export function isTrustedEvidenceSource(sourceId: string): boolean {
  return TRUSTED_EVIDENCE_SOURCES.has(sourceId);
}

/**
 * Sources a user may submit through POST /intents/:id/evidence.
 * Server-driven sources (gmail / gmail_imap / razorpay_api / razorpay_webhook
 * / razorpay_callback / razorpay_autopilot) anchor the intent's own reference
 * or query provider systems — accepting them with a user-supplied payload
 * would let anyone self-assert a paid entitlement (the collect() functions
 * cannot distinguish a provider event from user JSON). Those sources are
 * ingested ONLY via their internal callers (webhook handler, pool callback,
 * autopilot sweep, IMAP poller, refresh). User-asserted sources can never
 * reach ACTIVE: effectiveMatch() forces them to REVIEW.
 */
const USER_ASSERTABLE_EVIDENCE_SOURCES = new Set(['ocr', 'manual']);

export function isUserAssertableEvidenceSource(sourceId: string): boolean {
  return USER_ASSERTABLE_EVIDENCE_SOURCES.has(sourceId);
}

/**
 * Ingestion decision gate: untrusted (user-asserted) sources are forced to
 * REVIEW regardless of confidence, so a fabricated manual assertion can never
 * become ACTIVE. Trusted sources may activate as normal.
 */
function effectiveMatch(
  match: MatcherResult,
  sourceId: string,
  fraud: FraudCheck,
): { match: MatcherResult; fraud: FraudCheck } {
  if (isTrustedEvidenceSource(sourceId)) return { match, fraud };
  const flags = [...fraud.flags];
  if (!flags.includes('manual_assertion_cannot_activate')) flags.push('manual_assertion_cannot_activate');
  return {
    match: { ...match, decision: 'REVIEW' },
    fraud: { flags, blocked: fraud.blocked },
  };
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
    const existing = await withTenant(userId, async (q) =>
      (await q.query<{ id: string }>(`SELECT id FROM payment_evidence WHERE sha256 = $1 AND intent_id IS DISTINCT FROM $2`, [sha, intent.id])).rows[0] ?? null,
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

    const prior = await withTenant(userId, async (q) =>
      (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment_evidence WHERE owner_id = $1`, [userId])).rows[0] ?? null,
    );
    const fraud = await checkFraud(userId, intent, signals, sha, prior?.n ?? 0);

    const id = newId(PREFIX.PAYMENT_EVIDENCE);
    const insertResult = await withTenant(userId, async (q) =>
      q.query(
        `INSERT INTO payment_evidence (id, intent_id, owner_id, source, provider_payment_id, utr, reference, amount_inr, payer_email, paid_at, sha256, signals, matched, fraud_flags, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)
         ON CONFLICT (sha256) DO NOTHING`,
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
      ),
    );

    // ON CONFLICT (sha256) DO NOTHING: PostgreSQL returns rowCount 0 when
    // the INSERT was deduplicated by the unique constraint. If so, skip
    // activation — a concurrent request already processed this evidence.
    // rowCount >= 1 means this request won the race and may proceed.
    if ((insertResult.rowCount ?? 0) === 0) {
      replayCount += 1;
      continue;
    }

    const match = scoreEvidence(intent, signals, userEmail);
    const { match: effective, fraud: effectiveFraud } = effectiveMatch(match, sourceId, fraud);
    const applied = await applyDecision(userId, intent, effective, effectiveFraud);
    matchedCount += 1;
    lastResult = {
      confidence: effective.confidence,
      decision: effective.decision,
      flags: [...effectiveFraud.flags, ...(applied.intent.fraud_flags ?? [])],
      intentStatus: applied.intent.status,
    };

    stored.push(await evidenceById(userId, id));
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

async function evidenceById(userId: string, id: string): Promise<EvidenceRecord> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<EvidenceRecord>('SELECT * FROM payment_evidence WHERE id = $1', [id])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('Evidence');
  return row;
}

export function listEvidenceForIntent(userId: string, intentId: string): Promise<EvidenceRecord[]> {
  return withTenant(userId, async (q) =>
    (await q.query<EvidenceRecord>(
      `SELECT e.* FROM payment_evidence e JOIN payment_intents i ON i.id = e.intent_id
        WHERE i.id = $1 AND i.owner_id = $2 ORDER BY e.created_at DESC`,
      [intentId, userId],
    )).rows,
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