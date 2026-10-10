/**
 * CodeConClave — P1 browser instruction builder tests.
 * The backend is authoritative; these cover author-time validation + the
 * derived capabilities/origins the panel sends on POST.
 */
import { describe, it, expect } from 'vitest';
import {
  BrowserOp,
  BROWSER_MAX_ACTIONS,
  buildBrowserInstruction,
  deriveBrowserCapabilities,
  effectiveAllowedOrigins,
  originOf,
  summarizeAction,
  validateAction,
} from './browserInstruction';

describe('originOf', () => {
  it('returns the canonical origin for http(s) URLs', () => {
    expect(originOf('https://example.com/a/b')).toBe('https://example.com');
    expect(originOf('http://sub.example.com:8080/x')).toBe('http://sub.example.com:8080');
  });
  it('rejects non-http(s) and malformed input', () => {
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});

describe('deriveBrowserCapabilities', () => {
  it('maps every chosen op to its exact capability', () => {
    const caps = deriveBrowserCapabilities([
      { op: BrowserOp.OPEN, url: 'https://example.com' },
      { op: BrowserOp.CLICK, selector: '#go' },
      { op: BrowserOp.SUBMIT, selector: 'form' },
    ]);
    expect(caps.sort()).toEqual(['browser.click', 'browser.open', 'browser.submit']);
  });
});

describe('effectiveAllowedOrigins', () => {
  it('unions action URL origins with extra origins and caps at the max', () => {
    const origins = effectiveAllowedOrigins(
      [
        { op: BrowserOp.OPEN, url: 'https://example.com/start' },
        { op: BrowserOp.NAVIGATE, url: 'https://example.com/next' },
        { op: BrowserOp.DOWNLOAD, url: 'https://other.example.com/f' },
      ],
      ['https://dev.extra.example:4000'],
    );
    expect(origins).toEqual(['https://example.com', 'https://other.example.com', 'https://dev.extra.example:4000']);
    expect(origins.length).toBeLessThanOrEqual(20);
  });
});

describe('validateAction', () => {
  it('enforces the required fields per op', () => {
    expect(validateAction(BrowserOp.OPEN, { op: BrowserOp.OPEN, url: '' })).toMatch(/url/);
    expect(validateAction(BrowserOp.CLICK, { op: BrowserOp.CLICK, selector: '' })).toMatch(/selector/);
    expect(validateAction(BrowserOp.TYPE, { op: BrowserOp.TYPE, selector: '#q', text: 'hi' })).toBeNull();
    expect(validateAction(BrowserOp.SEARCH, { op: BrowserOp.SEARCH, query: '' })).toMatch(/query/);
    expect(validateAction(BrowserOp.SCROLL, { op: BrowserOp.SCROLL })).toMatch(/direction/);
    expect(validateAction(BrowserOp.RELOAD, { op: BrowserOp.RELOAD })).toBeNull();
  });
});

describe('buildBrowserInstruction', () => {
  it('builds a complete instruction with derived grants', () => {
    const { instruction, error } = buildBrowserInstruction({
      actions: [
        { op: BrowserOp.OPEN, url: 'https://example.com/' },
        { op: BrowserOp.SEARCH, query: 'hello' },
      ],
      lifetimeMs: 60 * 60 * 1000,
    });
    expect(error).toBeNull();
    expect(instruction).toEqual({
      type: 'browser',
      grants: {
        capabilities: ['browser.open', 'browser.read'],
        allowedOrigins: ['https://example.com'],
        lifetimeMs: 3600000,
      },
      actions: [
        { op: BrowserOp.OPEN, url: 'https://example.com/' },
        { op: BrowserOp.SEARCH, query: 'hello' },
      ],
    });
  });

  it('rejects empty action lists and overlong action lists', () => {
    expect(buildBrowserInstruction({ actions: [] }).error).toMatch(/at least one action/);
    const many = Array.from({ length: BROWSER_MAX_ACTIONS + 1 }, () => ({ op: BrowserOp.RELOAD } as { op: BrowserOp }));
    expect(buildBrowserInstruction({ actions: many }).error).toMatch(/at most 20 actions/);
  });

  it('clamps lifetime to the server max', () => {
    const { instruction } = buildBrowserInstruction({
      actions: [{ op: BrowserOp.OPEN, url: 'https://example.com/' }],
      lifetimeMs: 9999 * 24 * 60 * 60 * 1000,
    });
    expect(instruction!.grants.lifetimeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('reports author-time field errors with the action index', () => {
    const { error } = buildBrowserInstruction({
      actions: [{ op: BrowserOp.TYPE, selector: '', text: 'x' }],
    });
    expect(error).toMatch(/action 1: type requires a selector/);
  });
});

describe('summarizeAction', () => {
  it('renders a compact human string', () => {
    expect(summarizeAction({ op: BrowserOp.CLICK, selector: '#go' })).toContain('click #go');
  });
});