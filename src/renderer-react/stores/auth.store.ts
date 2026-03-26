import { create } from 'zustand';
import type { User, UserRole } from '@/api/types';
import type { PermissionKey } from '@/lib/permissions';
import { resolvePermissions, hasPermission, hasAnyPermission } from '@/lib/permissions';
import { api } from '@/api';
import { useCartStore } from './cart.store';
import { useShiftStore } from './shift.store';


interface AuthState {
  currentUser: User | null;
  isAuthenticated: boolean;
  isFirstLaunch: boolean;
  isDev: boolean;
  isLoading: boolean;

  login: (username: string, password: string) => Promise<User>;
  completeLogin: () => void;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
  checkSession: () => Promise<void>;
  loadAppInfo: () => Promise<void>;

  // Permission helpers
  hasRole: (role: UserRole) => boolean;
  hasPermission: (perm: PermissionKey) => boolean;
  hasAnyPermission: (perms: PermissionKey[]) => boolean;
  isAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentUser: null,
  isAuthenticated: false,
  isFirstLaunch: false,
  isDev: false,
  isLoading: true,

  login: async (username: string, password: string) => {
    const result = await api.auth.login(username, password);
    if ('error' in result) {
      throw new Error(result.error);
    }
    // IPC returns { success, user } or raw User — extract the user object
    const user = ('user' in result ? result.user : result) as User;
    // If must_change_password is set, store user but DON'T set isAuthenticated yet.
    // LoginPage will show the password-change dialog and call completeLogin() after.
    if (user.must_change_password === 1) {
      set({ currentUser: user, isAuthenticated: false });
    } else {
      set({ currentUser: user, isAuthenticated: true });
    }
    return user;
  },

  completeLogin: () => {
    const user = get().currentUser;
    if (user) set({ isAuthenticated: true });
  },

  logout: async () => {
    await api.auth.logout();
    useCartStore.getState().clear();
    useShiftStore.getState().reset();
    // Settings are global (not per-user) — don't reset on logout.
    // Resetting causes language/direction change → re-render cascade → focus loss.
    set({ currentUser: null, isAuthenticated: false });
  },

  setUser: (user) => {
    set({ currentUser: user, isAuthenticated: !!user });
  },

  checkSession: async () => {
    try {
      const result = await api.auth.getCurrentUser();
      // IPC returns { success, user } or null — extract the user object
      const user = result && typeof result === 'object' && 'user' in result
        ? (result as { user: User | null }).user
        : result;
      const u = user as User | null;
      const authenticated = !!u && u.must_change_password !== 1;
      set({ currentUser: u, isAuthenticated: authenticated, isLoading: false });
    } catch {
      set({ currentUser: null, isAuthenticated: false, isLoading: false });
    }
  },

  loadAppInfo: async () => {
    try {
      const info = await api.app.info();
      set({ isFirstLaunch: info.isFirstLaunch, isDev: info.isDev });
    } catch {
      // Ignore
    }
  },

  hasRole: (role) => get().currentUser?.role === role,
  hasPermission: (perm) => {
    const user = get().currentUser;
    if (!user) return false;
    const perms = resolvePermissions(user);
    return hasPermission(user.role, perms, perm);
  },
  hasAnyPermission: (keys) => {
    const user = get().currentUser;
    if (!user) return false;
    const perms = resolvePermissions(user);
    return hasAnyPermission(user.role, perms, keys);
  },
  isAdmin: () => get().currentUser?.role === 'admin',
}));
