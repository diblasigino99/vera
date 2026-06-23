import { SearchExperience } from "@/components/search-experience";

const examples = [
  "Best first date restaurant in Williamsburg",
  "Best budget hotel in Seattle",
  "Best Wi-Fi router for a large house",
  "Best espresso martini in NYC",
  "Best running shoes for beginners",
  "Best carry-on suitcase",
  "Best CRM for small businesses",
  "Best AI coding assistant"
];

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-14 sm:py-16">
      <section className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
        <h1 className="font-serif text-[6rem] leading-none tracking-[-0.04em] text-ink sm:text-[8.25rem]">
          Vera
        </h1>
        <p className="mt-7 text-xl font-normal tracking-normal text-muted sm:text-2xl">
          See where the internet agrees—and where it doesn&apos;t.
        </p>
        <div className="mt-14 w-full sm:mt-16">
          <SearchExperience rotatingPlaceholders={examples} />
        </div>
        <div className="mt-8 w-full max-w-2xl sm:mt-10">
          <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-[#A0A0A7]">Popular searches</p>
          <div className="grid gap-3 text-sm text-muted sm:text-[15px]">
            {examples.map((example) => (
              <a
                href={`/search?q=${encodeURIComponent(example)}&thinking=1`}
                key={example}
                className="mx-auto w-fit rounded-full px-3 py-1.5 transition duration-200 hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D7DCE4]"
              >
                {example}
              </a>
            ))}
          </div>
        </div>
        <p className="mt-8 text-sm leading-6 text-[#8D8D94]">
          Built from public discussions, reviews, and expert sources.
        </p>
      </section>
    </main>
  );
}
