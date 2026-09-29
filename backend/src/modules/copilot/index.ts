/**
 * CodeConClave — PKG-24 AI Developer Copilot — module public API.
 * Project-aware coding assistance, explanation, memory-aware suggestions,
 * ask-codeconclave, safe test generation, failure diagnosis, and safe B1-backed
 * change proposals. Reuses the AI Gateway, PKG-23 memory, PKG-22 workspace, and
 * B1 reviews — no second AI architecture, no second memory system.
 */
export { copilotRoutes } from './routes.js';
export { copilotCapabilities } from './service.js';
export { providerState } from './provider.js';
export { buildCopilotContext } from './context.js';
export { explainCode } from './explain.js';
export { suggestContextAware } from './suggest.js';
export { askCopilot } from './ask.js';
export { generateTestProposals } from './testgen.js';
export { diagnoseFailure } from './diagnose.js';
export { proposeChangeViaB1 } from './proposal.js';
export { copilotFeedback } from './feedback.js';
export { COPILOT_CONFIG } from './config.js';
