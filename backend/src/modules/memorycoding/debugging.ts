/**
 * CodeConClave — PKG-23 Cross-Session Debugging Memory.
 *
 * Supports continuity for recurring bugs. When the same symptom recurs,
 * CodeConClave links the occurrence (via dev_bug_incidents) and reports the
 * PREVIOUS diagnosis / fix / test / deployment — but ONLY when those values were
 * actually recorded. We never claim a causal relationship without evidence.
 *
 * Association between a current failure and a known bug is deterministic: an
 * exact-ish symptom key match. A new non-matching failure creates a new OPEN
 * incident (no false association).
 */
import {
  registerBugOccurrence,
  closeBugIncident,
  listBugIncidents,
  type BugIncidentRow,
} from './codingRecords.js';

export interface IncidentInput {
  projectId: string;
  title: string;
  symptomKey: string;
}

export interface RecurringBugReport {
  incident: BugIncidentRow;
  related: boolean;
  priorFix: string | null;
  priorTest: string | null;
  priorDeploy: string | null;
  occurrences: number;
}

export async function reportBug(
  userId: string,
  input: IncidentInput,
): Promise<BugIncidentRow> {
  return registerBugOccurrence(userId, input);
}

/**
 * Detect recurrence: if an OPEN incident with the same symptom key exists, this
 * is "related to the previous issue" and we surface prior fix/test evidence
 * (only when recorded). Returns related=false when no matching prior incident.
 */
export async function assessRecurrence(
  userId: string,
  projectId: string,
  symptomKey: string,
): Promise<RecurringBugReport | null> {
  const incidents = await listBugIncidents(userId, projectId);
  const prior = incidents.find((i) => i.symptom_key === symptomKey);
  if (!prior) return null;
  return {
    incident: prior,
    related: prior.occurrences > 1 || prior.status === 'FIXED',
    priorFix: prior.fix_summary,
    priorTest: prior.test_ref,
    priorDeploy: prior.deploy_ref,
    occurrences: prior.occurrences,
  };
}

/** Record that a bug was fixed (with evidence refs where recorded). */
export async function resolveBug(
  userId: string,
  incidentId: string,
  fix: { diagnosis?: string; fixSummary?: string; testRef?: string; deployRef?: string },
): Promise<BugIncidentRow | null> {
  return closeBugIncident(userId, incidentId, fix);
}

export async function listIncidents(userId: string, projectId?: string): Promise<BugIncidentRow[]> {
  return listBugIncidents(userId, projectId);
}
