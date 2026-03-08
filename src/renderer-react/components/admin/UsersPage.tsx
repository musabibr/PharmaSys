import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Edit2,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Power,
  Shield,
  ShieldCheck,
  UserCog,
  Users,
  Eye,
  EyeOff,
  Copy,
  Check,
} from 'lucide-react';
import { api, throwIfError } from '@/api';
import type { User, UserRole } from '@/api/types';
import {
  PERMISSION_REGISTRY,
  ALL_PERMISSION_KEYS,
  resolvePermissions,
} from '@/lib/permissions';
import type { PermissionKey } from '@/lib/permissions';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function roleBadgeVariant(role: UserRole): 'default' | 'secondary' | 'outline' {
  switch (role) {
    case 'admin':
      return 'default';
    case 'pharmacist':
      return 'secondary';
    case 'cashier':
      return 'outline';
    default:
      return 'outline';
  }
}

function roleLabel(role: UserRole, t: (key: string) => string): string {
  switch (role) {
    case 'admin':
      return t('Admin');
    case 'pharmacist':
      return t('Pharmacist');
    case 'cashier':
      return t('Cashier');
    default:
      return role;
  }
}

// ---------------------------------------------------------------------------
// Form state types
// ---------------------------------------------------------------------------

interface UserFormState {
  username: string;
  full_name: string;
  password: string;
  role: UserRole;
  permissions: Set<PermissionKey>;
  is_active: boolean;
}

function emptyForm(): UserFormState {
  return {
    username: '',
    full_name: '',
    password: '',
    role: 'cashier',
    permissions: new Set<PermissionKey>(['pos.sales', 'pos.held_sales']),
    is_active: true,
  };
}

function formFromUser(user: User): UserFormState {
  return {
    username: user.username,
    full_name: user.full_name,
    password: '',
    role: user.role,
    permissions: resolvePermissions(user),
    is_active: user.is_active === 1,
  };
}

