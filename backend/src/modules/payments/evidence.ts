/**
 * CodeConClave — payment evidence providers (Phase 4D).
 *
 * Capability detection is server-derived and honest: only evidence channels
 * that are actually configured are reported as available. Today only the
 * hosted Payment Link (Mode A) is active; the authenticated Razorpay API
 * (Mode B) and the signed webhook (Mode C) are DISABLED until real
 * credentials exist. Client-side claims (browser redirect, URL parameters,
 * screenshots, user-entered payment IDs, localStorage, polling) are NEVER
 * provider evidence — they cannot reach the verification path.
 */
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { incMetric } from '../../observability/metrics.js';
import { createHash } from 'node:crypto';
import { parsePaymentMail, type ParsedPaymentMail } from './imap-unlock/parse.js';

export interface EvidenceProviderStatus {
  enabled: boolean;
  reason: string | null;
}

export interface EvidenceProviders {
  link: EvidenceProviderStatus;
  api: EvidenceProviderStatus;
  webhook: EvidenceProviderStatus;
}

/** Honest capability detection: link is always available; API/webhook require real credentials. */
export function evidenceProviders(): EvidenceProviders {
  return {
    link: { enabled: true, reason: null },
    api: {
      enabled: apiDetectorAvailable(),
      reason: apiDetectorAvailable()
        ? null
        : 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both configured',
    },
    webhook: {
      enabled: webhookDetectorAvailable(),
      reason: webhookDetectorAvailable()
        ? null
        : 'RAZORPAY_WEBHOOK_SECRET is not configured or the webhook verification rail is disabled',
    },
  };
}

