import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFrontend } from './copy-frontend.mjs';

let root;
let srcDist;
let srcServer;
let dest;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codeconclave-frontend-copy-'));
  srcDist = join(root, 'source', 'dist');
  srcServer = join(root, 'source', 'server.cjs');
  dest = join(root, 'desktop', 'resources', 'frontend');
  mkdirSync(join(srcDist, 'assets'), { recursive: true });
  mkdirSync(join(dest, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(srcDist, 'index.html'), '<main>current</main>');
  writeFileSync(join(srcDist, 'assets', 'index-current.js'), 'current bundle');
  writeFileSync(srcServer, 'current server');
  writeFileSync(join(dest, 'dist', 'assets', 'index-stale.js'), 'stale bundle');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('copyFrontend', () => {
  it('copies the current frontend and removes stale hashed assets', () => {
    copyFrontend(srcDist, srcServer, dest);

    expect(readFileSync(join(dest, 'dist', 'index.html'), 'utf8')).toContain('current');
    expect(readFileSync(join(dest, 'dist', 'assets', 'index-current.js'), 'utf8')).toBe('current bundle');
    expect(() => readFileSync(join(dest, 'dist', 'assets', 'index-stale.js'))).toThrow();
    expect(readFileSync(join(dest, 'server.cjs'), 'utf8')).toBe('current server');
  });
});
