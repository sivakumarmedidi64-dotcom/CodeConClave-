/**
 * CodeConClave — scoped email triage + drafts (comms).
 *
 * What this is: deterministic triage of Gmail threads fetched through the
 * EXISTING plugin engine (`executePluginAction` → google adapter → OAuth),
 * plus reply-DRAFT construction. What this is NOT: autonomous sending.
 *
 * Sending is architecturally incapable of being silent here: the ONLY send
 * path is `requestSendDraft`, which delegates to `executePluginAction` for
 * `gmail.send`, and the engine + control policy force SEND-permission actions
 * through the approval flow (`plugin_policy_approval_required`). There is no
 * direct Gmail fetch in this module, no stored credential handling, and no
 * `autoSend` flag anywhere. Drafts are returned as data for the user (or an
 * approved task) to send — never sent by triage itself.
 *
 * Classification is rule-based and every verdict carries its reasons, so a
 * "draft candidate" is an explainable suggestion, never an autonomous decision
 * to speak as the user.
 */
import { AppError } from '../../shared/errors.js';

export type EmailVerdict = 'DRAFT_CANDIDATE' | 'NEEDS_REVIEW' | 'NOISE';

export interface EmailThread {
  id: string;
  from: string;
  subject: string;
  snippet: string;
}

export interface TriageDecision {
  thread: EmailThread;
  verdict: EmailVerdict;
  reasons: string[];
}

export interface ReplyDraft {
  to: string[];
  subject: string;
  bodyTemplate: string;
  sendPolicy: 'APPROVAL_REQUIRED';
  sourceThreadId: string;
}

export interface TriageSummary {
  decisions: TriageDecision[];
  counts: Record<EmailVerdict, number>;
}

const NOISE_FROM = /(no-?reply|donotreply|mailer-daemon|postmaster|notifications?@|newsletter@|noreply@)/i;
const UNSUBSCRIBE_HINT = /unsubscribe|view in browser|email preferences/i;
const SENSITIVE_HINT =
  /\b(invoice|payment|billing|password|security breach|legal|contract|salary|offer letter|termination|confidential|ssn|account number)\b/i;
const SCHEDULING_HINT = /\b(meeting|call|schedule|reschedule|calendar|invite|tomorrow|monday|tuesday|wednesday|thursday|friday|next week|\d{1,2}:\d{2})\b/i;
const QUESTION_HINT = /\?/;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic thread classification. Order matters (documented):
 * NOISE (machine mail) → NEEDS_REVIEW (sensitive/long/unknown w/ links) →
 * DRAFT_CANDIDATE (short direct question or scheduling ask) → NEEDS_REVIEW
 * (default: a human looks at anything we cannot explain).
 */
export function classifyThread(thread: EmailThread): TriageDecision {
  if (!thread.id || !thread.from) throw AppError.badRequest('invalid_thread', 'thread id and sender are required');
  const subject = thread.subject ?? '';
  const snippet = thread.snippet ?? '';
  const hay = `${subject}\n${snippet}`;
  const reasons: string[] = [];

  if (NOISE_FROM.test(thread.from) || UNSUBSCRIBE_HINT.test(hay)) {
    reasons.push('machine sender or bulk-mail markers');
    if (words(hay) < 5) reasons.push('no substantive content');
    return { thread, verdict: 'NOISE', reasons };
  }
  if (SENSITIVE_HINT.test(hay)) {
    reasons.push('sensitive topic (money/credentials/legal/employment) — human must decide');
    return { thread, verdict: 'NEEDS_REVIEW', reasons };
  }
  if (words(hay) > 120) {
    reasons.push('long thread — needs human reading, not a guessed reply');
    return { thread, verdict: 'NEEDS_REVIEW', reasons };
  }
  if (SCHEDULING_HINT.test(hay) && words(hay) <= 120) {
    reasons.push('scheduling ask — draftable, send still requires approval');
    return { thread, verdict: 'DRAFT_CANDIDATE', reasons };
  }
  if (QUESTION_HINT.test(hay) && words(hay) <= 60) {
    reasons.push('short direct question — draftable, send still requires approval');
    return { thread, verdict: 'DRAFT_CANDIDATE', reasons };
  }
  reasons.push('no explainable draft rule matched — default to human review');
  return { thread, verdict: 'NEEDS_REVIEW', reasons };
}

