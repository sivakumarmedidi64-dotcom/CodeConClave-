/**
 * CodeConClave AI OS — P3.12 IDE Foundation.
 *
 * Additive, flag-gated foundation for editor/IDE integration (extension host +
 * protocol + diagnostics bridge). It does NOT ship an IDE or editor; it exposes
 * a minimal bridge that other surfaces (VS Code / web / mobile) can adopt in a
 * later phase. All actions are workspace-isolated and capability-gated; nothing
 * auto-imports or auto-executes editor commands without authorization.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export interface IdeDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
  file?: string;
  line?: number;
}

export interface IdeBridge {
  openFile(workspaceId: string, file: string): Promise<boolean>;
  applyDiagnostics(workspaceId: string, diagnostics: readonly IdeDiagnostic[]): Promise<void>;
}

export type CapabilityHolder = (c: string) => boolean;

export class IdeFoundation {
  private bridges = new Map<string, IdeBridge>();
  private sessions = new Map<string, { workspaceId: string; bridgeId: string }>();

  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder) {}

  isEnabled(): boolean {
    return this.feature() === 'ide';
  }

  registerBridge(bridgeId: string, bridge: IdeBridge): () => void {
    this.ensure();
    this.bridges.set(bridgeId, bridge);
    return () => this.bridges.delete(bridgeId);
  }

  createSession(workspaceId: string, bridgeId: string): { sessionId: string } {
    this.ensure();
    if (!this.bridges.has(bridgeId)) throw AppError.notFound(`ide bridge ${bridgeId}`, 'aios_p3_ide_no_bridge');
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { workspaceId, bridgeId });
    return { sessionId };
  }

  /** Open a file in the editor bridge (capability-gated). */
  async openFile(sessionId: string, file: string): Promise<boolean> {
    this.ensure();
    const s = this.session(sessionId);
    this.requireCap('ide.open', s.workspaceId);
    const b = this.bridges.get(s.bridgeId);
    if (!b) throw AppError.notFound('ide bridge', 'aios_p3_ide_no_bridge');
    return b.openFile(s.workspaceId, file);
  }

  /** Push diagnostics into the editor bridge (capability-gated). */
  async pushDiagnostics(sessionId: string, diagnostics: readonly IdeDiagnostic[]): Promise<void> {
    this.ensure();
    const s = this.session(sessionId);
    this.requireCap('ide.diagnostics', s.workspaceId);
    const b = this.bridges.get(s.bridgeId);
    if (!b) throw AppError.notFound('ide bridge', 'aios_p3_ide_no_bridge');
    await b.applyDiagnostics(s.workspaceId, sanitizeFields(diagnostics as unknown as Record<string, unknown>) as unknown as readonly IdeDiagnostic[]);
  }

  private session(sessionId: string): { workspaceId: string; bridgeId: string } {
    const s = this.sessions.get(sessionId);
    if (!s) throw AppError.notFound(`ide session ${sessionId}`, 'aios_p3_ide_no_session');
    return s;
  }

  private requireCap(cap: string, ws: string): void {
    if (!this.hasCap(cap)) throw AppError.forbidden('aios_p3_ide_cap', `capability ${cap} required`);
    void ws;
  }

  private ensure(): void {
    if (this.feature() !== 'ide') throw AppError.conflict('aios_p3_ide_off', 'ide foundation feature is off');
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}
