import { create } from 'zustand';
import type { Shift } from '@/api/types';
import { api } from '@/api';

interface ShiftState {
  currentShift: Shift | null;
  isLoading: boolean;
  loadError: string | null;
  loadCurrentShift: () => Promise<void>;
  openShift: (openingAmount: number) => Promise<Shift>;
  closeShift: (shiftId: number, actualCash: number, notes?: string) => Promise<Shift>;
  reset: () => void;
}

export const useShiftStore = create<ShiftState>((set) => ({
  currentShift: null,
  isLoading: false,
  loadError: null,

  loadCurrentShift: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const shift = await api.shifts.getCurrent();
      set({ currentShift: shift, isLoading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load shift';
      console.error('Failed to load current shift:', message);
      set({ currentShift: null, isLoading: false, loadError: message });
    }
  },

  openShift: async (openingAmount) => {
    const shift = await api.shifts.open(openingAmount);
    set({ currentShift: shift });
    return shift;
  },

  closeShift: async (shiftId, actualCash, notes) => {
    const result = await api.shifts.close(shiftId, actualCash, notes);
    set({ currentShift: null });
    return result;
  },

  reset: () => set({ currentShift: null }),
}));
