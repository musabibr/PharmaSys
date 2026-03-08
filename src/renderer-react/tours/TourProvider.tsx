import { createContext, useContext, useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsStore } from '@/stores/settings.store';
import { useTour } from './useTour';

type TourContextType = ReturnType<typeof useTour>;

const TourContext = createContext<TourContextType | null>(null);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const tour = useTour();
  const { isFirstLaunch, isAuthenticated } = useAuthStore();
  const { isLoaded: settingsLoaded } = useSettingsStore();
  const hasTriggeredRef = useRef(false);

  // Auto-trigger welcome tour on first launch
  useEffect(() => {
    if (
      isAuthenticated &&
      settingsLoaded &&
      isFirstLaunch &&
      !hasTriggeredRef.current &&
      !tour.hasAnyCompleted()
    ) {
      hasTriggeredRef.current = true;
      // Extra delay to ensure page is fully rendered
      const timer = setTimeout(() => {
        tour.startTour('welcome');
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isAuthenticated, settingsLoaded, isFirstLaunch, tour]);

  return (
    <TourContext.Provider value={tour}>
      {children}
    </TourContext.Provider>
  );
}

export function useTourContext(): TourContextType {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error('useTourContext must be used within a TourProvider');
  }
  return ctx;
}
