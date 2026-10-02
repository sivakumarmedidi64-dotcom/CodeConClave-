/**
 * CodeConClave AI OS — P2.13 Command Palette.
 *
 * A searchable command registry that DISPATCHES to the same authenticated
 * cowork command model (never a separate execution path). Every command runs
 * through the same capability + stop-rule gate. Voice (P2.20) and notifications
 * are merely other facades on this same model, so they can never bypass
 * controls. Commands may declare an optional required capability; dispatch
 * refuses to run unless the caller holds it AND stop rules allow the target.
 */
import { AppError } from '../../shared/errors.js';
import { Capability } from '../types.js';
import type { P2Feature } from './flags.js';

export interface PaletteCommand {
  id: string;
  title: string;
  keywords: string[];
  requiredCapability?: string | null;
  run: (ctx: { authorized: boolean }) => Promise<{ ok: boolean; note?: string }>;
}

export class CommandPalette {
  private commands = new Map<string, PaletteCommand>();

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'command_palette';
  }

  register(cmd: PaletteCommand): void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_palette_disabled', 'command palette is off');
    this.commands.set(cmd.id, cmd);
  }

  search(query: string, limit = 10): PaletteCommand['id'][] {
    if (!this.isEnabled()) return [];
    const q = query.toLowerCase();
    const scored = [...this.commands.values()]
      .map((c) => ({ id: c.id, score: scoreCommand(c, q) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.id);
  }

  /**
   * DISPATCH through the capability + stop-rule gate. `ruleAllows` is the
   * stop-rule policy outcome and `hasCapability` the capability outcome; if
   * either denies, the command MUST NOT run.
   */
  async run(
    id: string,
    opts: {
      capabilities: readonly Capability[];
      ruleAllows: boolean;
      authorized: boolean;
    },
  ): Promise<{ ok: boolean; note?: string }> {
    const cmd = this.commands.get(id);
    if (!cmd) throw AppError.notFound('aios_p2_palette_cmd', `command ${id} not found`);
    if (!opts.ruleAllows) return { ok: false, note: 'blocked by stop rule' };
    if (cmd.requiredCapability && !opts.capabilities.some((c) => c.kind === cmd.requiredCapability)) {
      return { ok: false, note: 'capability required' };
    }
    if (!opts.authorized) return { ok: false, note: 'not authorized' };
    return cmd.run({ authorized: opts.authorized });
  }
}

function scoreCommand(c: PaletteCommand, q: string): number {
  let score = 0;
  if (c.title.toLowerCase().includes(q)) score += 5;
  if (c.id.toLowerCase().includes(q)) score += 4;
  for (const k of c.keywords) if (k.toLowerCase().includes(q)) score += 2;
  return score;
}
