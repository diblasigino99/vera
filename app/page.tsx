import { SearchExperience } from "@/components/search-experience";
import Link from "next/link";

const examples = [
  "Best first date restaurant in Williamsburg",
  "Best budget hotel in Seattle",
  "Best Wi-Fi router for a large house"
];

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-16">
      <section className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
        <h1 className="font-serif text-[6rem] leading-none tracking-[-0.04em] text-ink sm:text-[8.25rem]">
          Vera
        </h1>
        <p className="mt-8 text-xl text-muted sm:text-2xl">
          Discover what the internet agrees on.
        </p>
        <div className="mt-16 w-full">
          <SearchExperience autoFocus />
        </div>
        <div className="mt-10 grid max-w-2xl gap-3 text-sm text-muted sm:text-[15px]">
          {examples.map((example) => (
            <Link
              href={`/search?q=${encodeURIComponent(example)}&thinking=1`}
              key={example}
              className="transition hover:text-ink"
            >
              {example}
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
