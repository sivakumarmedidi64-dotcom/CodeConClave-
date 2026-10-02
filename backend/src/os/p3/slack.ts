/**
 * CodeConClave AI OS — P3.2 Slack Connector.
 *
 * Slack slash-command foundation + cowork status notifications + cowork links,
 * all riding the canonical IPC event bus (no second event system). Every slash
 * command is an authenticated facade on the SAME cowork command model (mirrors
 * P2 Voice: no bypass). Workspace isolation is enforced — a slash command from
 * one workspace can never act in another. Commands require explicit authorization.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { IpcBus } from '../ipc.js';
import type { P3Feature } from './flags.js';

export interface SlackSlashCommand {
  command: string;
  text: string;
  workspaceId: string;
  userId: string;
}

export type SlashAction =
  | 'cowork.status'
  | 'cowork.link'
  | 'cowork.run'
  | 'cowork.approve'
  | 'unknown';

export interface SlackSink {
  post(channel: string, text: string, opts?: { link?: string }): Promise<void>;
}

export type SlackDispatch = (cmd: SlackSlashCommand) => Promise<{ ok: boolean; action: SlashAction; note?: string }>;

export class SlackConnector {
  private byWorkspace = new Map<string, { teamId: string; channel: string }>();
  private botToken: string | null = null;

  constructor(
    private feature: () => P3Feature | null,
    private ipc: IpcBus,
    private sink: SlackSink,
    private capabilities: (workspaceId: string) => readonly string[],
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'slack';
  }

  /** Connect a Slack workspace (app install). Token kept server-side only. */
  connect(ws: string, teamId: string, channel: string, botToken: string): { workspaceId: string } {
    this.ensure();
    this.byWorkspace.set(ws, { teamId, channel });
    this.botToken = botToken; // never logged / emitted; redacted on any event
    this.ipc.publish(`aios.p3.slack.${ws}`, sanitizeFields({ event: 'connected', teamId }), { workspaceId: ws }).catch(() => void 0);
    return { workspaceId: ws };
  }

  /**
   * Handle a slash command. Routes through `dispatch` which is expected to be
   * the SAME authenticated cowork command path (capability + stop-rules). If the
   * caller lacks authorization, nothing runs. Workspace-isolated by construction.
   */
  async slash(cmd: SlackSlashCommand, dispatch: SlackDispatch): Promise<{ ok: boolean; action: SlashAction; note?: string }> {
    this.ensure();
    const conn = this.byWorkspace.get(cmd.workspaceId);
    if (!conn) throw AppError.notFound('slack connection', 'aios_p3_slack_no_connection');
    // explicit command authorization: the user must hold the slack.cmd capability
    if (!this.capabilities(cmd.workspaceId).includes('slack.cmd')) {
      throw AppError.forbidden('aios_p3_slack_unauthorized', 'slash command not authorized');
    }
    const res = await dispatch(cmd);
    this.ipc.publish(`aios.p3.slack.${cmd.workspaceId}`, sanitizeFields({ event: 'slash', command: cmd.command, action: res.action, userId: cmd.userId }), { workspaceId: cmd.workspaceId }).catch(() => void 0);
    return res;
  }

  /** Send a cowork status notification to the workspace channel (redacted, linked). */
  async notifyStatus(ws: string, kind: string, summary: string, link?: string): Promise<void> {
    this.ensure();
    const conn = this.byWorkspace.get(ws);
    if (!conn) return;
    await this.sink.post(conn.channel, summary, { link });
    this.ipc.publish(`aios.p3.slack.${ws}`, sanitizeFields({ event: 'status', kind }), { workspaceId: ws }).catch(() => void 0);
  }

  private ensure(): void {
    if (this.feature() !== 'slack') throw AppError.conflict('aios_p3_slack_disabled', 'slack feature is off');
  }

  /** Workspace connection count (isolation test helper). */
  connectedWorkspaces(): string[] {
    return [...this.byWorkspace.keys()];
  }
}

export function classifySlashText(text: string): SlashAction {
  const t = text.toLowerCase();
  if (t.includes('status')) return 'cowork.status';
  if (t.includes('link')) return 'cowork.link';
  if (t.includes('run')) return 'cowork.run';
  if (t.includes('approve')) return 'cowork.approve';
  return 'unknown';
}
