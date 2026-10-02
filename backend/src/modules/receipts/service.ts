/**
 * CodeConClave — Verified Execution Receipts (blueprint #1) + Spec-to-Proof
 * matrix (blueprint #6).
 *
 * Every completed engine task emits one machine-readable receipt proving how
 * its artifact was produced: run identities, output hashes, verification
 * outcome, artifact sha. Receipts are hash-chained per task (each commits to
 * the previous receipt hash); `verifyReceiptChain` recomputes the chain so
 * tampering is detectable. The receipt is assembled from persisted engine
 * rows (runs, artifact bytes, verification strings) — never from model
 * self-report.
 *
 * Spec-to-Proof: plan acceptance criteria become proof rows carrying a
 * machine-checked verdict. PASS requires a real verifier run (verification
 * string contains PASS); otherwise the row is SKIPPED/FAIL with the evidence
 * attached. The matrix can never claim proof it does not have.
 */
import { queryMany, queryOne, withSystem } from '../../shared/db.js';
import { sha256Hex } from '../../shared/crypto.js';
import { newId, PREFIX } from '../../shared/ids.js';

export type ProofVerdict = 'PASS' | 'FAIL' | 'SKIPPED';

export interface ReceiptRunInput {
  runId: string;
  coworkerType: string;
  orderIndex: number;
  verification: string | null;
  output: unknown;
}

export interface IssueReceiptInput {
  taskId: string;
  attemptId: string;
  projectId: string;
  ownerId: string;
  /** Exact artifact bytes that were persisted (hashed, never stored twice). */
  artifactContent: string;
  /** Combined verification string from the verify step. */
  verification: string;
  runs: ReceiptRunInput[];
  models?: string[];
  /** Plan acceptance criteria → proof rows. Empty/missing → no rows. */
  criteria?: Array<string | null | undefined>;
}

export interface IssuedReceipt {
  id: string;
  receiptHash: string;
  prevReceiptHash: string | null;
  proofVerdicts: Array<{ criterion: string; verdict: ProofVerdict }>;
}

/** Deterministic JSON: recursively sorted keys, no whitespace variance. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeReceiptHash(prevReceiptHash: string | null, canonicalPayload: string): string {
  return sha256Hex(`${prevReceiptHash ?? 'GENESIS'}|${canonicalPayload}`);
}

export function verdictFor(verification: string): ProofVerdict {
  if (verification.includes('PASS')) return 'PASS';
  if (verification.includes('FAIL')) return 'FAIL';
  return 'SKIPPED';
}

export async function issueReceipt(input: IssueReceiptInput): Promise<IssuedReceipt> {
  const artifactSha256 = sha256Hex(input.artifactContent);
  const runRefs = input.runs.map((r) => ({
    runId: r.runId,
    coworkerType: r.coworkerType,
    orderIndex: r.orderIndex,
    verification: r.verification,
    outputHash: sha256Hex(stableStringify(r.output ?? null)),
  }));
  const models = input.models ?? [];
  const canonical = stableStringify({
    artifactSha256,
    attemptId: input.attemptId,
    models,
    ownerId: input.ownerId,
    projectId: input.projectId,
    runRefs,
    taskId: input.taskId,
    verification: input.verification,
  });
  const prev = await queryOne<{ receipt_hash: string }>(
    'SELECT receipt_hash FROM artifact_receipts WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
    [input.taskId],
  );
  const prevReceiptHash = prev?.receipt_hash ?? null;
  const receiptHash = computeReceiptHash(prevReceiptHash, canonical);
  const id = newId(PREFIX.RECEIPT);
  await withSystem((q) =>
    q.query(
      `INSERT INTO artifact_receipts
         (id, task_id, attempt_id, project_id, owner_id, artifact_sha256,
          run_refs, input_hashes, verification, models, prev_receipt_hash, receipt_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12)`,
      [
        id,
        input.taskId,
        input.attemptId,
        input.projectId,
        input.ownerId,
        artifactSha256,
        JSON.stringify(runRefs),
        JSON.stringify(runRefs.map((r) => r.outputHash)),
        input.verification,
        JSON.stringify(models),
        prevReceiptHash,
        receiptHash,
      ],
    ),
  );
  const criteria = (input.criteria ?? []).map((c) => (c ?? '').trim()).filter(Boolean);
  const proofVerdicts: IssuedReceipt['proofVerdicts'] = [];
  for (const criterion of criteria) {
    const verdict = verdictFor(input.verification);
    await withSystem((q) =>
      q.query(
        `INSERT INTO spec_proofs (id, receipt_id, task_id, criterion, verdict, evidence)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          newId(PREFIX.SPEC_PROOF),
          id,
          input.taskId,
          criterion,
          verdict,
          JSON.stringify({
            verification: input.verification,
            artifactSha256,
            runIds: runRefs.map((r) => r.runId),
          }),
        ],
      ),
    );
    proofVerdicts.push({ criterion, verdict });
  }
  return { id, receiptHash, prevReceiptHash, proofVerdicts };
}

export interface ReceiptRow {
  id: string;
  task_id: string;
  attempt_id: string;
  project_id: string;
  owner_id: string;
  artifact_sha256: string;
  run_refs: Array<{ runId: string; coworkerType: string; orderIndex: number; verification: string | null; outputHash: string }>;
  input_hashes: string[];
  verification: string;
  models: string[];
  prev_receipt_hash: string | null;
  receipt_hash: string;
}

export async function verifyReceiptChain(taskId: string): Promise<{ ok: boolean; count: number; brokenAt: string | null }> {
  const rows = await queryMany<ReceiptRow>(
    'SELECT * FROM artifact_receipts WHERE task_id = $1 ORDER BY created_at ASC',
    [taskId],
  );
  let prev: string | null = null;
  for (const row of rows) {
    const canonical = stableStringify({
      artifactSha256: row.artifact_sha256,
      attemptId: row.attempt_id,
      models: row.models ?? [],
      ownerId: row.owner_id,
      projectId: row.project_id,
      runRefs: row.run_refs ?? [],
      taskId: row.task_id,
      verification: row.verification,
    });
    if (row.prev_receipt_hash !== prev) return { ok: false, count: rows.length, brokenAt: row.id };
    if (computeReceiptHash(prev, canonical) !== row.receipt_hash) {
      return { ok: false, count: rows.length, brokenAt: row.id };
    }
    prev = row.receipt_hash;
  }
  return { ok: true, count: rows.length, brokenAt: null };
}

export interface ProofRow {
  id: string;
  receipt_id: string;
  task_id: string;
  criterion: string;
  verdict: ProofVerdict;
  evidence: Record<string, unknown>;
}

/** Latest proof matrix for a task (latest receipt's rows, if any). */
export async function getProofMatrix(taskId: string): Promise<{ receiptId: string | null; proofs: ProofRow[] }> {
  const latest = await queryOne<{ id: string }>(
    'SELECT id FROM artifact_receipts WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
    [taskId],
  );
  if (!latest) return { receiptId: null, proofs: [] };
  const proofs = await queryMany<ProofRow>('SELECT * FROM spec_proofs WHERE receipt_id = $1 ORDER BY created_at ASC', [latest.id]);
  return { receiptId: latest.id, proofs };
}
