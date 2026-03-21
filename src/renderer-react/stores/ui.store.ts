import { create } from 'zustand';

type Theme = 'dark' | 'light';
type Density = 'auto' | 'comfort' | 'compact';

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  density: Density;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setDensity: (density: Density) => void;
  cycleDensity: () => void;
  resolvedDensity: () => 'comfort' | 'compact';
}

const DENSITY_CYCLE: Density[] = ['auto', 'compact', 'comfort'];

export const useUiStore = create<UiState>((set, get) => ({
  theme: (localStorage.getItem('pharmasys-theme') as Theme) || 'light',

  sidebarCollapsed: (() => {
    const stored = localStorage.getItem('pharmasys-sidebar-collapsed');
    if (stored !== null) return stored === 'true';
    return typeof window !== 'undefined' && window.innerWidth <= 1400;
  })(),

  density: (localStorage.getItem('pharmasys-density') as Density) || 'auto',

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
    const next = !get().sidebarCollapsed;
    localStorage.setItem('pharmasys-sidebar-collapsed', String(next));
    set({ sidebarCollapsed: next });
  },

  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem('pharmasys-sidebar-collapsed', String(collapsed));
    set({ sidebarCollapsed: collapsed });
  },

  setDensity: (density) => {
    localStorage.setItem('pharmasys-density', density);
    set({ density });
  },

  cycleDensity: () => {
    const current = get().density;
    const idx = DENSITY_CYCLE.indexOf(current);
    const next = DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length];
    localStorage.setItem('pharmasys-density', next);
    set({ density: next });
  },

  resolvedDensity: () => {
    const d = get().density;
    if (d === 'auto') {
      return typeof window !== 'undefined' && window.innerHeight <= 800
        ? 'compact'
        : 'comfort';
    }
    return d;
  },
}));
