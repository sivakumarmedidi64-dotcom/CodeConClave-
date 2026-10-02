/**
 * CodeConClave — policy engine unit tests (deterministic, no DB required).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateToolCall,
  validWorkspacePath,
  looksLikeSecretPath,
  osSensitivePath,
  dangerousCommand,
  blockedNetworkHost,
  hasCapability,
  registerGrants,
  revokeGrants,
} from './policy.js';

describe('policy engine — deny-by-default baselines', () => {
  it('denies secret paths with no approval path', () => {
    expect(looksLikeSecretPath('.env')).toBe(true);
    expect(looksLikeSecretPath('backend/.env.local')).toBe(true);
    expect(looksLikeSecretPath('config/credentials.json')).toBe(true);
    expect(looksLikeSecretPath('src/index.ts')).toBe(false);
  });

  it('denies OS-sensitive prefixes', () => {
    expect(osSensitivePath('/etc/passwd')).toBe(true);
    expect(osSensitivePath('C:\\Windows\\system32')).toBe(true);
    expect(osSensitivePath('src/app/index.ts')).toBe(false);
  });

  it('rejects path traversal and absolute paths', () => {
    expect(validWorkspacePath('src/../.env')).toBe(false);
    expect(validWorkspacePath('/etc/passwd')).toBe(false);
    expect(validWorkspacePath('C:\\Windows\\x')).toBe(false);
    expect(validWorkspacePath('src/app/hello.ts')).toBe(true);
  });

  it('flags destructive commands', () => {
    expect(dangerousCommand('rm -rf /')).toBe(true);
    expect(dangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(dangerousCommand('npm test')).toBe(false);
  });

  it('blocks management-plane network hosts', () => {
    expect(blockedNetworkHost('https://s3.amazonaws.com/x')).toBe(true);
    expect(blockedNetworkHost('https://api.github.com/repos')).toBe(false);
    expect(blockedNetworkHost('not a url')).toBe(true);
  });

  it('file_read of a secret → denied', () => {
    const d = evaluateToolCall({ tool: 'file_read', input: { path: '.env' }, userId: 'u1' });
    expect(d.allowed).toBe(false);
  });

  it('file_read without capability → denied', () => {
    const d = evaluateToolCall({ tool: 'file_read', input: { path: 'src/index.ts' }, userId: 'u1' });
    expect(d).toMatchObject({ allowed: false, deniedBy: 'capability' });
  });

  it('file_read with capability and clean path → LOW, no approval', () => {
    registerGrants([{ id: 'g1', userId: 'u1', capability: 'READ_WORKSPACE', scope: 'src', expiresAt: Date.now() + 60_000 }]);
    const d = evaluateToolCall({ tool: 'file_read', input: { path: 'src/index.ts' }, userId: 'u1' });
    expect(d).toEqual({ allowed: true, risk: 'LOW', requiresApproval: false });
    revokeGrants('u1');
  });

  it('file_delete is HIGH risk → requires approval', () => {
    registerGrants([{ id: 'g2', userId: 'u1', capability: 'WRITE_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 }]);
    const d = evaluateToolCall({ tool: 'file_delete', input: { path: 'src/old.ts' }, userId: 'u1' });
    expect(d).toMatchObject({ allowed: true, risk: 'HIGH', requiresApproval: true });
    revokeGrants('u1');
  });

  it('terminal_exec of allowed command list only', () => {
    registerGrants([{ id: 'g3', userId: 'u1', capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + 60_000 }]);
    const d = evaluateToolCall({ tool: 'terminal_exec', input: { command: 'rm -rf /' }, userId: 'u1' });
    expect(d.allowed).toBe(false); // dangerous command wins before capability
    const ok = evaluateToolCall({ tool: 'terminal_exec', input: { command: 'npm test' }, userId: 'u1' });
    expect(ok).toMatchObject({ allowed: true, risk: 'LOW', requiresApproval: false });
    revokeGrants('u1');
  });

  it('unknown tool → denied', () => {
    const d = evaluateToolCall({ tool: 'not_a_tool', input: {}, userId: 'u1' });
    expect(d).toMatchObject({ allowed: false, deniedBy: 'unknown_tool' });
  });

  it('expired grants never authorize', () => {
    registerGrants([{ id: 'g4', userId: 'u1', capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() - 1 }]);
    const d = evaluateToolCall({ tool: 'file_read', input: { path: 'src/a.ts' }, userId: 'u1' });
    expect(d.allowed).toBe(false);
    revokeGrants('u1');
  });

  it('hasCapability checks scope prefix', () => {
    registerGrants([{ id: 'g5', userId: 'u1', capability: 'READ_WORKSPACE', scope: 'src/app', expiresAt: Date.now() + 60_000 }]);
    expect(hasCapability('u1', 'READ_WORKSPACE', 'src/app/x.ts')).toBe(true);
    expect(hasCapability('u1', 'READ_WORKSPACE', 'src/other.ts')).toBe(false);
    revokeGrants('u1');
  });
});