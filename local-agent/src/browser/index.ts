/**
 * CodeConClave Local Agent — browser control (P1).
 * Public surface: capability advertisement, the action contract gate, and the
 * managed-session runner. Nothing here trusts page content.
 */
export { connectCdp, CdpError, type CdpSession } from './cdp.js';
export { findBrowserPath, launchManagedBrowser, type LaunchOptions } from './launch.js';
export { ManagedBrowser, ActionResult } from './types.js';
export {
  KNOWN_BROWSER_CAPABILITIES,
  OP_TO_CAPABILITY,
  RETRYABLE_OPS,
  browserGrants,
  advertisedBrowserCapabilities,
  isPrivateHost,
  allowedOriginMatches,
  sensitiveDestination,
  assertBrowserAction,
} from './contract.js';
export { BrowserController, type ControllerOptions, type OpResult } from './controller.js';
export { redactSecrets, isPasswordField } from './redact.js';
export { runBrowserInstruction, type BrowserRunOutcome, type BrowserRunDeps } from './task-bridge.js';