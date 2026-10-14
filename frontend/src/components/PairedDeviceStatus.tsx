/**
 * Live, server-authoritative presence for the user's paired Local Agents.
 * This status never implies that cloud project files are on the device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Presence = 'ONLINE' | 'STALE' | 'OFFLINE' | 'UNKNOWN';
type DeviceStatus = { state: string; presence: Presence };
type LoadState = 'loading' | 'ready' | 'error';

const POLL_INTERVAL_MS = 15_000;

function parseDevices(payload: unknown): DeviceStatus[] {
  if (typeof payload !== 'object' || payload === null || !('devices' in payload) || !Array.isArray(payload.devices)) {
    throw new Error('Invalid paired-device status response');
  }

  return payload.devices.map((value: unknown) => {
    if (typeof value !== 'object' || value === null || !('state' in value) || !('presence' in value)) {
      throw new Error('Invalid paired-device status row');
    }
    const row = value as { state: unknown; presence: unknown };
    if (typeof row.state !== 'string' || typeof row.presence !== 'string') {
      throw new Error('Invalid paired-device status fields');
    }
    const presence: Presence = row.presence === 'ONLINE' || row.presence === 'STALE' || row.presence === 'OFFLINE'
      ? row.presence
      : 'UNKNOWN';
    return { state: row.state, presence };
  }).filter((device) => device.state === 'PAIRED');
}

export function PairedDeviceStatus({ description }: { description: string }) {
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (mounted.current) setRefreshing(true);
    try {
      const payload = await api<unknown>('/api/v1/local-workspace/devices');
      const currentDevices = parseDevices(payload);
      if (mounted.current) {
        setDevices(currentDevices);
        setLoadState('ready');
        setLastChecked(new Date());
      }
    } catch {
      if (mounted.current) {
        setDevices([]);
        setLoadState('error');
        setLastChecked(null);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const online = devices.filter((device) => device.presence === 'ONLINE').length;
  const stale = devices.filter((device) => device.presence === 'STALE').length;
  const unknown = devices.filter((device) => device.presence === 'UNKNOWN').length;

  let statusText: string;
  let stateName: string;
  if (loadState === 'loading') {
    statusText = 'Checking paired-device status…';
    stateName = 'loading';
  } else if (loadState === 'error') {
    statusText = 'STATUS UNAVAILABLE — The paired-device connection could not be confirmed.';
    stateName = 'error';
  } else if (devices.length === 0) {
    statusText = 'NO PAIRED DEVICE — Pair a Local Agent to use files on this device.';
    stateName = 'offline';
  } else if (unknown > 0) {
    statusText = `DEGRADED — Presence is unknown for ${unknown} paired device${unknown === 1 ? '' : 's'}.`;
    stateName = 'degraded';
  } else if (online > 0) {
    statusText = `ONLINE — ${online} of ${devices.length} paired device${devices.length === 1 ? '' : 's'} currently connected.`;
    stateName = 'online';
  } else if (stale > 0) {
    statusText = `DEGRADED — ${stale} paired device${stale === 1 ? '' : 's'} have a stale heartbeat; local actions are unavailable.`;
    stateName = 'degraded';
  } else {
    statusText = `OFFLINE — ${devices.length} paired device${devices.length === 1 ? '' : 's'}; local actions are unavailable.`;
    stateName = 'offline';
  }

  return (
    <section className="cc-card" data-testid="paired-device-status" data-state={stateName} aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14 }}>Web-to-local connection</h2>
          <p data-testid="paired-device-presence" style={{ margin: '4px 0 0' }}>{statusText}</p>
          {lastChecked && (
            <p className="cc-hint" data-testid="paired-device-checked" style={{ margin: '2px 0 0' }}>
              Last confirmed {lastChecked.toLocaleTimeString()}{refreshing ? ' · checking again' : ''}
            </p>
          )}
          <p className="cc-hint" style={{ margin: '4px 0 0' }}>{description}</p>
        </div>
        <button
          type="button"
          className="cc-btn cc-btn--ghost cc-btn--sm"
          aria-label="Refresh paired-device status"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </div>
    </section>
  );
}
