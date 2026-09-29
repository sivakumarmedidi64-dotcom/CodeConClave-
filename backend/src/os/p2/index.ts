/**
 * CodeConClave AI OS — P2 public barrel.
 * Additive, feature-flag-gated (all AIOS_P2_* default OFF). Import any feature
 * directly or use { createP2 } to bind the shared managers to an Aios instance.
 * No production behavior changes while the flags are off.
 */
export * from './flags.js';
export { BreakpointManager } from './breakpoint.js';
export type { BreakpointSpec, PausedBreakpoint, PauseCapture } from './breakpoint.js';
export { RealtimeDiff } from './realtime-diff.js';
export type { Hunk } from './realtime-diff.js';
export { SessionReplay } from './replay.js';
export type { ReplayEvent, ReplayEventType } from './replay.js';
export { UndoLog } from './undo.js';
export type { UndoAction, UndoPreview } from './undo.js';
export { TeamCowork } from './team-cowork.js';
export type { TeamSession, Participant, ParticipantRole, Capability as CoworkCapability } from './team-cowork.js';
export { StopRules, StopRuleOperation, canonicalize, isUnder } from './stop-rules.js';
export type { StopRulePolicy, ProtectedPath, ApprovalSubject, ApprovalGrant, EvaluationContext, AuditEvent, AllowResult, DenyResult } from './stop-rules.js';
export { Personality, PersonalityMode } from './personality.js';
export type { PersonalityConfig } from './personality.js';
export { SessionSummarizer, summarizeEvents } from './session-summary.js';
export type { SessionSummary } from './session-summary.js';
export { SmartFilePicker } from './smart-files.js';
export type { FileCandidate, WorkspaceIndex } from './smart-files.js';
export { ErrorQuickFix } from './error-fix.js';
export type { FixProposal, FixOutcome, ErrorContext } from './error-fix.js';
export { ContextSidebar } from './context-sidebar.js';
export type { ContextPanel, ContextSidebarInput } from './context-sidebar.js';
export { CoworkTemplates } from './templates.js';
export type { CoworkTemplate, TemplateStep } from './templates.js';
export { CommandPalette } from './command-palette.js';
export type { PaletteCommand } from './command-palette.js';
export { SkillEngine } from './skills.js';
export type { Skill, SkillStep } from './skills.js';
export { Scheduler } from './scheduler.js';
export type { ScheduledJob } from './scheduler.js';
export { VoiceGateway, VOICE_OPERATION_WORDS } from './voice.js';
export type { VoiceIntent } from './voice.js';
export { VoiceService } from './voice-service.js';
export {
  VoiceTone,
  VoiceFeedbackState,
  VoiceCapabilityStatus,
  VOICE_COMMAND_ALLOWLIST,
  VOICE_TONES,
  DEFAULT_VOICE_PREFERENCES,
} from './voice-service.js';
export type {
  VoicePreferences,
  VoiceTranscriptEntry,
  VoiceHistoryPage,
  VoiceSession,
  VoiceCommandDef,
  VoiceGuardConfig,
} from './voice-service.js';
export { Notifications } from './notifications.js';
export type { Notification, NotifySink } from './notifications.js';

import type { Aios } from '../os-api.js';
import { SessionReplay } from './replay.js';
import { TeamCowork } from './team-cowork.js';
import { Notifications } from './notifications.js';
import { enabled, P2Feature } from './flags.js';

/** Names of all P2 features (for tooling / palette). */
export function p2Catalog(): string[] {
  return [
    'breakpoint',
    'diff',
    'replay',
    'undo',
    'team_cowork',
    'stop_rules',
    'personality',
    'summary',
    'smart_files',
    'error_fix',
    'context_sidebar',
    'templates',
    'command_palette',
    'skills',
    'scheduler',
    'voice',
    'notifications',
  ];
}

/**
 * Bind the shared managers that consume the IPC bus (replay/notifications/team
 * cowork). Other P2 features are workspace/policy-scoped and are constructed by
 * callers with their specific context. Additive wiring only — nothing is
 * enabled unless its flag is on.
 */
export function createP2(aios: Aios): {
  replay: SessionReplay;
  notifications: import('./notifications.js').Notifications;
  teamCowork: TeamCowork;
  enabled: (f: P2Feature) => boolean;
} {
  const notifications = new Notifications(aios.ipc, () => (enabled('notifications') ? 'notifications' : null));
  const teamCowork = new TeamCowork(aios.ipc, () => (enabled('team_cowork') ? 'team_cowork' : null));
  const replay = new SessionReplay(aios.ipc, () => (enabled('replay') ? 'replay' : null));
  return { replay, notifications, teamCowork, enabled };
}
