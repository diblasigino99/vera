import { ResultsView } from "@/components/results-view";

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

  console.log("SEARCH_PAGE_RENDER", { query, showThinking });

  return (
    <main className="min-h-screen bg-white px-5 py-8">
      <ResultsView initialResult={null} query={query} showThinking={showThinking} />
    </main>
  );
}
