/**
 * CodeConClave Desktop — IPC registry with sender validation.
 *
 * Every dispatch is validated BEFORE the handler runs:
 *   1. the channel must exist in the static CHANNELS allow-list,
 *   2. the payload must pass the channel's validator (unknown fields dropped,
 *      wrong types rejected),
 *   3. the sender must be the top frame of the app's main window
 *      (frameId 0, top frame) and must carry a permitted origin,
 *   4. the capability required by the channel must be granted on the ACTIVE
 *      workspace (checked by the caller via DesktopApp, which owns grants).
 *
 * Handlers are registered by the composition root with their channel; a
 * handler can never be reached under a different channel name because lookup
 * is allow-list based, not dynamic.
 */
import { IpcPayloadError, channelDef, type IpcChannelName } from './channels.js';

export type SenderIdentity = {
  frameId: number;
  isTopFrame: boolean;
  origin: string | null;
};

export interface Portals {
  /** Whether the sender origin matches the app origin the window is allowed to host. */
  isPermittedOrigin(origin: string | null): boolean;
}

export type Handler<P, R> = (payload: P, sender: SenderIdentity) => Promise<R>;

export class IpcSecurityError extends Error {
  readonly code = 'ipc_forbidden';
  constructor(message: string) {
    super(message);
    this.name = 'IpcSecurityError';
  }
}

export class IpcRegistry {
  private readonly handlers = new Map<IpcChannelName, Handler<unknown, unknown>>();

  register<P, R>(channel: IpcChannelName, handler: Handler<P, R>): void {
    if (!channelDef(channel)) throw new Error(`channel not allow-listed: ${channel}`);
    if (this.handlers.has(channel)) throw new Error(`channel already registered: ${channel}`);
    this.handlers.set(channel, handler as Handler<unknown, unknown>);
  }

  /** Call a handler through the same validation path the real IPC would use. */
  async dispatch<P>(channel: string, payload: unknown, sender: SenderIdentity, portals: Portals): Promise<unknown> {
    if (!channelDef(channel)) throw new IpcSecurityError(`channel not allow-listed: ${channel}`);
    if (!sender.isTopFrame || sender.frameId !== 0) {
      throw new IpcSecurityError('ipc permitted only from the top frame of the main window');
    }
    if (!portals.isPermittedOrigin(sender.origin)) {
      throw new IpcSecurityError(`origin not permitted`);
    }
    const def = channelDef(channel)!;
    let clean: unknown;
    try {
      clean = def.validate(payload);
    } catch (err) {
      if (err instanceof IpcPayloadError) throw err;
      throw new IpcPayloadError('invalid payload');
    }
    const handler = this.handlers.get(def.channel);
    if (!handler) throw new IpcSecurityError(`handler not registered: ${channel}`);
    return handler(clean, sender);
  }

  channelCount(): number {
    return this.handlers.size;
  }
}