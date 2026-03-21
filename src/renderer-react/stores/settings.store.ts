import { create } from 'zustand';
import { api } from '@/api';

/**
 * The backend returns Setting[] ({key, value, updated_at}[]), but the store
 * uses a flat Record<string, string>. This helper normalises both shapes.
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

interface SettingsState {
  settings: Record<string, string>;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  getSetting: (key: string, fallback?: string) => string;
  setSetting: (key: string, value: string) => Promise<void>;
  getCurrencySymbol: () => string;
  getLanguage: () => string;
  getBankConfig: () => Array<{ id: string; name: string; account_number: string; enabled: boolean }>;
  reset: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {},
  isLoaded: false,

  loadSettings: async () => {
    try {
      const raw = await api.settings.getAll();
      set({ settings: toRecord(raw), isLoaded: true });
    } catch {
      set({ isLoaded: true });
    }
  },

  getSetting: (key, fallback = '') => get().settings[key] || fallback,

  setSetting: async (key, value) => {
    await api.settings.set(key, value);
    set({ settings: { ...get().settings, [key]: value } });
  },

  getCurrencySymbol: () => get().settings['currency'] || get().settings['currency_symbol'] || 'SDG',

  getLanguage: () => get().settings['language'] || 'en',

  getBankConfig: () => {
    const DEFAULT_BANKS = [
      { id: 'bok', name: 'BOK', account_number: '', enabled: true },
      { id: 'fawry', name: 'FAWRY', account_number: '', enabled: true },
      { id: 'ocash', name: 'OCASH', account_number: '', enabled: true },
    ];
    try {
      const parsed = JSON.parse(get().settings['bank_config'] || '[]');
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_BANKS;
    } catch {
      return DEFAULT_BANKS;
    }
  },

  reset: () => set({ settings: {}, isLoaded: false }),
}));
