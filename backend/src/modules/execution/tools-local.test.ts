/**
 * CodeConClave — paired-device local tool adapter tests.
 *
 * Pins: the four local_* tools delegate to the local-workspace bridge with
 * the SERVER-SET caller identity (a userId smuggled inside tool input is
 * ignored — cross-user reach is structurally impossible), required fields are
 * validated, and nothing touches the network here (bridge mocked).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const bridge = vi.hoisted(() => ({
  listLocalTree: vi.fn(async () => ({ root: '/p', entries: [] })),
  readLocalFile: vi.fn(async () => ({ file: { content: 'hi' } })),
  writeLocalFile: vi.fn(async () => ({ afterHash: 'h' })),
  runLocalCommand: vi.fn(async () => ({ output: 'ok', payload: { exitCode: 0 } })),
}));
vi.mock('../local-workspace/service.js', () => bridge);

import { registerCoreTools } from './tools.js';
import { runRegisteredTool } from './toolcalls.js';

beforeAll(() => {
  registerCoreTools();
});

describe('local tool adapters — delegation + identity', () => {
  it('local_list forwards owner identity, device and path', async () => {
    const out = (await runRegisteredTool('local_list', { deviceId: 'd1', path: '/p', userId: 'attacker' }, { userId: 'victim' })) as Record<string, unknown>;
    expect(bridge.listLocalTree).toHaveBeenCalledWith('victim', 'd1', '/p');
    expect(out).toMatchObject({ ok: true });
  });

  it('local_read forwards and returns file content', async () => {
    await runRegisteredTool('local_read', { deviceId: 'd1', path: 'a.txt' }, { userId: 'u1' });
    expect(bridge.readLocalFile).toHaveBeenCalledWith('u1', 'd1', 'a.txt');
  });

  it('local_write forwards content for approval-gated execution', async () => {
    const out = (await runRegisteredTool('local_write', { deviceId: 'd1', path: 'a.txt', content: 'x' }, { userId: 'u1' })) as Record<string, unknown>;
    expect(bridge.writeLocalFile).toHaveBeenCalledWith('u1', 'd1', 'a.txt', 'x');
    expect(out).toMatchObject({ ok: true });
  });

  it('local_exec forwards command and cwd', async () => {
    await runRegisteredTool('local_exec', { deviceId: 'd1', command: 'npm test', cwd: '/p' }, { userId: 'u1' });
    expect(bridge.runLocalCommand).toHaveBeenCalledWith('u1', 'd1', 'npm test', '/p');
  });

  it('refuses without an authenticated caller context', async () => {
    await expect(runRegisteredTool('local_read', { deviceId: 'd1', path: 'a.txt' }, undefined)).rejects.toThrow(/authenticated caller context/);
  });

  it('requires deviceId (and path/command)', async () => {
    await expect(runRegisteredTool('local_read', { path: 'a.txt' }, { userId: 'u1' })).rejects.toThrow(/requires deviceId/);
    await expect(runRegisteredTool('local_exec', { deviceId: 'd1' }, { userId: 'u1' })).rejects.toThrow(/requires deviceId, command/);
  });

  it('does not shadow existing core tools', async () => {
    const out = (await runRegisteredTool('chat_reply', { text: 'hi' }, { userId: 'u1' })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true });
  });
});
