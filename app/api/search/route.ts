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
  const cacheElapsedMs = Date.now() - cacheStartedAt;
  console.log("[vera:search] cache lookup completed", {
    normalizedQuery,
    hit: Boolean(cached),
    elapsedMs: cacheElapsedMs
  });

  if (cached) {
    logSearchTimingSummary({
      normalizedQuery,
      cached: true,
      cacheElapsedMs,
      totalElapsedMs: Date.now() - requestStartedAt
    });
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
    const tavilyElapsedMs = Date.now() - tavilyStartedAt;
    console.log("[vera:search] Tavily results returned", {
      query: body.data.query,
      count: sources.length,
      elapsedMs: tavilyElapsedMs,
      urls: sources.map((source) => source.url)
    });
    const openAIStartedAt = Date.now();
    const consensus = await analyzeConsensus(body.data.query, sources);
    const openAIElapsedMs = Date.now() - openAIStartedAt;
    console.log("[vera:search] OpenAI analysis returned", {
      query: body.data.query,
      mode: consensus.mode,
      elapsedMs: openAIElapsedMs,
      storedSources: consensus.sources.length,
      results: consensus.results.map((result) => result.name)
    });
    const cacheWriteStartedAt = Date.now();
    await cacheConsensus(consensus);
    const cacheWriteElapsedMs = Date.now() - cacheWriteStartedAt;
    console.log("[vera:search] cache write completed", {
      normalizedQuery,
      elapsedMs: cacheWriteElapsedMs
    });
    logSearchTimingSummary({
      normalizedQuery,
      cached: false,
      cacheElapsedMs,
      tavilyElapsedMs,
      openAIElapsedMs,
      cacheWriteElapsedMs,
      totalElapsedMs: Date.now() - requestStartedAt
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

function logSearchTimingSummary({
  normalizedQuery,
  cached,
  cacheElapsedMs,
  tavilyElapsedMs = 0,
  openAIElapsedMs = 0,
  cacheWriteElapsedMs = 0,
  totalElapsedMs
}: {
  normalizedQuery: string;
  cached: boolean;
  cacheElapsedMs: number;
  tavilyElapsedMs?: number;
  openAIElapsedMs?: number;
  cacheWriteElapsedMs?: number;
  totalElapsedMs: number;
}) {
  const stages = [
    { stage: "cache_lookup", elapsedMs: cacheElapsedMs },
    { stage: "tavily", elapsedMs: tavilyElapsedMs },
    { stage: "openai", elapsedMs: openAIElapsedMs },
    { stage: "cache_write", elapsedMs: cacheWriteElapsedMs }
  ];
  const slowest = stages.reduce((current, next) => (next.elapsedMs > current.elapsedMs ? next : current), stages[0]);

  console.log("[vera:search] stage timing summary", {
    normalizedQuery,
    cached,
    stages,
    slowestStage: slowest.stage,
    slowestElapsedMs: slowest.elapsedMs,
    totalElapsedMs
  });
}
