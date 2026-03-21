import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Loader2, WifiOff, RefreshCw, Search, Wifi } from 'lucide-react';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { api } from '@/api';
import type { DiscoveredServer } from '@/api/types';

/**
 * Shows a full-screen overlay when the client cannot reach the server.
 * Only active in client mode — renders nothing in standalone/server mode.
 *
 * When disconnected, automatically scans the LAN for the server. If the server
 * moved to a new IP (e.g., WiFi change), the user can click "Reconnect" to
 * update the saved config and reload with the new address.
 */
export function ConnectionOverlay() {
  const { t } = useTranslation();
  const { mode, serverUrl, connected, checking, retry } = useConnectionStatus();

  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [foundServer, setFoundServer] = useState<DiscoveredServer | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const runScan = useCallback(async () => {
    if (!api?.discovery?.scan) return;
    setScanning(true);
    setScanDone(false);
    setFoundServer(null);
    try {
      const servers = await api.discovery.scan();
      if (servers.length > 0) {
        setFoundServer(servers[0]);
      }
    } catch {
      // Discovery not available
    } finally {
      setScanning(false);
      setScanDone(true);
    }
  }, []);

  // Auto-scan when overlay first appears (disconnected)
  useEffect(() => {
    if (mode === 'client' && !connected && !scanning && !scanDone) {
      runScan();
    }
  }, [mode, connected, scanning, scanDone, runScan]);

  // Reset scan state when reconnected
  useEffect(() => {
    if (connected) {
      setScanDone(false);
      setFoundServer(null);
    }
  }, [connected]);

  const handleReconnect = async (server: DiscoveredServer) => {
    setReconnecting(true);
    try {
      await api.device.saveConfig({
        mode: 'client',
        serverHost: server.ip,
        serverPort: server.port,
      });
      // Window will be recreated by main process with the new server URL
    } catch {
      setReconnecting(false);
    }
  };

  // Don't render anything if not in client mode or if connected
  if (mode !== 'client' || connected) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-lg border bg-card p-8 shadow-lg max-w-md w-full">
        <WifiOff className="h-12 w-12 text-destructive" />
        <h2 className="text-lg font-semibold">{t('Connection Lost')}</h2>
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          {t('Cannot connect to the server at')} <code className="font-mono">{serverUrl}</code>.
          {' '}{t('Check that the server is running and your network connection.')}
        </p>

        {/* Auto-discovery results */}
        {scanning && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('Searching for server on the network...')}
          </div>
        )}

        {!scanning && foundServer && (
          <div className="w-full rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-3">
              <Wifi className="h-5 w-5 shrink-0 text-emerald-500" />
              <div className="flex-1">
                <p className="text-sm font-medium">{t('Server found at a new address')}</p>
                <p className="text-sm text-muted-foreground">
                  {foundServer.name} — {foundServer.ip}:{foundServer.port}
                </p>
              </div>
            </div>
            <Button
              className="mt-3 w-full"
              onClick={() => handleReconnect(foundServer)}
              disabled={reconnecting}
            >
              {reconnecting ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="me-2 h-4 w-4" />
              )}
              {t('Reconnect')}
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1" onClick={retry} disabled={checking}>
            {checking ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="me-2 h-4 w-4" />
            )}
            {t('Retry Connection')}
          </Button>

          {!scanning && scanDone && !foundServer && (
            <Button variant="outline" className="flex-1" onClick={runScan}>
              <Search className="me-2 h-4 w-4" />
              {t('Find Server')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
