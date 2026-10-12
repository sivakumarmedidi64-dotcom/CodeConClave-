/**
 * CodeConClave — tuning data exporter (Neon → local JSONL, never committed).
 * Reads YOUR verified history and emits Alpaca-style rows the shared QLoRA
 * skeleton consumes:
 *   {"instruction": "...", "input": "...", "output": "{...json...}"}
 *
 * v1 box: scout-router — task → {"lane","risk"} routing JSON (≤300 tok).
 * Gold only: COMPLETED/VERIFIED tasks. Secrets are scanned and skipped.
 * Prints the file sha256 so the Hub upload can be pinned by every notebook.
 *
 * Usage (backend dir, direct node — npm run needs cmd.exe):
 *   node ..\node_modules\tsx\dist\cli.mjs src/scripts/export-tune-data.ts --box scout-router --limit 5000
 */
import { mkdirSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../shared/db.js';
import { secretScanDeny } from '../modules/ingest/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const outDir = path.join(repoRoot, 'data', 'training');

const SCOUT_INSTRUCTION =
  'Route this CodeConClave task. Reply with JSON only: {"lane": <CODER|PLANNER|FASTQA>, "risk": <LOW|MEDIUM|HIGH|CRITICAL>}.';

function laneOf(pipeline: unknown, mode: string): string {
  if (Array.isArray(pipeline)) {
    const first = pipeline
      .map((e) => (typeof e === 'string' ? e : (e as { coworker_type?: unknown })?.coworker_type))
      .find((t) => typeof t === 'string') as string | undefined;
    if (first === 'PLANNER' || first === 'ARCHITECT') return 'PLANNER';
    if (first === 'REVIEWER' || first === 'TESTER' || first === 'SECURITY') return 'FASTQA';
    if (first) return 'CODER';
  }
  return mode === 'LOCAL' ? 'FASTQA' : 'CODER';
}

async function exportScoutRouter(limit: number, projectId: string | null): Promise<{ rows: number; file: string; sha256: string }> {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'scout-router.jsonl');
  const stream = createWriteStream(file, { encoding: 'utf8' });
  const hash = createHash('sha256');
  const params: unknown[] = [];
  let where = `status IN ('COMPLETED','VERIFIED')`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $1`;
  }
  const sql = `SELECT title, description, risk_level, execution_mode, coworker_pipeline
               FROM tasks WHERE ${where} ORDER BY updated_at DESC LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50000)) : 5000}`;
  const res = await pool.query(sql, params);
  let rows = 0;
  for (const t of res.rows as Array<{
    title: string; description: string | null; risk_level: string;
    execution_mode: string; coworker_pipeline: unknown;
  }>) {
    const input = `${t.title ?? ''}\n${(t.description ?? '').slice(0, 500)}`.trim().slice(0, 800);
    if (!input || secretScanDeny(input)) continue;
    const output = JSON.stringify({ lane: laneOf(t.coworker_pipeline, t.execution_mode), risk: t.risk_level || 'MEDIUM' });
    const line = JSON.stringify({ instruction: SCOUT_INSTRUCTION, input, output }) + '\n';
    stream.write(line);
    hash.update(line);
    rows += 1;
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });
  return { rows, file, sha256: hash.digest('hex') };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const box = argv.includes('--box') ? String(argv[argv.indexOf('--box') + 1] ?? '') : 'scout-router';
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 5000;
  const projectId = argv.includes('--project') ? String(argv[argv.indexOf('--project') + 1] ?? '') : null;
  (async () => {
    try {
      if (box !== 'scout-router') {
        console.log(`box '${box}' not implemented yet — v1 ships scout-router. coder/reviewer/planner/fastqa exporters unlock after your first gold tasks land.`);
        process.exitCode = 2;
        return;
      }
      const { rows, file, sha256 } = await exportScoutRouter(limit, projectId);
      console.log(`TUNE_EXPORT_ROWS=${rows}`);
      console.log(`TUNE_EXPORT_FILE=${file}`);
      console.log(`TUNE_EXPORT_SHA256=${sha256}`);
      if (rows === 0) {
        console.log('NOTE: no COMPLETED/VERIFIED tasks yet — run real CodeConClave work first, or start training on open slices (Glaive + AutoIF) while gold accumulates.');
      } else {
        console.log('NEXT: upload to HF Hub (private): huggingface-cli upload SaharshMedidi/codeconclave-tune-data data/training/scout-router.jsonl scout-router.jsonl');
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  })().catch(async (err) => {
    console.error(`[export-tune-data] fatal: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await pool.end();
    } finally {
      process.exitCode = 2;
    }
  });
}
