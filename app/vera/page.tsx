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
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:py-16 lg:pt-[6.5rem] lg:pb-14">
      <section className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
        <p className="mb-5 text-[0.62rem] font-medium uppercase tracking-[0.34em] text-[#B3B3B8] sm:mb-6">
          Nexra AI Presents
        </p>
        <h1 className="font-serif text-[6.5rem] leading-[0.86] tracking-[-0.055em] text-[#111114] sm:text-[9rem]">
          Vera
        </h1>
        <p className="mt-8 text-[1.15rem] font-normal leading-8 tracking-[-0.01em] text-[#686870] sm:text-[1.45rem]">
          See where the internet agrees—and where it doesn&apos;t.
        </p>
        <div className="mt-[3.25rem] w-full sm:mt-14">
          <SearchExperience rotatingPlaceholders={examples} />
        </div>
        <div className="mt-8 w-full max-w-[43rem] sm:mt-9">
          <p className="mb-4 text-[0.68rem] font-medium uppercase tracking-[0.22em] text-[#A6A6AD]">Popular searches</p>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-2.5 text-sm text-[#74747D] sm:text-[15px]">
            {examples.map((example) => (
              <a
                href={`/vera/search?q=${encodeURIComponent(example)}&thinking=1`}
                key={example}
                className="rounded-full border border-[#F0F0F3] bg-white px-3.5 py-1.5 leading-6 shadow-[0_1px_0_rgba(17,17,20,0.025)] transition duration-300 hover:border-[#E2E2E7] hover:bg-[#FAFAFB] hover:text-[#111114] hover:shadow-[0_6px_18px_rgba(17,17,20,0.045)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D7DCE4]"
              >
                {example}
              </a>
            ))}
          </div>
        </div>
        <p className="mt-10 text-[0.84rem] leading-6 text-[#8D8D94] sm:mt-11">
          Built from public discussions, reviews, and expert sources.
        </p>
      </section>
    </main>
  );
}
