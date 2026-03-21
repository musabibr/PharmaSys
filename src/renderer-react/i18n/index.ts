import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';

// Read cached language so first render matches the pre-paint dir set in index.html
const cachedLang =
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('pharmasys-lang') || 'en'
    : 'en';

i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
  },
  lng: cachedLang, // Use cached language — updated from DB settings after login
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  // Key-as-English: i18next returns the key itself when not found,
  // with interpolation applied (no en.json needed)
});

export default i18n;
