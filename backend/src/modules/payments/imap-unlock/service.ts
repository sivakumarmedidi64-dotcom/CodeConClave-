/**
 * CodeConClave — IMAP auto-unlock service (NO-API / NO-WEBHOOK payment rail).
 *
 * The zero-credential auto-activation story for deployments that only have
 * static Razorpay Payment Links (no KEY_ID/KEY_SECRET, no webhook secret):
 *
 *   1. The merchant's payment-account mailbox (GMAIL_USER, already configured
 *      for transactional email) receives Razorpay "payment received"
 *      notifications for every link payment.
 *   2. This poller fetches UNSEEN razorpay.com mail over IMAP, proves the
 *      message origin (From razorpay.com + dkim/spf/dmarc pass), and
 *      normalizes the payment signals (amount, payment id, reference, payer,
 *      paid-at).
 *   3. Correlation (server-authoritative, in this order):
 *        a. parsed REFERENCE  -> exact PENDING/REVIEW intent (pool-link rail;
 *           full matcher score up to 1.00 -> AUTO-ACTIVE through activation.ts)
 *        b. amount + window + unique payer-email match -> single-candidate
 *           PENDING intent (reference-less shared-link rail; matcher tops out
 *           below the active threshold -> lands in REVIEW for founder
 *           one-click approval, never silently auto-activates)
 *        c. ambiguous/zero candidates -> audited, left untouched
 *   4. Correlated evidence is ingested through pipeline.ingestEvidence with
 *      the TRUSTED 'gmail_imap' source so dedupe, replay guard, fraud checks,
 *      matcher and exactly-once activation all apply unchanged.
 *
 * This module never grants entitlements directly and never weakens a
 * threshold: an activation only ever happens inside the existing pipeline.
 */
import { withSystem, pool, queryOne } from '../../../shared/db.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../shared/logger.js';
import { recordAudit } from '../../audit/service.js';
import { ingestEvidence } from '../pipeline.js';
import { parsePaymentMail, type ParsedPaymentMail } from './parse.js';
import { imapTransport, imapCredentialsConfigured, type MailboxTransport } from './mailbox.js';

export interface PollOutcome {
  mailUid: number | null;
  correlation: 'reference' | 'unique_candidate' | 'ambiguous' | 'unmatched' | 'not_payment' | 'untrusted_origin';
  intentId: string | null;
  ownerId: string | null;
  source: string;
  status: string | null;
  confidence: number | null;
  decision: string | null;
  detail: string;
}

export interface PollReport {
  polledAt: string;
  fetched: number;
  processed: number;
  outcomes: PollOutcome[];
  error: string | null;
}

/** Status for the founder dashboard / capability endpoint. */
export function imapUnlockStatus(): {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  pollSeconds: number;
  lookbackDays: number;
  mailboxUser: string | null;
} {
  const enabled = env.PAYMENT_IMAP_UNLOCK_ENABLED === 'true';
  const configured = imapCredentialsConfigured();
  return {
    enabled,
    configured,
    reason: !enabled
      ? 'PAYMENT_IMAP_UNLOCK_ENABLED is not true'
      : configured
        ? null
        : 'GMAIL_USER + GMAIL_APP_PASSWORD are required for the mailbox rail',
    pollSeconds: env.PAYMENT_IMAP_POLL_SECONDS,
    lookbackDays: env.PAYMENT_IMAP_LOOKBACK_DAYS,
    // Mailbox identity is not a secret (it is the deployment's own sending
    // address) but is only surfaced to admins via the founder-gated route.
    mailboxUser: enabled && configured ? env.GMAIL_USER! : null,
  };
}

interface IntentCandidate {
  id: string;
  owner_id: string;
  plan_id: string;
  amount_inr: number;
  reference: string;
  status: string;
  created_at: Date;
  owner_email: string | null;
}

