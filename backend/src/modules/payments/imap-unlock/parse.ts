/**
 * CodeConClave — IMAP auto-unlock: Razorpay payment-email parsing.
 *
 * Pure, deterministic normalization of merchant-mailbox Razorpay payment
 * notifications into STAGE 26H EvidenceSignals. Same trust contract as the
 * existing Gmail evidence rail:
 *   - the message MUST prove Razorpay origin (From domain razorpay.com AND
 *     dkim/spf/dmarc pass for that domain in Authentication-Results);
 *   - only normalized signals are produced (amount, payment id, reference,
 *     payer email, UTR, paid-at). Message bodies are never stored.
 * The matcher + activation pipeline (NOT this module) decide activation.
 */
import type { EvidenceSignals } from '../evidence.js';

export const RAZORPAY_SENDER_DOMAIN = 'razorpay.com';

/** Minimal mail shape (mailparser ParsedMail subset) this parser depends on. */
export interface ParsedPaymentMail {
  uid?: number;
  subject: string | null;
  from: string | null;
  date: Date | null;
  text: string | null;
  html: string | null;
  /** Every Authentication-Results header value (joined), lowercased. */
  authResults: string | null;
}

/**
 * Authenticated-origin gate for IMAP-fetched mail — mirrors
 * evidence.isAuthenticRazorpayMail with the same semantics: the From domain
 * must be razorpay.com AND at least one of dkim/spf/dmarc must PASS naming
 * that domain. A message without Authentication-Results is rejected.
 */
export function isAuthenticRazorpayOrigin(mail: ParsedPaymentMail): boolean {
  const from = (mail.from ?? '').toLowerCase();
  const fromDomain = (from.match(/@([a-z0-9.-]+\.[a-z]{2,})\b/)?.[1] ?? '');
  if (fromDomain !== RAZORPAY_SENDER_DOMAIN) return false;

  const auth = (mail.authResults ?? '').toLowerCase();
  if (!auth) return false;
  const dkimPass =
    auth.includes('dkim=pass') &&
    (auth.includes(`header.d=${RAZORPAY_SENDER_DOMAIN}`) || auth.includes(`d=${RAZORPAY_SENDER_DOMAIN}`));
  const spfPass = auth.includes('spf=pass') && auth.includes(RAZORPAY_SENDER_DOMAIN);
  const dmarcPass = auth.includes('dmarc=pass') && auth.includes(RAZORPAY_SENDER_DOMAIN);
  return dkimPass || spfPass || dmarcPass;
}

/** Subjects that must never be read as a successful payment. */
const NEGATIVE_SUBJECT = /refund|failed|cancel|expired|reversed|dispute|chargeback/i;

/**
 * A mail is a candidate payment notification only when it carries both a
 * provider payment id (pay_...) and a parseable INR amount. Subject
 * keywords are never the acceptance test (templates change); the pay_ id +
 * amount pair is the stable core of every Razorpay "payment received"
 * notification.
 */
export function looksLikePaymentConfirmation(mail: ParsedPaymentMail): boolean {
  if (mail.subject && NEGATIVE_SUBJECT.test(mail.subject)) return false;
  const body = mailText(mail);
  if (!body) return false;
  return /\bpay_[A-Za-z0-9_]{8,}\b/.test(body) && extractAmountInr(body) !== null;
}

/** Subject + text + tag-stripped html as one lowercase-normalized search corpus. */
export function mailText(mail: ParsedPaymentMail): string {
  const parts: string[] = [];
  if (mail.subject) parts.push(mail.subject);
  if (mail.text) parts.push(mail.text);
  if (mail.html) {
    parts.push(
      mail.html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#x27;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"'),
    );
  }
  return parts.join('\n');
}

function extractAmountInr(text: string): number | null {
  const match =
    text.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/)?.[1] ??
    text.match(/INR\s?([\d,]+(?:\.\d{1,2})?)/i)?.[1] ??
    text.match(/(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  if (!match) return null;
  const n = Number(match.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalize one mail into EvidenceSignals (or null when it is not a payment
 * confirmation). The email Date header is the paid-at proxy (received time
 * of the provider notification).
 */
export function parsePaymentMail(mail: ParsedPaymentMail): EvidenceSignals | null {
  if (!isAuthenticRazorpayOrigin(mail)) return null;
  if (!looksLikePaymentConfirmation(mail)) return null;

  const body = mailText(mail);
  const signals: EvidenceSignals = {
    amountInr: extractAmountInr(body),
    paymentId: body.match(/\bpay_[A-Za-z0-9_]{8,}\b/)?.[0] ?? null,
    paidAt: mail.date ?? null,
  };

  // Reference: the server-issued correlation anchor. Pool links created in
  // the Razorpay dashboard carry their Reference Id into every notification;
  // the historical CCPRO/CCTEAM scheme is matched too.
  const ref =
    body.match(/\bCC(?:PRO|TEAM)-[A-Z0-9]{6}\b/)?.[0] ??
    body.match(/\bCCPOOL-[A-Z0-9]+\b/i)?.[0]?.toUpperCase() ??
    body.match(/\breference\s*(?:id|no|number)?\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9_-]{4,63})\b/i)?.[1] ??
    null;
  if (ref) signals.reference = ref;

  // Payer email: prefer the labeled customer field, fall back to the first
  // email in the corpus that is NOT a razorpay.com address.
  const labeled = body.match(
    /(?:customer|payer|buyer|billing|contact|to)\s*(?:email)?\s*[:\-]\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
  )?.[1];
  const anyEmail = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const payer = (labeled ?? anyEmail?.[0] ?? '').toLowerCase();
  signals.payerEmail = payer && !payer.endsWith(`@${RAZORPAY_SENDER_DOMAIN}`) ? payer : null;

  // UTR only when explicitly labeled (an unlabeled 12-digit number is too
  // collision-prone to be a signal).
  const utr = body.match(/(?:utr|upi\s*ref(?:erence)?(?:\s*(?:no|number))?)\s*[:#-]?\s*(\d{9,22})\b/i)?.[1];
  if (utr) signals.utr = utr;

  return signals.amountInr !== null && signals.paymentId ? signals : null;
}
