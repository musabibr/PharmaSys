import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Shepherd from 'shepherd.js';
import type { Tour as TourType, StepOptionsButton } from 'shepherd.js';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsStore } from '@/stores/settings.store';
import { TOURS } from './tour-definitions';
import type { TourDefinition, TourStepDef } from './types';

const COMPLETED_KEY = 'completed_tours';

function getCompletedTours(getSetting: (k: string, fb?: string) => string): string[] {
  try {
    const raw = getSetting(COMPLETED_KEY, '[]');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useTour() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { currentUser, hasPermission, isAdmin } = useAuthStore();
  const { getSetting, setSetting } = useSettingsStore();
  const tourRef = useRef<TourType | null>(null);

  /** Check if user can see this tour/step based on role + permission */
  const canAccess = useCallback(
    (def: { requiredRole?: string[]; requiredPermission?: string }) => {
      if (!currentUser) return false;
      // Role check
      if (def.requiredRole && def.requiredRole.length > 0) {
        if (!def.requiredRole.includes(currentUser.role) && !isAdmin()) return false;
      }
      // Permission check
      if (def.requiredPermission) {
        if (!hasPermission(def.requiredPermission as any)) return false;
      }
      return true;
    },
    [currentUser, isAdmin, hasPermission]
  );

  /** Get tours available to the current user */
  const getAvailableTours = useCallback((): TourDefinition[] => {
    return TOURS.filter((tour) => canAccess(tour));
  }, [canAccess]);

  /** Check if a tour is completed */
  const isCompleted = useCallback(
    (tourId: string): boolean => {
      return getCompletedTours(getSetting).includes(tourId);
    },
    [getSetting]
  );

  /** Mark a tour as completed */
  const markCompleted = useCallback(
    async (tourId: string) => {
      const completed = getCompletedTours(getSetting);
      if (!completed.includes(tourId)) {
        completed.push(tourId);
        await setSetting(COMPLETED_KEY, JSON.stringify(completed));
      }
    },
    [getSetting, setSetting]
  );

  /** Cancel any running tour */
  const cancelTour = useCallback(() => {
    if (tourRef.current) {
      tourRef.current.cancel();
      tourRef.current = null;
    }
  }, []);

  /** Start a specific tour */
  const startTour = useCallback(
    (tourId: string) => {
      // Cancel any existing tour
      cancelTour();

      const tourDef = TOURS.find((t) => t.id === tourId);
      if (!tourDef) return;

      // Filter steps by role/permission
      const filteredSteps = tourDef.steps.filter((step) => canAccess(step));
      if (filteredSteps.length === 0) return;

      // Navigate to the tour's page
      navigate(tourDef.route);

      // Small delay to let the page render
      setTimeout(() => {
        const totalSteps = filteredSteps.length;
        const isRtl = document.documentElement.dir === 'rtl';

        const tour = new Shepherd.Tour({
          useModalOverlay: true,
          defaultStepOptions: {
            scrollTo: { behavior: 'smooth', block: 'center' },
            cancelIcon: { enabled: true },
            classes: '',
          },
        });

        filteredSteps.forEach((stepDef: TourStepDef, index: number) => {
          const stepNum = index + 1;
          const isFirst = index === 0;
          const isLast = index === filteredSteps.length - 1;

          const buttons: StepOptionsButton[] = [];

          // Back button (not on first step)
          if (!isFirst) {
            buttons.push({
              text: t('Back'),
              action: () => tour.back(),
              classes: 'shepherd-button-secondary',
            });
          } else {
            // Skip button on first step
            buttons.push({
              text: t('Skip'),
              action: () => tour.cancel(),
              classes: 'shepherd-button-secondary',
            });
          }

          // Next / Done button
          buttons.push({
            text: isLast ? t('Done') : t('Next'),
            action: () => (isLast ? tour.complete() : tour.next()),
            classes: 'shepherd-button-primary',
          });

          const progressHtml = `
            <div class="shepherd-progress">
              <div class="shepherd-progress-bar">
                <div class="shepherd-progress-bar-fill" style="width: ${(stepNum / totalSteps) * 100}%"></div>
              </div>
              <span class="shepherd-progress-text">${stepNum} / ${totalSteps}</span>
            </div>
          `;

          tour.addStep({
            id: stepDef.id,
            title: t(stepDef.title),
            text: progressHtml + `<p>${t(stepDef.text)}</p>`,
            attachTo: stepDef.target
              ? { element: stepDef.target, on: (stepDef.position || 'auto') as any }
              : undefined,
            buttons: isRtl ? [...buttons].reverse() : buttons,
          });
        });

        tour.on('complete', () => {
          markCompleted(tourId);
          toast.success(t('Tour completed!'));
          tourRef.current = null;
        });

        tour.on('cancel', () => {
          tourRef.current = null;
        });

        tourRef.current = tour;
        tour.start();
      }, 400);
    },
    [canAccess, cancelTour, navigate, t, markCompleted]
  );

  /** Reset all completed tours */
  const resetAllTours = useCallback(async () => {
    await setSetting(COMPLETED_KEY, '[]');
    toast.success(t('All tours have been reset'));
  }, [setSetting, t]);

  /** Reset a single tour */
  const resetTour = useCallback(
    async (tourId: string) => {
      const completed = getCompletedTours(getSetting).filter((id) => id !== tourId);
      await setSetting(COMPLETED_KEY, JSON.stringify(completed));
    },
    [getSetting, setSetting]
  );

  /** Check if any tours have been completed (for first-launch detection) */
  const hasAnyCompleted = useCallback((): boolean => {
    return getCompletedTours(getSetting).length > 0;
  }, [getSetting]);

  return {
    startTour,
    cancelTour,
    getAvailableTours,
    isCompleted,
    resetAllTours,
    resetTour,
    hasAnyCompleted,
  };
}
