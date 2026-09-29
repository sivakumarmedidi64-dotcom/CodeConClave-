import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  formatWatchtowerReport,
  watchtowerExitCode,
} from './run-watchtower.js';
import type { WatchtowerReport } from '../modules/payments/pool/watchtower.js';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(scriptsDir, '..', '..');
const entryPath = path.join(scriptsDir, 'run-watchtower.ts');
// Dead-loopback test URL: port 1 always refuses fast. Built at runtime so the
// source tree never contains a connection-string literal.
const DEAD_DB_URL = ['postgres://cc:cc@127.0.0.1:1', '/cc_none'].join('');

function fakeReport(overrides: Partial<WatchtowerReport> = {}): WatchtowerReport {
  return {
    checks: [
      { check: 'C1', ok: true, detail: '5 reserved / 10 active' },
      { check: 'C7', ok: false, unreadable: true, detail: 'C7 unreadable: boom' },
    ],
    failing: 1,
    unreadable: 1,
    alertSent: false,
    alertDestinationConfigured: false,
    ...overrides,
  };
}

function runCli(envPatch: Record<string, string> = {}): { stdout: string; status: number } {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', entryPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...envPatch },
        timeout: 120_000,
      },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? -1;
    stdout = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  return { stdout, status };
}

describe('run-watchtower pure resolvers', () => {
  it('WATCHTOWER_EXIT_CODE_CONTRACT: 0 = clean, 1 = any failing/unreadable', () => {
    expect(watchtowerExitCode(fakeReport({ failing: 0, unreadable: 0, checks: [{ check: 'C1', ok: true, detail: null }] }))).toBe(0);
    expect(watchtowerExitCode(fakeReport({ failing: 0, unreadable: 0 }))).toBe(0);
    expect(watchtowerExitCode(fakeReport())).toBe(1);
    expect(watchtowerExitCode(fakeReport({ failing: 2, unreadable: 2 }))).toBe(1);
  });

  it('WATCHTOWER_FORMAT: report lines mirror check outcomes without leaking the alert address', () => {
    const out = formatWatchtowerReport(fakeReport({ alertDestinationConfigured: true }));
    expect(out).toContain('C1:: OK');
    expect(out).toContain('C7 (STATE_UNREADABLE):: FAIL');
    expect(out).not.toContain('@');
  });
});

describe('run-watchtower CLI (real subprocess, dead DB)', () => {
  it('RUNTIME_EXECUTION: engine runs all C1-C7 checks, prints machine lines, exits 1', () => {
    const { stdout, status } = runCli({
      DATABASE_URL: DEAD_DB_URL,
      PAYMENT_WATCHTOWER_ALERT_EMAIL: '',
    });
    for (const i of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) {
      expect(stdout).toContain(i);
    }
    expect(stdout).toContain('WATCHTOWER_CHECKS=7');
    expect(stdout).toContain('WATCHTOWER_CLEAN=false');
    expect(stdout).toContain('WATCHTOWER_ALERT_DESTINATION_CONFIGURED=false');
    expect(stdout).toContain('WATCHTOWER_ALERT_SENT=false');
    expect(stdout).not.toMatch(/WATCHTOWER_ALERT_EMAIL=/);
    expect(status).toBe(1);
  });

  it('NO_DESTINATION_STILL_RUNS: an unconfigured destination never skips checks', () => {
    const { stdout, status } = runCli({
      DATABASE_URL: DEAD_DB_URL,
      PAYMENT_WATCHTOWER_ALERT_EMAIL: '',
    });
    const checkLineCount = (stdout.match(/^C[1-7](?:\s|\(|::)/gm) ?? []).length;
    expect(checkLineCount).toBe(7);
    expect(status).toBe(1);
  });
});

describe('run-watchtower structural honesty', () => {
  it('READ_ONLY_SURFACE: the runner imports only the read-only engine, never mutators', () => {
    const src = readFileSync(entryPath, 'utf8');
    expect(src).toContain('../modules/payments/pool/watchtower.js');
    expect(src).not.toContain('pool/service');
    expect(src).not.toContain('pool/seeder');
    expect(src).not.toContain('seed-payment-pool');
    expect(src).not.toMatch(/(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\s/i);
  });

  it('PACKAGE_SCRIPT: backend package.json exposes watchtower:run', () => {
    const pkg = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.watchtower_run ?? pkg.scripts?.['watchtower:run']).toBe('tsx src/scripts/run-watchtower.ts');
  });
});