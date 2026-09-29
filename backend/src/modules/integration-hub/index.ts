/**
 * CodeConClave — PKG-26 — Universal Integration Hub.
 * Reuse-driven read-only surface over the existing plugin/webhook/release/
 * observability substrate. No second engine, no duplicate state.
 */
export { integrationHubRoutes } from './routes.js';
export { buildIntegrationHub, deploymentProviderCapabilities, hubProvider, hubStateFor } from './service.js';
export type { HubProvider, HubConnection, HubState } from './service.js';
