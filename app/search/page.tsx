import { ResultsView } from "@/components/results-view";
import { SearchExperience } from "@/components/search-experience";
import { getCachedConsensus } from "@/lib/server/cache";
import Link from "next/link";

type SearchPageProps = {
  searchParams: Promise<{
    q?: string;
    thinking?: string;
  }>;
};

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const showThinking = params.thinking === "1";
  const cached = query ? await getCachedConsensus(query) : null;

  return (
    <main className="min-h-screen bg-white px-5 py-8">
      <nav className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <Link href="/" className="font-serif text-3xl text-ink">
          Vera
        </Link>
        <Link href="/profile" className="text-sm text-muted transition hover:text-ink">
          Profile
        </Link>
      </nav>

      <section className="mx-auto mt-14 w-full max-w-4xl">
        <SearchExperience initialQuery={query} compact />
        <ResultsView initialResult={cached} query={query} showThinking={showThinking} />
      </section>
    </main>
  );
}
