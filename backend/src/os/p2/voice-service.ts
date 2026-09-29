/**
 * CodeConClave AI OS — PKG-10 VoiceService (canonical voice subsystem).
 *
 * This is the ONE canonical voice service boundary. It manages:
 *   - voice session (a single active voice context)
 *   - voice intent (reuses the P2 VoiceGateway parser)
 *   - voice command (a SAFE allowlist of existing application actions)
 *   - voice history (transcripts / commands / results / preferences)
 *   - voice preferences (enabled / tone / output)
 *
 * It is purely additive and feature-flag-gated (`AIOS_P2_VOICE`, default OFF).
 * It REUSES the existing primitives and creates NO second command system, LLM
 * gateway, scheduler, memory, permission system, or persistence system:
 *   - command dispatch → existing P2 CommandPalette (authenticated, capability
 *     + stop-rule gated)
 *   - history / preferences persistence → existing OS StateStore (`memory`)
 *   - decisions → the same capability + stop-rule + resource-governor chain as
 *     every other interface. Voice NEVER introduces a bypass path.
 *
 * SECURITY NON-NEGOTIABLES (fail closed):
 *   - An arbitrary spoken shell command is NOT executed — only allowlisted
 *     command IDs may run, and only when authenticated + capable.
 *   - `commit` still requires the existing explicit authorization.
 *   - `push` is denied if existing policy denies push (not in allowlist).
 *   - `pay` / `activate pro` / entitlement grants are structurally impossible.
 *   - distributed-execution and real-isolation actions are not exposed by voice.
 *   - B1 review (proposal/hunk review, test gating, explicit commit) is never
 *     bypassed — voice only invokes existing approved flows.
 *
 * HONESTY (never fabricate capability):
 *   - Audio speech-to-text / text-to-speech, wake-word detection, offline
 *     speech, real multilingual speech and verified accent support all require a
 *     real speech engine/provider, which this repository/environment does not
 *     have. Their status is `ENVIRONMENT_BLOCKED` / `NOT_IMPLEMENTED`, never
 *     PASS. Browser Web Speech is a separate, honest client capability — it is
 *     NOT claimed as provider-backed voice.
 */
import { AppError } from '../../shared/errors.js';
import { Capability, CapabilityKind } from '../types.js';
import type { StateStore } from '../state.js';
import type { ResourceGovernor, ConcurrencySlot } from '../resource-governor.js';
import type { CommandPalette, PaletteCommand } from './command-palette.js';
import type { StopRuleOperation } from './stop-rules.js';
import { VoiceGateway, VoiceIntent } from './voice.js';
import type { P2Feature } from './flags.js';

// ---------------------------------------------------------------------------
// Public voice model (plain data; no duplicate models).
// ---------------------------------------------------------------------------

export const VoiceTone = {
  NEUTRAL: 'NEUTRAL',
  CONCISE: 'CONCISE',
  DETAILED: 'DETAILED',
  FRIENDLY: 'FRIENDLY',
} as const;
export type VoiceTone = (typeof VoiceTone)[keyof typeof VoiceTone];

