import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: (localStorage.getItem('pharmasys-theme') as Theme) || 'light',
  sidebarCollapsed: false,

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('pharmasys-theme', next);
    set({ theme: next });
  },

  setTheme: (theme) => {
    localStorage.setItem('pharmasys-theme', theme);
    set({ theme });
  },

  toggleSidebar: () => {
    set({ sidebarCollapsed: !get().sidebarCollapsed });
  },

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed });
  },
}));
