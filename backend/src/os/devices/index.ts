/**
 * CodeConclave AI OS — execution device model (barrel).
 * Every device operation must pass the capability + availability gate.
 */
export { DeviceRegistry, defaultDeviceCatalog } from './registry.js';
export {
  DeviceKind,
} from './types.js';
export type { Device } from './types.js';