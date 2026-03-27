import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Building2,
  Receipt,
  SlidersHorizontal,
  Landmark,
  Database,
  ShieldCheck,
  Lock,
  Loader2,
  Save,
  Plus,
  Trash2,
  RefreshCw,
  Download,
  RotateCcw,
  AlertTriangle,
  Eye,
  EyeOff,
  Upload,
  CalendarClock,
} from 'lucide-react';
import { api } from '@/api';
import { useSettingsStore } from '@/stores/settings.store';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTourContext } from '@/tours/TourProvider';
import { HelpCircle, Check, Play } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BankAccount {
  id: string;
  name: string;
  account_number: string;
  enabled: boolean;
}

const DEFAULT_BANKS: BankAccount[] = [
  { id: 'bok', name: 'BOK', account_number: '', enabled: true },
  { id: 'fawry', name: 'FAWRY', account_number: '', enabled: true },
  { id: 'ocash', name: 'OCASH', account_number: '', enabled: true },
];

interface BackupEntry {
  filename: string;
  size: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECURITY_QUESTIONS = [
  "What is your mother's maiden name?",
  'What was the name of your first pet?',
  'What city were you born in?',
  'What is your favorite book?',
  'What was your childhood nickname?',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format byte size to human-readable KB/MB */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format an ISO date string in a human-friendly form */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The backend returns Setting[] ({key, value, updated_at}[]), but the page
 * needs Record<string, string>. This normalises both shapes.
 */
function toRecord(data: unknown): Record<string, string> {
  if (Array.isArray(data)) {
    const record: Record<string, string> = {};
    for (const item of data) {
      if (item && typeof item === 'object' && 'key' in item) {
        record[(item as { key: string }).key] = String((item as { value: unknown }).value ?? '');
      }
    }
    return record;
  }
  return (data as Record<string, string>) || {};
}

/** Parse bank_config JSON safely, falling back to defaults */
function parseBankAccounts(json: string | undefined): BankAccount[] {
  if (!json) return DEFAULT_BANKS;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_BANKS;
  } catch {
    return DEFAULT_BANKS;
  }
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SettingsSkeleton() {
  return (
    <div className="flex h-full flex-col p-4 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-96" />
      <div className="space-y-4 mt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { t } = useTranslation();
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const currentUser = useAuthStore((s) => s.currentUser);
  const { getAvailableTours, startTour, isCompleted, resetAllTours } = useTourContext();

  // ── Master loading state ──────────────────────────────────────────────────
  const [initialLoading, setInitialLoading] = useState(true);
  const [settings, setSettings] = useState<Record<string, string>>({});

  // ── Business Information ──────────────────────────────────────────────────
  const [businessName, setBusinessName] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [savingBusiness, setSavingBusiness] = useState(false);

  // ── Receipt Settings ──────────────────────────────────────────────────────
  const [receiptHeader, setReceiptHeader] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [savingReceipt, setSavingReceipt] = useState(false);

  // ── System Preferences ────────────────────────────────────────────────────
  const [language, setLanguage] = useState('en');
  const [currency, setCurrency] = useState('SDG');
  const [lowStockThreshold, setLowStockThreshold] = useState('10');
  const [expiryWarningDays, setExpiryWarningDays] = useState('90');
  const [defaultMarkup, setDefaultMarkup] = useState('20');
  const [shiftsEnabled, setShiftsEnabled] = useState(true);
  const [savingPreferences, setSavingPreferences] = useState(false);

  // ── Security Settings (admin-only) ──────────────────────────────────────
  const [sessionTimeout, setSessionTimeout] = useState('30');
  const [lockoutAttempts, setLockoutAttempts] = useState('5');
  const [lockoutDuration, setLockoutDuration] = useState('15');
  const [savingSecurity, setSavingSecurity] = useState(false);

  // ── Bank Accounts ─────────────────────────────────────────────────────────
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [savingBanks, setSavingBanks] = useState(false);

  // ── Backups ───────────────────────────────────────────────────────────────
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [restoringFromFile, setRestoringFromFile] = useState(false);
  const [backupInterval, setBackupInterval] = useState('8');
  const [savingBackupInterval, setSavingBackupInterval] = useState(false);

  // ── Recurring Expense Generation ─────────────────────────────────────────
  const [generationMode, setGenerationMode] = useState('startup');
  const [generationHour, setGenerationHour] = useState('0');
  const [savingGeneration, setSavingGeneration] = useState(false);

  // ── Account Security — Change Password ────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // ── Account Security — Security Question ──────────────────────────────────
  const [securityQuestion, setSecurityQuestion] = useState(SECURITY_QUESTIONS[0]);
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [savingSecurityQ, setSavingSecurityQ] = useState(false);

  // ── Initial data load ─────────────────────────────────────────────────────
  const fetchSettings = useCallback(async () => {
    try {
      const raw = await api.settings.getAll();
      const s = toRecord(raw);
      setSettings(s);

      setBusinessName(s['business_name'] || '');
      setBusinessAddress(s['business_address'] || '');
      setBusinessPhone(s['business_phone'] || '');
      setReceiptHeader(s['receipt_header'] || '');
      setReceiptFooter(s['receipt_footer'] || '');
      setLanguage(s['language'] || 'en');
      setCurrency(s['currency'] || 'SDG');
      setLowStockThreshold(s['low_stock_threshold'] || '10');
      setExpiryWarningDays(s['expiry_warning_days'] || '90');
      setDefaultMarkup(s['default_markup_percent'] || '20');
      setShiftsEnabled(s['shifts_enabled'] !== 'false');
      setSessionTimeout(s['session_timeout_minutes'] || '30');
      setLockoutAttempts(s['account_lockout_attempts'] || '5');
      setLockoutDuration(s['account_lockout_duration_minutes'] || '15');
      setBankAccounts(parseBankAccounts(s['bank_config']));
      setBackupInterval(s['auto_backup_hours'] || '8');
      setGenerationMode(s['recurring_generation_mode'] || 'startup');
      setGenerationHour(s['recurring_generation_hour'] || '0');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load settings'));
    }
  }, [t]);

  const fetchBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const data = await api.backup.list();
      setBackups(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to load backups'));
    } finally {
      setLoadingBackups(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await fetchSettings();
      if (!cancelled) {
        await fetchBackups();
      }
      if (!cancelled) {
        setInitialLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Generic multi-key save helper ─────────────────────────────────────────
  async function saveKeys(
    keys: Record<string, string>,
    setLoading: (v: boolean) => void,
    successMsg: string
  ) {
    setLoading(true);
    try {
      for (const [key, value] of Object.entries(keys)) {
        if (settings[key] !== value) {
          await api.settings.set(key, value);
        }
      }
      await loadSettings();
      setSettings((prev) => ({ ...prev, ...keys }));
      toast.success(t(successMsg));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save settings'));
    } finally {
      setLoading(false);
    }
  }

  // ── Save handlers ─────────────────────────────────────────────────────────
  async function handleSaveBusiness() {
    await saveKeys(
      {
        business_name: businessName.trim(),
        business_address: businessAddress.trim(),
        business_phone: businessPhone.trim(),
      },
      setSavingBusiness,
      'Business information saved'
    );
  }

  async function handleSaveReceipt() {
    await saveKeys(
      {
        receipt_header: receiptHeader.trim(),
        receipt_footer: receiptFooter.trim(),
      },
      setSavingReceipt,
      'Receipt settings saved'
    );
  }

  async function handleSavePreferences() {
    const threshold = parseInt(lowStockThreshold, 10);
    const warningDays = parseInt(expiryWarningDays, 10);
    const markup = parseInt(defaultMarkup, 10);
    if (isNaN(threshold) || threshold < 0) {
      toast.error(t('Low stock threshold must be a non-negative number'));
      return;
    }
    if (isNaN(warningDays) || warningDays < 0) {
      toast.error(t('Expiry warning days must be a non-negative number'));
      return;
    }
    if (isNaN(markup) || markup < 0) {
      toast.error(t('Default markup must be a non-negative number'));
      return;
    }

    setSavingPreferences(true);
    try {
      const currencyVal = currency.trim() || 'SDG';
      const keys: Record<string, string> = {
        language,
        currency: currencyVal,
        currency_symbol: currencyVal,
        low_stock_threshold: String(threshold),
        expiry_warning_days: String(warningDays),
        default_markup_percent: String(markup),
        shifts_enabled: String(shiftsEnabled),
      };

      for (const [key, value] of Object.entries(keys)) {
        if (settings[key] !== value) {
          await api.settings.set(key, value);
        }
      }

      // Reload settings into Zustand store — App.tsx useEffect will
      // automatically apply the new language/dir when storedLanguage changes
      await loadSettings();
      setSettings((prev) => ({ ...prev, ...keys }));
      toast.success(t('System preferences saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save settings'));
    } finally {
      setSavingPreferences(false);
    }
  }

  async function handleSaveBanks() {
    const cleaned = bankAccounts.filter((acc) => acc.name.trim());
    setSavingBanks(true);
    try {
      await api.settings.set('bank_config', JSON.stringify(cleaned));
      await loadSettings();
      setSettings((prev) => ({
        ...prev,
        bank_config: JSON.stringify(cleaned),
      }));
      setBankAccounts(cleaned.length > 0 ? cleaned : DEFAULT_BANKS);
      toast.success(t('Bank accounts saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save bank accounts'));
    } finally {
      setSavingBanks(false);
    }
  }

  function handleAddBankAccount() {
    const id = `bank_${Date.now()}`;
    setBankAccounts((prev) => [...prev, { id, name: '', account_number: '', enabled: true }]);
  }

  function handleRemoveBankAccount(index: number) {
    setBankAccounts((prev) => prev.filter((_, i) => i !== index));
  }

  function handleBankAccountChange(
    index: number,
    field: keyof BankAccount,
    value: string
  ) {
    setBankAccounts((prev) =>
      prev.map((acc, i) => {
        if (i !== index) return acc;
        if (field === 'enabled') return { ...acc, enabled: value === 'true' };
        return { ...acc, [field]: value };
      })
    );
  }

  async function handleSaveSecuritySettings() {
    const timeout = parseInt(sessionTimeout, 10);
    const attempts = parseInt(lockoutAttempts, 10);
    const duration = parseInt(lockoutDuration, 10);
    if (isNaN(timeout) || timeout < 1) {
      toast.error(t('Session timeout must be at least 1 minute'));
      return;
    }
    if (isNaN(attempts) || attempts < 1) {
      toast.error(t('Lockout attempts must be at least 1'));
      return;
    }
    if (isNaN(duration) || duration < 1) {
      toast.error(t('Lockout duration must be at least 1 minute'));
      return;
    }
    await saveKeys(
      {
        session_timeout_minutes: String(timeout),
        account_lockout_attempts: String(attempts),
        account_lockout_duration_minutes: String(duration),
      },
      setSavingSecurity,
      'Security settings saved'
    );
  }

  async function handleCreateBackup() {
    setCreatingBackup(true);
    try {
      const result = await api.backup.create();
      if (result?.success) {
        toast.success(`${t('Backup created')}: ${result.filename}`);
        await fetchBackups();
        // Prompt user to save to a custom location
        try {
          const saveResult = await api.backup.saveAs(result.path);
          if (saveResult?.success) {
            toast.success(t('Backup saved successfully'));
          }
        } catch { /* user cancelled dialog — ignore */ }
      } else {
        toast.error(t('Failed to create backup'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to create backup'));
    } finally {
      setCreatingBackup(false);
    }
  }

  async function handleRestoreBackup(filename: string) {
    const confirmed = window.confirm(
      t('Are you sure you want to restore this backup? All current data will be overwritten. This action cannot be undone.')
    );
    if (!confirmed) return;

    setRestoringBackup(filename);
    try {
      const result = await api.backup.restore(filename);
      if (result?.success) {
        toast.success(t('Backup restored successfully. Restarting application...'));
        setTimeout(() => api.app.restart(), 1500);
      } else {
        toast.error(t('Failed to restore backup'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to restore backup'));
    } finally {
      setRestoringBackup(null);
    }
  }

  async function handleRestoreFromFile() {
    const confirmed = window.confirm(
      t('Are you sure you want to restore a backup from file? All current data will be overwritten. This action cannot be undone.')
    );
    if (!confirmed) return;

    setRestoringFromFile(true);
    try {
      const result = await api.backup.restoreFromFile();
      if (result?.success) {
        toast.success(t('Backup restored successfully. Restarting application...'));
        setTimeout(() => api.app.restart(), 1500);
      } else if (result?.error) {
        toast.error(result.error);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to restore backup'));
    } finally {
      setRestoringFromFile(false);
    }
  }

  async function handleSaveBackupInterval() {
    setSavingBackupInterval(true);
    try {
      await api.settings.set('auto_backup_hours', backupInterval);
      api.backup.restartAutoBackupTimer();
      toast.success(t('Backup interval saved'));
      await loadSettings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save backup interval'));
    } finally {
      setSavingBackupInterval(false);
    }
  }

  async function handleSaveGeneration() {
    setSavingGeneration(true);
    try {
      await api.settings.set('recurring_generation_mode', generationMode);
      await api.settings.set('recurring_generation_hour', generationHour);
      api.recurringExpenses.restartTimer();
      toast.success(t('Generation settings saved'));
      await loadSettings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to save settings'));
    } finally {
      setSavingGeneration(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();

    if (!currentPassword) {
      toast.error(t('Current password is required'));
      return;
    }
    if (newPassword.length < 6) {
      toast.error(t('New password must be at least 6 characters'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('Passwords do not match'));
      return;
    }

    setChangingPassword(true);
    try {
      const result = await api.auth.changePassword(currentPassword, newPassword);
      if (result?.success) {
        toast.success(t('Password changed successfully'));
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowCurrentPassword(false);
        setShowNewPassword(false);
      } else {
        toast.error(result?.error || t('Failed to change password'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to change password'));
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleSetSecurityQuestion(e: React.FormEvent) {
    e.preventDefault();

    if (!securityAnswer.trim()) {
      toast.error(t('Security answer is required'));
      return;
    }

    setSavingSecurityQ(true);
    try {
      const result = await api.auth.setSecurityQuestion(
        securityQuestion,
        securityAnswer.trim()
      );
      if (result?.success) {
        toast.success(t('Security question set successfully'));
        setSecurityAnswer('');
      } else {
        toast.error(result?.error || t('Failed to set security question'));
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('Failed to set security question')
      );
    } finally {
      setSavingSecurityQ(false);
    }
  }

  const isAdmin = currentUser?.role === 'admin';
  const defaultTab = isAdmin ? 'general' : 'security';

  if (initialLoading) {
    return <SettingsSkeleton />;
  }

  // ── Save button helper ────────────────────────────────────────────────────
  const SaveBtn = ({ saving, onClick, label }: { saving: boolean; onClick: () => void; label?: string }) => (
    <Button onClick={onClick} disabled={saving} className="gap-1.5">
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {t(label || 'Save')}
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue={defaultTab} className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('Settings')}</h1>
        </div>

        <TabsList className="mx-4 w-fit">
          {isAdmin && (
            <TabsTrigger value="general" className="gap-1.5">
              <SlidersHorizontal className="h-4 w-4" />
              {t('General')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="banks" className="gap-1.5">
              <Landmark className="h-4 w-4" />
              {t('Bank Accounts')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="backup" className="gap-1.5">
              <Database className="h-4 w-4" />
              {t('Backup')}
            </TabsTrigger>
          )}
          <TabsTrigger value="security" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            {t('Security')}
          </TabsTrigger>
        </TabsList>

        {/* ================================================================ */}
        {/* General Tab                                                      */}
        {/* ================================================================ */}
        {isAdmin && (
          <TabsContent value="general" className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto p-4 space-y-6">

              {/* ── Business Information ──────────────────────────────────── */}
              <section data-tour="settings-pharmacy" className="space-y-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">{t('Business Information')}</h2>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="business-name">{t('Business Name')}</Label>
                    <Input
                      id="business-name"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder={t('e.g. PharmaSys Pharmacy')}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="business-phone">{t('Business Phone')}</Label>
                    <Input
                      id="business-phone"
                      value={businessPhone}
                      onChange={(e) => setBusinessPhone(e.target.value)}
                      placeholder={t('e.g. +249 123 456 789')}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="business-address">{t('Business Address')}</Label>
                  <Textarea
                    id="business-address"
                    rows={2}
                    value={businessAddress}
                    onChange={(e) => setBusinessAddress(e.target.value)}
                    placeholder={t('Street address, city, state')}
                  />
                </div>

                <div className="flex justify-end">
                  <SaveBtn saving={savingBusiness} onClick={handleSaveBusiness} />
                </div>
              </section>

              <Separator />

              {/* ── Receipt Settings ──────────────────────────────────────── */}
              <section data-tour="settings-receipt" className="space-y-4">
                <div className="flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">{t('Receipt Settings')}</h2>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="receipt-header">{t('Receipt Header')}</Label>
                    <Textarea
                      id="receipt-header"
                      rows={3}
                      value={receiptHeader}
                      onChange={(e) => setReceiptHeader(e.target.value)}
                      placeholder={t('Text shown above items on the receipt')}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="receipt-footer">{t('Receipt Footer')}</Label>
                    <Textarea
                      id="receipt-footer"
                      rows={3}
                      value={receiptFooter}
                      onChange={(e) => setReceiptFooter(e.target.value)}
                      placeholder={t('Text shown below totals on the receipt')}
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <SaveBtn saving={savingReceipt} onClick={handleSaveReceipt} />
                </div>
              </section>

              <Separator />

              {/* ── System Preferences ────────────────────────────────────── */}
              <section className="space-y-4">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">{t('System Preferences')}</h2>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>{t('Language')}</Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="ar">{t('Arabic')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="currency">{t('Currency')}</Label>
                    <Input
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      placeholder="SDG"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="default-markup">{t('Default Markup %')}</Label>
                    <Input
                      id="default-markup"
                      type="number"
                      min={0}
                      step={1}
                      value={defaultMarkup}
                      onChange={(e) => setDefaultMarkup(e.target.value)}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex-1 me-4">
                      <Label htmlFor="shifts-toggle" className="text-sm font-medium cursor-pointer">
                        {t('Require Shifts')}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('When disabled, sales and returns work without opening a shift. Useful for single-pharmacist pharmacies.')}
                      </p>
                    </div>
                    <Switch
                      id="shifts-toggle"
                      checked={shiftsEnabled}
                      onCheckedChange={setShiftsEnabled}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="low-stock">{t('Low Stock Threshold')}</Label>
                    <Input
                      id="low-stock"
                      type="number"
                      min={0}
                      step={1}
                      value={lowStockThreshold}
                      onChange={(e) => setLowStockThreshold(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="expiry-days">{t('Expiry Warning Days')}</Label>
                    <Input
                      id="expiry-days"
                      type="number"
                      min={0}
                      step={1}
                      value={expiryWarningDays}
                      onChange={(e) => setExpiryWarningDays(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <SaveBtn saving={savingPreferences} onClick={handleSavePreferences} />
                </div>
              </section>

              {/* ── Recurring Expense Generation ─────────────────────────── */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">{t('Recurring Expense Generation')}</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>{t('Generation Mode')}</Label>
                    <Select value={generationMode} onValueChange={setGenerationMode}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="startup">{t('On Startup')}</SelectItem>
                        <SelectItem value="scheduled">{t('Scheduled (daily)')}</SelectItem>
                        <SelectItem value="manual">{t('Manual Only')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {generationMode === 'scheduled' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="gen-hour">{t('Generation Hour')}</Label>
                      <Input
                        id="gen-hour"
                        type="number"
                        min={0}
                        max={23}
                        step={1}
                        value={generationHour}
                        onChange={(e) => setGenerationHour(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('0 = midnight, 12 = noon, 23 = 11 PM')}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex justify-end">
                  <SaveBtn saving={savingGeneration} onClick={handleSaveGeneration} />
                </div>
              </section>
            </div>
          </TabsContent>
        )}

        {/* ================================================================ */}
        {/* Bank Accounts Tab                                                */}
        {/* ================================================================ */}
        {isAdmin && (
          <TabsContent value="banks" className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('Bank accounts available for bank transfer payments')}
              </p>

              {bankAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('No bank accounts configured. Add one below.')}
                </p>
              ) : (
                <div className="space-y-3">
                  {bankAccounts.map((account, index) => (
                    <div key={account.id || index} className="flex items-center gap-3">
                      <div className="w-36">
                        <Input
                          value={account.name}
                          onChange={(e) =>
                            handleBankAccountChange(index, 'name', e.target.value)
                          }
                          placeholder={t('Bank Name')}
                        />
                      </div>
                      <div className="flex-1">
                        <Input
                          value={account.account_number}
                          onChange={(e) =>
                            handleBankAccountChange(index, 'account_number', e.target.value)
                          }
                          placeholder={t('Account Number')}
                        />
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={account.enabled}
                          onChange={(e) =>
                            handleBankAccountChange(index, 'enabled', e.target.checked ? 'true' : 'false')
                          }
                          className="h-4 w-4 rounded border-input"
                        />
                        {t('Enabled')}
                      </label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => handleRemoveBankAccount(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddBankAccount}
                  className="gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add Bank Account')}
                </Button>

                <SaveBtn saving={savingBanks} onClick={handleSaveBanks} />
              </div>
            </div>
          </TabsContent>
        )}

        {/* ================================================================ */}
        {/* Backup Tab                                                       */}
        {/* ================================================================ */}
        {isAdmin && (
          <TabsContent value="backup" className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto p-4 space-y-4">
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleCreateBackup}
                  disabled={creatingBackup}
                  className="gap-1.5"
                >
                  {creatingBackup ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t('Create Backup')}
                </Button>

                <Button
                  variant="outline"
                  onClick={handleRestoreFromFile}
                  disabled={restoringFromFile}
                  className="gap-1.5"
                >
                  {restoringFromFile ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {t('Restore from File')}
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchBackups}
                  disabled={loadingBackups}
                  className="gap-1.5"
                >
                  {loadingBackups ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t('Refresh')}
                </Button>
              </div>

              {/* Auto-backup interval */}
              <div className="flex items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t('Auto Backup Interval (hours)')}</Label>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={backupInterval}
                    onChange={(e) => setBackupInterval(e.target.value)}
                    className="w-28"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveBackupInterval}
                  disabled={savingBackupInterval}
                  className="gap-1.5"
                >
                  {savingBackupInterval ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {t('Save')}
                </Button>
                <p className="text-xs text-muted-foreground pb-1">
                  {t('Set to 0 to disable auto backup')}
                </p>
              </div>

              <Separator />

              {loadingBackups && backups.length === 0 ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : backups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Database className="mb-2 h-10 w-10" />
                  <p className="text-sm font-medium">{t('No backups found')}</p>
                  <p className="mt-1 text-xs">
                    {t('Create your first backup to protect your data')}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Filename')}</TableHead>
                      <TableHead>{t('Size')}</TableHead>
                      <TableHead>{t('Created')}</TableHead>
                      <TableHead className="w-24">{t('Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {backups.map((backup) => (
                      <TableRow key={backup.filename}>
                        <TableCell className="font-mono text-sm">
                          {backup.filename}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatFileSize(backup.size)}
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {formatDate(backup.created_at)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={restoringBackup === backup.filename}
                            onClick={() => handleRestoreBackup(backup.filename)}
                          >
                            {restoringBackup === backup.filename ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            {t('Restore')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>
        )}

        {/* ================================================================ */}
        {/* Security Tab                                                     */}
        {/* ================================================================ */}
        <TabsContent value="security" className="flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto p-4 space-y-6">

            {/* ── Security Settings (admin only) ───────────────────────── */}
            {isAdmin && (
              <>
                <section className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">{t('Security Settings')}</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('Session timeout and account lockout policy')}
                  </p>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="session-timeout">{t('Session Timeout (minutes)')}</Label>
                      <Input
                        id="session-timeout"
                        type="number"
                        min={1}
                        step={1}
                        value={sessionTimeout}
                        onChange={(e) => setSessionTimeout(e.target.value)}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="lockout-attempts">{t('Lockout Attempts')}</Label>
                      <Input
                        id="lockout-attempts"
                        type="number"
                        min={1}
                        step={1}
                        value={lockoutAttempts}
                        onChange={(e) => setLockoutAttempts(e.target.value)}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="lockout-duration">{t('Lockout Duration (minutes)')}</Label>
                      <Input
                        id="lockout-duration"
                        type="number"
                        min={1}
                        step={1}
                        value={lockoutDuration}
                        onChange={(e) => setLockoutDuration(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <SaveBtn saving={savingSecurity} onClick={handleSaveSecuritySettings} />
                  </div>
                </section>

                <Separator />
              </>
            )}

            {/* ── Change Password ─────────────────────────────────────── */}
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t('Change Password')}</h2>
                {currentUser && (
                  <span className="text-xs text-muted-foreground">
                    ({currentUser.username})
                  </span>
                )}
              </div>

              <form onSubmit={handleChangePassword} className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="current-password">{t('Current Password')}</Label>
                    <div className="relative">
                      <Input
                        id="current-password"
                        type={showCurrentPassword ? 'text' : 'password'}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder={t('Enter current password')}
                        className="pe-10"
                      />
                      <button
                        type="button"
                        className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                        tabIndex={-1}
                      >
                        {showCurrentPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="new-password">{t('New Password')}</Label>
                    <div className="relative">
                      <Input
                        id="new-password"
                        type={showNewPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t('Minimum 6 characters')}
                        className="pe-10"
                      />
                      <button
                        type="button"
                        className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        tabIndex={-1}
                      >
                        {showNewPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="confirm-password">{t('Confirm Password')}</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t('Re-enter new password')}
                    />
                    {confirmPassword && newPassword !== confirmPassword && (
                      <p className="flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="h-3 w-3" />
                        {t('Passwords do not match')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      changingPassword ||
                      !currentPassword ||
                      newPassword.length < 6 ||
                      newPassword !== confirmPassword
                    }
                    className="gap-1.5"
                  >
                    {changingPassword ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    {t('Change Password')}
                  </Button>
                </div>
              </form>
            </section>

            <Separator />

            {/* ── Security Question ────────────────────────────────────── */}
            <section className="space-y-4">
              <h2 className="text-sm font-semibold">{t('Security Question')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('Set a security question to recover your account if you forget your password')}
              </p>

              <form onSubmit={handleSetSecurityQuestion} className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('Question')}</Label>
                    <Select value={securityQuestion} onValueChange={setSecurityQuestion}>
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

                  <div className="space-y-1.5">
                    <Label htmlFor="security-answer">{t('Answer')}</Label>
                    <Input
                      id="security-answer"
                      value={securityAnswer}
                      onChange={(e) => setSecurityAnswer(e.target.value)}
                      placeholder={t('Your answer')}
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={savingSecurityQ || !securityAnswer.trim()}
                    className="gap-1.5"
                  >
                    {savingSecurityQ ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    {t('Set Security Question')}
                  </Button>
                </div>
              </form>
            </section>

            <Separator />

            {/* ── Guided Tours ──────────────────────────────────────────── */}
            <section data-tour="settings-tours" className="space-y-4">
              <h2 className="text-sm font-semibold">{t('Guided Tours')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('Replay guided tours to learn how to use different parts of the system')}
              </p>

              <div className="space-y-2">
                {getAvailableTours().map((tour) => (
                  <div
                    key={tour.id}
                    className="flex items-center justify-between rounded-md border px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {isCompleted(tour.id) ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div>
                        <p className="text-sm font-medium">{t(tour.name)}</p>
                        <p className="text-xs text-muted-foreground">{t(tour.description)}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => startTour(tour.id)}
                      className="gap-1.5"
                    >
                      <Play className="h-3.5 w-3.5" />
                      {isCompleted(tour.id) ? t('Replay') : t('Start')}
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetAllTours}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('Reset All Tours')}
                </Button>
              </div>
            </section>
          </div>
        </TabsContent>

      </Tabs>
    </div>
  );
}

