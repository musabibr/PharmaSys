import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/api';
import type { DeviceMode } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Settings, Monitor, Server, Wifi, Loader2, RefreshCw, CheckCircle2, XCircle, Search, WifiOff } from 'lucide-react';
import type { DiscoveredServer } from '@/api/types';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';

// ─── Forgot-password flow steps ──────────────────────────────────────────────

type ForgotStep = 1 | 2 | 3;

interface ForgotState {
  step: ForgotStep;
  username: string;
  securityQuestion: string;
  answer: string;
  newPassword: string;
  confirmPassword: string;
  error: string;
  loading: boolean;
}

const initialForgotState: ForgotState = {
  step: 1,
  username: '',
  securityQuestion: '',
  answer: '',
  newPassword: '',
  confirmPassword: '',
  error: '',
  loading: false,
};

// ─── Password change modal state ─────────────────────────────────────────────

interface PasswordChangeState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  error: string;
  loading: boolean;
}

const initialPasswordChangeState: PasswordChangeState = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  error: '',
  loading: false,
};

// ─── Security question setup (first launch) ────────────────────────────────

const SECURITY_QUESTIONS = [
  "What is your mother's maiden name?",
  'What was the name of your first pet?',
  'What city were you born in?',
  'What is your favorite book?',
  'What was your childhood nickname?',
];

// ─── Component ───────────────────────────────────────────────────────────────

