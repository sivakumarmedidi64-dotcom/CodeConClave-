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
        : 'RAZORPAY_WEBHOOK_SECRET is not configured (webhook mode off)',
    },
  };
}

export function apiDetectorAvailable(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export function webhookDetectorAvailable(): boolean {
  return Boolean(env.RAZORPAY_WEBHOOK_SECRET) && env.RAZORPAY_MODE === 'webhook';
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

export type EvidenceSource26H = 'gmail' | 'ocr' | 'razorpay_api' | 'razorpay_webhook' | 'manual';

export const EVIDENCE_SOURCES_26H: EvidenceSource26H[] = ['gmail', 'ocr', 'razorpay_api', 'razorpay_webhook', 'manual'];

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
 */
function gmailSource(): PaymentEvidenceSource {
  const configured = () =>
    Boolean(env.GMAIL_OAUTH_ACCESS_TOKEN) ||
    Boolean(env.GMAIL_OAUTH_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return {
    id: 'gmail',
    label: 'Gmail (OAuth)',
    available: configured,
    unavailableReason: () =>
      configured()
        ? null
        : 'GMAIL_OAUTH_ACCESS_TOKEN (or refresh token + GOOGLE_CLIENT_ID/SECRET) not configured',
    collect: async (reference: string): Promise<EvidenceSignals[]> => {
      if (!configured()) {
        throw AppError.conflict('evidence_source_blocked', 'Gmail evidence source is not configured');
      }
      const token = env.GMAIL_OAUTH_ACCESS_TOKEN ?? '';
      const query = `subject:"CodeConClave" ${reference}`;
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw AppError.conflict('gmail_fetch_failed', `Gmail API returned ${response.status}`);
      }
      const body = (await response.json()) as { messages?: Array<{ id: string }> };
      if (!body.messages || body.messages.length === 0) return [];
      const signals: EvidenceSignals[] = [];
      for (const msg of body.messages.slice(0, 3)) {
        const detail = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!detail.ok) continue;
        const meta = (await detail.json()) as { payload?: { headers?: Array<{ name: string; value: string }> } };
        const headers = Object.fromEntries((meta.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
        const subject = headers.subject ?? '';
        const ref = subject.match(/\bCC(PRO|TEAM)-[A-Z0-9]{6}\b/)?.[0];
        if (!ref) continue;
        const amount = subject.match(/₹\s?([\d,]+)/)?.[1] ?? subject.match(/INR\s?([\d,]+)/i)?.[1];
        const paymentId = subject.match(/\bpay_[A-Za-z0-9_]+\b/)?.[0];
        const payer = headers.from ? (headers.from.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? null) : null;
        signals.push({
          reference: ref,
          amountInr: amount ? Number(amount.replace(/,/g, '')) : null,
          payerEmail: payer,
          paidAt: headers.date ? new Date(headers.date).toISOString() : null,
          paymentId: paymentId ?? null,
        });
      }
      return signals;
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
        : 'RAZORPAY_WEBHOOK_SECRET is not configured (webhook mode off)',
    collect: (_reference: string, payload: unknown): EvidenceSignals[] => {
      const event = payload as { event?: string; payload?: { payment?: { entity?: { id?: string; amount?: number; email?: string; created_at?: number; notes?: Record<string, string> } } } };
      const entity = event.payload?.payment?.entity;
      if (!entity?.id) return [];
      const ref = entity.notes?.reference ?? null;
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

/** Registry of every registered PaymentEvidenceSource (server-derived availability). */
export function evidenceSources26H(): PaymentEvidenceSource[] {
  return [
    gmailSource(),
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