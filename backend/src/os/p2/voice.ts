/**
 * CodeConClave AI OS — P2.19–21 Voice.
 *
 * Voice is ONLY another facade over the same authenticated cowork command model
 * (the P2.13 Command Palette). A spoken instruction is parsed into an intent
 * (operation + optional target) and dispatched through the SAME
 * capability + stop-rule gate as every other interface. A malicious voice
 * command ("delete all test files") is therefore denied exactly like its typed
 * equivalent. Voice NEVER introduces a bypass path.
 */
import { AppError } from '../../shared/errors.js';
import { Capability } from '../types.js';
import type { StopRuleOperation, DenyResult, AllowResult } from './stop-rules.js';
import type { CommandPalette } from './command-palette.js';
import type { P2Feature } from './flags.js';

export interface VoiceIntent {
  operation: StopRuleOperation;
  target: string | null;
  commandId: string | null;
  raw: string;
}

export const VOICE_OPERATION_WORDS: Array<{ word: string; op: StopRuleOperation }> = [
  { word: 'delete', op: 'delete' },
  { word: 'remove', op: 'delete' },
  { word: 'rename', op: 'rename' },
  { word: 'move', op: 'rename' },
  { word: 'install', op: 'package.install' },
  { word: 'merge', op: 'git.merge' },
  { word: 'commit', op: 'git.commit' },
  { word: 'create', op: 'write' },
  { word: 'edit', op: 'edit' },
];

export class VoiceGateway {
  constructor(
    private feature: () => P2Feature | null,
    private palette: CommandPalette,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'voice';
  }

  /** PARSE a spoken phrase into an intent. */
  parse(spoken: string): VoiceIntent {
    const raw = String(spoken);
    const lower = raw.toLowerCase();
    const target = extractTarget(lower, raw);
    let operation: StopRuleOperation = 'exec';
    for (const { word, op } of VOICE_OPERATION_WORDS) {
      if (lower.includes(word)) {
        operation = op;
        break;
      }
    }
    // map to a palette command id when it matches a registered command title
    const matches = this.palette.search(raw, 1);
    const commandId = matches.length > 0 ? matches[0]! : null;
    return { operation, target, commandId, raw };
  }

  /**
   * EXECUTE a parsed intent through the SAME gate: stop rules first, then the
   * palette's authenticated dispatch. If either denies, nothing runs.
   */
  async execute(
    intent: VoiceIntent,
    opts: {
      capabilities: readonly Capability[];
      authorized: boolean;
      stopRuleDecision: AllowResult | DenyResult;
      perform: (intent: VoiceIntent) => Promise<{ ok: boolean }>;
    },
  ): Promise<{ ok: boolean; blocked: boolean; reason?: string }> {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_voice_disabled', 'voice feature is off');
    if (!opts.stopRuleDecision.allowed) {
      return { ok: false, blocked: true, reason: opts.stopRuleDecision.reason };
    }
    if (!opts.authorized) {
      return { ok: false, blocked: true, reason: 'not authorized' };
    }
    if (intent.commandId) {
      const res = await this.palette.run(intent.commandId, {
        capabilities: opts.capabilities,
        ruleAllows: opts.stopRuleDecision.allowed,
        authorized: opts.authorized,
      });
      if (!res.ok) return { ok: false, blocked: true, reason: res.note ?? 'command did not run' };
    }
    const performed = await opts.perform(intent);
    return { ok: performed.ok, blocked: false };
  }
}

function extractTarget(lower: string, raw: string): string | null {
  // crude heuristic: a quoted path or a trailing path-ish token in the phrase
  const quoted = /"([^"]+)"/.exec(raw);
  if (quoted) return quoted[1] ?? null;
  const m = /\b([A-Za-z0-9_./\\-]+\.(ts|tsx|js|jsx|py|go|rs|json|yml|yaml))\b/.exec(raw);
  return m ? m[1] ?? null : null;
}