export function LoginPage() {
  const { t } = useTranslation();
  const { login, completeLogin, isFirstLaunch } = useAuthStore();

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Forgot password flow
  const [showForgot, setShowForgot] = useState(false);
  const [forgot, setForgot] = useState<ForgotState>(initialForgotState);

  // Security question setup (shown after password change on first launch)
  const [showSecuritySetup, setShowSecuritySetup] = useState(false);
  const [secQuestion, setSecQuestion] = useState(SECURITY_QUESTIONS[0]);
  const [secAnswer, setSecAnswer] = useState('');
  const [secError, setSecError] = useState('');
  const [secLoading, setSecLoading] = useState(false);

  // Password change modal (shown after login when must_change_password === 1)
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [pwChange, setPwChange] = useState<PasswordChangeState>(initialPasswordChangeState);

  // Device setup dialog
  const [showDeviceSetup, setShowDeviceSetup] = useState(false);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const [deviceTesting, setDeviceTesting] = useState(false);
  const [deviceTestResult, setDeviceTestResult] = useState<'success' | 'fail' | null>(null);
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('standalone');
  const [deviceHost, setDeviceHost] = useState('');
  const [devicePort, setDevicePort] = useState(3001);
  const [deviceLanIp, setDeviceLanIp] = useState('');
  const [deviceAllIps, setDeviceAllIps] = useState<Array<{ name: string; address: string }>>([]);
  const [deviceScanning, setDeviceScanning] = useState(false);
  const [deviceDiscovered, setDeviceDiscovered] = useState<DiscoveredServer[]>([]);

  // Connection status for server/client mode indicator
  const conn = useConnectionStatus();

  // Refs for autofocus management
  const usernameRef = useRef<HTMLInputElement>(null);
  const forgotUsernameRef = useRef<HTMLInputElement>(null);
  const forgotAnswerRef = useRef<HTMLInputElement>(null);
  const forgotNewPasswordRef = useRef<HTMLInputElement>(null);

  // Focus management when switching views / steps
  useEffect(() => {
    if (!showForgot) {
      usernameRef.current?.focus();
    }
  }, [showForgot]);

  useEffect(() => {
    if (showForgot) {
      if (forgot.step === 1) forgotUsernameRef.current?.focus();
      else if (forgot.step === 2) forgotAnswerRef.current?.focus();
      else if (forgot.step === 3) forgotNewPasswordRef.current?.focus();
    }
  }, [showForgot, forgot.step]);

  // ── Device setup handlers ───────────────────────────────────────────────

  const openDeviceSetup = async () => {
    setShowDeviceSetup(true);
    setDeviceLoading(true);
    setDeviceTestResult(null);
    try {
      const config = await api.device.getConfig();
      setDeviceMode(config.mode);
      setDeviceHost(config.serverHost);
      setDevicePort(config.serverPort);
      setDeviceLanIp(config.lanIp || '');
      setDeviceAllIps(config.allLanIps || []);
    } catch {
      toast.error(t('Failed to load device configuration'));
    } finally {
      setDeviceLoading(false);
    }
  };

  const handleDeviceTestConnection = async () => {
    if (!deviceHost) {
      toast.error(t('Enter server IP address first'));
      return;
    }
    setDeviceTesting(true);
    setDeviceTestResult(null);
    try {
      const url = `http://${deviceHost}:${devicePort}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      if (json.status === 'ok') {
        setDeviceTestResult('success');
        toast.success(t('Connection successful'));
      } else {
        setDeviceTestResult('fail');
        toast.error(t('Server responded but status is not ok'));
      }
    } catch {
      setDeviceTestResult('fail');
      toast.error(t('Cannot connect to server'));
    } finally {
      setDeviceTesting(false);
    }
  };

  const handleDeviceScan = async () => {
    setDeviceScanning(true);
    setDeviceDiscovered([]);
    try {
      const found = await api.discovery.scan();
      setDeviceDiscovered(found);
      if (found.length === 0) {
        toast.info(t('No servers found on your network'));
      }
    } catch {
      toast.error(t('Discovery not available'));
    } finally {
      setDeviceScanning(false);
    }
  };

  const handleDeviceSave = async () => {
    if (deviceMode === 'client' && !deviceHost) {
      toast.error(t('Server IP address is required for client mode'));
      return;
    }
    setDeviceSaving(true);
    try {
      const result = await api.device.saveConfig({
        mode: deviceMode,
        serverHost: deviceHost,
        serverPort: devicePort,
      });
      if (result?.success) {
        toast.success(t('Device configuration saved. Restart the application to apply changes.'));
        setShowDeviceSetup(false);
      } else {
        toast.error(t('Failed to save configuration'));
      }
    } catch {
      toast.error(t('Failed to save configuration'));
    } finally {
      setDeviceSaving(false);
    }
  };

  // ── Login handler ────────────────────────────────────────────────────────

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError(t('Please enter username and password'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      const user = await login(username.trim(), password);
      if (user.must_change_password === 1) {
        setShowPasswordChange(true);
        setPwChange({ ...initialPasswordChangeState });
      }
    } catch (err: any) {
      setError(err.message || t('Login failed'));
    } finally {
      setLoading(false);
    }
  };

  // ── Forgot password handlers ─────────────────────────────────────────────

  const updateForgot = (patch: Partial<ForgotState>) => {
    setForgot((prev) => ({ ...prev, ...patch }));
  };

  const handleForgotStep1 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgot.username.trim()) {
      updateForgot({ error: t('Please enter your username') });
      return;
    }
    updateForgot({ error: '', loading: true });
    try {
      const result = await api.auth.getSecurityQuestion(forgot.username.trim());
      if (!result || !result.question) {
        updateForgot({ error: t('No security question set for this account'), loading: false });
        return;
      }
      updateForgot({
        securityQuestion: result.question,
        step: 2,
        loading: false,
      });
    } catch (err: any) {
      updateForgot({ error: err.message || t('Failed to retrieve security question'), loading: false });
    }
  };

  const handleForgotStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgot.answer.trim()) {
      updateForgot({ error: t('Please enter your answer') });
      return;
    }
    updateForgot({ error: '', step: 3 });
  };

  const handleForgotStep3 = async (e: React.FormEvent) => {
    e.preventDefault();
    const { answer, newPassword, confirmPassword, username: forgotUsername } = forgot;

    if (!newPassword) {
      updateForgot({ error: t('Please enter a new password') });
      return;
    }
    if (newPassword.length < 8) {
      updateForgot({ error: t('Password must be at least 8 characters') });
      return;
    }
    if (newPassword !== confirmPassword) {
      updateForgot({ error: t('Passwords do not match') });
      return;
    }

    updateForgot({ error: '', loading: true });
    try {
      const result = await api.auth.resetPasswordWithSecurityAnswer(
        forgotUsername.trim(),
        answer.trim(),
        newPassword
      );
      if (result && result.error) {
        updateForgot({ error: result.error, loading: false });
        return;
      }
      if (result && result.success) {
        toast.success(t('Password reset successfully'));
        exitForgotFlow();
      } else {
        updateForgot({ error: t('Password reset failed'), loading: false });
      }
    } catch (err: any) {
      updateForgot({ error: err.message || t('Password reset failed'), loading: false });
    }
  };

  const forgotGoBack = () => {
    if (forgot.step === 1) {
      exitForgotFlow();
    } else {
      updateForgot({ step: (forgot.step - 1) as ForgotStep, error: '' });
    }
  };

  const exitForgotFlow = () => {
    setShowForgot(false);
    setForgot(initialForgotState);
  };

  const enterForgotFlow = () => {
    setShowForgot(true);
    setForgot({ ...initialForgotState, username: username.trim() });
    setError('');
  };

  // ── Password change modal handlers ───────────────────────────────────────

  const updatePwChange = (patch: Partial<PasswordChangeState>) => {
    setPwChange((prev) => ({ ...prev, ...patch }));
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    const { currentPassword, newPassword, confirmPassword } = pwChange;

    if (!currentPassword || !newPassword || !confirmPassword) {
      updatePwChange({ error: t('All fields are required') });
      return;
    }
    if (newPassword.length < 8) {
      updatePwChange({ error: t('Password must be at least 8 characters') });
      return;
    }
    if (newPassword !== confirmPassword) {
      updatePwChange({ error: t('Passwords do not match') });
      return;
    }

    updatePwChange({ error: '', loading: true });
    try {
      const result = await api.auth.changePassword(currentPassword, newPassword);
      if (result && result.error) {
        updatePwChange({ error: result.error, loading: false });
        return;
      }
      if (result && result.success) {
        toast.success(t('Password changed successfully'));
        setShowPasswordChange(false);
        setPwChange(initialPasswordChangeState);
        // On first launch, also require security question setup
        if (isFirstLaunch) {
          setShowSecuritySetup(true);
        } else {
          // Password changed — now fully authenticate
          completeLogin();
        }
      } else {
        updatePwChange({ error: t('Password change failed'), loading: false });
      }
    } catch (err: any) {
      updatePwChange({ error: err.message || t('Password change failed'), loading: false });
    }
  };

  // ── Security question setup handler ─────────────────────────────────────
  const handleSecuritySetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secAnswer.trim()) {
      setSecError(t('Security answer is required'));
      return;
    }
    setSecError('');
    setSecLoading(true);
    try {
      const result = await api.auth.setSecurityQuestion(secQuestion, secAnswer.trim());
      if (result?.success) {
        toast.success(t('Security question set successfully'));
        setShowSecuritySetup(false);
        setSecAnswer('');
        // Security question set — now fully authenticate
        completeLogin();
      } else {
        setSecError(result?.error || t('Failed to set security question'));
      }
    } catch (err: any) {
      setSecError(err.message || t('Failed to set security question'));
    } finally {
      setSecLoading(false);
    }
  };

  // ── Render: Forgot password flow ─────────────────────────────────────────

  const renderForgotFlow = () => (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
          <span className="text-3xl font-bold text-emerald-500">P</span>
        </div>
        <CardTitle className="text-2xl">{t('Reset Password')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {forgot.step === 1 && t('Enter your username to begin')}
          {forgot.step === 2 && t('Answer your security question')}
          {forgot.step === 3 && t('Choose a new password')}
        </p>
      </CardHeader>
      <CardContent>
        {/* Step indicators */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {([1, 2, 3] as const).map((step) => (
            <div key={step} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                  forgot.step === step
                    ? 'bg-emerald-500 text-white'
                    : forgot.step > step
                      ? 'bg-emerald-500/20 text-emerald-500'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {forgot.step > step ? '\u2713' : step}
              </div>
              {step < 3 && (
                <div
                  className={`h-0.5 w-8 ${
                    forgot.step > step ? 'bg-emerald-500/40' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Username */}
        {forgot.step === 1 && (
          <form onSubmit={handleForgotStep1} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-username">{t('Username')}</Label>
              <Input
                ref={forgotUsernameRef}
                id="forgot-username"
                type="text"
                value={forgot.username}
                onChange={(e) => updateForgot({ username: e.target.value })}
                placeholder={t('Enter your username')}
                autoComplete="username"
                disabled={forgot.loading}
              />
            </div>

            {forgot.error && (
              <p className="text-sm text-destructive">{forgot.error}</p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={forgotGoBack}
                disabled={forgot.loading}
              >
                {t('Back')}
              </Button>
              <Button type="submit" className="flex-1" disabled={forgot.loading}>
                {forgot.loading ? t('Loading...') : t('Next')}
              </Button>
            </div>
          </form>
        )}

        {/* Step 2: Security question */}
        {forgot.step === 2 && (
          <form onSubmit={handleForgotStep2} className="space-y-4">
            <div className="rounded-md border border-border bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground">{t('Security Question')}</p>
              <p className="mt-1 text-sm font-medium">{forgot.securityQuestion}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="forgot-answer">{t('Your Answer')}</Label>
              <Input
                ref={forgotAnswerRef}
                id="forgot-answer"
                type="text"
                value={forgot.answer}
                onChange={(e) => updateForgot({ answer: e.target.value })}
                placeholder={t('Enter your answer')}
                disabled={forgot.loading}
              />
            </div>

            {forgot.error && (
              <p className="text-sm text-destructive">{forgot.error}</p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={forgotGoBack}
                disabled={forgot.loading}
              >
                {t('Back')}
              </Button>
              <Button type="submit" className="flex-1" disabled={forgot.loading}>
                {t('Next')}
              </Button>
            </div>
          </form>
        )}

        {/* Step 3: New password */}
        {forgot.step === 3 && (
          <form onSubmit={handleForgotStep3} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-new-password">{t('New Password')}</Label>
              <Input
                ref={forgotNewPasswordRef}
                id="forgot-new-password"
                type="password"
                value={forgot.newPassword}
                onChange={(e) => updateForgot({ newPassword: e.target.value })}
                placeholder={t('Enter new password')}
                autoComplete="new-password"
                disabled={forgot.loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="forgot-confirm-password">{t('Confirm Password')}</Label>
              <Input
                id="forgot-confirm-password"
                type="password"
                value={forgot.confirmPassword}
                onChange={(e) => updateForgot({ confirmPassword: e.target.value })}
                placeholder={t('Confirm new password')}
                autoComplete="new-password"
                disabled={forgot.loading}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              {t('Password must be at least 8 characters')}
            </p>

            {forgot.error && (
              <p className="text-sm text-destructive">{forgot.error}</p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={forgotGoBack}
                disabled={forgot.loading}
              >
                {t('Back')}
              </Button>
              <Button type="submit" className="flex-1" disabled={forgot.loading}>
                {forgot.loading ? t('Resetting...') : t('Reset Password')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );

  // ── Render: Login form ───────────────────────────────────────────────────

  const renderLoginForm = () => (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
          <span className="text-3xl font-bold text-emerald-500">P</span>
        </div>
        <CardTitle className="text-2xl">PharmaSys</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('Pharmacy Management System')}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-username">{t('Username')}</Label>
            <Input
              ref={usernameRef}
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('Enter your username')}
              autoFocus
              autoComplete="username"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="login-password">{t('Password')}</Label>
            <Input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('Enter your password')}
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {isFirstLaunch && (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {t('Default credentials')}: <span className="font-mono font-medium text-foreground">admin</span> / <span className="font-mono font-medium text-foreground">admin123</span>
              </p>
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('Signing in...') : t('Sign In')}
          </Button>

          <div className="text-center">
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={enterForgotFlow}
            >
              {t('Forgot Password?')}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );

  // ── Render: Password change dialog ───────────────────────────────────────

  const renderPasswordChangeDialog = () => (
    <Dialog
      open={showPasswordChange}
      onOpenChange={(open) => {
        // Prevent closing by clicking overlay — user must change password
        if (!open && pwChange.loading) return;
        // Allow closing only via successful change (controlled by handler)
        // But still allow escape / X button if not loading
        if (!open) setShowPasswordChange(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Change Password Required')}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t('You must change your password before continuing')}
          </p>
        </DialogHeader>

        <form onSubmit={handlePasswordChange} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="change-current-password">{t('Current Password')}</Label>
            <Input
              id="change-current-password"
              type="password"
              value={pwChange.currentPassword}
              onChange={(e) => updatePwChange({ currentPassword: e.target.value })}
              placeholder={t('Enter current password')}
              autoComplete="current-password"
              disabled={pwChange.loading}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="change-new-password">{t('New Password')}</Label>
            <Input
              id="change-new-password"
              type="password"
              value={pwChange.newPassword}
              onChange={(e) => updatePwChange({ newPassword: e.target.value })}
              placeholder={t('Enter new password')}
              autoComplete="new-password"
              disabled={pwChange.loading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="change-confirm-password">{t('Confirm Password')}</Label>
            <Input
              id="change-confirm-password"
              type="password"
              value={pwChange.confirmPassword}
              onChange={(e) => updatePwChange({ confirmPassword: e.target.value })}
              placeholder={t('Confirm new password')}
              autoComplete="new-password"
              disabled={pwChange.loading}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {t('Password must be at least 8 characters')}
          </p>

          {pwChange.error && (
            <p className="text-sm text-destructive">{pwChange.error}</p>
          )}

          <DialogFooter>
            <Button type="submit" className="w-full" disabled={pwChange.loading}>
              {pwChange.loading ? t('Changing...') : t('Change Password')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  // ── Render: Security question setup dialog ───────────────────────────────

  const renderSecuritySetupDialog = () => (
    <Dialog
      open={showSecuritySetup}
      onOpenChange={(open) => {
        if (!open && secLoading) return;
      }}
    >
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('Set Security Question')}</DialogTitle>
          <DialogDescription>
            {t('Set a security question to recover your account if you forget your password')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSecuritySetup} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('Question')}</Label>
            <Select value={secQuestion} onValueChange={setSecQuestion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECURITY_QUESTIONS.map((q) => (
                  <SelectItem key={q} value={q}>
                    {t(q)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sec-answer">{t('Answer')}</Label>
            <Input
              id="sec-answer"
              value={secAnswer}
              onChange={(e) => setSecAnswer(e.target.value)}
              placeholder={t('Your answer')}
              disabled={secLoading}
              autoFocus
            />
          </div>

          {secError && (
            <p className="text-sm text-destructive">{secError}</p>
          )}

          <DialogFooter>
            <Button type="submit" className="w-full" disabled={secLoading || !secAnswer.trim()}>
              {secLoading ? t('Saving...') : t('Set Security Question')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  // ── Render: Device setup dialog ──────────────────────────────────────────

  const renderDeviceSetupDialog = () => (
    <Dialog open={showDeviceSetup} onOpenChange={setShowDeviceSetup}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            {t('Device Setup')}
          </DialogTitle>
          <DialogDescription>
            {t('Configure how this device connects to the PharmaSys database')}
          </DialogDescription>
        </DialogHeader>

        {deviceLoading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Mode Selection */}
            <div className="space-y-3">
              {/* Standalone */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  deviceMode === 'standalone' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="deviceMode"
                  value="standalone"
                  checked={deviceMode === 'standalone'}
                  onChange={() => setDeviceMode('standalone')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    <span className="text-sm font-medium">{t('Standalone')}</span>
                    <Badge variant="secondary" className="text-xs">{t('Default')}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('Single device with local database. No network required.')}
                  </p>
                </div>
              </label>

              {/* Server */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  deviceMode === 'server' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="deviceMode"
                  value="server"
                  checked={deviceMode === 'server'}
                  onChange={() => setDeviceMode('server')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    <span className="text-sm font-medium">{t('Server')}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('Main device with local database. Other devices connect to this one over LAN.')}
                  </p>
                </div>
              </label>

              {/* Client */}
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  deviceMode === 'client' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="deviceMode"
                  value="client"
                  checked={deviceMode === 'client'}
                  onChange={() => setDeviceMode('client')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4" />
                    <span className="text-sm font-medium">{t('Client')}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('Connects to a server device over LAN. No local database.')}
                  </p>
                </div>
              </label>
            </div>

            {/* Server mode info */}
            {deviceMode === 'server' && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('Server Information')}</p>
                  {deviceAllIps.length > 0 ? (
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">{t('Available IP Addresses')}</span>
                      {deviceAllIps.map((ip) => (
                        <div key={ip.address} className="flex items-center justify-between rounded-lg bg-muted/50 p-2">
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-background px-2 py-0.5 font-mono text-sm font-semibold">
                              {ip.address}
                            </code>
                            <span className="text-xs text-muted-foreground">({ip.name})</span>
                          </div>
                          {ip.address === deviceLanIp && (
                            <Badge variant="default" className="text-[10px] px-1.5 py-0">{t('Recommended')}</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-lg bg-muted/50 p-2.5">
                      <span className="text-sm">{t('LAN IP Address')}</span>
                      <code className="rounded bg-background px-2 py-0.5 font-mono text-sm">
                        {deviceLanIp || '...'}
                      </code>
                    </div>
                  )}
                  <div className="flex items-center justify-between rounded-lg bg-muted/50 p-2.5">
                    <span className="text-sm">{t('Port')}</span>
                    <code className="rounded bg-background px-2 py-0.5 font-mono text-sm">
                      {devicePort}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('Client devices should connect to')}{' '}
                    <code className="font-mono text-foreground">{deviceLanIp}:{devicePort}</code>
                  </p>
                </div>
              </>
            )}

            {/* Client mode config */}
            {deviceMode === 'client' && (
              <>
                <Separator />
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('Server Connection')}</p>

                  {/* Scan for Servers */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleDeviceScan}
                    disabled={deviceScanning}
                    className="w-full"
                  >
                    {deviceScanning ? (
                      <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="me-2 h-3.5 w-3.5" />
                    )}
                    {deviceScanning ? t('Searching...') : t('Scan for Servers')}
                  </Button>

                  {deviceDiscovered.length > 0 && (
                    <div className="space-y-1.5">
                      {deviceDiscovered.map((server) => (
                        <button
                          key={`${server.ip}:${server.port}`}
                          type="button"
                          onClick={() => {
                            setDeviceHost(server.ip);
                            setDevicePort(server.port);
                            setDeviceTestResult(null);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg border border-border p-2 text-start transition-colors hover:border-primary hover:bg-primary/5"
                        >
                          <Wifi className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          <div className="flex-1">
                            <p className="text-xs font-medium">{server.name}</p>
                            <p className="text-[10px] text-muted-foreground">{server.ip}:{server.port}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2 space-y-1.5">
                      <Label htmlFor="device-host" className="text-xs">{t('Server IP Address')}</Label>
                      <Input
                        id="device-host"
                        placeholder="192.168.137.1"
                        value={deviceHost}
                        onChange={(e) => {
                          setDeviceHost(e.target.value);
                          setDeviceTestResult(null);
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="device-port" className="text-xs">{t('Port')}</Label>
                      <Input
                        id="device-port"
                        type="number"
                        value={devicePort}
                        onChange={(e) => {
                          setDevicePort(Number(e.target.value) || 3001);
                          setDeviceTestResult(null);
                        }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDeviceTestConnection}
                      disabled={deviceTesting || !deviceHost}
                    >
                      {deviceTesting ? (
                        <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="me-2 h-3.5 w-3.5" />
                      )}
                      {t('Test Connection')}
                    </Button>

                    {deviceTestResult === 'success' && (
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {t('Connected')}
                      </span>
                    )}
                    {deviceTestResult === 'fail' && (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <XCircle className="h-3.5 w-3.5" />
                        {t('Connection failed')}
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}

            <DialogFooter>
              <Button onClick={handleDeviceSave} disabled={deviceSaving}>
                {deviceSaving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('Save & Restart Required')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  // ── Main render ──────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {showForgot ? renderForgotFlow() : renderLoginForm()}
      {renderPasswordChangeDialog()}
      {renderSecuritySetupDialog()}
      {renderDeviceSetupDialog()}

      {/* Connection status + Device setup — bottom bar */}
      <div className="fixed bottom-0 inset-x-0 flex items-center justify-between border-t border-border bg-background/80 px-4 py-2 backdrop-blur">
        {/* Connection status */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {conn.mode === 'server' && (
            <>
              <Server className="h-3.5 w-3.5" />
              <span className="font-medium">{t('Server')}</span>
              <span className="font-mono">{conn.lanIp || '...'}</span>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            </>
          )}
          {conn.mode === 'client' && conn.connected && (
            <>
              <Monitor className="h-3.5 w-3.5" />
              <span className="font-medium">{t('Client')}</span>
              <span className="text-emerald-600 dark:text-emerald-400">{t('Connected')}</span>
              <span className="font-mono">{conn.serverUrl.replace('http://', '')}</span>
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            </>
          )}
          {conn.mode === 'client' && !conn.connected && (
            <>
              <WifiOff className="h-3.5 w-3.5 text-destructive" />
              <span className="font-medium text-destructive">{t('Disconnected')}</span>
              <span className="font-mono">{conn.serverUrl.replace('http://', '')}</span>
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
              </span>
            </>
          )}
        </div>

        {/* Device setup button */}
        <button
          type="button"
          onClick={openDeviceSetup}
          className="flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t('Device Setup')}
        >
          <Settings className="h-3.5 w-3.5" />
          {t('Device Setup')}
        </button>
      </div>
    </div>
  );
}
