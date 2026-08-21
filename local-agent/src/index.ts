/**
 * CodeConClave Local Agent — CLI (Section 6.6, 6.5 cross-platform).
 * Commands: init, status, pair, serve, workspaces, selftest, unpair.
 * Never executes cloud tasks: LOCAL tasks wait for this agent to be online.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { VERSION, loadConfig, saveConfig, type AgentConfig } from './config.js';
import { resolveWorkspacePath, classifyCommand, isProtectedPath, gateTerminalInput } from './policy.js';
import { sha256 } from './diff.js';
import { listDirectory, readFile, proposeEdit, applyEdit, fileMetadata } from './files.js';
import { TerminalSession } from './terminal.js';
import { HubClient } from './hub.js';

const DEFAULT_BACKEND = process.env.CODECONCLAVE_BACKEND_URL ?? 'http://localhost:4000';
const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell' : 'bash';
const MAX_TERMINAL_TABS = 8;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ------------------------------------------------------------------ init / status

function cmdInit(backendUrl: string): void {
  const existing = loadConfig();
  if (existing && existing.pairedTo) {
    console.error('Local Agent is already initialized and paired. Run `codeconclave-agent status`.');
    process.exit(1);
  }
  const deviceSecret = randomHex(32);
  const config: AgentConfig = {
    version: VERSION,
    deviceId: existing?.deviceId ?? `la_${randomHex(12)}`,
    deviceSecretHash: sha256Hex(deviceSecret),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    backendUrl: backendUrl || existing?.backendUrl,
    workspaces: existing?.workspaces ?? [],
  };
  saveConfig(config);
  console.log('');
  console.log('CodeConClave Local Agent initialized.');
  console.log('');
  console.log('  device id    : ' + config.deviceId);
  console.log('  backend      : ' + (config.backendUrl ?? '(set at pair time)'));
  console.log('  secret (one-time display, never stored):');
  console.log('  ' + deviceSecret);
  console.log('');
  console.log('Next: pair with your account, then add a workspace:');
  console.log('  npx codeconclave-agent@latest pair <deviceId> <code>');
  console.log('  npx codeconclave-agent@latest workspaces add <absolute-path>');
}

function cmdStatus(): void {
  const config = loadConfig();
  if (!config) {
    console.log('Not initialized. Run `codeconclave-agent init`.');
    return;
  }
  console.log('');
  console.log('CodeConClave Local Agent — status');
  console.log('  version  : ' + config.version);
  console.log('  deviceId : ' + config.deviceId);
  console.log('  createdAt: ' + config.createdAt);
  console.log('  pairedTo : ' + (config.pairedTo ?? '(not paired)'));
  console.log('  backend  : ' + (config.backendUrl ?? '—'));
  console.log('  workspaces:');
  for (const w of config.workspaces ?? []) {
    console.log(`    - ${w.root} (${(w.capabilities ?? []).join(', ') || 'read'})`);
  }
  if ((config.workspaces ?? []).length === 0) {
    console.log('    (none — add one with `codeconclave-agent workspaces add <path>`)');
  }
}

// ------------------------------------------------------------------ pair

async function cmdPair(deviceId: string, code: string, backendUrl: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('Not initialized. Run `codeconclave-agent init` first.');
    process.exit(1);
  }
  if (config.pairedTo) {
    console.error('Already paired. Run `codeconclave-agent unpair` first to re-pair.');
    process.exit(1);
  }
  const base = backendUrl || config.backendUrl || DEFAULT_BACKEND;
  console.log('Pairing with ' + base + ' ...');
  const res = await fetch(`${base}/api/v1/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, code }),
  });
  const body = (await res.json().catch(() => null)) as { data?: { token?: string }; error?: { message?: string } } | null;
  if (!res.ok || !body?.data?.token) {
    console.error('Pairing failed: ' + (body?.error?.message ?? `HTTP ${res.status}`));
    process.exit(1);
  }
  config.token = body.data.token;
  config.pairedTo = base;
  config.backendUrl = base;
  saveConfig(config);
  console.log('Paired. Token stored (0600) at ' + config.deviceId);
  console.log('Run `codeconclave-agent serve` to connect.');
}

function cmdUnpair(): void {
  const config = loadConfig();
  if (!config) return;
  config.token = undefined;
  config.pairedTo = undefined;
  saveConfig(config);
  console.log('Unpaired. The cloud device record remains; revoke it from Remote Control.');
}

// ------------------------------------------------------------------ workspaces

function cmdWorkspaces(action: string, arg: string): void {
  const config = loadConfig();
  if (!config) {
    console.error('Not initialized. Run `codeconclave-agent init` first.');
    process.exit(1);
  }
  config.workspaces ??= [];
  switch (action) {
    case 'add': {
      const root = normalize(arg);
      if (!isAbsolute(root)) {
        console.error('Workspace root must be an absolute path.');
        process.exit(1);
      }
      if (existsSync(root)) {
        config.workspaces.push({ root, name: root.split(/[\\/]/).pop() ?? root, capabilities: ['file_read', 'file_write', 'terminal_exec', 'git_op'] });
        saveConfig(config);
        console.log('Added workspace: ' + root);
        console.log('  capabilities: file_read, file_write, terminal_exec, git_op');
        console.log('  The deny-by-default policy still protects .env, .ssh, keys, credentials.');
      } else {
        console.error('Path does not exist: ' + root);
        process.exit(1);
      }
      return;
    }
    case 'list':
      cmdStatus();
      return;
    case 'remove': {
      const root = normalize(arg);
      config.workspaces = config.workspaces.filter((w) => w.root !== root);
      saveConfig(config);
      console.log('Removed workspace: ' + root);
      return;
    }
    default:
      console.error('usage: codeconclave-agent workspaces <add|list|remove> [path]');
      process.exit(1);
  }
}

// ------------------------------------------------------------------ selftest

function cmdSelfTest(): void {
  const config = loadConfig();
  if (!config) {
    console.error('Not initialized. Run `codeconclave-agent init` first.');
    process.exit(1);
  }
  console.log('CodeConClave Local Agent — security self-test');
  const checks: Array<[string, boolean, string]> = [
    ['config exists', Boolean(config), config?.deviceId ?? ''],
    ['device token stored', Boolean(config.token), config.pairedTo ?? '(not paired)'],
    ['workspace roots present', (config.workspaces ?? []).length > 0, `${(config.workspaces ?? []).length} workspace(s)`],
    ['.env blocked by policy', isProtectedPath(join(config.workspaces?.[0]?.root ?? homedir(), '.env')), 'deny-by-default'],
    ['.ssh blocked by policy', isProtectedPath(join(config.workspaces?.[0]?.root ?? homedir(), '.ssh', 'id_rsa')), 'deny-by-default'],
    ['id_rsa blocked by policy', isProtectedPath(join(config.workspaces?.[0]?.root ?? homedir(), 'id_rsa')), 'deny-by-default'],
    ['traversal blocked', resolveWorkspacePath(config.workspaces?.[0]?.root ?? '', '../outside').ok === false, 'path containment'],
    ['dangerous command blocked', classifyCommand('rm -rf /').allowed === false, 'command safety'],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? 'All checks passed.' : `${failed} check(s) FAILED — do not connect until resolved.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ serve

async function cmdServe(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('Not initialized. Run `codeconclave-agent init`, `pair`, and `workspaces add` first.');
    process.exit(1);
  }
  if (!config.token || !config.pairedTo) {
    console.error('Not paired. Run `codeconclave-agent pair <deviceId> <code>`.');
    process.exit(1);
  }
  if ((config.workspaces ?? []).length === 0) {
    console.error('No workspaces. Add one: `codeconclave-agent workspaces add <path>`.');
    process.exit(1);
  }

  const terminals = new Map<string, TerminalSession>();
  const handlers: { handleCommand: (corrId: string, cmd: Record<string, unknown>) => Promise<void> } = {
    handleCommand: async (corrId, cmd) => {
      const kind = String(cmd.kind ?? '');
      const root = workspaceFor(config, String(cmd.path ?? ''));
      const relay = (payload: unknown) => hub.send({ type: 'cmd_result', corrId, ok: true, payload });
      const relayError = (error: string) => hub.send({ type: 'cmd_result', corrId, ok: false, error });
      const stream = (channel: string, text: string, tabId?: string) =>
        hub.send({ type: 'cmd_stream', corrId, channel, text, tabId });

      switch (kind) {
        case 'terminal.start': {
          const tabId = String(cmd.tabId ?? 'tab_1');
          if (terminals.size >= MAX_TERMINAL_TABS) return relayError('too many terminal tabs');
          const shell = String(cmd.shell ?? DEFAULT_SHELL);
          const gate = gateTerminalInput(shell);
          if (!gate.allowed) return relayError(`policy_denied: ${gate.reason}`);
          const cwd = root?.ok ? root.abs : (config.workspaces?.[0]?.root ?? homedir());
          const existing = terminals.get(tabId);
          if (existing) return relayError('tab already exists — restart it instead');
          const rawTimeout = Number(cmd.timeoutMs ?? 0);
          const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 24 * 60 * 60 * 1000) : undefined;
          const session = new TerminalSession(tabId, shell, cwd, timeoutMs ? { timeoutMs } : {});
          session.on('output', (ch, text) => stream(ch, text, tabId));
          session.on('status', (id, status, code) =>
            hub.send({
              type: 'cmd_stream',
              corrId,
              channel: 'status',
              text: JSON.stringify({ tabId: id, status, exitCode: code, pid: session.getStatus().pid }),
            }),
          );
          terminals.set(tabId, session);
          const started = session.start();
          if (!started.ok) return relayError(started.error ?? 'start failed');
          relay({ tabId, shell, cwd, status: session.getStatus() });
          return;
        }
        case 'terminal.input': {
          const tabId = String(cmd.tabId ?? '');
          const session = terminals.get(tabId);
          if (!session) return relayError('unknown tab');
          const gate = gateTerminalInput(String(cmd.data ?? ''));
          if (!gate.allowed) return relayError(`policy_denied: ${gate.reason}`);
          session.write(String(cmd.data ?? ''));
          return;
        }
        case 'terminal.stop': {
          const tabId = String(cmd.tabId ?? '');
          const session = terminals.get(tabId);
          if (!session) return relayError('unknown tab');
          session.stop();
          terminals.delete(tabId);
          relay({ tabId, status: session.getStatus() });
          return;
        }
        case 'terminal.restart': {
          const tabId = String(cmd.tabId ?? '');
          const session = terminals.get(tabId);
          if (!session) return relayError('unknown tab');
          session.restart();
          relay({ tabId, status: session.getStatus() });
          return;
        }
        case 'file.list': {
          if (!root?.ok) return relayError(root?.reason ?? 'no workspace covers this path');
          const result = listDirectory(root.abs, requestedWithin(root, String(cmd.path ?? '/')), Number(cmd.limit ?? 200));
          if (result.error) return relayError(result.error);
          relay({ entries: result.entries, root: root.abs });
          return;
        }
        case 'file.metadata': {
          if (!root?.ok) return relayError(root?.reason ?? 'no workspace covers this path');
          const meta = fileMetadata(root.abs, requestedWithin(root, String(cmd.path ?? '')));
          if ('error' in meta) return relayError(meta.error as string);
          relay(meta);
          return;
        }
        case 'file.read': {
          if (!root?.ok) return relayError(root?.reason ?? 'no workspace covers this path');
          if (!hasCap(config, root.abs, 'file_read')) return relayError('capability file_read not granted for this workspace');
          const result = readFile(root.abs, requestedWithin(root, String(cmd.path ?? '')));
          if (!result.ok) return relayError(result.error);
          relay(result);
          return;
        }
        case 'file.diff': {
          if (!root?.ok) return relayError(root?.reason ?? 'no workspace covers this path');
          if (!hasCap(config, root.abs, 'file_write')) return relayError('capability file_write not granted for this workspace');
          const proposal = proposeEdit(root.abs, requestedWithin(root, String(cmd.path ?? '')), String(cmd.content ?? ''));
          relay(proposal);
          return;
        }
        case 'file.write': {
          if (!root?.ok) return relayError(root?.reason ?? 'no workspace covers this path');
          if (!hasCap(config, root.abs, 'file_write')) return relayError('capability file_write not granted for this workspace');
          const proposal = applyEdit(root.abs, requestedWithin(root, String(cmd.path ?? '')), String(cmd.content ?? ''));
          if (!proposal.allowed) return relayError(proposal.reason);
          hub.send({
            type: 'tool_result',
            jobId: String(cmd.taskId ?? ''),
            output: {
              path: proposal.path,
              beforeHash: proposal.beforeHash,
              afterHash: proposal.afterHash,
              diff: proposal.diff,
              backupPath: proposal.backupPath ?? null,
            },
          });
          relay({ path: proposal.path, beforeHash: proposal.beforeHash, afterHash: proposal.afterHash, backupPath: proposal.backupPath ?? null });
          return;
        }
        default:
          relayError('unknown_command');
      }
    },
  };

  const hub = new HubClient(config, handlers);

  hub.setStateListener((online: boolean) => {
    console.log(online ? '● connected to cloud hub' : '○ disconnected from cloud hub (reconnecting with backoff)');
  });
  hub.connect();
  console.log(`CodeConClave Local Agent serving on ${config.pairedTo} (device ${config.deviceId})`);
  console.log('Local tasks wait for this connection (WAITING_FOR_LOCAL_AGENT). Press Ctrl+C to stop.');
  const shutdown = () => {
    hub.stop();
    for (const t of terminals.values()) t.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

function workspaceFor(config: AgentConfig, path: string): { ok: true; abs: string } | { ok: false; reason: string } {
  for (const w of config.workspaces ?? []) {
    const resolved = resolveWorkspacePath(w.root, path);
    if (resolved.ok) return resolved;
  }
  return { ok: false, reason: 'path is not inside any granted workspace' };
}

function requestedWithin(scope: { abs: string }, path: string): string {
  return path.startsWith(scope.abs) ? path.slice(scope.abs.length).replace(/^[\\/]/, '') || '.' : path;
}

function hasCap(config: AgentConfig, root: string, cap: string): boolean {
  return (config.workspaces ?? []).some((w) => w.root === root && (w.capabilities ?? []).includes(cap));
}

// ------------------------------------------------------------------ main

function usage(): void {
  console.log(
    [
      'CodeConClave Local Agent v' + VERSION,
      '',
      'usage: codeconclave-agent <command> [args]',
      '',
      'commands:',
      '  init [--backend <url>]           generate device credentials (secret shown once)',
      '  status                           show initialization / pairing / workspace state',
      '  pair <deviceId> <code> [url]     exchange the 6-digit pairing code for a device token',
      '  unpair                           remove the stored token (revoke in app too)',
      '  serve                            connect to the cloud hub and execute local commands',
      '  workspaces add <abs-path>        grant a workspace (read/write/terminal within it)',
      '  workspaces list                  list granted workspaces',
      '  workspaces remove <abs-path>     revoke a workspace grant',
      '  selftest                         verify policy + configuration before serving',
      '  help                             show this message',
      '',
      'env: CODECONCLAVE_BACKEND_URL (default http://localhost:4000)',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flagBackend = (): string => {
    const idx = args.indexOf('--backend');
    return idx >= 0 && args[idx + 1] ? args[idx + 1]! : DEFAULT_BACKEND;
  };
  switch (cmd) {
    case 'init':
      cmdInit(flagBackend());
      break;
    case 'status':
      cmdStatus();
      break;
    case 'pair': {
      const deviceId = args[1];
      const code = args[2];
      const backend = args[3] ?? flagBackend();
      if (!deviceId || !code) {
        console.error('usage: codeconclave-agent pair <deviceId> <6-digit code> [url]');
        process.exit(1);
      }
      await cmdPair(deviceId, code, backend);
      break;
    }
    case 'unpair':
      cmdUnpair();
      break;
    case 'workspaces': {
      const action = args[1];
      const arg = args[2] ?? '';
      if (!action) {
        console.error('usage: codeconclave-agent workspaces <add|list|remove> [path]');
        process.exit(1);
      }
      cmdWorkspaces(action, arg);
      break;
    }
    case 'selftest':
      cmdSelfTest();
      break;
    case 'serve':
      await cmdServe();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      break;
    default:
      console.error('Unknown command: ' + cmd);
      usage();
      process.exitCode = 1;
  }
}

void main();
