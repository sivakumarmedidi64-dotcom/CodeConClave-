/**
 * CodeConclave AI OS — DeviceRegistry (capability-gated devices).
 *
 * Selection + gate boundary for every execution device. `require` resolves a
 * device by id or kind, then checks: the caller's capability set against the
 * device's required capabilities (deny-by-default), and the device's real
 * availability. Fail-closed on both. Devices themselves never self-authorize;
 * the registry is the single door.
 */
import { AppError } from '../../shared/errors.js';
import { hasCapability, type CapabilitySet } from '../capabilities.js';
import { Capability, CapabilityKind } from '../types.js';
import { Device, DeviceKind } from './types.js';

export class DeviceRegistry {
  private devices = new Map<string, Device>();

  register(device: Device): Device {
    if (this.devices.has(device.id)) {
      throw AppError.conflict('aios_device_exists', `device '${device.id}' is already registered`);
    }
    this.devices.set(device.id, device);
    return device;
  }

  unregister(id: string): boolean {
    return this.devices.delete(id);
  }

  all(): Device[] {
    return [...this.devices.values()];
  }

  byKind(kind: DeviceKind): Device[] {
    return [...this.devices.values()].filter((d) => d.kind === kind);
  }

  /**
   * Capability + availability gate. Returns the device only when the caller
   * holds every required capability AND the device is host-verified available.
   */
  require(idOrKind: string, caps: CapabilitySet | Capability[], scope: string): Device {
    const device = this.resolve(idOrKind);
    if (!device) {
      throw AppError.notFound('aios_device', `device '${idOrKind}' not found`);
    }
    const list = caps instanceof Array ? caps : caps.list();
    for (const req of device.requiredCapabilities) {
      if (!hasCapability(list, req, scope)) {
        throw AppError.forbidden(
          'aios_device_capability_denied',
          `capability '${req}' required to use device '${device.id}' is not granted`,
        );
      }
    }
    if (!device.available) {
      throw AppError.unavailable(
        'aios_device_unavailable',
        `device '${device.id}' is not available on this host`,
        { device: device.id },
      );
    }
    return device;
  }

  /** Standalone capability check against a proposed operation on any device. */
  assertCapability(kind: CapabilityKind | string, caps: Capability[] | CapabilitySet, scope: string, resource?: string): void {
    if (!hasCapability(caps instanceof Array ? caps : caps.list(), kind, scope, resource)) {
      throw AppError.forbidden('aios_device_capability_denied', `capability '${kind}' is not granted`);
    }
  }

  private resolve(idOrKind: string): Device | undefined {
    if (this.devices.has(idOrKind)) return this.devices.get(idOrKind);
    const byKind = this.byKind(idOrKind as DeviceKind);
    return byKind.length === 1 ? byKind[0] : undefined;
  }
}

/** Canonical device catalog: how the current architecture maps each device. */
export function defaultDeviceCatalog(getAvailability: (kind: DeviceKind) => boolean): Device[] {
  return [
    {
      id: 'local-agent-terminal',
      kind: DeviceKind.LOCAL_TERMINAL,
      available: getAvailability(DeviceKind.LOCAL_TERMINAL),
      requiredCapabilities: [CapabilityKind.TERMINAL_EXEC],
      description: 'local-agent terminal session (capability-gated)',
    },
    {
      id: 'local-agent-files',
      kind: DeviceKind.LOCAL_FILESYSTEM,
      available: getAvailability(DeviceKind.LOCAL_FILESYSTEM),
      requiredCapabilities: [CapabilityKind.FILE_READ, CapabilityKind.FILE_WRITE],
      description: 'local-agent workspace filesystem',
    },
    {
      id: 'local-agent-git',
      kind: DeviceKind.LOCAL_GIT,
      available: getAvailability(DeviceKind.LOCAL_GIT),
      requiredCapabilities: [CapabilityKind.GIT_READ],
      description: 'local-agent read-only git',
    },
    {
      id: 'docker-executor',
      kind: DeviceKind.DOCKER_EXECUTOR,
      available: getAvailability(DeviceKind.DOCKER_EXECUTOR),
      requiredCapabilities: [CapabilityKind.TERMINAL_EXEC],
      description: 'real container isolation executor (only when a container engine is reachable)',
    },
    {
      id: 'cloud-executor',
      kind: DeviceKind.CLOUD_EXECUTOR,
      available: getAvailability(DeviceKind.CLOUD_EXECUTOR),
      requiredCapabilities: [CapabilityKind.TERMINAL_EXEC, CapabilityKind.NETWORK_REQUEST],
      description: 'backend/cloud execution worker',
    },
    {
      id: 'future-remote-worker',
      kind: DeviceKind.FUTURE_REMOTE_WORKER,
      available: getAvailability(DeviceKind.FUTURE_REMOTE_WORKER),
      requiredCapabilities: [CapabilityKind.TERMINAL_EXEC],
      description: 'distributed worker pool (architecture prep; not live)',
    },
  ];
}