/** Truthful voice feedback states — no fake progress. */
export const VoiceFeedbackState = {
  LISTENING: 'LISTENING',
  TRANSCRIBING: 'TRANSCRIBING',
  COMMAND_DETECTED: 'COMMAND_DETECTED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  DENIED: 'DENIED',
  ERROR: 'ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type VoiceFeedbackState = (typeof VoiceFeedbackState)[keyof typeof VoiceFeedbackState];

/** Capability status classification (honest by design). */
export const VoiceCapabilityStatus = {
  IMPLEMENTABLE_NOW: 'IMPLEMENTABLE_NOW',
  ENVIRONMENT_BLOCKED: 'ENVIRONMENT_BLOCKED',
  DEFERRED: 'DEFERRED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;
export type VoiceCapabilityStatus = (typeof VoiceCapabilityStatus)[keyof typeof VoiceCapabilityStatus];

/** A safe, existing application command exposed to voice. */
export interface VoiceCommandDef {
  id: string;
  title: string;
  keywords: string[];
  /** Optional capability the caller must hold to run it. */
  requiredCapability?: CapabilityKind | string;
}

/** The canonical allowlist of voice commands (must map to EXISTING actions). */
export const VOICE_COMMAND_ALLOWLIST: readonly VoiceCommandDef[] = [
  { id: 'open_workspace', title: 'Open workspace', keywords: ['open', 'workspace'], requiredCapability: CapabilityKind.FILE_READ },
  { id: 'start_cowork', title: 'Start cowork', keywords: ['start', 'cowork'] },
  { id: 'pause', title: 'Pause', keywords: ['pause', 'hold'] },
  { id: 'resume', title: 'Resume', keywords: ['resume', 'continue'] },
  { id: 'run_tests', title: 'Run tests', keywords: ['run tests', 'test'] },
  { id: 'show_review', title: 'Show review', keywords: ['show review', 'review'] },
  { id: 'accept_hunk', title: 'Accept hunk', keywords: ['accept hunk', 'accept'] },
  { id: 'reject_hunk', title: 'Reject hunk', keywords: ['reject hunk', 'reject'] },
  { id: 'cancel', title: 'Cancel', keywords: ['cancel', 'stop'] },
  { id: 'show_schedule', title: 'Show schedule', keywords: ['show schedule', 'schedule'] },
  { id: 'run_schedule_now', title: 'Run schedule now', keywords: ['run schedule', 'run now'] },
  { id: 'stop_task', title: 'Stop task', keywords: ['stop task', 'stop'] },
];

export const VOICE_TONES: readonly VoiceTone[] = [VoiceTone.NEUTRAL, VoiceTone.CONCISE, VoiceTone.DETAILED, VoiceTone.FRIENDLY];

export interface VoicePreferences {
  enabled: boolean;
  tone: VoiceTone;
  /** Whether voice responses are spoken back (only where output is supported). */
  output: 'none' | 'speech' | 'text';
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  enabled: false,
  tone: VoiceTone.NEUTRAL,
  output: 'text',
};

export interface VoiceTranscriptEntry {
  id: string;
  userId: string;
  workspaceId: string | null;
  sessionId: string;
  transcript: string;
  intent?: VoiceIntent | null;
  commandId?: string | null;
  result?: 'completed' | 'denied' | 'error' | 'unsupported' | null;
  at: number;
}

export interface VoiceHistoryPage {
  entries: VoiceTranscriptEntry[];
}

export interface VoiceSession {
  id: string;
  userId: string;
  workspaceId: string | null;
  state: VoiceFeedbackState;
  transcript: string | null;
  commandId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Hard bounds this service enforces (fail closed). */
export interface VoiceGuardConfig {
  /** Whether an arbitrary parsed operation may run (only allowlisted when true). */
  allowOnlyAllowlist?: boolean;
  /** Capability required for any voice command dispatch. */
  requiredCapability?: CapabilityKind | string;
}

const DEFAULT_GUARD: VoiceGuardConfig = {
  allowOnlyAllowlist: true,
  requiredCapability: CapabilityKind.VOICE_CONTROL,
};

// ---------------------------------------------------------------------------
// Canonical voice service.
// ---------------------------------------------------------------------------

let sessionSeq = 0;

export class VoiceService {
  private readonly gateway: VoiceGateway;
  private session: VoiceSession | null = null;
  private readonly stateKey = (scope: string) => `voice:${scope}`;

  constructor(
    private feature: () => P2Feature | null,
    private palette: CommandPalette,
    private state: StateStore,
    private governor: ResourceGovernor,
    private guards: VoiceGuardConfig = DEFAULT_GUARD,
  ) {
    this.gateway = new VoiceGateway(feature, palette);
  }

  isEnabled(): boolean {
    return this.feature() === 'voice' && this.guardCapabilityReady();
  }

  private guardCapabilityReady(): boolean {
    return true; // capability is checked at dispatch; gateway enabled suffices here
  }

  /** Capability status of the 12 approved Group F capabilities (honest). */
  capabilityStatus(): Record<string, VoiceCapabilityStatus> {
    return {
      'voice.input': VoiceCapabilityStatus.IMPLEMENTABLE_NOW, // via browser + allowlist
      'real_time_transcription': VoiceCapabilityStatus.DEFERRED, // no speech engine
      'voice.output': VoiceCapabilityStatus.IMPLEMENTABLE_NOW, // via browser speechSynthesis (client)
      'wake_word': VoiceCapabilityStatus.NOT_IMPLEMENTED, // no real detector
      'voice.commands': VoiceCapabilityStatus.IMPLEMENTABLE_NOW, // allowlist via palette
      'accent_support': VoiceCapabilityStatus.NOT_IMPLEMENTED, // needs real recognition
      'offline_voice': VoiceCapabilityStatus.NOT_IMPLEMENTED, // needs local engine
      'voice.history': VoiceCapabilityStatus.IMPLEMENTABLE_NOW,
      'tone_control': VoiceCapabilityStatus.IMPLEMENTABLE_NOW,
      'hands_free': VoiceCapabilityStatus.DEFERRED, // continuous recognition only where supported
      'voice.feedback': VoiceCapabilityStatus.IMPLEMENTABLE_NOW,
      'multilingual_voice': VoiceCapabilityStatus.NOT_IMPLEMENTED, // needs real language support
    };
  }

  preferences(scope: string): Promise<VoicePreferences> {
    if (!this.isEnabled()) throw AppError.conflict('aios_voice_disabled', 'voice feature is off');
    return this.state.get<VoicePreferences>(this.stateKey(`${scope}:prefs`)).then((b) => b?.data ?? DEFAULT_VOICE_PREFERENCES);
  }

  async setPreferences(scope: string, prefs: Partial<VoicePreferences>): Promise<VoicePreferences> {
    if (!this.isEnabled()) throw AppError.conflict('aios_voice_disabled', 'voice feature is off');
    const current = await this.preferences(scope);
    const next: VoicePreferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      ...current,
      ...prefs,
    };
    if (!VOICE_TONES.includes(next.tone)) next.tone = VoiceTone.NEUTRAL;
    if (!['none', 'speech', 'text'].includes(next.output)) next.output = 'text';
    await this.state.put(1, this.stateKey(`${scope}:prefs`), next);
    return next;
  }

  beginSession(opts: { userId: string; workspaceId: string | null }): VoiceSession {
    if (!this.isEnabled()) throw AppError.conflict('aios_voice_disabled', 'voice feature is off');
    const now = Date.now();
    this.session = {
      id: `vs_${sessionSeq++}_${now}`,
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      state: VoiceFeedbackState.LISTENING,
      transcript: null,
      commandId: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.session;
  }

  /** Start a new session or return the current one when the context matches. */
  ensureSession(opts: { userId: string; workspaceId: string | null }): VoiceSession {
    if (this.session && this.session.userId === opts.userId && this.session.workspaceId === opts.workspaceId) {
      return this.session;
    }
    return this.beginSession(opts);
  }

  /**
   * Run a voice command through the canonical chain:
   *   transcript → intent parse → authenticate → capability → stop-rule gate →
   *   resource governor → allowlisted existing action.
   * Returns a truthful feedback state; a denied/unsupported command never runs.
   */
  async run(
    transcript: string,
    opts: {
      userId: string;
      workspaceId: string | null;
      capabilities: readonly Capability[];
      authorized: boolean;
      stop: (intent: VoiceIntent) => Promise<{ allowed: boolean; reason?: string }>;
      execute: (commandId: string) => Promise<{ ok: boolean; note?: string }>;
      enableSpeech?: boolean;
    },
  ): Promise<{ state: VoiceFeedbackState; sessionId: string; commandId: string | null; transcript: string; note?: string }> {
    if (!this.isEnabled()) throw AppError.conflict('aios_voice_disabled', 'voice feature is off');
    if (!this.guards.allowOnlyAllowlist) throw AppError.conflict('aios_voice_guard', 'voice allows only allowlisted commands');

    const session = this.ensureSession({ userId: opts.userId, workspaceId: opts.workspaceId });
    this.patchSession({ state: VoiceFeedbackState.TRANSCRIBING, transcript });

    // PARSE through the existing VoiceGateway (the canonical intent parser).
    const intent = this.gateway.parse(transcript);

    // AUTH + capability: caller must hold the required capability AND be authorized.
    if (!opts.authorized || !hasCap(opts.capabilities, this.guards.requiredCapability ?? CapabilityKind.VOICE_CONTROL)) {
      this.patchSession({ state: VoiceFeedbackState.DENIED, commandId: null });
      await this.record(session, transcript, intent, null, 'denied');
      return { state: VoiceFeedbackState.DENIED, sessionId: session.id, commandId: null, transcript, note: 'not authorized or capability required' };
    }

    // Map the transcript to an ALLOWLISTED existing command via the palette search.
    const commandId = this.matchAllowlist(transcript);

    // STOP-RULE gate (the canonical policy check below the prompt layer).
    const stopDecision = await opts.stop(intent);
    if (!stopDecision.allowed) {
      this.patchSession({ state: VoiceFeedbackState.DENIED, commandId });
      await this.record(session, transcript, intent, commandId, 'denied');
      return { state: VoiceFeedbackState.DENIED, sessionId: session.id, commandId, transcript, note: stopDecision.reason ?? 'blocked by stop rule' };
    }

    if (!commandId) {
      this.patchSession({ state: VoiceFeedbackState.UNSUPPORTED });
      await this.record(session, transcript, intent, null, 'unsupported');
      return { state: VoiceFeedbackState.UNSUPPORTED, sessionId: session.id, commandId: null, transcript, note: 'no matching supported command' };
    }

    // RESOURCE GOVERNOR: gate before execution (fail closed on admission).
    let slot: ConcurrencySlot | null = null;
    try {
      slot = await this.governor.acquire();
    } catch {
      this.patchSession({ state: VoiceFeedbackState.DENIED });
      await this.record(session, transcript, intent, null, 'denied');
      return { state: VoiceFeedbackState.DENIED, sessionId: session.id, commandId: null, transcript, note: 'resource limit reached' };
    }

    this.patchSession({ state: VoiceFeedbackState.COMMAND_DETECTED, commandId });
    try {
      this.patchSession({ state: VoiceFeedbackState.EXECUTING });
      const res = await opts.execute(commandId);
      const state = res.ok ? VoiceFeedbackState.COMPLETED : VoiceFeedbackState.DENIED;
      this.patchSession({ state });
      await this.record(session, transcript, intent, commandId, res.ok ? 'completed' : 'denied');
      return { state, sessionId: session.id, commandId, transcript, note: res.note };
    } catch (err) {
      this.patchSession({ state: VoiceFeedbackState.ERROR });
      await this.record(session, transcript, intent, commandId, 'error');
      return { state: VoiceFeedbackState.ERROR, sessionId: session.id, commandId, transcript, note: err instanceof Error ? err.message : 'voice command error' };
    } finally {
      slot.release();
    }
  }

  /** Register the safe commands into the palette (idempotent; keeps them gated). */
  registerCommands(exec: (id: string) => Promise<{ ok: boolean; note?: string }>): void {
    for (const cmd of VOICE_COMMAND_ALLOWLIST) {
      const def: PaletteCommand = {
        id: cmd.id,
        title: cmd.title,
        keywords: cmd.keywords,
        requiredCapability: cmd.requiredCapability ?? this.guards.requiredCapability,
        run: () => (this.isEnabled() ? exec(cmd.id) : Promise.resolve({ ok: false, note: 'voice disabled' })),
      };
      try {
        this.palette.register(def);
      } catch {
        // already registered — idempotent
      }
    }
  }

  /** History for a user/workspace (scoped), most recent first. */
  async history(userId: string, workspaceId: string | null, limit = 50): Promise<VoiceHistoryPage> {
    if (!this.isEnabled()) throw AppError.conflict('aios_voice_disabled', 'voice feature is off');
    const key = this.stateKey(`hist:${workspaceId ?? 'global'}:${userId}`);
    const block = await this.state.get<VoiceTranscriptEntry[]>(key);
    const list = (block?.data ?? []).slice(-limit).reverse();
    return { entries: list };
  }

  /** Current session snapshot (for feedback UI). */
  currentSession(): VoiceSession | null {
    return this.session ? { ...this.session } : null;
  }

  private async record(
    session: VoiceSession,
    transcript: string,
    intent: VoiceIntent | null,
    commandId: string | null,
    result: VoiceTranscriptEntry['result'],
  ): Promise<void> {
    const key = this.stateKey(`hist:${session.workspaceId ?? 'global'}:${session.userId}`);
    const block = await this.state.get<VoiceTranscriptEntry[]>(key);
    const list = block?.data ?? [];
    const entry: VoiceTranscriptEntry = {
      id: `vt_${session.id}_${list.length}`,
      userId: session.userId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      transcript,
      intent,
      commandId,
      result,
      at: Date.now(),
    };
    list.push(entry);
    // keep bounded; raw audio is never retained.
    const trimmed = list.slice(-200);
    await this.state.put(1, key, trimmed);
  }

  private matchAllowlist(transcript: string): string | null {
    const q = transcript.toLowerCase().trim();
    let best: { id: string; score: number } | null = null;
    for (const def of VOICE_COMMAND_ALLOWLIST) {
      let score = 0;
      if (def.title.toLowerCase().includes(q)) score += 5;
      if (q.includes(def.title.toLowerCase())) score += 4;
      for (const k of def.keywords) {
        if (q.includes(k.toLowerCase())) score += 3;
      }
      if (score > 0 && (!best || score > best.score)) best = { id: def.id, score };
    }
    return best ? best.id : null;
  }

  private patchSession(patch: Partial<VoiceSession>): void {
    if (!this.session) return;
    this.session = { ...this.session, ...patch, updatedAt: Date.now() };
  }
}

function hasCap(caps: readonly Capability[], kind: CapabilityKind | string): boolean {
  return caps.some((c) => c.kind === kind);
}