/** Pure triage over many threads (mirrors the zeroInbox digest pattern). */
export function triageInbox(threads: EmailThread[]): TriageSummary {
  if (!Array.isArray(threads)) throw AppError.badRequest('invalid_input', 'threads must be an array');
  if (threads.length > 100) throw AppError.badRequest('invalid_input', 'triage at most 100 threads per run');
  const decisions = threads.map(classifyThread);
  const counts: Record<EmailVerdict, number> = { DRAFT_CANDIDATE: 0, NEEDS_REVIEW: 0, NOISE: 0 };
  for (const d of decisions) counts[d.verdict] += 1;
  return { decisions, counts };
}

/**
 * Build a reply DRAFT (data only). The body is an explicit template with a
 * placeholder where the human/approved agent writes the actual answer — this
 * function never produces a "ready to fire" message on its own.
 */
export function buildReplyDraft(thread: EmailThread): ReplyDraft {
  if (!thread.id || !thread.from) throw AppError.badRequest('invalid_thread', 'thread id and sender are required');
  const subject = thread.subject?.startsWith('Re:') ? thread.subject : `Re: ${thread.subject ?? '(no subject)'}`;
  return {
    to: [thread.from],
    subject,
    bodyTemplate: `Hi,\n\n[Write the reply here — draft prepared by CodeConClave triage for thread "${thread.id}". Nothing has been sent.]\n\nThanks!`,
    sendPolicy: 'APPROVAL_REQUIRED',
    sourceThreadId: thread.id,
  };
}

export interface PluginEngine {
  (opts: { userId: string; connectionId: string; action: string; input: Record<string, unknown> }): Promise<{ ok: boolean; data: unknown }>;
}

async function defaultEngine(): Promise<PluginEngine> {
  const { executePluginAction } = await import('../plugins/engine.js');
  return (opts) => executePluginAction(opts);
}

interface GmailListRow {
  messages?: Array<{ id: string }>;
}

interface GmailMeta {
  payload?: { headers?: Array<{ name: string; value: string }> };
  snippet?: string;
}

function header(meta: GmailMeta, name: string): string {
  const headers = meta.payload?.headers ?? [];
  const found = headers.find((h) => h.name.toLowerCase() === name);
  return found ? String(found.value) : '';
}

/**
 * Fetch unread threads through the plugin engine (OAuth + scopes enforced
 * there). Returns normalized threads for `triageInbox`. Network only; no
 * sending capability is reachable from this function.
 */
export async function fetchUnreadThreads(
  userId: string,
  connectionId: string,
  opts: { query?: string; maxResults?: number } = {},
  engine: PluginEngine | null = null,
): Promise<EmailThread[]> {
  if (!userId || !connectionId) throw AppError.badRequest('invalid_input', 'userId and connectionId are required');
  const run = engine ?? (await defaultEngine());
  const max = Math.max(1, Math.min(opts.maxResults ?? 10, 25));
  const listed = await run({ userId, connectionId, action: 'gmail.messages.list', input: { query: opts.query ?? 'is:unread', maxResults: max } });
  const rows = ((listed.data as GmailListRow | null)?.messages ?? []).slice(0, max);
  const threads: EmailThread[] = [];
  for (const row of rows) {
    const got = await run({ userId, connectionId, action: 'gmail.messages.get', input: { id: row.id, format: 'metadata' } });
    const meta = (got.data ?? {}) as GmailMeta;
    threads.push({
      id: row.id,
      from: header(meta, 'from'),
      subject: header(meta, 'subject'),
      snippet: String(meta.snippet ?? ''),
    });
  }
  return threads;
}

/**
 * The ONLY send path: delegates to the plugin engine's `gmail.send`, which
 * applies OAuth scope checks AND the control-policy approval gate (SEND
 * permission → `plugin_policy_approval_required` unless an approval was
 * granted through the approvals flow). Calling this without a granted
 * approval throws instead of sending. There is deliberately no parameter to
 * bypass that.
 */
export async function requestSendDraft(
  userId: string,
  connectionId: string,
  draft: { to: string[]; subject: string; body: string; idempotencyKey?: string },
  engine: PluginEngine | null = null,
): Promise<unknown> {
  if (!userId || !connectionId) throw AppError.badRequest('invalid_input', 'userId and connectionId are required');
  if (!Array.isArray(draft.to) || draft.to.length === 0 || !draft.subject || !draft.body) {
    throw AppError.badRequest('invalid_draft', 'a complete draft (to, subject, body) is required to request sending');
  }
  const run = engine ?? (await defaultEngine());
  const outcome = await run({
    userId,
    connectionId,
    action: 'gmail.send',
    input: { to: draft.to, subject: draft.subject, body: draft.body, ...(draft.idempotencyKey ? { idempotencyKey: draft.idempotencyKey } : {}) },
  });
  return outcome.data;
}
