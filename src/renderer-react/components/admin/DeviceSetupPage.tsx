import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Loader2, Monitor, Server, Wifi, CheckCircle2, XCircle, RefreshCw, Search } from 'lucide-react';
import { api } from '@/api';
import type { DeviceMode, DiscoveredServer } from '@/api/types';

export function DeviceSetupPage() {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);

  const [mode, setMode] = useState<DeviceMode>('standalone');
  const [serverHost, setServerHost] = useState('');
  const [serverPort, setServerPort] = useState(3001);
  const [lanIp, setLanIp] = useState('');
  const [allLanIps, setAllLanIps] = useState<Array<{ name: string; address: string }>>([]);
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.device.getConfig();
        if (cancelled) return;
        setMode(config.mode);
        setServerHost(config.serverHost);
        setServerPort(config.serverPort);
        setLanIp(config.lanIp || '');
        setAllLanIps(config.allLanIps || []);
      } catch {
        if (!cancelled) toast.error(t('Failed to load device configuration'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const handleTestConnection = async () => {
    if (!serverHost) {
      toast.error(t('Enter server IP address first'));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const url = `http://${serverHost}:${serverPort}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      if (json.status === 'ok') {
        setTestResult('success');
        toast.success(t('Connection successful'));
      } else {
        setTestResult('fail');
        toast.error(t('Server responded but status is not ok'));
      }
    } catch {
      setTestResult('fail');
      toast.error(t('Cannot connect to server'));
    } finally {
      setTesting(false);
    }
  };

  const handleScanForServers = async () => {
    setScanning(true);
    setDiscoveredServers([]);
    try {
      const found = await api.discovery.scan();
      setDiscoveredServers(found);
      if (found.length === 0) {
        toast.info(t('No servers found on your network'));
      }
    } catch {
      toast.error(t('Discovery not available'));
    } finally {
      setScanning(false);
    }
  };

  const handleSave = async () => {
    if (mode === 'client' && !serverHost) {
      toast.error(t('Server IP address is required for client mode'));
      return;
    }
    setSaving(true);
    try {
      const result = await api.device.saveConfig({
        mode,
        serverHost,
        serverPort,
      });
      if (result?.success) {
        toast.success(t('Device configuration saved. Restart the application to apply changes.'));
      } else {
        toast.error(t('Failed to save configuration'));
      }
    } catch {
      toast.error(t('Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t('Device Setup')}</h1>
        <p className="text-muted-foreground">
          {t('Configure how this device connects to the PharmaSys database')}
        </p>
      </div>

      {/* Mode Selection */}
      <Card>
        <CardHeader>
          <CardTitle>{t('Device Mode')}</CardTitle>
          <CardDescription>
            {t('Choose how this device operates in your pharmacy network')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Standalone */}
          <label
            className={`flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
              mode === 'standalone' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
          >
            <input
              type="radio"
              name="deviceMode"
              value="standalone"
              checked={mode === 'standalone'}
              onChange={() => setMode('standalone')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4" />
                <span className="font-medium">{t('Standalone')}</span>
                <Badge variant="secondary">{t('Default')}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Single device with local database. No network required.')}
              </p>
            </div>
          </label>

          {/* Server */}
          <label
            className={`flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
              mode === 'server' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
          >
            <input
              type="radio"
              name="deviceMode"
              value="server"
              checked={mode === 'server'}
              onChange={() => setMode('server')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4" />
                <span className="font-medium">{t('Server')}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Main device with local database. Other devices connect to this one over LAN.')}
              </p>
            </div>
          </label>

          {/* Client */}
          <label
            className={`flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors ${
              mode === 'client' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
            }`}
          >
            <input
              type="radio"
              name="deviceMode"
              value="client"
              checked={mode === 'client'}
              onChange={() => setMode('client')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4" />
                <span className="font-medium">{t('Client')}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Connects to a server device over LAN. No local database.')}
              </p>
            </div>
          </label>
        </CardContent>
      </Card>

      {/* Server Mode Info */}
      {mode === 'server' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('Server Information')}</CardTitle>
            <CardDescription>
              {t('Client devices should connect to one of these IP addresses')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {allLanIps.length > 0 ? (
              <div className="space-y-2">
                <span className="text-sm font-medium">{t('Available IP Addresses')}</span>
                {allLanIps.map((ip) => (
                  <div key={ip.address} className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-background px-2 py-1 font-mono text-sm font-semibold">
                        {ip.address}
                      </code>
                      <span className="text-xs text-muted-foreground">({ip.name})</span>
                    </div>
                    {ip.address === lanIp && (
                      <Badge variant="default" className="text-xs">{t('Recommended')}</Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                <span className="text-sm font-medium">{t('LAN IP Address')}</span>
                <code className="rounded bg-background px-2 py-1 font-mono text-sm">
                  {lanIp || '...'}
                </code>
              </div>
            )}
            <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
              <span className="text-sm font-medium">{t('Port')}</span>
              <code className="rounded bg-background px-2 py-1 font-mono text-sm">
                {serverPort}
              </code>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('Client devices should connect to')}{' '}
              <code className="font-mono text-foreground">{lanIp}:{serverPort}</code>
            </p>
          </CardContent>
        </Card>
      )}

      {/* Client Mode Config */}
      {mode === 'client' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('Server Connection')}</CardTitle>
            <CardDescription>
              {t('Enter the IP address and port of the server device')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Scan for Servers */}
            <div className="space-y-3">
              <Button
                variant="outline"
                onClick={handleScanForServers}
                disabled={scanning}
                className="w-full"
              >
                {scanning ? (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="me-2 h-4 w-4" />
                )}
                {scanning ? t('Searching for PharmaSys servers on your network...') : t('Scan for Servers')}
              </Button>

              {discoveredServers.length > 0 && (
                <div className="space-y-2">
                  {discoveredServers.map((server) => (
                    <button
                      key={`${server.ip}:${server.port}`}
                      type="button"
                      onClick={() => {
                        setServerHost(server.ip);
                        setServerPort(server.port);
                        setTestResult(null);
                      }}
                      className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-start transition-colors hover:border-primary hover:bg-primary/5"
                    >
                      <Wifi className="h-4 w-4 shrink-0 text-emerald-500" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{server.name}</p>
                        <p className="text-xs text-muted-foreground">{server.ip}:{server.port}</p>
                      </div>
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="serverHost">{t('Server IP Address')}</Label>
                <Input
                  id="serverHost"
                  placeholder="192.168.1.100"
                  value={serverHost}
                  onChange={(e) => {
                    setServerHost(e.target.value);
                    setTestResult(null);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="serverPort">{t('Port')}</Label>
                <Input
                  id="serverPort"
                  type="number"
                  value={serverPort}
                  onChange={(e) => {
                    setServerPort(Number(e.target.value) || 3001);
                    setTestResult(null);
                  }}
                />
              </div>
            </div>

            <Separator />

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={testing || !serverHost}
              >
                {testing ? (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="me-2 h-4 w-4" />
                )}
                {t('Test Connection')}
              </Button>

              {testResult === 'success' && (
                <div className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('Connected')}
                </div>
              )}
              {testResult === 'fail' && (
                <div className="flex items-center gap-1 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  {t('Connection failed')}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {t('Save & Restart Required')}
        </Button>
      </div>
    </div>
  );
}
