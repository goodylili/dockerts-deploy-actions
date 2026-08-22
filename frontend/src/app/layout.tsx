import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Biodata intake",
  description:
    "Record and review biodata submissions with live age and BMI calculation.",
};

// Runs before paint so the stored theme applies without a flash of the wrong palette.
// Themes are "light" | "dark" | "red"; red is a light-background theme, so it keeps
// the light color-scheme for native controls.
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.classList.toggle("red",t==="red");r.style.colorScheme=t==="dark"?"dark":"light";}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
