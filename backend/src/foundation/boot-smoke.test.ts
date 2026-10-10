import { describe, it, expect } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';

function request(port: number, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) =>
      resolve({ status: res.statusCode ?? 0 }),
    );
    req.on('error', reject);
    req.end();
  });
}

describe('application boot (P0-03 regression)', () => {
  it('createApp() mounts the integration hub router (401, not 404)', async () => {
    const app = createApp();
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { status } = await request(port, '/api/v1/integrations/hub');
      // A mounted integration-hub router is auth-gated (requireAuth + paid):
      // unauthenticated caller MUST get 401, NOT 404. A missing/dead mount
      // surfaces as 404 — the exact P0-03 boot blocker this guards.
      expect(status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});