/** Count how many permissions a user has (from permissions_json or legacy) */
function countPermissions(user: User): number {
  if (user.role === 'admin') return ALL_PERMISSION_KEYS.length;
  return resolvePermissions(user).size;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function UsersSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-4">
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionGroupList — expandable permission groups
// ---------------------------------------------------------------------------

function PermissionGroupList({
  permissions,
  onToggle,
  onToggleGroup,
}: {
  permissions: Set<PermissionKey>;
  onToggle: (key: PermissionKey) => void;
  onToggleGroup: (keys: PermissionKey[]) => void;
}) {
  const { t } = useTranslation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  function toggleExpand(module: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(module)) {
        next.delete(module);
      } else {
        next.add(module);
      }
      return next;
    });
  }

  return (
    <div className="space-y-2">
      {PERMISSION_REGISTRY.map((group) => {
        const groupKeys = group.permissions.map((p) => p.key);
        const checkedCount = groupKeys.filter((k) => permissions.has(k)).length;
        const allChecked = checkedCount === groupKeys.length;
        const isExpanded = expandedGroups.has(group.module);

        return (
          <div key={group.module} className="rounded-md border">
            {/* Group header */}
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-sm font-medium"
                onClick={() => toggleExpand(group.module)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {t(group.label)}
                <Badge variant="secondary" className="text-[10px]">
                  {checkedCount}/{groupKeys.length}
                </Badge>
              </button>
              <Switch
                checked={allChecked}
                onCheckedChange={() => onToggleGroup(groupKeys)}
                className="scale-90"
              />
            </div>

            {/* Individual permissions */}
            {isExpanded && (
              <div className="border-t px-3 py-2">
                <div className="space-y-2">
                  {group.permissions.map((perm) => (
                    <div key={perm.key} className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium">{t(perm.label)}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {t(perm.description)}
                        </p>
                      </div>
                      <Switch
                        checked={permissions.has(perm.key)}
                        onCheckedChange={() => onToggle(perm.key)}
                        className="scale-75"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsersPage
// ---------------------------------------------------------------------------

export function UsersPage() {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);

  // ── Data state ──────────────────────────────────────────────────────────
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Create/Edit dialog state ────────────────────────────────────────────
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // ── Reset Password dialog state ─────────────────────────────────────────
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetTargetUser, setResetTargetUser] = useState<User | null>(null);
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // ── Deactivation confirmation dialog state ──────────────────────────────
  const [deactivateDialogOpen, setDeactivateDialogOpen] = useState(false);
  const [deactivateTargetUser, setDeactivateTargetUser] = useState<User | null>(null);
  const [deactivateSubmitting, setDeactivateSubmitting] = useState(false);

  // ── Password visibility toggles ──────────────────────────────────────
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [showResetNewPassword, setShowResetNewPassword] = useState(false);
  const [showResetConfirmPassword, setShowResetConfirmPassword] = useState(false);

  // ── Credentials success dialog (after create / reset) ────────────────
  const [credentialsDialogOpen, setCredentialsDialogOpen] = useState(false);
  const [credentialsInfo, setCredentialsInfo] = useState<{ username: string; password: string; isReset: boolean } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const isEditing = editingUser !== null;
  const isAdminRole = form.role === 'admin';

  // ── Fetch users ─────────────────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = throwIfError(await api.users.getAll());
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to load users'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // ── Copy to clipboard helper ────────────────────────────────────────────
  async function copyToClipboard(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast.error(t('Failed to copy'));
    }
  }

  // ── Open Create dialog ──────────────────────────────────────────────────
  function openCreateDialog() {
    setEditingUser(null);
    setForm(emptyForm());
    setFormError(null);
    setShowCreatePassword(false);
    setFormDialogOpen(true);
  }

  // ── Open Edit dialog ────────────────────────────────────────────────────
  function openEditDialog(user: User) {
    setEditingUser(user);
    setForm(formFromUser(user));
    setFormError(null);
    setFormDialogOpen(true);
  }

  // ── Open Reset Password dialog ──────────────────────────────────────────
  function openResetPasswordDialog(user: User) {
    setResetTargetUser(user);
    setResetNewPassword('');
    setResetConfirmPassword('');
    setResetError(null);
    setShowResetNewPassword(false);
    setShowResetConfirmPassword(false);
    setResetDialogOpen(true);
  }

  // ── Update form field ───────────────────────────────────────────────────
  function updateForm(patch: Partial<UserFormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function togglePermission(key: PermissionKey) {
    setForm((prev) => {
      const next = new Set(prev.permissions);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { ...prev, permissions: next };
    });
  }

  function toggleGroupAll(groupKeys: PermissionKey[]) {
    setForm((prev) => {
      const next = new Set(prev.permissions);
      const allOn = groupKeys.every((k) => next.has(k));
      for (const k of groupKeys) {
        if (allOn) {
          next.delete(k);
        } else {
          next.add(k);
        }
      }
      return { ...prev, permissions: next };
    });
  }

  // ── Validate form ───────────────────────────────────────────────────────
  function validateForm(): string | null {
    if (!form.username.trim()) {
      return t('Username is required');
    }
    if (!form.full_name.trim()) {
      return t('Full name is required');
    }
    if (!isEditing) {
      if (!form.password) {
        return t('Password is required');
      }
      if (form.password.length < 6) {
        return t('Password must be at least 6 characters');
      }
    }
    return null;
  }

  // ── Submit Create/Edit ──────────────────────────────────────────────────
  async function handleSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setFormSubmitting(true);
    try {
      const permissionsArray = [...form.permissions];
      if (isEditing) {
        // Cannot change own role
        const isSelf = editingUser!.id === currentUser?.id;

        const updateData: Record<string, unknown> = {
          full_name: form.full_name.trim(),
          permissions: permissionsArray,
          is_active: form.is_active ? 1 : 0,
        };

        // Only update role if it's not the current user
        if (!isSelf) {
          updateData.role = form.role;
        }

        const updatedUser = throwIfError(await api.users.update(editingUser!.id, updateData as Partial<User>));
        // If we just edited the current user, refresh the auth store so
        // permission changes take effect immediately in the frontend
        if (isSelf && updatedUser) {
          useAuthStore.getState().setUser(updatedUser as User);
        }
        toast.success(t('User updated successfully'));
      } else {
        const createdPassword = form.password;
        const createdUsername = form.username.trim();
        throwIfError(await api.users.create({
          username: createdUsername,
          full_name: form.full_name.trim(),
          password: createdPassword,
          role: form.role,
          permissions: permissionsArray,
        } as Partial<User> & { password: string }));
        setFormDialogOpen(false);
        setCredentialsInfo({ username: createdUsername, password: createdPassword, isReset: false });
        setCredentialsDialogOpen(true);
        await fetchUsers();
        return;
      }

      setFormDialogOpen(false);
      await fetchUsers();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('Failed to save user'));
    } finally {
      setFormSubmitting(false);
    }
  }

  // ── Submit Reset Password ───────────────────────────────────────────────
  async function handleSubmitResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setResetError(null);

    if (!resetNewPassword) {
      setResetError(t('Password is required'));
      return;
    }
    if (resetNewPassword.length < 6) {
      setResetError(t('Password must be at least 6 characters'));
      return;
    }
    if (resetNewPassword !== resetConfirmPassword) {
      setResetError(t('Passwords do not match'));
      return;
    }

    setResetSubmitting(true);
    try {
      throwIfError(await api.users.resetPassword(resetTargetUser!.id, resetNewPassword));
      setResetDialogOpen(false);
      setCredentialsInfo({ username: resetTargetUser!.username, password: resetNewPassword, isReset: true });
      setCredentialsDialogOpen(true);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : t('Failed to reset password'));
    } finally {
      setResetSubmitting(false);
    }
  }

  // ── Toggle active status ────────────────────────────────────────────────
  function handleToggleActive(user: User) {
    if (user.id === currentUser?.id) {
      toast.error(t('You cannot deactivate your own account'));
      return;
    }

    if (user.is_active === 1) {
      // Deactivating — show confirmation dialog
      setDeactivateTargetUser(user);
      setDeactivateDialogOpen(true);
    } else {
      // Reactivating — no confirmation needed
      performToggleActive(user);
    }
  }

  async function performToggleActive(user: User) {
    const newStatus = user.is_active === 1 ? 0 : 1;
    try {
      throwIfError(await api.users.update(user.id, { is_active: newStatus }));
      toast.success(
        newStatus === 1
          ? t('User activated successfully')
          : t('User deactivated successfully')
      );
      await fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update user status'));
    }
  }

  async function handleConfirmDeactivate() {
    if (!deactivateTargetUser) return;
    setDeactivateSubmitting(true);
    try {
      throwIfError(await api.users.update(deactivateTargetUser.id, { is_active: 0 }));
      toast.success(t('User deactivated successfully'));
      setDeactivateDialogOpen(false);
      await fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to update user status'));
    } finally {
      setDeactivateSubmitting(false);
    }
  }

  // ── Unlock account ──────────────────────────────────────────────────────
  async function handleUnlockAccount(user: User) {
    try {
      throwIfError(await api.users.unlockAccount(user.id));
      toast.success(t('Account unlocked successfully'));
      await fetchUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('Failed to unlock account'));
    }
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading && users.length === 0) {
    return <UsersSkeleton />;
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (error && users.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <AlertTriangle className="mb-3 h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">{error}</p>
        <button
          onClick={fetchUsers}
          className="mt-4 text-sm text-primary underline hover:no-underline"
        >
          {t('Try again')}
        </button>
      </div>
    );
  }

  // Whether the current user is being edited (restrict role changes + deactivation)
  const isSelfEditing = isEditing && editingUser?.id === currentUser?.id;

  return (
    <div className="space-y-6">
      {/* ── Page Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('User Management')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Manage system users, roles, and permissions')}
          </p>
        </div>
        <Button onClick={openCreateDialog} className="gap-1.5" data-tour="users-add">
          <Plus className="h-4 w-4" />
          {t('New User')}
        </Button>
      </div>

      {/* ── Users Table ────────────────────────────────────────────────────── */}
      <Card data-tour="users-list">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">{t('Users')}</CardTitle>
            <Badge variant="secondary" className="ms-1">
              {users.length}
            </Badge>
            {loading && <Loader2 className="ms-auto h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Users className="mb-3 h-10 w-10" />
              <p className="text-sm font-medium">{t('No users found')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Username')}</TableHead>
                  <TableHead>{t('Full Name')}</TableHead>
                  <TableHead>{t('Role')}</TableHead>
                  <TableHead>{t('Permissions')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Created')}</TableHead>
                  <TableHead className="text-end">{t('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    {/* Username */}
                    <TableCell className="font-medium">
                      {user.username}
                      {user.id === currentUser?.id && (
                        <Badge variant="outline" className="ms-2 text-[10px]">
                          {t('You')}
                        </Badge>
                      )}
                    </TableCell>

                    {/* Full Name */}
                    <TableCell>{user.full_name}</TableCell>

                    {/* Role */}
                    <TableCell>
                      <Badge variant={roleBadgeVariant(user.role)}>
                        {roleLabel(user.role, t)}
                      </Badge>
                    </TableCell>

                    {/* Permissions */}
                    <TableCell>
                      {user.role === 'admin' ? (
                        <Badge variant="default" className="gap-1 text-[10px]">
                          <ShieldCheck className="h-3 w-3" />
                          {t('All')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {countPermissions(user)}/{ALL_PERMISSION_KEYS.length} {t('permissions')}
                        </Badge>
                      )}
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <Badge variant={user.is_active === 1 ? 'success' : 'destructive'}>
                        {user.is_active === 1 ? t('Active') : t('Inactive')}
                      </Badge>
                    </TableCell>

                    {/* Created */}
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(user.created_at)}
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {/* Edit */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEditDialog(user)}
                          title={t('Edit User')}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>

                        {/* Reset Password */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openResetPasswordDialog(user)}
                          title={t('Reset Password')}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>

                        {/* Unlock Account */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleUnlockAccount(user)}
                          title={t('Unlock Account')}
                        >
                          <Lock className="h-4 w-4" />
                        </Button>

                        {/* Toggle Active/Inactive */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className={
                            user.is_active === 1
                              ? 'h-8 w-8 text-destructive hover:text-destructive'
                              : 'h-8 w-8 text-green-600 hover:text-green-600'
                          }
                          onClick={() => handleToggleActive(user)}
                          disabled={user.id === currentUser?.id}
                          title={user.is_active === 1 ? t('Deactivate') : t('Reactivate')}
                        >
                          <Power className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Create/Edit User Dialog ────────────────────────────────────────── */}
      <Dialog open={formDialogOpen} onOpenChange={setFormDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCog className="h-5 w-5" />
              {isEditing ? t('Edit User') : t('Add User')}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? t('Update user details and permissions.')
                : t('Create a new user account.')}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitForm}>
            <div className="space-y-4 py-2">
              {/* ── Username ──────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label htmlFor="user-username">
                  {t('Username')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="user-username"
                  value={form.username}
                  onChange={(e) => updateForm({ username: e.target.value })}
                  disabled={isEditing}
                  placeholder={t('Enter username')}
                  autoComplete="off"
                />
                {isEditing && (
                  <p className="text-xs text-muted-foreground">
                    {t('Username cannot be changed after creation')}
                  </p>
                )}
              </div>

              {/* ── Full Name ─────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label htmlFor="user-fullname">
                  {t('Full Name')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="user-fullname"
                  value={form.full_name}
                  onChange={(e) => updateForm({ full_name: e.target.value })}
                  placeholder={t('Enter full name')}
                  autoComplete="off"
                />
              </div>

              {/* ── Password (create only) ────────────────────────────── */}
              {!isEditing && (
                <div className="space-y-1.5">
                  <Label htmlFor="user-password">
                    {t('Password')} <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      id="user-password"
                      type={showCreatePassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => updateForm({ password: e.target.value })}
                      placeholder={t('Minimum 6 characters')}
                      autoComplete="new-password"
                      className="pe-9"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute end-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowCreatePassword(!showCreatePassword)}
                      tabIndex={-1}
                    >
                      {showCreatePassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Role ──────────────────────────────────────────────── */}
              <div className="space-y-1.5">
                <Label>{t('Role')}</Label>
                <Select
                  value={form.role}
                  onValueChange={(val) => updateForm({ role: val as UserRole })}
                  disabled={isSelfEditing}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{t('Admin')}</SelectItem>
                    <SelectItem value="pharmacist">{t('Pharmacist')}</SelectItem>
                    <SelectItem value="cashier">{t('Cashier')}</SelectItem>
                  </SelectContent>
                </Select>
                {isSelfEditing && (
                  <p className="text-xs text-muted-foreground">
                    {t('You cannot change your own role')}
                  </p>
                )}
              </div>

              {/* ── Permissions ────────────────────────────────────────── */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <Shield className="h-4 w-4" />
                  {t('Permissions')}
                  {!isAdminRole && (
                    <Badge variant="secondary" className="ms-1 text-[10px]">
                      {form.permissions.size}/{ALL_PERMISSION_KEYS.length}
                    </Badge>
                  )}
                </Label>
                {isAdminRole ? (
                  <p className="text-xs text-muted-foreground">
                    {t('Admin role has all permissions by default')}
                  </p>
                ) : (
                  <PermissionGroupList
                    permissions={form.permissions}
                    onToggle={togglePermission}
                    onToggleGroup={toggleGroupAll}
                  />
                )}
              </div>

              {/* ── Active toggle (edit only) ─────────────────────────── */}
              {isEditing && (
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="user-active" className="cursor-pointer text-sm">
                      {t('Active')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('Inactive users cannot log in')}
                    </p>
                  </div>
                  <Switch
                    id="user-active"
                    checked={form.is_active}
                    onCheckedChange={(checked) => updateForm({ is_active: checked })}
                    disabled={isSelfEditing}
                  />
                </div>
              )}

              {/* ── Form error ────────────────────────────────────────── */}
              {formError && (
                <p className="text-sm text-destructive">{formError}</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormDialogOpen(false)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={formSubmitting}>
                {formSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {isEditing ? t('Save') : t('Create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Reset Password Dialog ──────────────────────────────────────────── */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              {t('Reset Password')}
            </DialogTitle>
            <DialogDescription>
              {t('Set a new password for')} <strong>{resetTargetUser?.full_name}</strong> (
              {resetTargetUser?.username})
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitResetPassword}>
            <div className="space-y-4 py-2">
              {/* New Password */}
              <div className="space-y-1.5">
                <Label htmlFor="reset-new-pw">
                  {t('New Password')} <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="reset-new-pw"
                    type={showResetNewPassword ? 'text' : 'password'}
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    placeholder={t('Minimum 6 characters')}
                    autoComplete="new-password"
                    className="pe-9"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute end-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowResetNewPassword(!showResetNewPassword)}
                    tabIndex={-1}
                  >
                    {showResetNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {/* Confirm Password */}
              <div className="space-y-1.5">
                <Label htmlFor="reset-confirm-pw">
                  {t('Confirm Password')} <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    id="reset-confirm-pw"
                    type={showResetConfirmPassword ? 'text' : 'password'}
                    value={resetConfirmPassword}
                    onChange={(e) => setResetConfirmPassword(e.target.value)}
                    placeholder={t('Re-enter new password')}
                    autoComplete="new-password"
                    className="pe-9"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute end-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowResetConfirmPassword(!showResetConfirmPassword)}
                    tabIndex={-1}
                  >
                    {showResetConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {/* Error */}
              {resetError && (
                <p className="text-sm text-destructive">{resetError}</p>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setResetDialogOpen(false)}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={resetSubmitting}>
                {resetSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('Reset Password')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Deactivation Confirmation Dialog ───────────────────────────────── */}
      <Dialog open={deactivateDialogOpen} onOpenChange={setDeactivateDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t('Deactivate User')}
            </DialogTitle>
            <DialogDescription>
              {t('Are you sure you want to deactivate')}{' '}
              <strong>{deactivateTargetUser?.full_name}</strong> ({deactivateTargetUser?.username})?
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">
              {t('This user will no longer be able to log in to the system.')}
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeactivateDialogOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDeactivate}
              disabled={deactivateSubmitting}
            >
              {deactivateSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('Deactivate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Credentials Success Dialog ──────────────────────────────────────── */}
      <Dialog open={credentialsDialogOpen} onOpenChange={setCredentialsDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-green-500" />
              {credentialsInfo?.isReset ? t('Password Reset Successfully') : t('User Created Successfully')}
            </DialogTitle>
            <DialogDescription>
              {credentialsInfo?.isReset
                ? t('Save the new password — it cannot be viewed again.')
                : t('Save these credentials — the password cannot be viewed again.')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {/* Username */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('Username')}</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
                <code className="flex-1 text-sm font-medium">{credentialsInfo?.username}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => copyToClipboard(credentialsInfo?.username || '', 'username')}
                >
                  {copiedField === 'username' ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('Password')}</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
                <code className="flex-1 text-sm font-medium">{credentialsInfo?.password}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => copyToClipboard(credentialsInfo?.password || '', 'password')}
                >
                  {copiedField === 'password' ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setCredentialsDialogOpen(false)} className="w-full">
              {t('Done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
