import { create } from 'zustand';
import type { Shift } from '@/api/types';
import { api } from '@/api';

interface ShiftState {
  currentShift: Shift | null;
  isLoading: boolean;
  loadError: string | null;
  /** True when the current shift has been open for more than 24 hours */
  isStaleShift: boolean;
  loadCurrentShift: () => Promise<void>;
  openShift: (openingAmount: number) => Promise<Shift>;
  closeShift: (shiftId: number, actualCash: number, notes?: string) => Promise<Shift>;
  updateOpeningAmount: (shiftId: number, openingAmount: number) => Promise<Shift>;
  reset: () => void;
}

export const useShiftStore = create<ShiftState>((set) => ({
  currentShift: null,
  isLoading: false,
  loadError: null,
  isStaleShift: false,

  loadCurrentShift: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const shift = await api.shifts.getCurrent();
      let isStale = false;
      if (shift?.opened_at) {
        const age = Date.now() - new Date(shift.opened_at).getTime();
        isStale = age > 24 * 60 * 60 * 1000;
      }
      set({ currentShift: shift, isLoading: false, isStaleShift: isStale });
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

  updateOpeningAmount: async (shiftId, openingAmount) => {
    const updated = await api.shifts.updateOpeningAmount(shiftId, openingAmount);
    set({ currentShift: updated });
    return updated;
  },

  reset: () => set({ currentShift: null }),
}));