/** Exact reference -> most recent matchable intent (any owner). */
async function findIntentByReference(reference: string): Promise<IntentCandidate | null> {
  return withSystem<IntentCandidate | null>(async (q) =>
    (await q.query<IntentCandidate>(
      `SELECT i.id, i.owner_id, i.plan_id, i.amount_inr, i.reference, i.status, i.created_at, u.email AS owner_email
       FROM payment_intents i LEFT JOIN users u ON u.id = i.owner_id
      WHERE i.reference = $1 AND i.status IN ('PENDING','REVIEW')
      ORDER BY i.created_at DESC
      LIMIT 1`,
      [reference],
    )).rows[0] ?? null,
  );
}

/**
 * Reference-less correlation: PENDING/REVIEW intents with the exact amount,
 * created before the payment, still unexpired. Optionally narrowed to the
 * unique intent whose owner email matches the payer email.
 */
async function findCandidatesBySignals(amountInr: number, paidAt: Date, payerEmail: string | null): Promise<IntentCandidate[]> {
  const rows = await pool.query<IntentCandidate>(
    `SELECT i.id, i.owner_id, i.plan_id, i.amount_inr, i.reference, i.status, i.created_at, u.email AS owner_email
       FROM payment_intents i LEFT JOIN users u ON u.id = i.owner_id
      WHERE i.amount_inr = $1
        AND i.status IN ('PENDING','REVIEW')
        AND i.created_at <= $2
        AND i.expires_at >= $2
      ORDER BY i.created_at DESC
      LIMIT 50`,
    [amountInr, paidAt],
  );
  const candidates = rows.rows ?? [];
  if (payerEmail) {
    const emailMatches = candidates.filter((c) => (c.owner_email ?? '').toLowerCase() === payerEmail.toLowerCase());
    if (emailMatches.length > 0) return emailMatches;
  }
  return candidates;
}

/** Ingest one mail for one intent through the existing trusted pipeline. */
async function ingestForIntent(
  mail: ParsedPaymentMail,
  intent: IntentCandidate,
): Promise<PollOutcome> {
  const result = await ingestEvidence(intent.owner_id, intent.id, 'gmail_imap', {
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    date: mail.date,
    authResults: mail.authResults,
  });
  return {
    mailUid: mail.uid ?? null,
    correlation: 'reference',
    intentId: intent.id,
    ownerId: intent.owner_id,
    source: 'gmail_imap',
    status: result.result?.intentStatus ?? null,
    confidence: result.result?.confidence ?? null,
    decision: result.result?.decision ?? null,
    detail: `ingested for intent ${intent.id} (${intent.plan_id})`,
  };
}

async function auditSkip(mail: ParsedPaymentMail, outcome: PollOutcome): Promise<void> {
  await recordAudit({
    action: 'payment.imap_unlock_skipped',
    actorUserId: null,
    scope: 'SYSTEM',
    resourceType: 'payment_intent',
    resourceId: outcome.intentId,
    detail: {
      correlation: outcome.correlation,
      detail: outcome.detail,
      paymentId: null,
      subject: (mail.subject ?? '').slice(0, 120),
    },
  });
}

/**
 * Correlate one parsed mail to AT MOST ONE intent and push its evidence
 * through the trusted pipeline. Order: exact reference (auto-active rail),
 * then unique amount+window+payer candidate (review rail).
 */
