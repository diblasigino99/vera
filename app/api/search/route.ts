import { NextResponse } from "next/server";
import { z } from "zod";
import {
  analyzeConsensus,
  buildDominantPlatformFallbackConsensus,
  buildLocalFallbackConsensus,
  buildNoReliableConsensus,
  buildProductFallbackConsensus
} from "@/lib/server/analyze";
import { cacheConsensus, getCachedConsensus, getCacheVersion, getStaleCachedConsensus } from "@/lib/server/cache";
import { createExternalCallCounts } from "@/lib/server/external-call-counts";
import { getLiveSearchSetup, liveSearchSetupMessage } from "@/lib/server/env";
import { recoverLocalSparseSources, searchPublicWeb } from "@/lib/server/search";
import { canonicalizeQuery, inferQueryEvidenceType, normalizeQuery } from "@/lib/utils";
import type { ConsensusResponse } from "@/lib/types";
import type { SearchPublicWebTimings } from "@/lib/server/search";

const SearchBody = z.object({
  query: z.string().trim().min(3).max(240)
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const externalCallCounts = createExternalCallCounts();
  const body = SearchBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Enter a more specific search." }, { status: 400 });
  }

  const normalizedQuery = normalizeQuery(body.data.query);
  const canonicalQuery = canonicalizeQuery(body.data.query);
  console.log("ORIGINAL_QUERY", body.data.query);
  console.log("NORMALIZED_QUERY", normalizedQuery);
  console.log("CANONICAL_QUERY", canonicalQuery);
  console.log("API_SEARCH_STARTED", {
    originalQuery: body.data.query,
    normalizedQuery,
    canonicalQuery,
    cacheVersion: getCacheVersion(),
    timestamp: new Date().toISOString()
  });
  console.log("[vera:search] request started", {
    query: body.data.query,
    normalizedQuery
  });

  if (normalizedQuery.includes("__cache_test__")) {
    const fakeResult = buildCacheTestResult(body.data.query, normalizedQuery);
    const cacheWriteStartedAt = Date.now();

    try {
      await cacheConsensus(fakeResult, externalCallCounts);
    } catch (error) {
      console.log("[vera:search] cache test write failed", {
        normalizedQuery,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    logSearchTimingSummary({
      normalizedQuery,
      cached: true,
      cacheElapsedMs: 0,
      cacheWriteElapsedMs: Date.now() - cacheWriteStartedAt,
      totalElapsedMs: Date.now() - requestStartedAt
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    return NextResponse.json(fakeResult);
  }

  let cacheElapsedMs = 0;

  try {
    const cacheStartedAt = Date.now();
    const cached = await getCachedConsensus(body.data.query, externalCallCounts);
    cacheElapsedMs = Date.now() - cacheStartedAt;
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
      logSearchCostAudit({
        query: body.data.query,
        normalizedQuery,
        cached: true,
        cacheHit: true,
        cacheElapsedMs,
        totalElapsedMs: Date.now() - requestStartedAt,
        externalCallCounts
      });
      console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
      return NextResponse.json(cached);
    }
  } catch (error) {
    console.log("[vera:search] cache lookup aborted live search", {
      normalizedQuery,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cache lookup failed." }, { status: 500 });
  }

  const setup = getLiveSearchSetup();
  if (!setup.ready) {
    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs,
      totalElapsedMs: Date.now() - requestStartedAt,
      externalCallCounts,
      abortedBeforeLiveSearch: true
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    return NextResponse.json(
      {
        error: liveSearchSetupMessage(setup.missing),
        setup
      },
      { status: 503 }
    );
  }

  try {
    const tavilyStartedAt = Date.now();
    const sourceTimings: SearchPublicWebTimings = { tavilyMs: 0, filteringMs: 0 };
    let sources = await searchPublicWeb(body.data.query, externalCallCounts, sourceTimings);
    const searchElapsedMs = Date.now() - tavilyStartedAt;
    const tavilyElapsedMs = sourceTimings.tavilyMs || searchElapsedMs;
    const filteringElapsedMs = sourceTimings.filteringMs;
    console.log("[vera:search] Tavily results returned", {
      query: body.data.query,
      count: sources.length,
      elapsedMs: searchElapsedMs,
      tavilyMs: tavilyElapsedMs,
      filteringMs: filteringElapsedMs,
      urls: sources.map((source) => source.url)
    });
    const openAIStartedAt = Date.now();
    let consensus: ConsensusResponse;
    let openAITimedOut = false;
    const evidenceType = inferQueryEvidenceType(body.data.query);

    try {
      consensus = await analyzeConsensus(body.data.query, sources, externalCallCounts);
    } catch (error) {
      openAITimedOut = isTimeoutError(error);

      if (!openAITimedOut || sources.length < 3) {
        throw error;
      }

      console.log("OPENAI_EXTRACTION_TIMEOUT", {
        evidenceType,
        sourceCount: sources.length,
        inputSourceCount: openAIInputSourceCount(evidenceType, sources.length),
        fallbackReturned: true
      });

      consensus =
        buildDominantPlatformFallbackConsensus(
          body.data.query,
          sources,
          "Vera found broad default-platform evidence, but live extraction timed out before all alternatives could be scored."
        ) ??
        buildProductFallbackConsensus(
          body.data.query,
          sources,
          "Vera found product-review evidence, but live extraction timed out before all alternatives could be scored."
        ) ??
        buildLocalFallbackConsensus(
          body.data.query,
          sources,
          "Vera found local source evidence, but live extraction timed out before all businesses could be scored."
        ) ??
        buildNoReliableConsensus(
          body.data.query,
          sources,
          "Vera found relevant sources, but the live evidence extraction timed out before it could form a reliable consensus."
        );
    }

    const openAIElapsedMs = Date.now() - openAIStartedAt;
    if (evidenceType === "product_recommendation" && consensus.results.length === 0) {
      consensus =
        buildProductFallbackConsensus(
          body.data.query,
          sources,
          "Vera found product-review evidence, but the extracted product signals were too thin to score directly."
        ) ?? consensus;
    }
    if (evidenceType === "local_recommendation" && consensus.results.length < 3) {
      consensus =
        buildLocalFallbackConsensus(
          body.data.query,
          sources,
          "Vera found local source evidence, but the extracted business signals were too thin to score directly."
        ) ?? consensus;
    }
    if (evidenceType === "local_recommendation" && validLocalResultCount(consensus) < 3) {
      const recoveryStartedAt = Date.now();
      let recoveredSources = sources;

      try {
        recoveredSources = await recoverLocalSparseSources(body.data.query, sources, externalCallCounts);
      } catch (error) {
        console.warn("[vera:search] local sparse recovery failed softly", {
          query: body.data.query,
          elapsedMs: Date.now() - recoveryStartedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (recoveredSources.length > sources.length) {
        sources = recoveredSources;
        try {
          consensus = await analyzeConsensus(body.data.query, sources, externalCallCounts);
          console.log("[vera:search] local sparse recovery analysis returned", {
            query: body.data.query,
            resultCount: consensus.results.length,
            elapsedMs: Date.now() - recoveryStartedAt,
            storedSources: consensus.sources.length,
            results: consensus.results.map((result) => result.name)
          });
        } catch (error) {
          if (!isTimeoutError(error)) {
            throw error;
          }

          console.log("OPENAI_EXTRACTION_TIMEOUT", {
            evidenceType,
            sourceCount: sources.length,
            inputSourceCount: openAIInputSourceCount(evidenceType, sources.length),
            fallbackReturned: true,
            stage: "local_sparse_recovery"
          });
          consensus =
            buildLocalFallbackConsensus(
              body.data.query,
              sources,
              "Vera found additional local evidence, but sparse recovery extraction timed out before it could rescore every business."
            ) ?? consensus;
        }
      }
    }
    if (evidenceType === "local_recommendation" && consensus.results.length === 0) {
      const stale = await getStaleCachedConsensus(body.data.query, externalCallCounts);

      if (stale?.results.length) {
        console.warn("[vera:search] local analysis returned empty; returned stale cached result", {
          normalizedQuery,
          searchId: stale.id,
          cacheVersion: stale.cacheVersion ?? null
        });
        console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
        return NextResponse.json({
          ...stale,
          explanation: stale.explanation || "Vera returned the latest cached local consensus because live extraction did not recover enough businesses."
        });
      }
    }

    logDominantPlatformTiming({
      query: body.data.query,
      tavilyMs: tavilyElapsedMs,
      openAiMs: openAIElapsedMs,
      sourceCount: sources.length,
      inputSourceCount: openAIInputSourceCount(evidenceType, sources.length),
      timedOut: openAITimedOut
    });
    console.log("[vera:search] OpenAI analysis returned", {
      query: body.data.query,
      mode: consensus.mode,
      elapsedMs: openAIElapsedMs,
      timedOut: openAITimedOut,
      storedSources: consensus.sources.length,
      results: consensus.results.map((result) => result.name)
    });
    const cacheWriteStartedAt = Date.now();
    await cacheConsensus(consensus, externalCallCounts);
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
      filteringElapsedMs,
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
    console.log("TAVILY_CALL_COUNT", {
      evidenceType,
      phase: "request_total",
      calls: externalCallCounts.tavilyCalls
    });
    console.log("OPENAI_CALL_COUNT", {
      evidenceType,
      phase: "request_total",
      calls: externalCallCounts.openAiCalls
    });
    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs,
      tavilyElapsedMs,
      filteringElapsedMs,
      openAIElapsedMs,
      cacheWriteElapsedMs,
      totalElapsedMs: Date.now() - requestStartedAt,
      externalCallCounts
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    return NextResponse.json(consensus);
  } catch (error) {
    if (inferQueryEvidenceType(body.data.query) === "local_recommendation" && isTransientLiveSearchError(error)) {
      const stale = await getStaleCachedConsensus(body.data.query, externalCallCounts);

      if (stale) {
        console.warn("[vera:search] local live search failed; returned stale cached result", {
          normalizedQuery,
          error: error instanceof Error ? error.message : String(error),
          searchId: stale.id,
          cacheVersion: stale.cacheVersion ?? null
        });
        console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
        return NextResponse.json({
          ...stale,
          explanation: stale.explanation || "Vera returned the latest cached local consensus because live retrieval was temporarily unavailable."
        });
      }
    }

    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs,
      totalElapsedMs: Date.now() - requestStartedAt,
      externalCallCounts,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    const message = error instanceof Error ? error.message : "Vera could not complete this search.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isTimeoutError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /timeout|timed out|request timed out/i.test(`${error.name} ${error.message}`);
}

function isTransientLiveSearchError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /timeout|timed out|request timed out|fetch failed|network|abort|aborted|connection error/i.test(`${error.name} ${error.message}`);
}

function openAIInputSourceCount(evidenceType: ReturnType<typeof inferQueryEvidenceType>, sourceCount: number) {
  if (evidenceType === "local_recommendation") {
    return Math.min(sourceCount, 8);
  }

  return Math.min(sourceCount, 8);
}

function validLocalResultCount(consensus: ConsensusResponse) {
  return consensus.results.filter((result) => result.name && (result.consensusPercentage ?? 0) > 0).length;
}

function logDominantPlatformTiming({
  query,
  tavilyMs,
  openAiMs,
  sourceCount,
  inputSourceCount,
  timedOut
}: {
  query: string;
  tavilyMs: number;
  openAiMs: number;
  sourceCount: number;
  inputSourceCount: number;
  timedOut: boolean;
}) {
  if (inferQueryEvidenceType(query) !== "dominant_platform") {
    return;
  }

  console.log("DOMINANT_PLATFORM_TIMING", {
    tavilyMs,
    openAiMs,
    sourceCount,
    inputSourceCount,
    timedOut
  });
}

function buildCacheTestResult(originalQuery: string, normalizedQuery: string): ConsensusResponse {
  const createdAt = new Date().toISOString();
  const sources = [
    {
      title: "Vera cache test source",
      url: "https://example.com/vera-cache-test",
      domain: "example.com",
      snippet: "Synthetic source used only to verify Vera cache, routing, and Learn Why behavior."
    }
  ];

  return {
    id: "11111111-1111-4111-8111-111111111111",
    query: originalQuery,
    normalizedQuery,
    canonicalQuery: canonicalizeQuery(originalQuery),
    cacheVersion: getCacheVersion(),
    generated_at: createdAt,
    model: "cache-test",
    mode: "strong_consensus",
    headline: "Cache test result returned instantly.",
    explanation: "This result skipped Tavily and OpenAI so Vera can isolate frontend, routing, deployment, and cache behavior.",
    intent: {
      category: "debug",
      location: "Williamsburg",
      constraints: ["cache test"],
      optimizeFor: ["speed", "determinism"],
      avoid: ["live search", "OpenAI analysis"]
    },
    results: [
      {
        id: "cache-test-maison-premiere",
        rank: 1,
        name: "Maison Premiere",
        consensusPercentage: 91,
        summary: "Synthetic cache-test winner for first-date searches in Williamsburg.",
        reasons: ["Atmosphere", "Cocktails", "Conversation-friendly", "Consistent recommendation"],
        downsides: ["Synthetic debug result", "Not based on live data"],
        evidence: ["Returned by Vera cache test mode without external search or model calls."],
        sources
      },
      {
        id: "cache-test-fresh-kills",
        rank: 2,
        name: "Fresh Kills",
        consensusPercentage: 84,
        summary: "Synthetic runner-up used to verify stable result ordering.",
        reasons: ["Cocktails", "Date-night energy"],
        downsides: ["Synthetic debug result"],
        evidence: ["Included only to test Learn Why navigation and stored result rendering."],
        sources
      }
    ],
    sources,
    createdAt,
    cached: true
  };
}

function logSearchTimingSummary({
  normalizedQuery,
  cached,
  cacheElapsedMs,
  tavilyElapsedMs = 0,
  filteringElapsedMs = 0,
  openAIElapsedMs = 0,
  cacheWriteElapsedMs = 0,
  totalElapsedMs
}: {
  normalizedQuery: string;
  cached: boolean;
  cacheElapsedMs: number;
  tavilyElapsedMs?: number;
  filteringElapsedMs?: number;
  openAIElapsedMs?: number;
  cacheWriteElapsedMs?: number;
  totalElapsedMs: number;
}) {
  const stages = [
    { stage: "cache_lookup", elapsedMs: cacheElapsedMs },
    { stage: "tavily", elapsedMs: tavilyElapsedMs },
    { stage: "source_filtering", elapsedMs: filteringElapsedMs },
    { stage: "openai", elapsedMs: openAIElapsedMs },
    { stage: "cache_write", elapsedMs: cacheWriteElapsedMs }
  ];
  const slowest = stages.reduce((current, next) => (next.elapsedMs > current.elapsedMs ? next : current), stages[0]);

  if (!cached) {
    console.log("COLD_SEARCH_TIMING", {
      tavilyMs: tavilyElapsedMs,
      filteringMs: filteringElapsedMs,
      openAiMs: openAIElapsedMs,
      cacheWriteMs: cacheWriteElapsedMs,
      totalMs: totalElapsedMs,
      slowestStage: slowest.stage
    });
  }

  console.log("[vera:search] stage timing summary", {
    normalizedQuery,
    cached,
    stages,
    slowestStage: slowest.stage,
    slowestElapsedMs: slowest.elapsedMs,
    totalElapsedMs
  });
}

function logSearchCostAudit({
  query,
  normalizedQuery,
  cached,
  cacheHit,
  cacheElapsedMs,
  tavilyElapsedMs = 0,
  filteringElapsedMs = 0,
  openAIElapsedMs = 0,
  cacheWriteElapsedMs = 0,
  totalElapsedMs,
  externalCallCounts,
  abortedBeforeLiveSearch = false,
  error
}: {
  query: string;
  normalizedQuery: string;
  cached: boolean;
  cacheHit: boolean;
  cacheElapsedMs: number;
  tavilyElapsedMs?: number;
  filteringElapsedMs?: number;
  openAIElapsedMs?: number;
  cacheWriteElapsedMs?: number;
  totalElapsedMs: number;
  externalCallCounts: ReturnType<typeof createExternalCallCounts>;
  abortedBeforeLiveSearch?: boolean;
  error?: string;
}) {
  const evidenceType = inferQueryEvidenceType(query);

  console.log("SEARCH_COST_AUDIT", {
    query,
    normalizedQuery,
    evidenceType,
    cacheVersion: getCacheVersion(),
    cached,
    cacheHit,
    abortedBeforeLiveSearch,
    counts: {
      supabaseReads: externalCallCounts.supabaseReads,
      tavilyCalls: externalCallCounts.tavilyCalls,
      openAiCalls: externalCallCounts.openAiCalls,
      supabaseWrites: externalCallCounts.supabaseWrites
    },
    tavilyCallReasons: externalCallCounts.tavilyCallReasons,
    openAiCallReasons: externalCallCounts.openAiCallReasons,
    timings: {
      cacheMs: cacheElapsedMs,
      tavilyMs: tavilyElapsedMs,
      filteringMs: filteringElapsedMs,
      openAiMs: openAIElapsedMs,
      cacheWriteMs: cacheWriteElapsedMs,
      totalMs: totalElapsedMs
    },
    error: error ?? null
  });
}
