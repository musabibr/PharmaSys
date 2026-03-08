import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Loader2, Server, Link2, CheckCircle2, Search, Wifi, XCircle, RefreshCw } from 'lucide-react';
import { api } from '@/api';
import type { DiscoveredServer } from '@/api/types';

type WizardStep = 'choose' | 'server-done' | 'client-scan' | 'client-manual' | 'restart';

export function DeviceSetupWizard() {
  const { t } = useTranslation();

  const [step, setStep] = useState<WizardStep>('choose');
  const [saving, setSaving] = useState(false);

  // Client scan state
  const [scanning, setScanning] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [scanDone, setScanDone] = useState(false);

  // Manual fallback state
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState(3001);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handlePickServer = async () => {
    setSaving(true);
    try {
      const result = await api.device.saveConfig({
        mode: 'server',
        serverHost: '',
        serverPort: 3001,
      });
      if (!result?.success) {
        toast.error(t('Failed to save configuration'));
      }
      // The main process reloads the window automatically after saving.
      // The App component will re-check getConfig and see mode='server'.
    } catch {
      toast.error(t('Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  const handlePickClient = async () => {
    setStep('client-scan');
    await runScan();
  };

  const runScan = async () => {
    setScanning(true);
    setScanDone(false);
    setServers([]);
    try {
      const found = await api.discovery.scan();
      setServers(found);
    } catch {
      // Discovery not available — show manual fallback
    } finally {
      setScanning(false);
      setScanDone(true);
    }
  };

  const handleSelectServer = async (server: DiscoveredServer) => {
    setSaving(true);
    try {
      const result = await api.device.saveConfig({
        mode: 'client',
        serverHost: server.ip,
        serverPort: server.port,
      });
      if (!result?.success) {
        toast.error(t('Failed to save configuration'));
      }
      // The main process closes and recreates the window with the correct preload.
    } catch {
      toast.error(t('Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!manualHost) {
      toast.error(t('Enter server IP address first'));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const url = `http://${manualHost}:${manualPort}/health`;
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

  const handleManualSave = async () => {
    if (!manualHost) {
      toast.error(t('Server IP address is required for client mode'));
      return;
    }
    setSaving(true);
    try {
      const result = await api.device.saveConfig({
        mode: 'client',
        serverHost: manualHost,
        serverPort: manualPort,
      });
      if (!result?.success) {
        toast.error(t('Failed to save configuration'));
      }
      // The main process closes and recreates the window with the correct preload.
    } catch {
      toast.error(t('Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = () => {
    api.app.restart();
  };

  // ── Render steps ───────────────────────────────────────────────────────────

  // Step 1: Choose role
  if (step === 'choose') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
              <span className="text-3xl font-bold text-emerald-500">P</span>
            </div>
            <h1 className="text-2xl font-bold">{t('How will you use this device?')}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('Choose how this device operates in your pharmacy network')}
            </p>
          </div>

          <div className="grid gap-4">
            {/* Main Device */}
            <button
              type="button"
              onClick={handlePickServer}
              disabled={saving}
              className="flex items-start gap-4 rounded-xl border-2 border-border bg-card p-6 text-start transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
                <Server className="h-6 w-6 text-emerald-500" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">{t('Main Device')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('This device stores all data. Other devices connect to it.')}
                </p>
              </div>
            </button>

            {/* Connect to another */}
            <button
              type="button"
              onClick={handlePickClient}
              disabled={saving}
              className="flex items-start gap-4 rounded-xl border-2 border-border bg-card p-6 text-start transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                <Link2 className="h-6 w-6 text-blue-500" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">{t('Connect to Another Device')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('This device connects to a main device on your network.')}
                </p>
              </div>
            </button>
          </div>

          {saving && (
            <div className="flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Step: Server done
  if (step === 'server-done') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            </div>
            <CardTitle className="text-xl">{t('All set!')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              {t('This device is now the main server. Other devices can find it automatically on the network.')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('The app needs to restart to apply changes.')}
            </p>
            <Button onClick={handleRestart} className="w-full">
              {t('Restart Now')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step: Client scan
  if (step === 'client-scan') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-blue-500/10">
              <Search className="h-8 w-8 text-blue-500" />
            </div>
            <CardTitle className="text-xl">
              {scanning
                ? t('Searching for PharmaSys servers on your network...')
                : servers.length > 0
                  ? t('PharmaSys Server found')
                  : t('No servers found on your network')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {scanning && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              </div>
            )}

            {!scanning && servers.length > 0 && (
              <div className="space-y-3">
                {servers.map((server) => (
                  <button
                    key={`${server.ip}:${server.port}`}
                    type="button"
                    onClick={() => handleSelectServer(server)}
                    disabled={saving}
                    className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-start transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
                  >
                    <Wifi className="h-5 w-5 shrink-0 text-emerald-500" />
                    <div className="flex-1">
                      <p className="font-medium">{server.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {server.ip}:{server.port}
                      </p>
                    </div>
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}

            {!scanning && scanDone && servers.length === 0 && (
              <div className="space-y-4">
                <p className="text-center text-sm text-muted-foreground">
                  {t('Make sure the main device is running and connected to the same network.')}
                </p>

                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={runScan}>
                    <RefreshCw className="me-2 h-4 w-4" />
                    {t('Try Again')}
                  </Button>
                  <Button variant="outline" className="flex-1" onClick={() => setStep('client-manual')}>
                    {t('Enter IP Address Manually')}
                  </Button>
                </div>
              </div>
            )}

            {saving && (
              <div className="flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            <Separator />

            <Button variant="ghost" className="w-full" onClick={() => setStep('choose')}>
              {t('Back')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step: Manual IP entry fallback
  if (step === 'client-manual') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('Enter IP Address Manually')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="manual-host">{t('Server IP Address')}</Label>
                <Input
                  id="manual-host"
                  placeholder="192.168.1.100"
                  value={manualHost}
                  onChange={(e) => {
                    setManualHost(e.target.value);
                    setTestResult(null);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-port">{t('Port')}</Label>
                <Input
                  id="manual-port"
                  type="number"
                  value={manualPort}
                  onChange={(e) => {
                    setManualPort(Number(e.target.value) || 3001);
                    setTestResult(null);
                  }}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testing || !manualHost}
              >
                {testing ? (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="me-2 h-4 w-4" />
                )}
                {t('Test Connection')}
              </Button>

              {testResult === 'success' && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('Connected')}
                </span>
              )}
              {testResult === 'fail' && (
                <span className="flex items-center gap-1 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  {t('Connection failed')}
                </span>
              )}
            </div>

            <Separator />

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStep('client-scan')}>
                {t('Back')}
              </Button>
              <Button className="flex-1" onClick={handleManualSave} disabled={saving || !manualHost}>
                {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('Connect')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step: Restart
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </div>
          <CardTitle className="text-xl">{t('Configuration saved')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            {t('The app needs to restart to apply changes.')}
          </p>
          <Button onClick={handleRestart} className="w-full">
            {t('Restart Now')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
