/**
 * CodeConClave — Superpowers: MEETING-TO-CODE (Master Feature #66).
 *
 * Paste a meeting transcript; get issues, acceptance criteria, task
 * breakdown, and a draft PR plan. Requirements stop dying in meeting notes.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface MeetingExtractionRow {
  id: string;
  owner_id: string;
  title: string;
  transcript: string;
  issues: string[];
  acceptance_criteria: string[];
  tasks: string[];
  pr_plan: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): MeetingExtractionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  title: String(r.title),
  transcript: String(r.transcript),
  issues: (r.issues ?? []) as string[],
  acceptance_criteria: (r.acceptance_criteria ?? []) as string[],
  tasks: (r.tasks ?? []) as string[],
  pr_plan: String(r.pr_plan),
  created_at: new Date(r.created_at as string),
});

const sentenceParts = (text: string): string[] =>
  (text.match(/[^.!?]+[.!?]*/g) ?? [text])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

type Clause = 'issue' | 'criteria' | 'task' | 'none';

const classify = (sentence: string): Clause => {
  if (/(bug|broken|crashes|fails|regression|not working|blows up)/i.test(sentence)) return 'issue';
  if (/(must |should |acceptance|when .* then )/i.test(sentence)) return 'criteria';
  if (/(need to|need[s]? (to )?add|to do|todo|should add|add support|build a|roll out)/i.test(sentence)) return 'task';
  return 'none';
};

/** Transcript → issues, acceptance criteria, tasks, and a draft PR plan. */
export function extractFromTranscript(transcript: string): { issues: string[]; acceptance_criteria: string[]; tasks: string[] } {
  const issues: string[] = [];
  const acceptance_criteria: string[] = [];
  const tasks: string[] = [];
  for (const sentence of sentenceParts(transcript)) {
    const clause = classify(sentence);
    if (clause === 'issue') issues.push(sentence);
    else if (clause === 'criteria') acceptance_criteria.push(sentence);
    else if (clause === 'task') tasks.push(sentence);
  }
  return { issues, acceptance_criteria, tasks };
}

export async function extractMeeting(userId: string, input: { title: string; transcript: string }): Promise<MeetingExtractionRow> {
  if (!input.title || typeof input.title !== 'string') throw AppError.badRequest('invalid_title', 'a meeting title is required');
  if (!input.transcript || typeof input.transcript !== 'string') throw AppError.badRequest('invalid_transcript', 'paste the transcript or recording notes');
  const { issues, acceptance_criteria, tasks } = extractFromTranscript(input.transcript);
  const pr_plan = `PR "feat: ${input.title}": ${tasks.length} task(s) bundled into one reviewable change — branch off main, stack them in order, lean on automated checks`;
  const id = newId(PREFIX.MEETING_EXTRACTION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO meeting_extractions (id, owner_id, title, transcript, issues, acceptance_criteria, tasks, pr_plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.title, input.transcript, issues, acceptance_criteria, tasks, pr_plan],
  ));
  await recordAudit({
    action: AuditAction.MEETING_EXTRACTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'meeting_extractions',
    resourceId: id,
    detail: { title: input.title, issues: issues.length, tasks: tasks.length },
  });
  return getMeetingExtraction(userId, id);
}

export async function getMeetingExtraction(userId: string, id: string): Promise<MeetingExtractionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM meeting_extractions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('meeting_extraction_not_found', 'no meeting extraction found for that id');
  return rowOf(row);
}

export async function listMeetingExtractions(userId: string): Promise<MeetingExtractionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM meeting_extractions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function meetingToCodeReport(userId: string): Promise<{ extractions: number; issues: number; criteria: number; tasks: number }> {
  const extractions = await listMeetingExtractions(userId);
  return {
    extractions: extractions.length,
    issues: extractions.reduce((s, e) => s + e.issues.length, 0),
    criteria: extractions.reduce((s, e) => s + e.acceptance_criteria.length, 0),
    tasks: extractions.reduce((s, e) => s + e.tasks.length, 0),
  };
}