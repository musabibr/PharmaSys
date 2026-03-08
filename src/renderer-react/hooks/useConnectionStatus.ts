import { useState, useEffect, useCallback } from 'react';
import { api } from '@/api';
import type { DeviceMode } from '@/api/types';

export interface ConnectionStatus {
  /** Current device mode (null while loading) */
  mode: DeviceMode | null;
  /** LAN IP of this device (server mode) */
  lanIp: string;
  /** Server URL (client mode) */
  serverUrl: string;
  /** Whether the client can reach the server */
  connected: boolean;
  /** True while checking connection */
  checking: boolean;
  /** Manually retry connection check */
  retry: () => Promise<void>;
}

/**
 * Shared hook that provides device mode + connection health status.
 * In client mode, periodically pings the server's /health endpoint.
 */
export function useConnectionStatus(pollIntervalMs = 15_000): ConnectionStatus {
  const [mode, setMode] = useState<DeviceMode | null>(null);
  const [lanIp, setLanIp] = useState('');
  const [serverHost, setServerHost] = useState('');
  const [serverPort, setServerPort] = useState(3001);
  const [connected, setConnected] = useState(true);
  const [checking, setChecking] = useState(false);

  // Load device config once
  useEffect(() => {
    if (!api?.device?.getConfig) {
      setMode('standalone');
      return;
    }
    api.device.getConfig()
      .then((config) => {
        setMode(config.mode);
        setLanIp(config.lanIp || '');
        setServerHost(config.serverHost || '');
        setServerPort(config.serverPort || 3001);
      })
      .catch(() => setMode('standalone'));
  }, []);

  const serverUrl = mode === 'client' && serverHost
    ? `http://${serverHost}:${serverPort}`
    : '';

  const checkHealth = useCallback(async () => {
    if (!serverUrl) return;
    setChecking(true);
    try {
      const res = await fetch(`${serverUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      setConnected(json.status === 'ok');
    } catch {
      setConnected(false);
    } finally {
      setChecking(false);
    }
  }, [serverUrl]);

  // Periodic health check in client mode
  useEffect(() => {
    if (mode !== 'client' || !serverUrl) return;
    checkHealth();
    const interval = setInterval(checkHealth, pollIntervalMs);
    return () => clearInterval(interval);
  }, [mode, serverUrl, checkHealth, pollIntervalMs]);

  return {
    mode,
    lanIp,
    serverUrl,
    connected: mode !== 'client' ? true : connected,
    checking,
    retry: checkHealth,
  };
}
