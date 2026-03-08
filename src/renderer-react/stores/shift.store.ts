import { create } from 'zustand';
import type { Shift } from '@/api/types';
import { api } from '@/api';

interface ShiftState {
  currentShift: Shift | null;
  isLoading: boolean;
  loadCurrentShift: () => Promise<void>;
  openShift: (openingAmount: number) => Promise<Shift>;
  closeShift: (shiftId: number, actualCash: number, notes?: string) => Promise<Shift>;
  reset: () => void;
}

export const useShiftStore = create<ShiftState>((set) => ({
  currentShift: null,
  isLoading: false,

  loadCurrentShift: async () => {
    set({ isLoading: true });
    try {
      const shift = await api.shifts.getCurrent();
      set({ currentShift: shift, isLoading: false });
    } catch {
      set({ currentShift: null, isLoading: false });
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
