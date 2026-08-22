"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "red" | "purple" | "blue";

// Cycle order for the toggle: each press advances to the next theme.
const ORDER: Theme[] = ["light", "dark", "red", "purple", "blue"];

// Themes carried by a class on <html>; "light" is the absence of all of them.
const THEME_CLASSES = ORDER.filter((t) => t !== "light");

const ICON: Record<Theme, string> = {
  light: "☾",
  dark: "◉",
  red: "☀",
  purple: "✦",
  blue: "◈",
};

const LABEL: Record<Theme, string> = {
  light: "Light mode",
  dark: "Dark mode",
  red: "Red mode",
  purple: "Purple mode",
  blue: "Blue mode",
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
  return THEME_CLASSES.find((t) => classes.contains(t)) ?? "light";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  for (const cls of THEME_CLASSES) {
    root.classList.toggle(cls, theme === cls);
  }
  // Every theme but dark has a light background, so native controls follow light.
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

  // The only feedback a theme switch gives is colour, so mirror it into a live
  // region for screen readers. Populated on change only: announcing the theme
  // the page loaded with would be noise, not news.
  const [announcement, setAnnouncement] = useState("");
  const lastAnnounced = useRef<Theme | null>(null);

  useEffect(() => {
    if (lastAnnounced.current === null) {
      lastAnnounced.current = theme;
      return;
    }
    if (lastAnnounced.current === theme) return;
    lastAnnounced.current = theme;
    setAnnouncement(LABEL[theme]);
  }, [theme]);

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
    <>
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
      {/* Always mounted so assistive tech is watching before the first change. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
