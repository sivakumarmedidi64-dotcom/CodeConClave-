/**
 * CodeConClave AI OS — P3 public barrel.
 * Additive, feature-flag-gated (all AIOS_P3_* default OFF). P3 builds ONLY on
 * the canonical P0/P1/P2 primitives (no second scheduler/event bus/state
 * system/memory system/filesystem abstraction). Nothing here is enabled unless
 * its flag is on, so pre-existing behavior is unchanged when flags are OFF.
 */
export * from './flags.js';
export { GitHubRemote } from './github.js';
export type {
  GitHubHttp,
  GitHubRepository,
  GitHubBranch,
  GitHubCommit,
  GitHubPullRequest,
  GitHubPrComment,
  GitHubConnectResult,
  GitHubCapability,
  SecretStore,
} from './github.js';
export { JiraConnector } from './jira.js';
export type { JiraTicket, JiraHttp } from './jira.js';
export { SlackConnector, classifySlashText } from './slack.js';
export type { SlackSlashCommand, SlashAction, SlackSink, SlackDispatch } from './slack.js';
export { DeviceNotifications } from './device-notifications.js';
export type { DeviceNotification, DeviceEventKind, DeviceTransport } from './device-notifications.js';
export { SkillSecurity, createCapabilityRegistry } from './skill-security.js';
export type { SkillManifest, TrustState, CapabilityRegistry } from './skill-security.js';
export { ContextIntelligence, CONTEXT_AGENTS, nextAgentPrompt } from './context.js';
export type { ContextAgent, ContextAgentName, AgentExecutor, CapabilityHolder as ContextCapabilityHolder } from './context.js';
export { TestingIntelligence, TESTING_AGENTS } from './testing.js';
export type { TestingAgent, TestingAgentName } from './testing.js';
export { SecurityIntelligence, SECURITY_AGENTS } from './security-intel.js';
export type { SecurityAgent, SecurityAgentName } from './security-intel.js';
export { PerformanceIntelligence, PERFORMANCE_AGENTS } from './performance-intel.js';
export type { PerformanceAgent, PerformanceAgentName } from './performance-intel.js';
export { ArchitectureIntelligence, ARCHITECTURE_AGENTS } from './architecture-intel.js';
export type { ArchitectureAgent, ArchitectureAgentName } from './architecture-intel.js';
export { TeamIntelligence, TEAM_AGENTS } from './team-intel.js';
export type { TeamAgent, TeamAgentName } from './team-intel.js';
export { DocumentationIntelligence, DOCUMENTATION_AGENTS } from './documentation-intel.js';
export type { DocumentationAgent, DocumentationAgentName } from './documentation-intel.js';
export { IdeFoundation } from './ide.js';
export type { IdeBridge, IdeDiagnostic } from './ide.js';

/** Names of all P3 tracks (for tooling). */
export function p3Catalog(): string[] {
  return [
    'github',
    'jira',
    'slack',
    'notifications',
    'skill_security',
    'context',
    'testing',
    'security',
    'performance',
    'architecture',
    'team',
    'documentation',
    'ide',
  ];
}
