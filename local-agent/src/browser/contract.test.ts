/**
 * CodeConClave Local Agent — browser action contract tests (agent side).
 *
 * The agent re-validates every action at execution time. These tests prove the
 * gate itself: capability requirements, origin allowlisting (including that a
 * public `*` grant never reaches private/internal/cloud-control hosts), and
 * filesystem scoping of uploads.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config.js';
import {
  browserGrants,
  advertisedBrowserCapabilities,
  isPrivateHost,
  allowedOriginMatches,
  assertBrowserAction,
} from './contract.js';

function makeConfig(root: string, caps = ALL): AgentConfig {
  return {
    version: '0.1.0',
    deviceId: 'dev_1',
    deviceSecretHash: 'x',
    createdAt: new Date().toISOString(),
    pairedTo: 'http://localhost:4000',
    token: 't',
    workspaces: [{ root, name: 'ws', capabilities: ['file_read', 'file_write', 'terminal_exec'] }],
    browser: [{ name: 'qa', capabilities: caps, allowedOrigins: ['*'] }],
  };
}

const ALL = [
  'browser.open',
  'browser.navigate',
  'browser.read',
  'browser.inspect',
  'browser.click',
  'browser.type',
  'browser.submit',
  'browser.download',
  'browser.upload',
];

describe('browser grants', () => {
  it('only surfaces grants composed entirely of known browser capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const cfg: AgentConfig = {
      ...makeConfig(root),
      browser: [
        { name: 'clean', capabilities: ['browser.open', 'browser.read'], allowedOrigins: ['*'] },
        { name: 'dirty', capabilities: ['browser.open', 'fake_cap'], allowedOrigins: ['*'] },
      ],
    };
    const grants = browserGrants(cfg);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.name).toBe('clean');
  });

  it('advertises the exact union of granted browser capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const cfg: AgentConfig = {
      ...makeConfig(root),
      browser: [
        { name: 'a', capabilities: ['browser.open', 'browser.read'], allowedOrigins: [] },
        { name: 'b', capabilities: ['browser.read', 'browser.click'], allowedOrigins: [] },
      ],
    };
    const caps = advertisedBrowserCapabilities(cfg);
    expect(caps.sort()).toEqual(['browser.click', 'browser.open', 'browser.read']);
  });
});

describe('host classification', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.9.9', true],
    ['172.20.0.1', true],
    ['192.168.1.5', true],
    ['169.254.1.1', true],
    ['example.internal', true],
    ['api.localhost', true],
    ['example.com', false],
    ['EXAMPLE.com', false],
    ['203.0.113.7', false],
    ['8.8.8.8', false],
  ])('isPrivateHost(%s) → %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe('origin allowlisting', () => {
  it('a public * grant admits public destinations only', () => {
    expect(allowedOriginMatches('*', new URL('https://example.com/page'))).toBe(true);
    expect(allowedOriginMatches('*', new URL('https://www.wikipedia.org/'))).toBe(true);
    expect(allowedOriginMatches('*', new URL('http://127.0.0.1:8080/'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('http://192.168.1.5/'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('http://10.0.0.8/'))).toBe(false);
  });

  it('never reaches cloud-control / credential infrastructure through *', () => {
    expect(allowedOriginMatches('*', new URL('https://aws.amazon.com/'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('https://s3.amazonaws.com/bucket'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('https://console.azure.com/'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('https://sheets.googleapis.com/'))).toBe(false);
  });

  it('matches an exact origin band (scheme + host + port, any path)', () => {
    expect(allowedOriginMatches('https://example.com', new URL('https://example.com/a/b'))).toBe(true);
    expect(allowedOriginMatches('https://example.com', new URL('https://example.com'))).toBe(true);
    expect(allowedOriginMatches('https://example.com', new URL('https://example.org/a'))).toBe(false);
    expect(allowedOriginMatches('https://example.com', new URL('http://example.com/a'))).toBe(false);
    expect(allowedOriginMatches('https://example.com', new URL('https://sub.example.com/a'))).toBe(false);
  });

  it('supports the 127.0.0.1:* port band for explicit local grants', () => {
    expect(allowedOriginMatches('http://127.0.0.1:*', new URL('http://127.0.0.1:3000/'))).toBe(true);
    expect(allowedOriginMatches('http://127.0.0.1:*', new URL('http://127.0.0.1:80/'))).toBe(true);
    expect(allowedOriginMatches('http://127.0.0.1:*', new URL('http://localhost:3000/'))).toBe(false);
  });
});

describe('assertBrowserAction gate', () => {
  it('admits a public open with a public grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const r = assertBrowserAction({ op: 'open', url: 'https://example.com/' }, makeConfig(root));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.downloadDir).toBe(join(root, 'browser-downloads', 'session'));
  });

  it('denies an open to a private host through a public grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const r = assertBrowserAction({ op: 'open', url: 'http://127.0.0.1:8080/' }, makeConfig(root));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_destination_out_of_scope');
  });

  it('denies non-http(s) schemes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const r = assertBrowserAction({ op: 'open', url: 'file:///etc/passwd' }, makeConfig(root));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_bad_url');
  });

  it('denies unknown ops', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const r = assertBrowserAction({ op: 'hack' }, makeConfig(root));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_unsupported_op');
  });

  it('denies an op whose capability is not granted', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const cfg = makeConfig(root, ['browser.open']);
    const r = assertBrowserAction({ op: 'submit', selector: '#go' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_capability_not_granted');
  });

  it('denies with a clear refusal when no browser grant exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const cfg = { ...makeConfig(root), browser: [] };
    const r = assertBrowserAction({ op: 'read' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_not_granted');
  });

  it('scopes an upload into a granted workspace and rejects escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    mkdirSync(join(root, 'in'), { recursive: true });
    const ok = assertBrowserAction({ op: 'upload', selector: 'input[type=file]', path: 'in/report.pdf' }, makeConfig(root));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.absUploadPath).toBe(join(root, 'in', 'report.pdf'));

    const esc = assertBrowserAction({ op: 'upload', selector: 'input[type=file]', path: '../outside.pdf' }, makeConfig(root));
    expect(esc.ok).toBe(false);
    if (!esc.ok) expect(esc.errorCode).toBe('browser_upload_out_of_scope');

    const prot = assertBrowserAction({ op: 'upload', selector: 'input[type=file]', path: '.env' }, makeConfig(root));
    expect(prot.ok).toBe(false);
    if (!prot.ok) expect(prot.errorCode).toBe('browser_upload_protected');
  });

  it('rejects a download of a private host through a public grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const r = assertBrowserAction({ op: 'download', url: 'http://127.0.0.1:9000/data.bin' }, makeConfig(root));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('browser_destination_out_of_scope');
  });

  it('requires a workspace for upload/download scoping', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-ct-'));
    const cfg = { ...makeConfig(root), workspaces: [] as AgentConfig['workspaces'] };
    const up = assertBrowserAction({ op: 'upload', selector: 'input[type=file]', path: 'a.txt' }, cfg);
    expect(up.ok).toBe(false);
    const dl = assertBrowserAction({ op: 'download' }, cfg);
    expect(dl.ok).toBe(false);
  });
});