export async function correlateMail(
  mail: ParsedPaymentMail,
  transport: MailboxTransport | null,
): Promise<PollOutcome> {
  const signals = parsePaymentMail(mail);
  if (!signals) {
    const outcome: PollOutcome = {
      mailUid: mail.uid ?? null,
      correlation: 'not_payment',
      intentId: null,
      ownerId: null,
      source: 'gmail_imap',
      status: null,
      confidence: null,
      decision: null,
      detail: 'not a Razorpay payment confirmation (or untrusted origin)',
    };
    return outcome;
  }

  // (a) exact reference — the pool-link AUTO-ACTIVE rail.
  if (signals.reference) {
    const intent = await findIntentByReference(signals.reference);
    if (intent) {
      return ingestForIntent(mail, { ...intent, reference: signals.reference });
    }
    const unmatched: PollOutcome = {
      mailUid: mail.uid ?? null,
      correlation: 'unmatched',
      intentId: null,
      ownerId: null,
      source: 'gmail_imap',
      status: null,
      confidence: null,
      decision: null,
      detail: `reference ${signals.reference} has no PENDING/REVIEW intent`,
    };
    await auditSkip(mail, unmatched);
    return unmatched;
  }

  // (b) reference-less: amount + window candidates, narrowed by payer email.
  if (typeof signals.amountInr === 'number' && signals.paidAt) {
    const candidates = await findCandidatesBySignals(signals.amountInr, new Date(signals.paidAt), signals.payerEmail ?? null);
    if (candidates.length === 1) {
      const intent = candidates[0]!;
      return ingestForIntent(mail, intent);
    }
    const outcome: PollOutcome = {
      mailUid: mail.uid ?? null,
      correlation: candidates.length > 1 ? 'ambiguous' : 'unmatched',
      intentId: null,
      ownerId: null,
      source: 'gmail_imap',
      status: null,
      confidence: null,
      decision: null,
      detail:
        candidates.length > 1
          ? `${candidates.length} candidate intents share this amount/window — refusing to guess`
          : 'no candidate intent for this amount/window',
    };
    await auditSkip(mail, outcome);
    return outcome;
  }

  const outcome: PollOutcome = {
    mailUid: mail.uid ?? null,
    correlation: 'unmatched',
    intentId: null,
    ownerId: null,
    source: 'gmail_imap',
    status: null,
    confidence: null,
    decision: null,
    detail: 'payment mail carried neither a reference nor a usable amount/date',
  };
  await auditSkip(mail, outcome);
  return outcome;
}

/** Run one mailbox sweep. Never throws: failures are captured in the report. */
export async function pollMailbox(transport?: MailboxTransport): Promise<PollReport> {
  const report: PollReport = {
    polledAt: new Date().toISOString(),
    fetched: 0,
    processed: 0,
    outcomes: [],
    error: null,
  };
  const t = transport ?? imapTransport();
  if (!t) {
    report.error = 'mailbox transport unavailable (disabled or credentials missing)';
    return report;
  }
  try {
    const since = new Date(Date.now() - env.PAYMENT_IMAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const mails = await t.fetchUnseen(since);
    report.fetched = mails.length;

    const seenUids: number[] = [];
    for (const mail of mails) {
      try {
        const outcome = await correlateMail(mail, t);
        report.outcomes.push(outcome);
        report.processed += 1;
        if (mail.uid !== undefined) seenUids.push(mail.uid);
        if (outcome.decision === 'ACTIVE') {
          logger.info('imap unlock activated entitlement', { intentId: outcome.intentId, confidence: outcome.confidence });
        }
      } catch (err) {
        report.outcomes.push({
          mailUid: mail.uid ?? null,
          correlation: 'unmatched',
          intentId: null,
          ownerId: null,
          source: 'gmail_imap',
          status: null,
          confidence: null,
          decision: null,
          detail: `pipeline error: ${(err as Error).message}`,
        });
      }
    }
    // Mark processed messages seen so the next sweep only sees new mail. Even
    // skipped messages are marked: a payment email never becomes more
    // correlatable later, and the audit trail already recorded the skip.
    if (seenUids.length > 0) {
      await t.markSeen(seenUids).catch((err: Error) =>
        logger.warn('imap unlock markSeen failed', { error: err.message }),
      );
    }
  } catch (err) {
    report.error = (err as Error).message;
    logger.warn('imap unlock poll failed', { error: report.error });
  }
  return report;
}

let loopTimer: ReturnType<typeof setInterval> | null = null;

/** Server-lifetime poll loop. No-op unless the rail is enabled and configured. */
export function startImapUnlockLoop(): void {
  if (loopTimer) return;
  const status = imapUnlockStatus();
  if (!status.enabled || !status.configured) {
    logger.info('imap unlock rail idle', { enabled: status.enabled, configured: status.configured });
    return;
  }
  loopTimer = setInterval(() => {
    void pollMailbox();
  }, env.PAYMENT_IMAP_POLL_SECONDS * 1000);
  loopTimer.unref();
  logger.info('imap unlock rail started', { pollSeconds: env.PAYMENT_IMAP_POLL_SECONDS });
}

export function stopImapUnlockLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}
