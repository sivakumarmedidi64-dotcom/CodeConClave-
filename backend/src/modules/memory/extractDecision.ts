/**
 * CodeConClave — conservative decision extraction from chat (continuity).
 *
 * A decision is recorded ONLY when the user's own words carry a decision
 * signal. Ambiguity is never upgraded:
 *
 *   explicit commitment  ("we'll use X", "let's go with Y", "decided",
 *                         "we chose", "use X instead of Y", "switch to")
 *                         -> ACTIVE
 *   explicit override    ("actually … instead", "never mind", "switch to …") 
 *                         -> ACTIVE + supersedes the overlapping record
 *   tentative / request  ("maybe we should", "consider", "what about",
 *                         "can you change … to", any question) -> TENTATIVE
 *   anything else                                              -> no extract
 *
 * "Maybe we should use X" is NOT a decision: it yields TENTATIVE at most and a
 * TENTATIVE record never supersedes anything.
 *
 * Collisions are surfaced, never silently chosen: when a new ACTIVE decision
 * overlaps a live record without an explicit override signal, an OPEN conflict
 * is recorded so the user resolves it in the Conflicts UI.
 *
 * Persisted text is passed through redactSecrets — raw secrets (API keys,
 * credentials, tokens) never enter the decision record.
 */
import { recordDecision, supersedeDecisions, type DecisionStatus } from './decisions.js';
import { redactSecrets } from '../secretGuard/service.js';
import { withTenant, pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ExtractedDecision {
  id: string;
  title: string;
  status: DecisionStatus;
}

export type DecisionSignalKind = 'ACTIVE' | 'TENTATIVE' | 'NONE';

export interface DecisionSignal {
  kind: DecisionSignalKind;
  /** Explicit override/switch language present. */
  changeSignal: boolean;
  /** The topic text the user committed to (max 180 chars). */
  subject: string;
}

// Explicit commitment verbs: "we decided", "we'll use", "let's go with",
// "switch to", "use X instead of Y", "we're going with", "roll with"…
const ACTIVE_SIGNALS: RegExp[] = [
  /\bwe('ll|'re|'ve|\swill|\sare|\shave)?\s+(going\s+with|using|use|stick(ing)?\s+with|roll(ing)?\s+with)\b/i,
  /\blet'?s\s+(use|go\s+with|switch\s+to|stick\s+with|roll\s+with)\b/i,
  /\bwe\s+(chose|choose|picked|decided|decide|committed|commit)\b/i,
  /\bwe('ve|\shave)?\s+decided\s+(on|to|that)\b/i,
  /\b(we\s+)?switch\w*\s+to\b/i,
  /\b(migrat(e|ed|ing)?\s+to)\b/i,
  /\b(use|using)\s+[a-z0-9_./-]+\s+instead\s+of\b/i,
  /\bdecided\s+(on|to|that)\b/i,
  /\bthe\s+decision\s+(is|was)\b/i,
  /\bgoing\s+with\b/i,
  /\b(define|standard|settled|landed)\s+on\b/i,
];

// Override / change-of-course language.
const CHANGE_SIGNALS: RegExp[] = [
  /instead\b/i,
  /never\s+mind\b/i,
  /forget\s+that\b/i,
  /scratch\s+that\b/i,
  /actually\b/i,
  /\bswitch\w*\s+(to|away\s+from|from)\b/i,
  /\b(revert|roll\s+back|undo|drop\s+that|stop\s+using)\b/i,
  /\bchange\w*\s+(it|this|that|the\s+\w+)\s*to\b/i,
];

// Tentative / possibility / request language. Any question is tentative.
const TENTATIVE_SIGNALS: RegExp[] = [
  /\bmaybe\s+(we|i|you)\b/i,
  /\b(considering|consider\b|reconsider\b)\b/i,
  /\bwhat\s+about\b/i,
  /\bhow\s+about\b/i,
  /\bperhaps\b/i,
  /\bthinking\s+of\b/i,
  /\bleaning\s+(towards?|to)\b/i,
  /\bshould\s+(we|i|they)\b/i,
  /\bcould\s+(try|use|go|switch)\b/i,
  /\bcould\s+be\s+(a|the)\b/i,
  /\btrying\s+out\b/i,
  /\bevaluat(e|ing)\s+(the\s+)?/i,
  /\btentative|undecided|not\s+sure\b/i,
  /\ba\s+possibility|an\s+option\b/i,
  /\b(option|alternative|choice)\s+(i|we)\s+(know|see)\b/i,
];

// Requests ("can you change this to …") are not decisions the user has taken.
const REQUEST_GUARD: RegExp =
  /^(can|could|will\s+you|would\s+you|please|i\s+want\s+(you\s+to|to)|make\s+it|update\s+it|change\s+it\s+to)\b/i;

function subjectAfter(match: RegExpExecArray, text: string): string {
  const rest = text.slice(match.index + match[0].length);
  const sentence = rest.split(/[.!?;]\s+|\n+/)[0] ?? '';
  const cleaned = sentence
    .replace(/^(to|the|a|an|and|for|with|that|on)\s+/i, '')
    .replace(/\s*instead\s*.*$/i, '')
    .trim()
    .slice(0, 180);
  return cleaned;
}

/** Pure classifier — exported for tests. No I/O. */
export function classifyDecisionSignal(content: string): DecisionSignal {
  const text = content.trim();
  if (!text) return { kind: 'NONE', changeSignal: false, subject: '' };
  const isQuestion = /[?]\s*$/.test(text);
  const actHit = ACTIVE_SIGNALS.map((re) => re.exec(text)).find((r) => r !== null) ?? null;
  const changeHit = CHANGE_SIGNALS.some((re) => re.test(text));
  const tentHit = TENTATIVE_SIGNALS.map((re) => re.exec(text)).find((r) => r !== null) ?? null;
  const requestHit = REQUEST_GUARD.test(text);

  if (actHit && !isQuestion && !requestHit) {
    const subject = subjectAfter(actHit, text);
    if (subject) return { kind: 'ACTIVE', changeSignal: changeHit, subject };
    return { kind: 'NONE', changeSignal: false, subject: '' };
  }
  if (actHit || tentHit) {
    const subject = subjectAfter(actHit ?? tentHit!, text);
    if (subject) return { kind: 'TENTATIVE', changeSignal: changeHit, subject };
  }
  return { kind: 'NONE', changeSignal: false, subject: '' };
}

async function insertOpenConflictIfAbsent(
  userId: string,
  decisionId: string,
  requestText: string,
): Promise<void> {
  const existing = await withTenant<{ id: string }[]>(userId, async (q) =>
    (
      await q.query<{ id: string }>(
        `SELECT id FROM decision_conflicts WHERE owner_id = $1 AND decision_id = $2 AND status = 'OPEN' LIMIT 1`,
        [userId, decisionId],
      )
    ).rows,
  );
  if (existing[0]) return;
  const id = newId(PREFIX.DECISION_CONFLICT);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO decision_conflicts (id, owner_id, decision_id, request_text, status)
       VALUES ($1,$2,$3,$4,'OPEN')`,
      [id, userId, decisionId, requestText.slice(0, 1000)],
    ),
  );
}

/**
 * Surface collisions: a new ACTIVE decision that overlaps an existing live
 * decision (without an explicit override signal) opens an OPEN conflict so the
 * user decides — the system never silently picks one.
 */
export async function surfaceDecisionCollisions(
  userId: string,
  input: { projectId?: string | null; subject: string; excludingId: string },
): Promise<number> {
  const subject = input.subject.trim();
  if (!subject) return 0;
  const rows = await withTenant<{ id: string; title: string }[]>(userId, async (q) =>
    (
      await q.query<{ id: string; title: string }>(
        `SELECT id, title FROM agent_decisions
         WHERE owner_id = $1 AND id <> $2 AND deleted_at IS NULL AND status = 'ACTIVE'
           AND ($3::text IS NULL OR project_id = $3)
         ORDER BY created_at DESC LIMIT 200`,
        [userId, input.excludingId, input.projectId ?? null],
      )
    ).rows,
  );
  let collisions = 0;
  for (const d of rows) {
    const overlap = subject
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((t) => t.length >= 3 && `${d.title} ${d.title}`.toLowerCase().includes(t));
    if (!overlap) continue;
    await insertOpenConflictIfAbsent(userId, d.id, subject);
    collisions += 1;
  }
  if (collisions > 0) {
    await recordAudit({
      action: AuditAction.DECISION_RECORDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'agent_decisions',
      resourceId: input.excludingId,
      detail: { collisionDetected: collisions, subject: subject.slice(0, 200) },
    });
  }
  return collisions;
}

export interface ExtractDecisionInput {
  conversationId: string;
  projectId?: string | null;
  /** The user's own words (the message that carries the decision). */
  content: string;
  /** The exact message id that produced this — links the record to its source. */
  messageId: string;
}

/**
 * Record a decision from a chat exchange when the user's words are a genuine
 * decision. Returns null (and records NOTHING) when no signal is present.
 * Fail-safe by design: never throws for classifier input, never stores raw
 * secrets, never invents context that was not said.
 */
export async function extractDecisionFromChat(
  userId: string,
  input: ExtractDecisionInput,
): Promise<ExtractedDecision | null> {
  const signal = classifyDecisionSignal(input.content);
  if (signal.kind === 'NONE' || !signal.subject) return null;
  const status: DecisionStatus = signal.kind === 'ACTIVE' ? 'ACTIVE' : 'TENTATIVE';
  const trimmed = input.content.trim();
  const title = redactSecrets(
    status === 'ACTIVE'
      ? `${subjectToTitle(signal.subject)} (decided)`
      : subjectToTitle(signal.subject),
  );
  const recorded = await recordDecision(userId, {
    title,
    decision: redactSecrets(trimmed.slice(0, 2000)),
    projectId: input.projectId ?? null,
    sourceConversationId: input.conversationId,
    sourceMessageIds: [input.messageId],
    evidenceRef: `message://${input.messageId}`,
    impact: 'LOW',
    status,
    scope: input.projectId ? 'PROJECT' : 'PERSONAL',
  });

  if (status === 'ACTIVE') {
    if (signal.changeSignal) {
      // Explicit override: the newer decision supersedes the overlapping one.
      await supersedeDecisions(userId, {
        projectId: input.projectId ?? null,
        subject: signal.subject,
        supersedingId: recorded.id,
      });
    } else {
      // Same topic as a live decision but no override language: surface it.
      await surfaceDecisionCollisions(userId, {
        projectId: input.projectId ?? null,
        subject: signal.subject,
        excludingId: recorded.id,
      });
    }
  }
  return { id: recorded.id, title: recorded.title, status: recorded.status };
}

function subjectToTitle(subject: string): string {
  const words = subject.split(/\s+/).filter(Boolean);
  if (words.length <= 8) return subject.slice(0, 80);
  return `${words.slice(0, 8).join(' ')}…`.slice(0, 80);
}