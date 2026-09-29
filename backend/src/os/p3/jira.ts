/**
 * CodeConClave AI OS — P3.2 Jira Connector.
 *
 * Connect → read ticket → create cowork from ticket → attach cowork result to
 * ticket. WRITE actions (attaching results, updating tickets) require explicit
 * user approval (bound, one-time). Credentials are workspace-scoped through an
 * injected secret manager and never logged. All event flow rides the canonical
 * IPC bus (no second event system). Read = jira.read; write = jira.write.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { IpcBus } from '../ipc.js';
import type { SecretStore } from './github.js';
import type { P3Feature } from './flags.js';

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  url: string;
  updatedAt: number;
}

export interface JiraHttp {
  connect(baseUrl: string, token: string): Promise<{ accountId: string; displayName: string }>;
  ticket(baseUrl: string, key: string, token: string): Promise<JiraTicket>;
  attachResult(baseUrl: string, key: string, token: string, body: string): Promise<{ posted: boolean }>;
}

type Gate = { capability: 'jira.read' | 'jira.write'; authorized: boolean; approvedFor?: string };

export class JiraConnector {
  private byWorkspace = new Map<string, { baseUrl: string }>();

  constructor(
    private feature: () => P3Feature | null,
    private ipc: IpcBus,
    private http: JiraHttp,
    private secrets: SecretStore,
    private capabilities: (workspaceId: string) => readonly string[],
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'jira';
  }

  /** Connect to a Jira instance. Token stored via secret manager (workspace-scoped). */
  async connect(ws: string, baseUrl: string, email: string, token: string, gate: Gate) {
    this.ensure();
    this.requireCap(gate.capability, ws);
    if (!gate.authorized) throw AppError.forbidden('aios_p3_jira_unauthorized', 'not authorized');
    await this.secrets.put(`jira:${ws}`, baseUrl, token);
    const acct = await this.http.connect(baseUrl, token);
    this.byWorkspace.set(ws, { baseUrl });
    void email;
    this.ipc.publish(`aios.p3.jira.${ws}`, sanitizeFields({ event: 'connected', accountId: acct.accountId }), { workspaceId: ws }).catch(() => void 0);
    return { workspaceId: ws, account: acct };
  }

  /** Read a ticket (read = jira.read). */
  async readTicket(ws: string, key: string, gate: Gate): Promise<{ ticket: JiraTicket; baseUrl: string }> {
    this.ensure();
    this.requireCap('jira.read', ws);
    const { baseUrl } = this.requireConnected(ws);
    const token = (await this.secrets.get(`jira:${ws}`, baseUrl)) ?? '';
    const ticket = await this.http.ticket(baseUrl, key, token);
    return { ticket, baseUrl };
  }

  /** Create a cowork from a ticket: emits a workspace-scoped cowork request on the bus. */
  createCoworkFromTicket(ws: string, ticket: JiraTicket, requestedBy: string, gate: Gate): { coworkRequestId: string } {
    this.ensure();
    this.requireCap('jira.read', ws);
    const id = randomUUID();
    this.ipc.publish(`aios.p3.jira.${ws}`, sanitizeFields({ event: 'cowork_requested', key: ticket.key, coworkRequestId: id, requestedBy }), { workspaceId: ws }).catch(() => void 0);
    return { coworkRequestId: id };
  }

  /** Attach a cowork result to a ticket. WRITE — requires explicit approval. */
  async attachResult(ws: string, key: string, resultBody: string, gate: Gate): Promise<{ posted: boolean }> {
    this.ensure();
    this.requireWrite(gate, ws, `attach:${key}`);
    const { baseUrl } = this.requireConnected(ws);
    const token = (await this.secrets.get(`jira:${ws}`, baseUrl)) ?? '';
    const res = await this.http.attachResult(baseUrl, key, token, resultBody);
    this.ipc.publish(`aios.p3.jira.${ws}`, sanitizeFields({ event: 'result_attached', key }), { workspaceId: ws }).catch(() => void 0);
    return res;
  }

  requireConnected(ws: string): { baseUrl: string } {
    const c = this.byWorkspace.get(ws);
    if (!c) throw AppError.notFound(`jira connection for workspace ${ws}`, 'aios_p3_jira_no_connection');
    return c;
  }

  private requireCap(kind: 'jira.read' | 'jira.write', ws: string): void {
    if (!this.capabilities(ws).includes(kind)) throw AppError.forbidden('aios_p3_jira_cap', `capability ${kind} required`);
  }

  private requireWrite(gate: Gate, ws: string, target: string): void {
    this.requireCap('jira.write', ws);
    if (!gate.authorized) throw AppError.forbidden('aios_p3_jira_unauthorized', 'not authorized');
    if (gate.approvedFor !== target) throw AppError.forbidden('aios_p3_jira_approval', `explicit approval required for ${target}`);
  }

  private ensure(): void {
    if (this.feature() !== 'jira') throw AppError.conflict('aios_p3_jira_disabled', 'jira feature is off');
  }
}
