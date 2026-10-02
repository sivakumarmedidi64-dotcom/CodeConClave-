/**
 * CodeConClave — #45 Error Recovery Playbook (PKG-17).
 * Advisory recovery playbook generator: given an error signature/category, emit
 * an ordered set of recovery steps (DIAGNOSE / PREVENT / REMEDIATE / ROLLBACK /
 * VERIFY). Deterministic, read-only — it does not execute recovery actions.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { ErrorRecoveryPlaybookReport, RecoveryStep, TruthfulnessState } from './types.js';

interface Pattern {
  key: string;
  match: RegExp;
  steps: (o: number) => RecoveryStep[];
}

const PATTERNS: Pattern[] = [
  {
    key: 'deployment_failure',
    match: /deploy|release|rollout|503|502|gateway|health.*fail|container.*crash|out of memory/i,
    steps: (o) => [
      { order: o++, action: 'DIAGNOSE', category: 'DIAGNOSE', detail: 'Check deployment logs and health checks; confirm which artifact/commit is live.' },
      { order: o++, action: 'PREVENT', category: 'PREVENT', detail: 'Confirm the failing image/config vs the last known-good artifact.' },
      { order: o++, action: 'REMEDIATE', category: 'REMEDIATE', detail: 'Correct the artifact/config and re-run the deploy through the fast-track gate.' },
      { order: o++, action: 'ROLLBACK', category: 'ROLLBACK', detail: 'If unresolved, roll back to the previous known-good commit and verify.' },
      { order: o++, action: 'VERIFY', category: 'VERIFY', detail: 'Run a post-fix smoke check and observe health for a short window.' },
    ],
  },
  {
    key: 'db_error',
    match: /connection (refused|timed out)|database.*(error|down|locked)|deadlock|timeout.*query|migration.*fail|constraint/i,
    steps: (o) => [
      { order: o++, action: 'DIAGNOSE', category: 'DIAGNOSE', detail: 'Check DB connectivity, lock state, and the most recent migration status.' },
      { order: o++, action: 'PREVENT', category: 'PREVENT', detail: 'Confirm connection pool and timeouts are within bounds.' },
      { order: o++, action: 'REMEDIATE', category: 'REMEDIATE', detail: 'Apply the corrective query/migration or retry the failed transaction.' },
      { order: o++, action: 'ROLLBACK', category: 'ROLLBACK', detail: 'If a migration broke state, plan its reversible downgrade.' },
      { order: o++, action: 'VERIFY', category: 'VERIFY', detail: 'Re-run the affected query/flow and confirm the error clears.' },
    ],
  },
  {
    key: 'auth_secret',
    match: /unauthori[sz]ed|403|401|token.*(invalid|expired)|api[_-]?key|secret.*(missing|invalid)|permission denied/i,
    steps: (o) => [
      { order: o++, action: 'DIAGNOSE', category: 'DIAGNOSE', detail: 'Check which credential/scope is being rejected and from where.' },
      { order: o++, action: 'PREVENT', category: 'PREVENT', detail: 'Confirm secrets are sourced from the vault, not rotated incorrectly.' },
      { order: o++, action: 'REMEDIATE', category: 'REMEDIATE', detail: 'Rotate/replace the affected credential in the secret store; never log it.' },
      { order: o++, action: 'VERIFY', category: 'VERIFY', detail: 'Re-authenticate and confirm the failing call succeeds with the new credential.' },
    ],
  },
  {
    key: 'test_flake',
    match: /flaky|flakes?|intermittent|timing|test.*(fail|unstable)/i,
    steps: (o) => [
      { order: o++, action: 'DIAGNOSE', category: 'DIAGNOSE', detail: 'Re-run the test in isolation and repeatedly to confirm flakiness vs a real regression.' },
      { order: o++, action: 'PREVENT', category: 'PREVENT', detail: 'Stabilize timing/ordering dependencies; pin any async waits.' },
      { order: o++, action: 'REMEDIATE', category: 'REMEDIATE', detail: 'Fix the underlying race/timing or mark as known-flaky with a tracking issue.' },
      { order: o++, action: 'VERIFY', category: 'VERIFY', detail: 'Confirm a clean sustained pass on the stabilized test.' },
    ],
  },
];

export async function buildErrorRecoveryPlaybook(
  userId: string,
  projectId: string,
  errorSignature: string,
): Promise<ErrorRecoveryPlaybookReport> {
  const state: TruthfulnessState = 'HEURISTIC';
  const lowered = errorSignature.toLowerCase();

  const matched = PATTERNS.find((p) => p.match.test(lowered));

  let steps: RecoveryStep[] = [];
  if (matched) {
    steps = matched.steps(1);
  } else {
    steps = [
      { order: 1, action: 'DIAGNOSE', category: 'DIAGNOSE', detail: 'Capture the full error, stack/failing path, and the triggering action.' },
      { order: 2, action: 'REMEDIATE', category: 'REMEDIATE', detail: 'Identify the single narrowest fix that addresses the symptom.' },
      { order: 3, action: 'PREVENT', category: 'PREVENT', detail: 'Add a guard/log to make the failure visible earlier.' },
      { order: 4, action: 'ROLLBACK', category: 'ROLLBACK', detail: 'If the change is suspect, prepare a rollback target.' },
      { order: 5, action: 'VERIFY', category: 'VERIFY', detail: 'Verify the fix resolves the symptom without new failures.' },
    ];
  }

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    errorSignature,
    matchedPattern: matched ? matched.key : null,
    steps,
    state,
    limitations: [
      'Pattern-matched heuristic from the error text; it does not execute any recovery action.',
      'Steps are guidance — always validate against the real failing system before acting.',
      'Advisory only; no command is run.',
    ],
  };
}