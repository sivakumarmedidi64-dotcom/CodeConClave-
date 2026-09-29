/**
 * CodeConClave — PKG-19 runtime — remote probes (verification + smoke).
 * Real network/TCP probing with injectable functions so tests remain fast and
 * deterministic. A probe that cannot run (no target configured, no network in
 * tests) returns the honest `UNAVAILABLE`/`BLOCKED` signal — never a fake PASS.
 */
export interface RemoteProbe {
  httpGet(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body?: string; error?: string }>;
  portOpen(host: string, port: number, timeoutMs: number): Promise<{ open: boolean; error?: string }>;
}

async function httpGet(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; body?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const body = (await res.text()).slice(0, 2000);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error)?.message ?? 'http error' };
  } finally {
    clearTimeout(timer);
  }
}

async function portOpen(host: string, port: number, timeoutMs: number): Promise<{ open: boolean; error?: string }> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ open: false, error: 'connection timeout' });
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ open: true });
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      resolve({ open: false, error: (err as Error)?.message ?? 'connection error' });
    });
  });
}

export const realProbe: RemoteProbe = { httpGet, portOpen };
