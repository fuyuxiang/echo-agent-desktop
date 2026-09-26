import { useLayoutEffect, useState, useCallback, useMemo, createContext, useContext } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

interface ThemeCtx {
  theme: Theme;
  preference: ThemePreference;
  toggle: () => void;
  setTheme: (t: ThemePreference) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export const THEME_STORAGE_KEY = "echoagent.theme";

function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // WebView privacy/storage restrictions must not prevent the UI from loading.
  }
  // Default to light, matching EchoAgent.
  return "light";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
}

/** Apply the persisted theme before React mounts to avoid a light startup frame. */
export function initializeTheme(): Theme {
  const preference = getStoredTheme();
  const theme = preference === "system" ? systemTheme() : preference;
  applyTheme(theme);
  return theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(getStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme: Theme = preference === "system" ? system : preference;

  useLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(media.matches ? "dark" : "light");
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useLayoutEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Keep the selected theme for this process even when persistence is unavailable.
    }
  }, [preference, theme]);

  const setTheme = useCallback((t: ThemePreference) => setPreference(t), []);
  const toggle = useCallback(
    () => setPreference((t) => (t === "dark" ? "light" : "dark")),
    []
  );

  const value = useMemo(() => ({ theme, preference, toggle, setTheme }), [theme, preference, toggle, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
