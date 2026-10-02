/**
 * CodeConclave — customer Google sign-in REMOVAL verification.
 *
 * Customer Google OAuth login no longer exists: there is no authorize route,
 * no login redirect, and no session creation from Google identity. The
 * /google/callback path survives SOLELY as the registered redirect URI for
 * third-party plugin-connector OAuth (discriminated by plugin state tokens);
 * any non-plugin state is rejected with 404 and can never mint a session.
 * Historical google_connections rows are preserved (no destructive
 * migration); affected users sign in via email OTP and enroll
 * handle/keyword/key.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { createApp } from '../app.js';
import { pluginOAuthStateToken } from '../modules/plugins/engine.js';

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('CUSTOMER GOOGLE SIGN-IN — removed', () => {
  it('has no authorize route (no login redirect exists)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/auth/google/authorize`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('not_found');
    });
  });

  it('rejects non-plugin callback states with 404 and sets no session', async () => {
    await withServer(async (base) => {
      for (const qs of ['?code=abc&state=csrf-challenge', '?code=abc&state=', '?code=&state=', '']) {
        const res = await fetch(`${base}/api/v1/auth/google/callback${qs}`);
        expect(res.status).toBe(404);
        const setCookie = res.headers.get('set-cookie') ?? '';
        expect(setCookie).not.toContain('cc_session');
      }
    });
  });

  it('still routes plugin-connector OAuth states to the plugin flow (no 404)', async () => {
    // A correctly signed plugin state must NOT take the removed-login 404
    // path: it proceeds into plugin verification (which fails later on the
    // unknown connection, proving the plugin branch — not the login branch —
    // handled it). No session is created either way.
    const state = pluginOAuthStateToken('usr_plugin_test', 'conn_missing');
    await withServer(async (base) => {
      const res = await fetch(
        `${base}/api/v1/auth/google/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).not.toBe(404);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).not.toContain('cc_session');
    });
  });

  it('plugin and customer states are mutually unintelligible namespaces', async () => {
    // A customer-shaped state can never be mistaken for a plugin state, so
    // the retained callback cannot be tricked into the removed login flow.
    const { isPluginOAuthState } = await import('../modules/plugins/engine.js');
    expect(isPluginOAuthState('csrf-challenge')).toBe(false);
    expect(isPluginOAuthState('')).toBe(false);
    expect(isPluginOAuthState(pluginOAuthStateToken('u1', 'c1'))).toBe(true);
  });
});
