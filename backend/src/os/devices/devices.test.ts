/**
 * CodeConClave — AI OS execution device model tests.
 * Every device operation must pass capability + availability gates; devices
 * never self-authorize. Pure unit tests (no network, no production wiring).
 */
import { describe, it, expect } from 'vitest';
import { DeviceRegistry, defaultDeviceCatalog } from './registry.js';
import { DeviceKind } from './types.js';
import { CapabilitySet } from '../capabilities.js';
import { CapabilityKind } from '../types.js';

function caps(kinds: string[]): CapabilitySet {
  const s = new CapabilitySet();
  for (const k of kinds) s.add(k, 'ws-1');
  return s;
}

describe('device registry gates', () => {
  const avail = (k: DeviceKind) => k !== DeviceKind.DOCKER_EXECUTOR;
  const catalog = () => defaultDeviceCatalog(avail);

  it('registers the canonical catalog with the six device kinds', () => {
    const reg = new DeviceRegistry();
    for (const d of catalog()) reg.register(d);
    const kinds = reg.all().map((d) => d.kind);
    expect(kinds).toContain(DeviceKind.LOCAL_TERMINAL);
    expect(kinds).toContain(DeviceKind.LOCAL_FILESYSTEM);
    expect(kinds).toContain(DeviceKind.LOCAL_GIT);
    expect(kinds).toContain(DeviceKind.DOCKER_EXECUTOR);
    expect(kinds).toContain(DeviceKind.CLOUD_EXECUTOR);
    expect(kinds).toContain(DeviceKind.FUTURE_REMOTE_WORKER);
  });

  it('denies access without the required capability (capability bypass guard)', () => {
    const reg = new DeviceRegistry();
    reg.register(catalog().find((d) => d.kind === DeviceKind.LOCAL_TERMINAL)!);
    expect(() => reg.require('local_terminal', caps([]), 'ws-1')).toThrowError(/capability/);
  });

  it('grants access only when capability AND availability both hold', () => {
    const reg = new DeviceRegistry();
    reg.register(catalog().find((d) => d.kind === DeviceKind.LOCAL_TERMINAL)!);
    const dev = reg.require('local_terminal', caps([CapabilityKind.TERMINAL_EXEC]), 'ws-1');
    expect(dev.kind).toBe(DeviceKind.LOCAL_TERMINAL);
  });

  it('denies an unavailable device even with capability (fail closed on availability)', () => {
    const reg = new DeviceRegistry();
    reg.register(catalog().find((d) => d.kind === DeviceKind.DOCKER_EXECUTOR)!); // unavailable: no runtime
    expect(() => reg.require('docker_executor', caps([CapabilityKind.TERMINAL_EXEC]), 'ws-1')).toThrowError(/not available/);
  });

  it('require by id wins over by-kind single match; unknown id fails', () => {
    const reg = new DeviceRegistry();
    reg.register(catalog().find((d) => d.kind === DeviceKind.LOCAL_GIT)!);
    expect(() => reg.require('nope', caps([CapabilityKind.GIT_READ]), 'ws-1')).toThrow();
  });

  it('unregister removes a device', () => {
    const reg = new DeviceRegistry();
    const d = catalog().find((id) => id.kind === DeviceKind.LOCAL_GIT)!;
    reg.register(d);
    expect(reg.unregister(d.id)).toBe(true);
    expect(reg.byKind(DeviceKind.LOCAL_GIT)).toHaveLength(0);
  });

  it('assertCapability is scope-aware', () => {
    const reg = new DeviceRegistry();
    reg.assertCapability(CapabilityKind.FILE_READ, caps([CapabilityKind.FILE_READ]), 'ws-1');
    expect(() => reg.assertCapability(CapabilityKind.FILE_READ, caps([CapabilityKind.FILE_READ]), 'ws-2')).toThrow();
  });
});