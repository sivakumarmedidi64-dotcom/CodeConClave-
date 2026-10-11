/**
 * CodeConClave — comms service (email triage over the plugin engine).
 *
 * Thin, audited orchestration over the pure `emailTriage.ts` core: assert
 * project ownership, fetch unread threads through the approval-aware plugin
 * engine (OAuth + scopes enforced there — never raw Gmail calls here), run
 * deterministic triage, build drafts for candidates. Sending is NOT exposed
 * here at all: the only send path in the product is the approval-gated plugin
 * execute flow, reached by an explicit user approval, never by triage.
 */
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import {
  triageInbox,
  buildReplyDraft,
  fetchUnreadThreads,
  type EmailThread,
  type PluginEngine,
} from './emailTriage.js';

export interface TriageEmailInput {
  projectId: string;
  connectionId?: string;
  query?: string;
  maxResults?: number;
  threads?: EmailThread[];
}

export interface TriageEmailDeps {
  assertProjectOwned?: (userId: string, projectId: string) => Promise<void>;
  engine?: PluginEngine | null;
  audit?: (entry: Record<string, unknown>) => Promise<void>;
}

async function defaultAssertProjectOwned(userId: string, projectId: string): Promise<void> {
  const { withTenant } = await import('../../shared/db.js');
  const rows = await withTenant<{ id: string }[]>(userId, (q) =>
    q.query<{ id: string }>('SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Project');
}

export async function triageEmailInbox(
  userId: string,
  input: TriageEmailInput,
  deps: TriageEmailDeps = {},
): Promise<{ summary: ReturnType<typeof triageInbox>; drafts: ReturnType<typeof buildReplyDraft>[] }> {
  if (!input.projectId) throw AppError.badRequest('invalid_input', 'projectId is required');
  await (deps.assertProjectOwned ?? defaultAssertProjectOwned)(userId, input.projectId);
  const threads = input.connectionId
    ? await fetchUnreadThreads(userId, input.connectionId, { query: input.query, maxResults: input.maxResults }, deps.engine ?? null)
    : (Array.isArray(input.threads) && input.threads.length > 0
      ? input.threads
      : (() => {
        throw AppError.badRequest('invalid_input', 'connectionId (live fetch) or threads[] (offline triage) is required');
      })());
  const summary = triageInbox(threads);
  const drafts = summary.decisions
    .filter((d) => d.verdict === 'DRAFT_CANDIDATE')
    .map((d) => buildReplyDraft(d.thread));
  const audit = deps.audit ?? (await import('../audit/service.js')).recordAudit;
  await audit({
    action: AuditAction.EMAIL_TRIAGED,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'email_triage',
    resourceId: input.projectId,
    detail: { ...summary.counts, drafts: drafts.length, via: input.connectionId ? 'live' : 'provided' },
  });
  return { summary, drafts };
}

export function draftEmailReply(thread: EmailThread): ReturnType<typeof buildReplyDraft> {
  return buildReplyDraft(thread);
}
