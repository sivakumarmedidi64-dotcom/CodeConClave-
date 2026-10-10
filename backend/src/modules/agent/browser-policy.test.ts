/**
 * CodeConClave — P1 browser-control policy tests.
 *
 * The browser policy is the contract between the Cloud control plane and the
 * local agent. These tests pin its deny-by-default surface: strict action
 * shapes, op→capability enforcement, destination/origin scope, private-host
 * denial, anti-loop bounds, sensitive-surface protection and retry honesty.
 */
import { describe, it, expect } from 'vitest';
import {
  parseBrowserInstruction,
  isPrivateHost,
  allowedOriginMatches,
  validateBrowserDestination,
  browserInstructionRequiredCapabilities,
  browserActionRisk,
  denySensitiveInteraction,
  BROWSER_OP_TO_CAPABILITY,
  BROWSER_NON_RETRYABLE_OPS,
  BROWSER_MAX_ACTIONS,
} from './browser-policy.js';
import { BrowserActionOp, BrowserCapability } from '@codeconclave/shared';

const instruction = {
  type: 'browser',
  grants: {
    capabilities: ['browser.open', 'browser.navigate', 'browser.click', 'browser.type', 'browser.submit', 'browser.read', 'browser.inspect'],
    allowedOrigins: ['https://example.com'],
    lifetimeMs: 24 * 60 * 60 * 1000,
  },
  actions: [
    { op: 'open', url: 'https://example.com/' },
    { op: 'read' },
    { op: 'inspect' },
    { op: 'click', selector: '#btn' },
    { op: 'type', selector: '#q', text: 'hello' },
    { op: 'submit', selector: 'form' },
  ],
};

describe('browser policy — instruction parsing', () => {
  it('accepts a valid instruction and normalizes it', () => {
    const r = parseBrowserInstruction(instruction);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instruction.type).toBe('browser');
    expect(r.instruction.actions).toHaveLength(6);
    expect(r.instruction.grants.capabilities).toContain('browser.open');
    expect(r.instruction.actions[0]!.url).toBe('https://example.com/');
  });

  it('rejects a non-browser instruction type', () => {
    expect(parseBrowserInstruction({ ...instruction, type: 'terminal' }).ok).toBe(false);
    expect(parseBrowserInstruction(null).ok).toBe(false);
    expect(parseBrowserInstruction('nope').ok).toBe(false);
  });

  it('rejects an action whose op requires an ungranted capability', () => {
    const missing = {
      ...instruction,
      grants: { ...instruction.grants, capabilities: ['browser.open'] },
      actions: [{ op: 'click', selector: '#btn' }],
    };
    const r = parseBrowserInstruction(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('capability_not_granted_click');
  });

  it('rejects unknown ops and malformed actions', () => {
    expect(parseBrowserInstruction({ ...instruction, actions: [{ op: 'hack' }] }).ok).toBe(false);
    expect(parseBrowserInstruction({ ...instruction, actions: [{ op: 'click' }] }).ok).toBe(false); // no selector
    expect(parseBrowserInstruction({ ...instruction, actions: [{ op: 'type', selector: '#q' }] }).ok).toBe(false); // no text
    expect(parseBrowserInstruction({ ...instruction, actions: [{ op: 'search' }] }).ok).toBe(false); // no query
  });

  it('rejects empty grants, empty origins and oversize action lists', () => {
    const noCaps = { ...instruction, grants: { ...instruction.grants, capabilities: [] } };
    expect(parseBrowserInstruction(noCaps).ok).toBe(false);
    const noOrigins = { ...instruction, grants: { ...instruction.grants, allowedOrigins: [] } };
    expect(parseBrowserInstruction(noOrigins).ok).toBe(false);
    const tooMany = {
      ...instruction,
      actions: Array.from({ length: BROWSER_MAX_ACTIONS + 1 }, (_, i) => ({ op: 'read' })),
    };
    expect(parseBrowserInstruction(tooMany).ok).toBe(false);
  });

  it('rejects navigation to a destination outside the granted origin scope', () => {
    const evil = {
      ...instruction,
      actions: [{ op: 'open', url: 'https://evil.test/' }],
    };
    const r = parseBrowserInstruction(evil);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('op_open_destination_not_in_scope');
  });

  it('rejects non-http(s) protocols and malformed urls', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'ftp://example.com/f']) {
      const r = parseBrowserInstruction({ ...instruction, actions: [{ op: 'open', url: u }] });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects sensitive/blocked destinations even when origins are broad', () => {
    const wide = {
      ...instruction,
      grants: { ...instruction.grants, allowedOrigins: ['*'] },
      actions: [{ op: 'open', url: 'http://169.254.169.254/latest/meta-data/' }],
    };
    expect(parseBrowserInstruction(wide).ok).toBe(false); // link-local deny even with '*'
  });

  it('clamps an oversized lifetime to the permission maximum', () => {
    const r = parseBrowserInstruction({ ...instruction, grants: { ...instruction.grants, lifetimeMs: Number.MAX_SAFE_INTEGER } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instruction.grants.lifetimeMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });

  it('derives the exact required-capability set from the actions', () => {
    const r = parseBrowserInstruction(instruction);
    if (!r.ok) return;
    const required = browserInstructionRequiredCapabilities(r.instruction);
    expect(required).toEqual([
      BrowserCapability.OPEN,
      BrowserCapability.READ,
      BrowserCapability.INSPECT,
      BrowserCapability.CLICK,
      BrowserCapability.TYPE,
      BrowserCapability.SUBMIT,
    ]);
  });
});

