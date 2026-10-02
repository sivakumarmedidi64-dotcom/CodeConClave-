/**
 * CodeConClave — PKG-25 — 24/7 Autonomous Cowork module index.
 */
export { autonomyRoutes } from './routes.js';
export { autonomyStatus, runProof } from './service.js';
export { runLogicHarness } from './harness.js';
export { runRealHarness } from './harness-real.js';
export { assertValidTransition, guardTransition, invalidTransitionReason, isValidTaskStatus, TASK_STATUS, TERMINAL_STATUS, CLAIMABLE_STATUS } from './state-machine.js';
export { buildTruthReport, TRUTH_KEYS } from './truth.js';
export { autonomyEnabled } from './config.js';
