/**
 * CodeConClave — public desktop download routes tests.
 * Covers the /info endpoint and the /desktop stream against a real temp
 * directory fixture (no DB required). The resolved path is always the
 * configured fixture dir — never request input.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { desktopDownloadRoutes } from './routes.js';

const createdDirs: string[] = [];

async function withServer(dir: string, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api/v1/downloads', desktopDownloadRoutes({ setupDir: dir }));
  const server = await new Promise<Awaited<ReturnType<typeof app.listen>>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}/api/v1/downloads`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('desktop download routes', () => {
  afterEach(() => {
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
    createdDirs.length = 0;
  });

  it('reports unavailable for an empty release dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-dl-empty-'));
    createdDirs.push(dir);
    await withServer(dir, async (base) => {
      const info = await fetch(`${base}/info`);
      expect(info.status).toBe(200);
      const body = (await info.json()) as { available: boolean; version: string | null };
      expect(body.available).toBe(false);
      expect(body.version).toBeNull();
      const dl = await fetch(`${base}/desktop`);
      expect(dl.status).toBe(404);
      const dlBody = (await dl.json()) as { errorCode: string };
      expect(dlBody.errorCode).toBe('desktop_installer_unavailable');
    });
  });

  it('reports unavailable when the release dir does not exist', async () => {
    await withServer(join(tmpdir(), 'cc-missing-', String(Date.now())), async (base) => {
      const info = await fetch(`${base}/info`);
      expect(info.status).toBe(200);
      const body = (await info.json()) as { available: boolean };
      expect(body.available).toBe(false);
    });
  });

  it('serves the installer with filename + content-disposition when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-dl-full-'));
    createdDirs.push(dir);
    const exe = join(dir, 'CodeConClave Setup 0.1.0.exe');
    writeFileSync(exe, Buffer.from('MZ fake installer payload', 'utf8'));
    await withServer(dir, async (base) => {
      const info = await fetch(`${base}/info`);
      const body = (await info.json()) as { available: boolean; version: string | null; sizeMB: number | null; fileName: string };
      expect(body).toMatchObject({ available: true, version: '0.1.0', fileName: 'CodeConClave Setup 0.1.0.exe' });
      const dl = await fetch(`${base}/desktop`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-disposition')).toContain('CodeConClave-Setup-0.1.0.exe');
      const bytes = Buffer.from(await dl.arrayBuffer());
      expect(bytes.toString('utf8')).toBe('MZ fake installer payload');
    });
  });

  it('prefers the newest installer when several exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-dl-multi-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'CodeConClave Setup 0.0.9.exe'), Buffer.from('old', 'utf8'));
    writeFileSync(join(dir, 'CodeConClave Setup 0.2.0.exe'), Buffer.from('newer', 'utf8'));
    await withServer(dir, async (base) => {
      const info = await fetch(`${base}/info`);
      const body = (await info.json()) as { version: string; fileName: string };
      expect(body.version).toBe('0.2.0');
      expect(body.fileName).toBe('CodeConClave Setup 0.2.0.exe');
    });
  });
});