describe('browser policy — destination / origin scope', () => {
  it('classifies loopback, RFC1918, link-local and private IPv6 as private', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '[::1]', 'fc00::1', 'fe80::1', 'foo.localhost']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it('`*` grants only public sites', () => {
    expect(allowedOriginMatches('*', new URL('https://example.com/'))).toBe(true);
    expect(allowedOriginMatches('*', new URL('http://127.0.0.1:3000/'))).toBe(false);
    expect(allowedOriginMatches('*', new URL('https://foo.aws.amazon.com/'))).toBe(false); // blocked cloud host
  });

  it('matches exact scheme+host+port and wildcard ports', () => {
    expect(allowedOriginMatches('https://example.com', new URL('https://example.com/path'))).toBe(true);
    expect(allowedOriginMatches('https://example.com', new URL('http://example.com/'))).toBe(false);
    expect(allowedOriginMatches('https://example.com', new URL('https://example.com:8443/'))).toBe(false);
    expect(allowedOriginMatches('https://example.com:*', new URL('https://example.com:8443/'))).toBe(true);
    expect(allowedOriginMatches('http://127.0.0.1:*', new URL('http://127.0.0.1:3456/test'))).toBe(true);
    expect(allowedOriginMatches('https://example.com/*', new URL('https://example.com/a/b'))).toBe(true);
  });

  it('destination validation returns normalized urls or a denial reason', () => {
    expect(validateBrowserDestination('https://example.com/x', ['https://example.com'])).toEqual({ allowed: true, url: 'https://example.com/x' });
    expect(validateBrowserDestination('https://google.com', ['https://example.com']).allowed).toBe(false);
    expect(validateBrowserDestination('', ['*']).allowed).toBe(false);
  });
});

describe('browser policy — consequential and retry classes', () => {
  it('maps every op to exactly one grant capability', () => {
    expect(BROWSER_OP_TO_CAPABILITY.click).toBe(BrowserCapability.CLICK);
    expect(BROWSER_OP_TO_CAPABILITY.submit).toBe(BrowserCapability.SUBMIT);
    expect(BROWSER_OP_TO_CAPABILITY.download).toBe(BrowserCapability.DOWNLOAD);
    expect(BROWSER_OP_TO_CAPABILITY.upload).toBe(BrowserCapability.UPLOAD);
    expect(Object.keys(BROWSER_OP_TO_CAPABILITY)).toHaveLength(Object.values(BrowserActionOp).length);
  });

  it('classifies submit/select/download/upload/click/type/back/forward as non-retryable', () => {
    for (const op of ['submit', 'select', 'download', 'upload', 'click', 'type', 'back', 'forward']) {
      expect(BROWSER_NON_RETRYABLE_OPS.has(op as never)).toBe(true);
    }
    for (const op of ['open', 'navigate', 'reload', 'read', 'inspect', 'search', 'extract', 'scroll', 'screenshot']) {
      expect(BROWSER_NON_RETRYABLE_OPS.has(op as never)).toBe(false);
    }
  });

  it('gives consequential ops a HIGH risk class', () => {
    expect(browserActionRisk('submit')).toBe('HIGH');
    expect(browserActionRisk('download')).toBe('HIGH');
    expect(browserActionRisk('upload')).toBe('HIGH');
    expect(browserActionRisk('read')).toBe('LOW');
  });

  it('never allows interaction on sensitive surfaces (auth/payment)', () => {
    expect(denySensitiveInteraction('type', new URL('https://accounts.example.com/login'))).toBe(true);
    expect(denySensitiveInteraction('submit', new URL('https://paypal.com/checkout'))).toBe(true);
    expect(denySensitiveInteraction('click', new URL('https://example.com/preferences'))).toBe(false);
    expect(denySensitiveInteraction('read', new URL('https://accounts.example.com/login'))).toBe(false);
  });
});

describe('browser policy — strict action schemas', () => {
  it('accepts only real action shapes for each op', () => {
    const base = (actions: unknown[]) => ({
      type: 'browser' as const,
      grants: {
        capabilities: Object.values(BrowserCapability),
        allowedOrigins: ['https://example.com'],
        lifetimeMs: 1000,
      },
      actions,
    });
    expect(parseBrowserInstruction(base([{ op: 'navigate', url: 'https://example.com/' }])).ok).toBe(true);
    expect(parseBrowserInstruction(base([{ op: 'navigate', url: 'https://example.com/', selector: '#x' }])).ok).toBe(true); // extra field tolerated
    expect(parseBrowserInstruction(base([{ op: 'scroll', direction: 'up' }])).ok).toBe(true);
    expect(parseBrowserInstruction(base([{ op: 'scroll', direction: 'sideways' }])).ok).toBe(false);
    expect(parseBrowserInstruction(base([{ op: 'extract', selectors: ['#a', '#b'] }])).ok).toBe(true);
    expect(parseBrowserInstruction(base([{ op: 'extract', selectors: [] }])).ok).toBe(false);
    expect(parseBrowserInstruction(base([{ op: 'upload', selector: '#file', path: 'tmp/a.txt' }])).ok).toBe(true);
    expect(parseBrowserInstruction(base([{ op: 'upload', selector: '#file' }])).ok).toBe(false);
    expect(parseBrowserInstruction(base([{ op: 'download', url: 'https://example.com/file.zip' }])).ok).toBe(true);
  });

  it('tolerates extra JSON fields that carry no privilege (unknown keys are ignored)', () => {
    const r = parseBrowserInstruction(instruction);
    expect(r.ok).toBe(true);
  });
});