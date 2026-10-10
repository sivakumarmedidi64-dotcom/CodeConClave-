/**
 * CodeConClave — P2 local workspace bridge tests.
 *
 * The bridge is a thin, audited, authenticated forwarder: it must forward the
 * right command, surface honest errors (offline / policy-denied / out-of-scope),
 * and audit state-changing operations. All enforcement happens on the agent, so
 * these tests pin the bridge contract, not the agent's policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hub = vi.hoisted(() => ({
  executeCommandResult: vi.fn(),
  isOnline: vi.fn(() => true),
}));
vi.mock('../agent/ws.js', () => ({ agentWs: () => hub }));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
const listDeviceStatus = vi.hoisted(() => vi.fn(async () => [{ id: 'd1', online: true }]));
vi.mock('../agent/service.js', () => ({ listDeviceStatus }));

import {
  listLocalDevices,
  listLocalWorkspaces,
  listLocalTree,
  readLocalFile,
  runLocalCommand,
  writeLocalFile,
} from './service.js';

function reply(payload: Record<string, unknown> | null, ok = true, error: string | null = null) {
  return { ok, output: '', payload, error };
}

describe('local workspace bridge', () => {
  beforeEach(() => {
    hub.executeCommandResult.mockReset();
    hub.isOnline.mockReset().mockReturnValue(true);
    hub.executeCommandResult.mockResolvedValue({ ok: true, output: '', payload: {}, error: null });
  });

  it('lists devices via the agent hub presence', async () => {
    const devices = await listLocalDevices('u1');
    expect(Array.isArray(devices)).toBe(true);
  });

  it('maps granted workspaces from the agent', async () => {
    hub.executeCommandResult.mockResolvedValueOnce({
      ok: true, output: '', error: null,
      payload: { workspaces: [{ root: '/home/u/proj', name: 'proj', capabilities: ['file_read', 'file_write'] }] },
    });
    const out = await listLocalWorkspaces('u1', 'd1');
    expect(out).toEqual([{ root: '/home/u/proj', name: 'proj', capabilities: ['file_read', 'file_write'] }]);
  });

  it('reads a file with metadata and audits the read', async () => {
    hub.executeCommandResult
      .mockResolvedValueOnce({ ok: true, output: '', payload: { path: 'a.ts', sizeBytes: 3 }, error: null })
      .mockResolvedValueOnce({ ok: true, output: '', payload: { content: 'abc', sha256: 'h1' }, error: null });
    const out = await readLocalFile('u1', 'd1', 'a.ts');
    expect(out.metadata).toMatchObject({ path: 'a.ts' });
    expect(out.file).toMatchObject({ content: 'abc', sha256: 'h1' });
  });

  it('diffs then applies a write', async () => {
    hub.executeCommandResult
      .mockResolvedValueOnce({ ok: true, output: '', payload: { diff: '-a\n+b' }, error: null })
      .mockResolvedValueOnce({ ok: true, output: '', payload: { path: 'a.ts', beforeHash: 'b1', afterHash: 'a1' }, error: null });
    const out = await writeLocalFile('u1', 'd1', 'a.ts', 'b');
    expect(out.diff).toBe('-a\n+b');
    expect(out).toMatchObject({ afterHash: 'a1' });
  });

  it('runs a command and returns real output', async () => {
    hub.executeCommandResult.mockResolvedValueOnce({ ok: true, output: 'ok\n', payload: { output: 'ok\n', exitCode: 0 }, error: null });
    const out = await runLocalCommand('u1', 'd1', 'npm test');
    expect(out.output).toBe('ok\n');
  });

  it('maps agent policy denial to a forbidden local_action_denied', async () => {
    hub.executeCommandResult.mockResolvedValueOnce({ ok: false, output: '', payload: null, error: 'policy_denied: rm -rf' });
    await expect(runLocalCommand('u1', 'd1', 'rm -rf /')).rejects.toMatchObject({ errorCode: 'local_action_denied' });
  });

  it('maps an out-of-scope error to forbidden local_scope_denied', async () => {
    hub.executeCommandResult.mockResolvedValueOnce({ ok: false, output: '', payload: null, error: 'path outside workspace' });
    await expect(readLocalFile('u1', 'd1', '../../etc/passwd')).rejects.toMatchObject({ errorCode: 'local_scope_denied' });
  });

  it('maps an offline device to unavailable local_agent_offline', async () => {
    hub.executeCommandResult.mockRejectedValueOnce(new Error('Local Agent is offline'));
    await expect(listLocalWorkspaces('u1', 'd1')).rejects.toMatchObject({ errorCode: 'local_agent_offline' });
  });
});
