/**
 * CodeConClave — Google adapter unit tests (no network).
 *
 * Covers the three pure helpers behind one-click Gmail connect and in-app
 * reading/replying: the OAuth authorize URL (login_hint preselects the typed
 * account), full-body plain-text extraction, and the RFC-822 send builder.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_REDIRECT_URI: 'https://app.example.com/auth/google/callback',
    GOOGLE_OAUTH_CONSENT_MODE: 'select_account',
  },
  enabledGoogleScopes: ['https://www.googleapis.com/auth/gmail.send'],
}));

import { googleAuthorizeUrl, extractPlainText, buildSendRaw } from './google.js';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('googleAuthorizeUrl', () => {
  it('keeps the existing OAuth params when no hint is given', () => {
    const url = new URL(googleAuthorizeUrl('state-1'));
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('login_hint')).toBeNull();
  });

  it('preselects the typed account with login_hint', () => {
    const url = new URL(googleAuthorizeUrl('state-2', 'saharsh@example.com'));
    expect(url.searchParams.get('login_hint')).toBe('saharsh@example.com');
  });

  it('ignores invalid hints instead of breaking connect', () => {
    for (const bad of ['', 'not-an-email', 'a@b', 'x y@z.com']) {
      expect(new URL(googleAuthorizeUrl('s', bad)).searchParams.get('login_hint')).toBeNull();
    }
  });
});

describe('extractPlainText', () => {
  it('decodes a single-part body', () => {
    const out = extractPlainText({ mimeType: 'text/plain', body: { data: b64url('hello inbox') } });
    expect(out).toEqual({ text: 'hello inbox', truncated: false });
  });

  it('prefers text/plain inside nested multiparts', () => {
    const out = extractPlainText({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<b>hi</b>') } },
        { mimeType: 'multipart/related', parts: [{ mimeType: 'text/plain', body: { data: b64url('plain wins') } }] },
      ],
    });
    expect(out.text).toBe('plain wins');
  });

  it('returns empty (never throws) for missing or unreadable bodies', () => {
    expect(extractPlainText(null)).toEqual({ text: '', truncated: false });
    expect(extractPlainText({ mimeType: 'text/plain' })).toEqual({ text: '', truncated: false });
    expect(extractPlainText({ mimeType: 'text/plain', body: { data: '!!!not-base64!!!' } })).toEqual({
      text: '',
      truncated: false,
    });
  });

  it('truncates huge bodies with a flag', () => {
    const out = extractPlainText({ mimeType: 'text/plain', body: { data: b64url('x'.repeat(60000)) } });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(50000);
  });
});

describe('buildSendRaw', () => {
  it('matches the established raw format for new mail', () => {
    expect(buildSendRaw({ to: ['a@x.com', 'b@x.com'], subject: 'Hi', body: 'body here' })).toBe(
      'To: a@x.com, b@x.com\r\nSubject: Hi\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody here',
    );
  });

  it('threads replies with In-Reply-To and References', () => {
    const raw = buildSendRaw({ to: ['a@x.com'], subject: 'Re: Hi', body: 'reply', inReplyTo: '<msg1@mail>' });
    expect(raw).toContain('In-Reply-To: <msg1@mail>');
    expect(raw).toContain('References: <msg1@mail>');
  });
});
