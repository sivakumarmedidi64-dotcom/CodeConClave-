/**
 * CodeConClave — PKG-22 Advanced Code Workspace — module entry.
 * Mounts /api/v1/codeworkspace. All capability-gated by AIOS_P2_WORKSPACE.
 */
export { codeWorkspaceRoutes } from './routes.js';
export { workspaceCapabilities, workspaceEnabledFlag } from './service.js';
export { workspaceEnabled } from './config.js';
