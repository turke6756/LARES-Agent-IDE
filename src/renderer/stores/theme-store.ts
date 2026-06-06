import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem('app-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* ignore */ }
  return 'dark';
}

function saveTheme(theme: Theme) {
  localStorage.setItem('app-theme', theme);
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'light') {
    root.classList.add('light');
    root.classList.remove('dark');
  } else {
    root.classList.add('dark');
    root.classList.remove('light');
  }
  // Sync native window chrome (title bar / menu bar) and persist for the
  // next launch's pre-paint background. Guarded: preload may not be ready
  // when this runs at module load.
  try {
    window.api?.system?.setTheme?.(theme);
  } catch { /* non-fatal — chrome stays on previous theme */ }
}

// Apply on load
const initialTheme = loadTheme();
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,
  toggleTheme: () => {
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      applyTheme(next);
      return { theme: next };
    });
  },
}));
