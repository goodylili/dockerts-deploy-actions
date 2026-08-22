"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "red";

// Cycle order for the toggle: each press advances to the next theme.
const ORDER: Theme[] = ["light", "dark", "red"];

const ICON: Record<Theme, string> = {
  light: "☾",
  dark: "◉",
  red: "☀",
};

// The theme lives on <html> (set pre-paint by the inline script in the root layout),
// so it is external state React subscribes to rather than owns.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  const classes = document.documentElement.classList;
  if (classes.contains("red")) return "red";
  return classes.contains("dark") ? "dark" : "light";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("red", theme === "red");
  // Red mode is a light-background theme, so native controls follow light.
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => "light" as Theme);

  // React's dev-only remount resets <html> to the attributes it manages from JSX,
  // clearing what the pre-paint inline script set. Re-apply before paint. No-op in production.
  useLayoutEffect(() => {
    try {
      const stored = localStorage.getItem("theme") as Theme | null;
      if (stored && ORDER.includes(stored)) apply(stored);
    } catch {
      // Storage unavailable; keep whatever the inline script managed to set.
    }
  }, []);

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  function toggle() {
    apply(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this page view.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 bg-white/70 text-slate-700 transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-900"
    >
      <span aria-hidden="true" className="text-base leading-none">
        {ICON[theme]}
      </span>
    </button>
  );
}
