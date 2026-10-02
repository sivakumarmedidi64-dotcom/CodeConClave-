/**
 * CodeConClave — FOUNDER GOOGLE SHEETS MIRROR (mirror only, NEVER authority).
 *
 * The database is ALWAYS the source of truth for payments/revenue. This module
 * pushes append-only, best-effort revenue snapshots to the founder's connected
 * Google Sheets spreadsheet (existing plug-in adapter `sheets.values.append`).
 * A sheet failure NEVER changes, blocks or fabricates payment truth.
 *
 * Enablement: the founder must (1) connect the Google plugin (OAuth) on the
 * Plugins page and (2) set FOUNDER_SHEET_ID to the spreadsheet id. Until then
 * `sheetMirrorStatus` reports not-configured and `pushRevenueSnapshot` returns
 * a clear reason without throwing.
 */
import { AppError } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';
import { executePluginAction } from '../../plugins/engine.js';
import { listConnections } from '../../plugins/health.js';
import { founderRevenueOverview, founderMonthlyRevenue } from './revenue.js';

export interface SheetMirrorStatus {
  configured: boolean;
  connected: boolean;
  connectionId: string | null;
  spreadsheetId: string | null;
  enabled: boolean;
  reason: string | null;
}

function resolveSpreadsheet(): string | null {
  const id = env.FOUNDER_SHEET_ID?.trim();
  return id ? id : null;
}

export async function sheetMirrorStatus(actorUserId: string): Promise<SheetMirrorStatus> {
  const spreadsheetId = resolveSpreadsheet();
  const connections = await listConnections(actorUserId);
  const google = connections.find(
    (c) => c.plugin_type === 'google' && (c.state === 'CONNECTED' || c.state === 'DEGRADED'),
  );
  return {
    configured: Boolean(spreadsheetId),
    connected: Boolean(google),
    connectionId: google?.id ?? null,
    spreadsheetId,
    enabled: Boolean(spreadsheetId && google),
    reason: !spreadsheetId
      ? 'FOUNDER_SHEET_ID is not configured (set it to the Google Sheet id).'
      : !google
        ? 'Google plugin is not connected for this account — connect it on the Plugins page (OAuth scope: spreadsheets).'
        : null,
  };
}

/**
 * Append a revenue snapshot to the founder sheet. Best-effort: any failure is
 * captured in the return value; it never propagates into payment processing.
 */
export async function pushRevenueSnapshot(actorUserId: string): Promise<{
  ok: boolean;
  reason: string | null;
  rowsPushed: number;
  range: string;
}> {
  const status = await sheetMirrorStatus(actorUserId);
  if (!status.enabled || !status.connectionId || !status.spreadsheetId) {
    return { ok: false, reason: status.reason ?? 'Sheet mirror not enabled', rowsPushed: 0, range: 'Revenue!A1' };
  }

  const header = ['Month', 'Solo INR', 'Team INR', 'API INR', 'Total INR', 'Refunded INR', 'Net INR', 'Customers'];
  const monthly = await founderMonthlyRevenue(12);
  const values = [header, ...monthly.map((m) => [m.month, m.soloInr, m.teamInr, m.apiInr, m.totalInr, m.refundedInr, m.netInr, m.customerCount])];

  try {
    const outcome = await executePluginAction({
      userId: actorUserId,
      connectionId: status.connectionId,
      action: 'sheets.values.append',
      input: { spreadsheetId: status.spreadsheetId, range: 'Revenue!A1', values },
    });
    if (!outcome.ok) {
      return { ok: false, reason: 'Sheet append returned failure', rowsPushed: 0, range: 'Revenue!A1' };
    }
    return { ok: true, reason: null, rowsPushed: values.length, range: 'Revenue!A1' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err),
      rowsPushed: 0,
      range: 'Revenue!A1',
    };
  }
}