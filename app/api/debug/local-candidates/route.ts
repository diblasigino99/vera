import { NextResponse } from "next/server";
import { debugLocalCandidateDiscovery } from "@/lib/server/analyze";

const defaultQueries = [
  "Best Italian restaurant in Seaford NY",
  "Best seafood restaurant in Seaford NY",
  "Best sushi in Huntington NY",
  "Best Italian restaurant in Delray Beach FL"
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const queries = query ? [query] : defaultQueries;

  return NextResponse.json({
    ok: true,
    mode: "local_candidate_discovery_debug",
    usesOpenAI: false,
    usesTavily: false,
    results: queries.map((item) => debugLocalCandidateDiscovery(item))
  });
}
