/**
 * CodeConClave — Superpowers: CODE COURT (Master Feature #22).
 *
 * When two agents — or two humans — disagree on an approach, the argument is
 * held in a structured courtroom: the prosecutor attacks the proposal with
 * evidence, the defense defends it with evidence, and a separate judge rules.
 * The verdict and reasoning become a permanent decision record.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CourtArgument {
  side: 'prosecution' | 'defense';
  argument: string;
  evidence: string[];
}

export interface CodeCourtCaseRow {
  id: string;
  owner_id: string;
  proposal: string;
  arguments: CourtArgument[];
  verdict: string;
  ruling: string;
  reasoning: string;
  status: 'DELIBERATING' | 'RULED';
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CodeCourtCaseRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  proposal: String(r.proposal),
  arguments: (r.arguments ?? []) as CourtArgument[],
  verdict: String(r.verdict),
  ruling: String(r.ruling),
  reasoning: String(r.reasoning),
  status: r.status as CodeCourtCaseRow['status'],
  created_at: new Date(r.created_at as string),
});

/** The judge counts evidence, not volume. A tie remands the case for questions. */
export function judgeDebate(argumentsList: CourtArgument[]): { verdict: string; ruling: string; reasoning: string } {
  const prosecution = argumentsList.filter((a) => a.side === 'prosecution');
  const defense = argumentsList.filter((a) => a.side === 'defense');
  const prosecutionPoints = prosecution.reduce((s, a) => s + a.evidence.length, 0);
  const defensePoints = defense.reduce((s, a) => s + a.evidence.length, 0);

  if (prosecutionPoints > defensePoints) {
    return {
      verdict: 'rejected',
      ruling: 'proposal rejected',
      reasoning: `the prosecution carried ${prosecutionPoints} pieces of evidence to the defense's ${defensePoints}`,
    };
  }
  if (defensePoints > prosecutionPoints) {
    return {
      verdict: 'admitted',
      ruling: 'proposal admitted',
      reasoning: `the defense carried ${defensePoints} pieces of evidence to the prosecution's ${prosecutionPoints}`,
    };
  }
  return {
    verdict: 'remanded',
    ruling: 'remanded for questions',
    reasoning: `both sides landed on ${prosecutionPoints} pieces of evidence; the case is remanded until each side answers the other's questions`,
  };
}

export async function holdCourt(userId: string, input: { proposal: string; arguments: CourtArgument[] }): Promise<CodeCourtCaseRow> {
  if (!input.proposal || typeof input.proposal !== 'string') throw AppError.badRequest('invalid_proposal', 'a proposal is required to open court');
  if (!Array.isArray(input.arguments) || input.arguments.length < 2) throw AppError.badRequest('too_few_arguments', 'a courtroom needs prosecution and defense');
  for (const a of input.arguments) {
    if (!['prosecution', 'defense'].includes(a.side)) throw AppError.badRequest('invalid_side', `${a.side} is not a recognized side`);
    if (!a.argument || typeof a.argument !== 'string') throw AppError.badRequest('invalid_argument', 'every argument needs a statement');
  }

  const { verdict, ruling, reasoning } = judgeDebate(input.arguments);
  const id = newId(PREFIX.CODE_COURT_CASE);
  await withTenant(userId, (q) => q.query('INSERT INTO code_court_cases (id, owner_id, proposal, arguments, verdict, ruling, reasoning, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
    id,
    userId,
    input.proposal,
    input.arguments,
    verdict,
    ruling,
    reasoning,
    'RULED',
  ]));
  await recordAudit({
    action: AuditAction.COURT_HELD,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'code_court_cases',
    resourceId: id,
    detail: { proposal: input.proposal },
  });
  await recordAudit({
    action: AuditAction.COURT_RULED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'code_court_cases',
    resourceId: id,
    detail: { verdict, reasoning },
  });
  return getCourtCase(userId, id);
}

export async function getCourtCase(userId: string, id: string): Promise<CodeCourtCaseRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM code_court_cases WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('code_court_case_not_found', 'no code court case found for that id');
  return rowOf(row);
}

export async function listCourtCases(userId: string): Promise<CodeCourtCaseRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM code_court_cases WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function codeCourtReport(userId: string): Promise<{ cases: number; admitted: number; rejected: number; remanded: number }> {
  const cases = await listCourtCases(userId);
  return {
    cases: cases.length,
    admitted: cases.filter((c) => c.verdict === 'admitted').length,
    rejected: cases.filter((c) => c.verdict === 'rejected').length,
    remanded: cases.filter((c) => c.verdict === 'remanded').length,
  };
}