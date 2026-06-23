import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeConsensus } from "@/lib/server/analyze";
import { cacheConsensus, getCachedConsensus } from "@/lib/server/cache";
import { getLiveSearchSetup, liveSearchSetupMessage } from "@/lib/server/env";
import { searchPublicWeb } from "@/lib/server/search";
import { normalizeQuery } from "@/lib/utils";

const SearchBody = z.object({
  query: z.string().trim().min(3).max(240)
});

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const body = SearchBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Enter a more specific search." }, { status: 400 });
  }

  const setup = getLiveSearchSetup();
  if (!setup.ready) {
    return NextResponse.json(
      {
        error: liveSearchSetupMessage(setup.missing),
        setup
      },
      { status: 503 }
    );
  }

  const normalizedQuery = normalizeQuery(body.data.query);
  console.log("[vera:search] request started", {
    query: body.data.query,
    normalizedQuery
  });

  const cacheStartedAt = Date.now();
  const cached = await getCachedConsensus(body.data.query);
  console.log("[vera:search] cache lookup completed", {
    normalizedQuery,
    hit: Boolean(cached),
    elapsedMs: Date.now() - cacheStartedAt
  });

  if (cached) {
    console.log("[vera:search] request completed", {
      normalizedQuery,
      cached: true,
      totalElapsedMs: Date.now() - requestStartedAt
    });
    return NextResponse.json(cached);
  }

  try {
    const tavilyStartedAt = Date.now();
    const sources = await searchPublicWeb(body.data.query);
    console.log("[vera:search] Tavily results returned", {
      query: body.data.query,
      count: sources.length,
      elapsedMs: Date.now() - tavilyStartedAt,
      urls: sources.map((source) => source.url)
    });
    const openAIStartedAt = Date.now();
    const consensus = await analyzeConsensus(body.data.query, sources);
    console.log("[vera:search] OpenAI analysis returned", {
      query: body.data.query,
      mode: consensus.mode,
      elapsedMs: Date.now() - openAIStartedAt,
      storedSources: consensus.sources.length,
      results: consensus.results.map((result) => result.name)
    });
    const cacheWriteStartedAt = Date.now();
    await cacheConsensus(consensus);
    console.log("[vera:search] cache write completed", {
      normalizedQuery,
      elapsedMs: Date.now() - cacheWriteStartedAt
    });
    console.log("[vera:search] Final Vera result JSON", {
      id: consensus.id,
      normalizedQuery,
      mode: consensus.mode,
      resultCount: consensus.results.length,
      storedSources: consensus.sources.length,
      totalElapsedMs: Date.now() - requestStartedAt
    });
    return NextResponse.json(consensus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vera could not complete this search.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
