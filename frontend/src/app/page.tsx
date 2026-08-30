import { BiodataApp } from "@/components/biodata-app";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs font-semibold tracking-[0.2em] text-indigo-600 uppercase dark:text-indigo-400">
            Biodata intake
          </p>
          <ThemeToggle />
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance text-slate-900 sm:text-4xl dark:text-slate-50">
          Record a person&rsquo;s biodata
        </h1>
        <p className="mt-3 max-w-2xl text-pretty text-slate-600 dark:text-slate-400">
          Fill in the details below. Age and BMI are calculated as you type, and
          each submission is saved exactly once — retrying after a network hiccup
          will never create a duplicate record.
        </p>
      </header>

      <BiodataApp />
 <div className="mt-8 rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-center dark:border-indigo-800 dark:bg-indigo-950">
        <h2 className="font-semibold text-indigo-700 dark:text-indigo-300">
          CI/CD Test 🚀
        </h2>
        <p className="mt-1 text-sm text-indigo-600 dark:text-indigo-400">

          My first automated deployment is working yes chris did it!

          My first automated deployment is working needs to be done chris

        </p>
      </div>
      <footer className="mt-10 text-xs text-slate-400 dark:text-slate-500">
        Data is stored on the records service; this page never talks to it
        directly.
      </footer>
    </main>
  );
}
