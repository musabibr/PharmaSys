import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Eye, EyeOff, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  function resetForm() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setLoading(false);
  }

  function handleOpenChange(open: boolean) {
    if (!open) resetForm();
    onOpenChange(open);
  }

  async function handleSubmit(e: React.FormEvent) {
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

    setLoading(true);
    try {
      const result = await api.auth.changePassword(currentPassword, newPassword);
      if (result?.success) {
        toast.success(t('Password changed successfully'));
        handleOpenChange(false);
      } else {
        toast.error(result?.error || t('Failed to change password'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to change password'));
    } finally {
      setLoading(false);
    }
  }

  const canSubmit =
    !loading &&
    !!currentPassword &&
    newPassword.length >= 6 &&
    newPassword === confirmPassword;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('Change Password')}
          </DialogTitle>
          <DialogDescription>
            {t('Enter your current password and choose a new one.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current password */}
          <div className="space-y-1.5">
            <Label htmlFor="cp-current">{t('Current Password')}</Label>
            <div className="relative">
              <Input
                id="cp-current"
                type={showCurrentPassword ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t('Enter current password')}
                className="pe-10"
                disabled={loading}
              />
              <button
                type="button"
                className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                tabIndex={-1}
              >
                {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* New password */}
          <div className="space-y-1.5">
            <Label htmlFor="cp-new">{t('New Password')}</Label>
            <div className="relative">
              <Input
                id="cp-new"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('Minimum 6 characters')}
                className="pe-10"
                disabled={loading}
              />
              <button
                type="button"
                className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                onClick={() => setShowNewPassword(!showNewPassword)}
                tabIndex={-1}
              >
                {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Confirm password */}
          <div className="space-y-1.5">
            <Label htmlFor="cp-confirm">{t('Confirm Password')}</Label>
            <Input
              id="cp-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('Re-enter new password')}
              disabled={loading}
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {t('Passwords do not match')}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit} className="gap-1.5">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {t('Change Password')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
