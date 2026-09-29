/**
 * CodeConClave — PAYMENT WATCHTOWER CLI (CB1 healing: scheduled runtime entry).
 *
 * A standalone runner over the EXISTING read-only, globally-unscoped watchtower
 * engine (`payments/pool/watchtower.ts`). This file adds NO checks and NO logic
 * changes — it only provides a process boundary a scheduler can invoke, plus a
 * contract a monitor can gate on:
 *
 *   exit 0  — all C1..C7 checks OK
 *   exit 1  — one or more checks failing and/or STATE_UNREADABLE (scan still ran)
 *   exit 2  — operational failure before/while running the scan
 *
 * Machine-readable lines are written to stdout:
 *   WATCHTOWER_CHECKS            number of checks executed (>=1)
 *   WATCHTOWER_CLEAN             true / false
 *   WATCHTOWER_ALERT_DESTINATION_CONFIGURED true / false   (value NEVER printed)
 *   WATCHTOWER_ALERT_SENT        true / false
 *
 * A missing alert destination NEVER skips or reduces coverage — the engine logs
 * exactly one ALERT_DESTINATION_UNCONFIGURED warning and the exit reflects the
 * scan result alone.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runPoolWatchtower, type WatchtowerReport } from '../modules/payments/pool/watchtower.js';
import { pool } from '../shared/db.js';

export function formatWatchtowerReport(report: WatchtowerReport): string {
  return report.checks
    .map((c) => `${c.check}${c.unreadable ? ' (STATE_UNREADABLE)' : ''}:: ${c.ok ? 'OK' : 'FAIL'} ${c.detail ?? ''}`)
    .join('\n');
}

export function watchtowerExitCode(report: WatchtowerReport): number {
  // The scan ALWAYS runs to completion; a failing or unreadable check is a
  // non-zero exit (fail-loud), regardless of alert delivery.
  return report.failing > 0 ? 1 : 0;
}

export async function runWatchtowerCli(): Promise<number> {
  const report = await runPoolWatchtower();
  const clean = report.failing === 0;
  process.stdout.write(formatWatchtowerReport(report) + '\n');
  process.stdout.write(`WATCHTOWER_CHECKS=${report.checks.length}\n`);
  process.stdout.write(`WATCHTOWER_CLEAN=${clean ? 'true' : 'false'}\n`);
  process.stdout.write(`WATCHTOWER_ALERT_DESTINATION_CONFIGURED=${report.alertDestinationConfigured ? 'true' : 'false'}\n`);
  process.stdout.write(`WATCHTOWER_ALERT_SENT=${report.alertSent ? 'true' : 'false'}\n`);
  return watchtowerExitCode(report);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runWatchtowerCli()
    .then(async (code) => {
      try {
        await pool.end();
      } finally {
        process.exitCode = code;
      }
    })
    .catch(async (err) => {
      process.stderr.write(`[watchtower] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        await pool.end();
      } finally {
        process.exitCode = 2;
      }
    });
}