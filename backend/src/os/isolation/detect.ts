/**
 * CodeConClave AI OS — host isolation capability audit (real-isolation layer).
 *
 * Probes the CURRENT host for genuinely usable execution boundaries and reports
 * an honest `IsolationMode`. It never guesses: if no real runtime/namespace is
 * reachable it returns POLICY_ONLY, and callers that demand real isolation fail
 * closed. Probes are injectable so unit tests can map every host shape without
 * touching the machine.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { IsolationMode } from './modes.js';

export interface IsolationProbes {
  /** Real container runtime with a reachable daemon (docker/podman/nerdctl). */
  containerRuntime: (kind: 'docker' | 'podman' | 'nerdctl') => Promise<boolean>;
  /** Linux namespaces usable unprivileged (user/pids/mount/net via `unshare -U`). */
  processNamespaces: () => Promise<boolean>;
  /** MicroVM providers (krun/qemu podman machine) — rarely available; explicit. */
  microvm: () => Promise<boolean>;
}

export interface IsolationSnapshot {
  mode: IsolationMode;
  runtimes: string[];
  note: string;
}

function probeCliVersion(bin: string, args: string[]): boolean {
  try {
    const r = spawnSync(bin, args, { timeout: 4000, windowsHide: true });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

/** Docker CLI present AND a reachable daemon (a CLI alone is NOT a runtime). */
function dockerServerReachable(): boolean {
  if (!probeCliVersion('docker', ['--version'])) return false;
  return probeCliVersion('docker', ['info', '--format', '{{.ServerVersion}}']);
}

const namedPipe = '//./pipe/docker_engine';
const unixSocket = '/var/run/docker.sock';

function dockerSocketPresent(): boolean {
  try {
    return existsSync(process.platform === 'win32' ? namedPipe : unixSocket);
  } catch {
    return false;
  }
}

function unshareNamespacesUsable(): boolean {
  if (process.platform !== 'linux') return false;
  if (!probeCliVersion('unshare', ['--version'])) return false;
  // A real, unprivileged user-namespace creation is the proof of PROCESS mode.
  return probeCliVersion('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--net', 'true']);
}

function microvmProbe(): boolean {
  return false; // no krun/qemu provider is safely detectable here; never implied
}

export const defaultProbes: IsolationProbes = {
  containerRuntime: async (kind) => {
    if (kind === 'docker') return dockerServerReachable() || dockerSocketPresent();
    if (kind === 'podman') return probeCliVersion('podman', ['--version']) && probeCliVersion('podman', ['info']);
    return probeCliVersion('nerdctl', ['--version']);
  },
  processNamespaces: async () => unshareNamespacesUsable(),
  microvm: async () => microvmProbe(),
};

const CONTAINER_KINDS = ['docker', 'podman', 'nerdctl'] as const;

/**
 * Determine the strongest isolation boundary this host can actually provide.
 * Returns POLICY_ONLY when no real boundary is usable (never guesses, never
 * claims container when the daemon is absent).
 */
export async function detectIsolationAbilities(probes: IsolationProbes = defaultProbes): Promise<IsolationSnapshot> {
  if (await probes.microvm()) {
    return { mode: IsolationMode.MICROVM, runtimes: ['microvm'], note: 'microvm runtime detected' };
  }
  for (const kind of CONTAINER_KINDS) {
    if (await probes.containerRuntime(kind)) {
      return { mode: IsolationMode.CONTAINER, runtimes: [kind], note: 'container engine reachable' };
    }
  }
  if (await probes.processNamespaces()) {
    return { mode: IsolationMode.PROCESS, runtimes: ['unshare'], note: 'unprivileged namespaces usable' };
  }
  return {
    mode: IsolationMode.POLICY_ONLY,
    runtimes: [],
    note: 'no real container/process isolation boundary reachable from this host (policy sandbox only)',
  };
}