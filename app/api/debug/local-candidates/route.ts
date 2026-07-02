import { NextResponse } from "next/server";
import { debugLocalCandidateDiscovery } from "@/lib/server/analyze";

const defaultQueries = [
  "Best espresso martini in NYC",
  "Best Italian restaurant in Seaford NY",
  "Best seafood restaurant in Seaford NY",
  "Best sushi in Huntington NY",
  "Best brunch in Huntington NY",
  "Best coffee in Delray Beach FL",
  "Best pizza in Massapequa NY",
  "Best Italian restaurant in Delray Beach FL"
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const queries = query ? [query] : defaultQueries;
  const results = await Promise.all(queries.map((item) => debugLocalCandidateDiscovery(item)));

  return NextResponse.json({
    ok: true,
    mode: "local_candidate_discovery_debug",
    usesOpenAI: false,
    usesTavily: false,
    results
  });
}
