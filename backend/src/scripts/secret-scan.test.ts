import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSecretScan } from './secret-scan';

/**
 * Hermetic secret-scan tests (CB2 Step 6a):
 *  - planted-fake detection works and the CLI never echoes secret values,
 *  - a clean tree exits 0, a planted tree exits 1,
 *  - the repo-wide default scan (the CI gate) exits 0.
 * All fixture dirs live under the OS temp dir, never inside the repo.
 */
const tempRoot = mkdtempSync(path.join(tmpdir(), 'cc-secret-scan-test-'));
// Constructed at runtime so the pattern never appears literally in source tree.
const PLANTED_TOKEN = ['AKIA', '123456', '7890ABCDEF'].join('');
let repoRoot: string;
let cleanDir: string;
let plantedDir: string;

function runCli(dir: string): { stdout: string; status: number } {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'backend', 'src', 'scripts', 'secret-scan.ts'), '--dir', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? -1;
    stdout = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  return { stdout, status };
}

beforeAll(() => {
  repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  expect(repoRoot.endsWith('CodeConClave-')).toBe(true);

  cleanDir = path.join(tempRoot, 'clean');
  mkdirSync(cleanDir);
  writeFileSync(path.join(cleanDir, 'notes.txt'), 'nothing sensitive here', 'utf8');

  plantedDir = path.join(tempRoot, 'planted');
  mkdirSync(plantedDir);
  writeFileSync(path.join(plantedDir, 'creds.txt'), `awsKey = "${PLANTED_TOKEN}"`, 'utf8');
  writeFileSync(path.join(plantedDir, 'safe.js'), 'const x = 1;', 'utf8');
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('secret-scan CLI (hermetic)', () => {
  it('PLANTED_DETECTION: a planted credential exits 1 and is reported without echoing the value', () => {
    const { stdout, status } = runCli(plantedDir);
    expect(status).toBe(1);
    expect(stdout).toContain('FINDING');
    expect(stdout).toContain('aws_access_key_id:1');
    expect(stdout).not.toContain(PLANTED_TOKEN);
  });

  it('CLEAN_TREE: a clean tree exits 0', () => {
    const { stdout, status } = runCli(cleanDir);
    expect(status).toBe(0);
    expect(stdout).toContain('findings=0');
  });

  it('REPO_DEFAULT_SCAN: repo-wide scan (CI gate) exits 0 with source surface intact', async () => {
    const code = await runSecretScan(repoRoot);
    expect(code).toBe(0);
  });
});