/**
 * CodeConClave Local Agent — real-browser E2E (P1).
 *
 * Drives an actual headless Chrome/Edge through the full instruction path:
 * open, read, inspect, search, scroll, type, select, click, submit, screenshot,
 * download, upload — with honest assertions on real artifacts (PNG magic,
 * sha256, byte counts). Self-contained: spins a local Node http fixture page.
 *
 * Requirement: a Chromium/Edge binary must be present (CODECONCLAVE_BROWSER_PATH
 * or the standard install paths). If none is found the suite skips honestly —
 * it never fakes a pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config.js';
import { findBrowserPath } from './launch.js';
import { runBrowserInstruction } from './task-bridge.js';

const PAGE = `<!doctype html><html><head><title>Fixture Page</title></head><body>
<div id="marker">alpha-beta-gamma</div>
<input id="field" name="q"/>
<input id="pass" type="password"/>
<select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
<button id="btn" onclick="document.getElementById('result').textContent='clicked-'+document.getElementById('field').value">Act</button>
<div id="result"></div>
<form id="form" method="get" action="/echo"><input name="q2"/><button type="submit">Go</button></form>
<input id="file" type="file" onchange="document.getElementById('result').textContent='files='+this.files.length"/>
<a id="dl" href="/download.bin" download>Download</a>
</body></html>`;

const DOWNLOAD_BYTES = Buffer.from('live download payload contents'.repeat(20));
const UPLOAD_CONTENT = Buffer.from('upload-me.txt contents\n');

let server: Server;
let origin = 'http://127.0.0.1:0';
let root: string;
let config: AgentConfig;
const hasBrowser = Boolean(findBrowserPath());

describe.skipIf(!hasBrowser)('browser controller E2E (real headless browser)', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccc-e2e-'));
    writeFileSync(join(root, 'upload.txt'), UPLOAD_CONTENT);
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/' || url === '/page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE);
        return;
      }
      if (url === '/download.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.bin"' });
        res.end(DOWNLOAD_BYTES);
        return;
      }
      if (url.startsWith('/echo')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Echoed</title></head><body><div id="echo">q2=${String(url)}</div></body></html>`);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    origin = `http://127.0.0.1:${addr.port}`;
    config = {
      version: '0.1.0',
      deviceId: 'dev_e2e',
      deviceSecretHash: 'x',
      createdAt: new Date().toISOString(),
      pairedTo: 'http://localhost:4000',
      token: 't',
      workspaces: [{ root, name: 'ws', capabilities: ['file_read', 'file_write', 'terminal_exec'] }],
      browser: [
        {
          name: 'e2e',
          capabilities: [
            'browser.open',
            'browser.navigate',
            'browser.read',
            'browser.inspect',
            'browser.click',
            'browser.type',
            'browser.submit',
            'browser.download',
            'browser.upload',
          ],
          allowedOrigins: ['http://127.0.0.1:*'],
        },
      ],
    };
  }, 15_000);

  afterAll(async () => {
    if (server) await new Promise((res) => server.close(() => res(null)));
  });

  const send = () => {};
  const reportProgress = () => {};

  it('executes a full happy-path instruction with real artifacts', async () => {
    const instruction = {
      type: 'browser',
      grants: { capabilities: ['browser.open', 'browser.navigate', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit', 'browser.download', 'browser.upload'], allowedOrigins: ['http://127.0.0.1:*'], lifetimeMs: 3600_000 },
      actions: [
        { op: 'open', url: `${origin}/page.html` },
        { op: 'read', selector: '#marker' },
        { op: 'inspect' },
        { op: 'search', query: 'beta' },
        { op: 'scroll', direction: 'bottom' },
        { op: 'type', selector: 'input[name=q2]', text: 'hello-e2e' },
        { op: 'select', selector: '#sel', value: 'b' },
        { op: 'upload', selector: '#file', path: 'upload.txt' },
        { op: 'click', selector: '#btn' },
        { op: 'screenshot' },
        { op: 'download', url: `${origin}/download.bin` },
        { op: 'submit', selector: '#form' },
      ],
    };

    const outcome = await runBrowserInstruction(instruction, config, 'lta_e2e', 1, { send, reportProgress });
    expect(outcome.ok, JSON.stringify({ errorCode: outcome.errorCode, error: outcome.error, summary: outcome.summary })).toBe(true);
    // submit lands on the /echo page with the typed query: the real final URL
    // proves type → click → submit really happened end-to-end.
    expect(String(outcome.summary.finalUrl ?? '')).toContain('q2=hello-e2e');

    const shots = outcome.artifacts.filter((a) => a.kind === 'browser_screenshot');
    const downloads = outcome.artifacts.filter((a) => a.kind === 'browser_download');
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(downloads.length).toBeGreaterThanOrEqual(1);

    const shot = shots[0] as { absPath: string; bytes: number; sha256: string };
    expect(existsSync(shot.absPath)).toBe(true);
    const png = readFileSync(shot.absPath);
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(png.length).toBe(shot.bytes);
    expect(shot.sha256).toMatch(/^[0-9a-f]{64}$/);

    const dl = downloads[0] as { absPath: string; bytes: number; sha256: string };
    expect(existsSync(dl.absPath)).toBe(true);
    expect(dl.bytes).toBe(DOWNLOAD_BYTES.length);
    expect(readFileSync(dl.absPath).toString('base64')).toBe(DOWNLOAD_BYTES.toString('base64'));
  }, 90_000);

  it('denies a protected interaction (password field) honestly', async () => {
    const instruction = {
      type: 'browser',
      grants: { capabilities: ['browser.open', 'browser.type', 'browser.read'], allowedOrigins: ['http://127.0.0.1:*'], lifetimeMs: 3600_000 },
      actions: [
        { op: 'open', url: `${origin}/page.html` },
        { op: 'type', selector: '#pass', text: 's3cret' },
      ],
    };
    const outcome = await runBrowserInstruction(instruction, config, 'lta_e2e_pass', 1, { send, reportProgress });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('browser_action_failed');
    const parsed = JSON.parse(String(outcome.error)) as { actionIndex: number; op: string; reason: string };
    expect(parsed.op).toBe('type');
    expect(parsed.reason).toContain('password');
  }, 60_000);

  it('denies a destination outside the grant BEFORE launching (no browser session)', async () => {
    const instruction = {
      type: 'browser',
      grants: { capabilities: ['browser.open'], allowedOrigins: ['http://127.0.0.1:*'], lifetimeMs: 3600_000 },
      actions: [{ op: 'open', url: 'https://aws.amazon.com/' }],
    };
    const outcome = await runBrowserInstruction(instruction, config, 'lta_e2e_blocked', 1, { send, reportProgress });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('browser_action_failed');
    expect(String(outcome.error)).toContain('"op":"open"');
  }, 30_000);
});