export function apiDetectorAvailable(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export function webhookDetectorAvailable(): boolean {
  return Boolean(env.RAZORPAY_WEBHOOK_SECRET) && env.RAZORPAY_WEBHOOK_ENABLED === 'true';
}

export type EvidenceSource = 'API' | 'WEBHOOK' | 'ADMIN';

export interface ProviderEvidence {
  source: EvidenceSource;
  provider_payment_id?: string;
  provider_order_id?: string;
  raw: unknown;
}

/**
 * Server-side validation of provider evidence. Rejects anything that is not
 * an independently verifiable provider record: client claims, screenshots,
 * URL parameters, user-entered payment IDs, malformed payloads.
 */
export function validateProviderEvidence(evidence: ProviderEvidence): void {
  if (!evidence || typeof evidence !== 'object') {
    incMetric('security.payment_spoof_attempts');
    throw AppError.badRequest('invalid_evidence', 'Evidence must be a provider record');
  }
  const source = evidence.source;
  if (source !== 'API' && source !== 'WEBHOOK' && source !== 'ADMIN') {
    incMetric('security.payment_spoof_attempts');
    throw AppError.badRequest(
      'invalid_evidence',
      'Evidence source must be API or WEBHOOK (client-side claims are never verifiable)',
    );
  }
  if (typeof evidence.raw !== 'object' || evidence.raw === null || Array.isArray(evidence.raw)) {
    incMetric('security.payment_spoof_attempts');
    throw AppError.badRequest('invalid_evidence', 'Evidence raw payload must be an object');
  }
  if (source === 'API' || source === 'WEBHOOK') {
    const pid = evidence.provider_payment_id;
    if (typeof pid !== 'string' || pid.trim().length === 0 || /\s/.test(pid)) {
      incMetric('security.payment_spoof_attempts');
      throw AppError.badRequest(
        'invalid_evidence',
        'Provider payment id is required and must be a single provider token',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// STAGE 26H — PaymentEvidenceSource adapter contract.
// Each source produces NORMALIZED signals (never raw screenshots/emails).
// A source's availability is server-derived and honest: unconfigured sources
// report unavailable with a reason and are never simulated. Screenshots/OCR
// are evidence inputs for the matcher — never authority.
// ---------------------------------------------------------------------------

export type EvidenceSource26H =
  | 'gmail'
  | 'gmail_imap'
  | 'ocr'
  | 'razorpay_api'
  | 'razorpay_webhook'
  | 'razorpay_callback'
  | 'razorpay_autopilot'
  | 'manual';

export const EVIDENCE_SOURCES_26H: EvidenceSource26H[] = ['gmail', 'gmail_imap', 'ocr', 'razorpay_api', 'razorpay_webhook', 'razorpay_callback', 'razorpay_autopilot', 'manual'];

export interface EvidenceSignals {
  reference?: string | null;
  amountInr?: number | null;
  payerEmail?: string | null;
  paidAt?: string | Date | null;
  paymentId?: string | null;
  utr?: string | null;
}

export interface PaymentEvidenceSource {
  id: EvidenceSource26H;
  label: string;
  available: () => boolean;
  unavailableReason: () => string | null;
  /** Fetch/parse normalized signals from the source for the given intent reference. */
  collect: (reference: string, payload: unknown) => Promise<EvidenceSignals[]> | EvidenceSignals[];
}

/** sha256 over the canonical JSON of a signal — replay/screenshot dedupe key. */
export function signalSha256(signals: EvidenceSignals): string {
  const canonical = JSON.stringify({
    reference: signals.reference ?? null,
    amountInr: signals.amountInr ?? null,
    payerEmail: signals.payerEmail ?? null,
    paidAt: signals.paidAt instanceof Date ? signals.paidAt.toISOString() : signals.paidAt ?? null,
    paymentId: signals.paymentId ?? null,
    utr: signals.utr ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * OCR fallback: pure text parsing of screenshot text into normalized signals.
 * The image-to-text OCR engine itself is an external integration (BLOCKED in
 * this env); parseOcrText stays deterministic and unit-testable. A parsed
 * UTR/amount/date/payment id is evidence for the matcher — a screenshot alone
 * can never activate anything.
 */
export function parseOcrText(text: string): EvidenceSignals {
  const out: EvidenceSignals = {};

  const paymentId = text.match(/\bpay_[A-Za-z0-9_]{6,}\b/)?.[0] ?? text.match(/\bpay_[A-Za-z0-9_]+\b/)?.[0];
  if (paymentId) out.paymentId = paymentId;

  const utr = text.match(/\b\d{12,16}\b/)?.[0];
  if (utr) out.utr = utr;

  const ref = text.match(/\bCC(PRO|TEAM)-[A-Z0-9]{6}\b/)?.[0];
  if (ref) out.reference = ref;

  const amountMatch =
    text.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/)?.[1] ??
    text.match(/INR\s?([\d,]+(?:\.\d{1,2})?)/i)?.[1] ??
    text.match(/(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  if (amountMatch) out.amountInr = Number(amountMatch.replace(/,/g, ''));

  const dateMatch =
    text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/)?.[0] ??
    text.match(/\b\d{1,2} [A-Z][a-z]{2} \d{4}\b/)?.[0];
  if (dateMatch) out.paidAt = dateMatch;

  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  if (email) out.payerEmail = email;

  return out;
}

/**
 * Gmail evidence rail. Only active when real Gmail OAuth credentials are
 * configured; searches for the user's payment confirmation referencing the
 * unique intent reference and extracts ONLY normalized signals (subject
 * fields, reference, amount, payer, payment id). Never stores message
 * contents. Unconfigured -> unavailable (BLOCKED, honest).
 *
 * Trust model: the mailbox is read server-side with real OAuth credentials,
 * and every candidate message must PASS authenticated origin verification
 * (email delivery authentication headers proving razorpay.com sent it:
 * dkim=pass / spf=pass / dmarc=pass + sender domain razorpay.com). A
 * message that fails origin authentication is NEVER treated as evidence —
 * an email address or subject alone is spoofable and never enough.
 *
 * Correlation: only messages that carry the EXACT server-issued intent
 * reference are released as signals. A reference-less receipt (e.g. from a
 * shared static Payment Link) cannot be attributed to a user by this
 * single-mailbox integration, so it is dropped (never auto-activates).
 */
export function gmailDetectorAvailable(): boolean {
  return (
    Boolean(env.GMAIL_OAUTH_ACCESS_TOKEN) ||
    Boolean(env.GMAIL_OAUTH_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  );
}

/** RFC-5322 header names are case-insensitive; join repeated headers. */
function headersOf(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = (payload as { payload?: { headers?: Array<{ name?: string; value?: string }> } }).payload?.headers ?? [];
  for (const h of headers) {
    const key = (h.name ?? '').toLowerCase();
    if (!key) continue;
    out[key] = out[key] ? `${out[key]} ${h.value ?? ''}` : (h.value ?? '');
  }
  return out;
}

/** Best-effort text extraction: subject first, then the text/plain body. */
function mailTextOf(payload: Record<string, unknown>): string {
  const headers = headersOf(payload);
  const subject = headers.subject ?? '';
  const body: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const part = node as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (typeof part.body?.data === 'string' && part.body.data.length > 0) {
      const raw = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
      let decoded = '';
      try {
        decoded = Buffer.from(raw, 'base64').toString('utf8');
      } catch {
        decoded = '';
      }
      if (decoded) body.push(decoded);
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(payload);
  return [subject, body.join('\n')].filter(Boolean).join('\n');
}

const RAZORPAY_SENDER_DOMAIN = 'razorpay.com';

/**
 * Authenticated-origin gate for payment receipt emails. Returns true ONLY
 * when the delivery authentication headers prove razorpay.com signed the
 * message AND the From/sender domain is razorpay.com. Spoofed "Razorpay"
 * messages (no pass, or pass for another domain) are rejected.
 */
export function isAuthenticRazorpayMail(payload: Record<string, unknown>): boolean {
  const headers = headersOf(payload);
  const from = headers.from ?? '';
  const fromDomain = (from.match(/@([A-Z0-9.-]+\.[A-Z]{2,})\b/i)?.[1] ?? '').toLowerCase();
  if (fromDomain !== RAZORPAY_SENDER_DOMAIN) return false;

  const auth = (headers['authentication-results'] ?? '').toLowerCase();
  const dkimPass =
    auth.includes('dkim=pass') &&
    (auth.includes(`header.d=${RAZORPAY_SENDER_DOMAIN}`) || auth.includes(`d=${RAZORPAY_SENDER_DOMAIN}`));
  const spfPass = auth.includes('spf=pass') && auth.includes(RAZORPAY_SENDER_DOMAIN);
  const dmarcPass = auth.includes('dmarc=pass') && auth.includes(RAZORPAY_SENDER_DOMAIN);
  return dkimPass || spfPass || dmarcPass;
}

function gmailSource(): PaymentEvidenceSource {
  return {
    id: 'gmail',
    label: 'Gmail (OAuth)',
    available: gmailDetectorAvailable,
    unavailableReason: () =>
      gmailDetectorAvailable()
        ? null
        : 'GMAIL_OAUTH_ACCESS_TOKEN (or refresh token + GOOGLE_CLIENT_ID/SECRET) not configured',
    collect: async (reference: string): Promise<EvidenceSignals[]> => {
      if (!gmailDetectorAvailable()) {
        throw AppError.conflict('evidence_source_blocked', 'Gmail evidence source is not configured');
      }
      const token = env.GMAIL_OAUTH_ACCESS_TOKEN ?? '';
      // Phase 1: the existing reference-subject search.
      // Phase 2: Razorpay payment confirmation receipts (authenticated origin,
      //          reference extracted from subject or body).
      const queries = [
        `subject:"CodeConClave" ${reference}`,
        `from:razorpay.com (subject:"Payment" OR subject:"successful" OR subject:"received" OR subject:"success")`,
      ];
      const signals: EvidenceSignals[] = [];
      for (const query of queries) {
        const response = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) {
          throw AppError.conflict('gmail_fetch_failed', `Gmail API returned ${response.status}`);
        }
        const body = (await response.json()) as { messages?: Array<{ id: string }> };
        for (const msg of (body.messages ?? []).slice(0, 20)) {
          try {
            const detail = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!detail.ok) continue;
            const full = (await detail.json()) as Record<string, unknown>;
            // Origin gate: never trust message text/address alone.
            if (!isAuthenticRazorpayMail(full)) continue;
            const text = mailTextOf(full);
            const ref =
              text.match(/\bCC(PRO|TEAM)-[A-Z0-9]{6}\b/)?.[0] ?? null;
            // STRICT binding: only the exact server-issued intent reference.
            if (!ref || ref !== reference) continue;
            const amount = text.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/)?.[1] ?? text.match(/INR\s?([\d,]+(?:\.\d{1,2})?)/i)?.[1] ?? null;
            const paymentId = text.match(/\bpay_[A-Za-z0-9_]{6,}\b/)?.[0] ?? null;
            const headers = headersOf(full);
            const payer = headers.from ? (headers.from.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? null) : null;
            // Filter Razorpay system emails (noreply@razorpay.com) — they are
            // sender addresses, not payer addresses. The IMAP parser already
            // does this; the Gmail source must too to avoid false sender_anomaly.
            const payerEmail = payer && !payer.toLowerCase().endsWith(`@${RAZORPAY_SENDER_DOMAIN}`) ? payer : null;
            const date = headers.date ? new Date(headers.date) : null;
            signals.push({
              reference: ref,
              amountInr: amount ? Number(amount.replace(/,/g, '')) : null,
              payerEmail: payerEmail,
              paidAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
              paymentId: paymentId ?? null,
            });
          } catch {
            continue;
          }
        }
      }
      return signals;
    },
  };
}

/**
 * Razorpay payment-link callback evidence (static-link pool rail, POLICY B).
 * The callback is a provider browser-redirect carrying Razorpay fields + a
 * signature. It is ONLY produced by the pool callback module AFTER the full
 * 16-point exactness validation (HMAC + link/index/reference/amount/currency/
 * plan/ownership/fraud) succeeds. As a TRUSTED provider rail it may reach
 * ACTIVE (unlike OCR/manual). Availability is config-gated by a pool key to
 * keep it honest: unconfigured -> unavailable.
 */
function razorpayCallbackSource(): PaymentEvidenceSource {
  return {
    id: 'razorpay_callback',
    label: 'Razorpay payment-link callback',
    available: () => Boolean(env.RAZORPAY_KEY_SECRET),
    unavailableReason: () =>
      Boolean(env.RAZORPAY_KEY_SECRET)
        ? null
        : 'RAZORPAY_KEY_SECRET is not configured for callback verification',
    collect: (intentReference: string, payload: unknown): EvidenceSignals[] => {
      const cb = (payload ?? {}) as {
        paymentId?: string | null;
        paymentLinkId?: string | null;
        referenceId?: string | null;
        linkStatus?: string | null;
        amountInr?: number | null;
      };
      if (!cb.paymentId) return [];
      // The callback module (pool/callback.ts) has ALREADY proven — via exact
      // link reference -> reservation -> intent binding plus plan/amount/
      // currency/ownership/fraud checks — that this payment belongs to THIS
      // intent. So the matcher anchor is the intent's own reference, passed in
      // as intentReference by ingestEvidence (NOT the static pool link's
      // reference, which is CC-pool-scoped and shared across users). Without
      // this, the reference anchor would never match and the rail could never
      // reach ACTIVE despite an exact, verified binding.
      return [
        {
          reference: intentReference,
          amountInr: typeof cb.amountInr === 'number' ? cb.amountInr : null,
          paidAt: new Date().toISOString(),
          paymentId: cb.paymentId,
        },
      ];
    },
  };
}

/** Razorpay API evidence (only when real API credentials exist). */
function razorpayApiSource(): PaymentEvidenceSource {
  return {
    id: 'razorpay_api',
    label: 'Razorpay API',
    available: () => apiDetectorAvailable(),
    unavailableReason: () =>
      apiDetectorAvailable()
        ? null
        : 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both configured',
    collect: async (reference: string): Promise<EvidenceSignals[]> => {
      if (!apiDetectorAvailable()) {
        throw AppError.conflict('evidence_source_blocked', 'Razorpay API evidence source is not configured');
      }
      const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const response = await fetch(
        `https://api.razorpay.com/v1/payments?count=50`,
        { headers: { Authorization: `Basic ${auth}` } },
      );
      if (!response.ok) {
        throw AppError.conflict('razorpay_api_failed', `Razorpay API returned ${response.status}`);
      }
      const body = (await response.json()) as { items?: Array<{ id?: string; amount?: number; email?: string; created_at?: number; notes?: Record<string, string> }> };
      const items = body.items ?? [];
      const hit = items.find((p) => p.notes?.reference === reference || p.notes?.session_id === reference);
      if (!hit) return [];
      return [
        {
          reference,
          amountInr: typeof hit.amount === 'number' ? Math.round(hit.amount / 100) : null,
          payerEmail: hit.email ?? null,
          paidAt: typeof hit.created_at === 'number' ? new Date(hit.created_at * 1000).toISOString() : null,
          paymentId: hit.id ?? null,
        },
      ];
    },
  };
}

/** Razorpay webhook evidence (push rail; only when the signed webhook is configured). */
function razorpayWebhookSource(): PaymentEvidenceSource {
  return {
    id: 'razorpay_webhook',
    label: 'Razorpay webhook',
    available: () => webhookDetectorAvailable(),
    unavailableReason: () =>
      webhookDetectorAvailable()
        ? null
        : 'RAZORPAY_WEBHOOK_SECRET is not configured or the webhook verification rail is disabled',
    collect: (_reference: string, payload: unknown): EvidenceSignals[] => {
      const event = payload as { event?: string; payload?: { payment?: { entity?: { id?: string; amount?: number; email?: string; created_at?: number; notes?: Record<string, string> } }; payment_link?: { entity?: { id?: string; reference_id?: string; notes?: Record<string, string> } } } };
      const entity = event.payload?.payment?.entity;
      if (!entity?.id) return [];
      // Trusted provider reference_id is the strong binding; fall back to notes
      // set on either the payment entity or the payment link entity.
      const linkEntity = event.payload?.payment_link?.entity;
      const ref = linkEntity?.reference_id ?? entity.notes?.reference ?? linkEntity?.notes?.reference ?? null;
      return [
        {
          reference: typeof ref === 'string' && ref.length > 0 ? ref : null,
          amountInr: typeof entity.amount === 'number' ? Math.round(entity.amount / 100) : null,
          payerEmail: entity.email ?? null,
          paidAt: typeof entity.created_at === 'number' ? new Date(entity.created_at * 1000).toISOString() : null,
          paymentId: entity.id,
        },
      ];
    },
  };
}

/**
 * Razorpay AUTOPILOT evidence (signed webhook rail under UNLOCK_MODE=AUTOPILOT).
 *
 * The autopilot webhook resolver (autopilot/service.ts) has ALREADY proven the
 * full condition set — HMAC signature, event idempotency, exact product binding
 * (payment_link.entity.id == the configured per-plan link ID, never the amount
 * alone), plan/amount/currency/ownership/fraud guards — and resolved the payment
 * to ONE unambiguous intent. So the matcher anchor is the intent's own reference,
 * passed in as intentReference by ingestEvidence (the same pattern the trusted
 * callback source uses). Without this, a static per-plan link payment could
 * never reach ACTIVE despite an exact, verified product binding.
 *
 * Availability is config-gated and honest: only when the webhook verification
 * rail is enabled (source availability). The effective UNLOCK_MODE gate lives
 * in the autopilot resolver (it may be a runtime DB override while the env
 * default is still MANUAL); ingest only ever receives autopilot evidence via
 * the resolver, so availability here checks the rail, not the mode.
 */
function razorpayAutopilotSource(): PaymentEvidenceSource {
  return {
    id: 'razorpay_autopilot',
    label: 'Razorpay autopilot webhook',
    available: () => webhookDetectorAvailable(),
    unavailableReason: () =>
      webhookDetectorAvailable()
        ? null
        : 'RAZORPAY_WEBHOOK_SECRET is not configured or the webhook verification rail is disabled',
    collect: (intentReference: string, payload: unknown): EvidenceSignals[] => {
      const ev = (payload ?? {}) as {
        paymentId?: string | null;
        amountInr?: number | null;
        payerEmail?: string | null;
        paidAt?: string | null;
      };
      if (!ev.paymentId) return [];
      return [
        {
          reference: intentReference,
          amountInr: typeof ev.amountInr === 'number' ? ev.amountInr : null,
          payerEmail: ev.payerEmail ?? null,
          paidAt: ev.paidAt ?? null,
          paymentId: ev.paymentId,
        },
      ];
    },
  };
}

/** Registry of every registered PaymentEvidenceSource (server-derived availability). */
export function evidenceSources26H(): PaymentEvidenceSource[] {
  return [
    gmailSource(),
    {
      id: 'gmail_imap',
      label: 'Merchant mailbox (IMAP, no-API)',
      available: () => env.PAYMENT_IMAP_UNLOCK_ENABLED === 'true' && Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD),
      unavailableReason: () =>
        env.PAYMENT_IMAP_UNLOCK_ENABLED !== 'true'
          ? 'PAYMENT_IMAP_UNLOCK_ENABLED is not true'
          : 'GMAIL_USER + GMAIL_APP_PASSWORD are not configured',
      // Collects from the poller-delivered raw mail (subject/text/html/date/
      // auth-results) using the SAME parser the poller used for correlation —
      // the pipeline always re-derives signals from the stored payload, so
      // what gets scored is exactly what was ingested.
      collect: (_reference: string, payload: unknown): EvidenceSignals[] => {
        const mail = payload as ParsedPaymentMail | null;
        if (!mail || typeof mail !== 'object') return [];
        const signals = parsePaymentMail(mail);
        return signals ? [signals] : [];
      },
    },
    {
      id: 'ocr',
      label: 'Screenshot OCR',
      available: () => true,
      unavailableReason: () => null,
      collect: (_reference: string, payload: unknown): EvidenceSignals[] => {
        const text = typeof payload === 'string' ? payload : (payload as { text?: string } | null)?.text ?? '';
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw AppError.badRequest('ocr_text_required', 'OCR evidence requires the extracted screenshot text');
        }
        const parsed = parseOcrText(text);
        return Object.keys(parsed).length > 0 ? [parsed] : [];
      },
    },
    razorpayApiSource(),
    razorpayWebhookSource(),
    razorpayCallbackSource(),
    razorpayAutopilotSource(),
    {
      id: 'manual',
      label: 'Manual entry',
      available: () => true,
      unavailableReason: () => null,
      collect: (_reference: string, payload: unknown): EvidenceSignals[] => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (typeof p !== 'object' || p === null) return [];
        const signals: EvidenceSignals = {};
        if (typeof p.paymentId === 'string' && p.paymentId.trim().length > 0) signals.paymentId = p.paymentId;
        if (typeof p.reference === 'string' && p.reference.trim().length > 0) signals.reference = p.reference;
        if (typeof p.amountInr === 'number') signals.amountInr = p.amountInr;
        if (typeof p.payerEmail === 'string' && p.payerEmail.trim().length > 0) signals.payerEmail = p.payerEmail;
        if (typeof p.paidAt === 'string' || p.paidAt instanceof Date) signals.paidAt = p.paidAt as string | Date;
        if (typeof p.utr === 'string' && p.utr.trim().length > 0) signals.utr = p.utr;
        return Object.keys(signals).length > 0 ? [signals] : [];
      },
    },
  ];
}

export function evidenceSource26H(id: string): PaymentEvidenceSource {
  const found = evidenceSources26H().find((s) => s.id === id);
  if (!found) throw AppError.badRequest('unknown_evidence_source', `Unknown evidence source ${id}`);
  return found;
}