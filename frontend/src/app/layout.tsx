import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Biodata intake",
  description:
    "Record and review biodata submissions with live age and BMI calculation.",
};

// Runs before paint so the stored theme applies without a flash of the wrong palette.
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.classList.toggle("dark",t==="dark");document.documentElement.style.colorScheme=t;}catch(e){}})();`;

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
      <body className="min-h-full bg-slate-50 bg-[radial-gradient(60rem_40rem_at_50%_-10rem,rgba(99,102,241,0.12),transparent)] text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
