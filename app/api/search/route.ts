import { NextResponse } from "next/server";
import { z } from "zod";
import {
  analyzeConsensus,
  buildDestinationFallbackConsensus,
  buildDominantPlatformFallbackConsensus,
  buildLocalFallbackConsensus,
  buildNoReliableConsensus,
  buildProductFallbackConsensus,
  createAnalyzeDiagnostics
} from "@/lib/server/analyze";
import { cacheConsensus, getCachedConsensus, getCacheVersion, getStaleCachedConsensus } from "@/lib/server/cache";
import {
  addConsensusDiscard,
  mapDiscardReasonCode,
  recordConsensusStage,
  runConsensusEngine,
  updateConsensusTrace
} from "@/lib/server/consensus-engine";
import { createExternalCallCounts } from "@/lib/server/external-call-counts";
import { getLiveSearchSetup, liveSearchSetupMessage } from "@/lib/server/env";
import { createSearchDiagnostics, recoverLocalSparseSources, searchPublicWeb } from "@/lib/server/search";
import { recordSearchEvent } from "@/lib/server/search-events";
import { attachPostDecisionActions } from "@/lib/server/action-resolution";
import { canonicalizeQuery, classifyConsensusEligibility, inferQueryEvidenceType, inferQueryIntent, normalizeQuery } from "@/lib/utils";
import { NO_RELIABLE_CONSENSUS_BODY } from "@/lib/types";
import type { ConsensusResponse, ContenderMetrics } from "@/lib/types";
import type { ConsensusTrace, DiscardReason } from "@/lib/server/consensus-engine";
import type { SearchPublicWebTimings } from "@/lib/server/search";

const SearchBody = z.object({
  query: z.string().trim().min(3).max(240),
  actorId: z.string().trim().min(1).max(128).optional()
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const externalCallCounts = createExternalCallCounts();
  const body = SearchBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Enter a more specific search." }, { status: 400 });
  }

  const searchData = body.data;
  const eligibility = classifyConsensusEligibility(searchData.query);

  if (!eligibility.eligible) {
    console.log("CONSENSUS_ELIGIBILITY_BYPASS", {
      query: searchData.query,
      reason: eligibility.reason
    });
    return NextResponse.json(
      {
        error: "Vera is built to analyze recommendations, comparisons, and internet consensus. This looks like a factual question.",
        unsupportedReason: eligibility.reason
      },
      { status: 400 }
    );
  }

  return runConsensusEngine(searchData.query, {
    actorId: searchData.actorId,
    execute: ({ trace }) => executeExistingSearchPipeline(trace)
  });

async function executeExistingSearchPipeline(trace?: ConsensusTrace) {
  const body = { data: searchData };
  const normalizedQuery = normalizeQuery(body.data.query);
  const canonicalQuery = canonicalizeQuery(body.data.query);
  const evidenceType = inferQueryEvidenceType(body.data.query);
  const queryIntent = inferQueryIntent(body.data.query);
  updateConsensusTrace(trace, {
    retrievalPlan: {
      query: body.data.query,
      normalizedQuery,
      canonicalQuery,
      evidenceType,
      queryIntent,
      cacheVersion: getCacheVersion(body.data.query),
      strategy: "existing route pipeline: cache lookup, searchPublicWeb, analyzeConsensus, existing fallbacks",
      unavailable: [
        "Exact Tavily query variants are internal to searchPublicWeb and are not returned to the route.",
        "Pre-filter raw Tavily result rows and source discard reasons are logged inside searchPublicWeb but are not returned."
      ]
    },
    cache: {
      status: "not_checked",
      cacheVersion: getCacheVersion(body.data.query)
    },
    callCounts: snapshotExternalCallCounts(externalCallCounts)
  });
  recordConsensusStage(trace, {
    stage: "parse_task",
    status: "completed",
    startedAt: new Date(requestStartedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - requestStartedAt,
    output: { normalizedQuery, canonicalQuery, evidenceType, queryIntent }
  });
  console.log("ORIGINAL_QUERY", body.data.query);
  console.log("NORMALIZED_QUERY", normalizedQuery);
  console.log("CANONICAL_QUERY", canonicalQuery);
  console.log("QUERY_INTENT", queryIntent);
  console.log("API_SEARCH_STARTED", {
    originalQuery: body.data.query,
    normalizedQuery,
    canonicalQuery,
    cacheVersion: getCacheVersion(body.data.query),
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
    updateTraceFromConsensus(trace, fakeResult, "cache_test");
    updateConsensusTrace(trace, {
      cache: { status: "write_completed", cacheHitType: "cache_test", cacheVersion: getCacheVersion(), searchId: fakeResult.id },
      latency: { cacheWriteMs: Date.now() - cacheWriteStartedAt, totalMs: Date.now() - requestStartedAt },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      searchId: fakeResult.id,
      consensusMode: fakeResult.mode,
      cacheHit: true,
      cacheHitType: "cache_test",
      cacheVersion: getCacheVersion(),
      totalMs: Date.now() - requestStartedAt,
      cacheMs: 0,
      cacheWriteMs: Date.now() - cacheWriteStartedAt
    });
    return await consensusJson(fakeResult);
  }

  if (isUnsupportedAdultLocalCategory(body.data.query)) {
    const consensus = buildNoReliableConsensus(body.data.query, []);
    const totalElapsedMs = Date.now() - requestStartedAt;

    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs: 0,
      totalElapsedMs,
      externalCallCounts,
      abortedBeforeLiveSearch: true
    });
    console.log("UNSUPPORTED_CATEGORY_SAFETY_BYPASS", {
      query: body.data.query,
      evidenceType,
      category: "adult_local"
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    updateTraceFromConsensus(trace, consensus, "unsupported_category_safety");
    addConsensusDiscard(trace, {
      stage: "safety_bypass",
      code: "category_mismatch",
      message: "Unsupported adult local category bypassed before live search."
    });
    updateConsensusTrace(trace, {
      cache: { status: "bypassed", cacheHitType: "unsupported_category_safety", cacheVersion: getCacheVersion() },
      latency: { totalMs: totalElapsedMs },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      searchId: consensus.id,
      consensusMode: consensus.mode,
      cacheHit: false,
      cacheHitType: "unsupported_category_safety",
      cacheVersion: getCacheVersion(),
      totalMs: totalElapsedMs,
      cacheMs: 0
    });
    return await consensusJson(consensus);
  }

  if (queryIntent === "negative_avoidance" || queryIntent === "reliability_risk") {
    const consensus = buildNoReliableConsensus(body.data.query, []);
    const totalElapsedMs = Date.now() - requestStartedAt;

    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs: 0,
      totalElapsedMs,
      externalCallCounts,
      abortedBeforeLiveSearch: true
    });
    console.log("NEGATIVE_INTENT_SAFETY_BYPASS", {
      query: body.data.query,
      intent: queryIntent,
      evidenceType
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    updateTraceFromConsensus(trace, consensus, "negative_intent_safety");
    addConsensusDiscard(trace, {
      stage: "safety_bypass",
      code: "outside_constraint",
      message: `Unsupported query intent bypassed before live search: ${queryIntent}.`
    });
    updateConsensusTrace(trace, {
      cache: { status: "bypassed", cacheHitType: "negative_intent_safety", cacheVersion: getCacheVersion() },
      latency: { totalMs: totalElapsedMs },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      searchId: consensus.id,
      consensusMode: consensus.mode,
      cacheHit: false,
      cacheHitType: "negative_intent_safety",
      cacheVersion: getCacheVersion(),
      totalMs: totalElapsedMs,
      cacheMs: 0
    });
    return await consensusJson(consensus);
  }

  const vagueQueryExplanation = vagueRecommendationGuardExplanation(body.data.query, evidenceType);
  if (vagueQueryExplanation) {
    const consensus = buildNoReliableConsensus(body.data.query, []);
    const totalElapsedMs = Date.now() - requestStartedAt;

    logSearchCostAudit({
      query: body.data.query,
      normalizedQuery,
      cached: false,
      cacheHit: false,
      cacheElapsedMs: 0,
      totalElapsedMs,
      externalCallCounts,
      abortedBeforeLiveSearch: true
    });
    console.log("VAGUE_QUERY_SAFETY_BYPASS", {
      query: body.data.query,
      evidenceType,
      reason: vagueQueryExplanation
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    updateTraceFromConsensus(trace, consensus, "vague_query_safety");
    addConsensusDiscard(trace, {
      stage: "safety_bypass",
      code: "insufficient_evidence",
      message: vagueQueryExplanation
    });
    updateConsensusTrace(trace, {
      cache: { status: "bypassed", cacheHitType: "vague_query_safety", cacheVersion: getCacheVersion() },
      latency: { totalMs: totalElapsedMs },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      searchId: consensus.id,
      consensusMode: consensus.mode,
      cacheHit: false,
      cacheHitType: "vague_query_safety",
      cacheVersion: getCacheVersion(),
      totalMs: totalElapsedMs,
      cacheMs: 0
    });
    return await consensusJson(consensus);
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
    recordConsensusStage(trace, {
      stage: "cache_lookup",
      status: "completed",
      startedAt: new Date(cacheStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: cacheElapsedMs,
      output: { hit: Boolean(cached), cacheVersion: cached?.cacheVersion ?? getCacheVersion(body.data.query) }
    });

    if (cached) {
      const response = withHelpfulNoConsensusCopy(cached, body.data.query, evidenceType, queryIntent);
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
      updateTraceFromConsensus(trace, response, "cache_hit");
      updateConsensusTrace(trace, {
        cache: {
          status: "hit",
          cacheVersion: response.cacheVersion ?? getCacheVersion(),
          searchId: response.id,
          elapsedMs: cacheElapsedMs,
          cacheHitType: "hit"
        },
        latency: { cacheMs: cacheElapsedMs, totalMs: Date.now() - requestStartedAt },
        callCounts: snapshotExternalCallCounts(externalCallCounts)
      });
      await recordSearchEvent({
        ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
        searchId: response.id,
        consensusMode: response.mode,
        cacheHit: true,
        cacheHitType: "hit",
        cacheVersion: response.cacheVersion ?? getCacheVersion(),
        totalMs: Date.now() - requestStartedAt,
        cacheMs: cacheElapsedMs
      });
      return await consensusJson(response);
    }
  } catch (error) {
    console.error("[vera:search] cache lookup aborted live search", {
      normalizedQuery,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    updateConsensusTrace(trace, {
      cache: {
        status: "error",
        cacheVersion: getCacheVersion(),
        elapsedMs: cacheElapsedMs,
        cacheHitType: "cache_lookup_error",
        error: error instanceof Error ? error.message : String(error)
      },
      latency: { cacheMs: cacheElapsedMs, totalMs: Date.now() - requestStartedAt },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      cacheHit: false,
      cacheHitType: "cache_lookup_error",
      cacheVersion: getCacheVersion(),
      totalMs: Date.now() - requestStartedAt,
      cacheMs: cacheElapsedMs,
      error: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({ error: "Vera couldn't complete this search. Please try again." }, { status: 500 });
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
    updateConsensusTrace(trace, {
      cache: { status: "miss", cacheVersion: getCacheVersion(), elapsedMs: cacheElapsedMs, cacheHitType: "setup_missing" },
      latency: { cacheMs: cacheElapsedMs, totalMs: Date.now() - requestStartedAt },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      cacheHit: false,
      cacheHitType: "setup_missing",
      cacheVersion: getCacheVersion(),
      totalMs: Date.now() - requestStartedAt,
      cacheMs: cacheElapsedMs,
      error: liveSearchSetupMessage(setup.missing)
    });
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
    const searchDiagnostics = trace?.enabled ? createSearchDiagnostics() : undefined;
    const analyzeDiagnostics = trace?.enabled ? createAnalyzeDiagnostics() : undefined;
    let sources = await searchPublicWeb(body.data.query, externalCallCounts, sourceTimings, searchDiagnostics);
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
    recordConsensusStage(trace, {
      stage: "retrieval",
      status: "completed",
      startedAt: new Date(tavilyStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: searchElapsedMs,
      output: {
        retainedSourceCount: sources.length,
        tavilyMs: tavilyElapsedMs,
        filteringMs: filteringElapsedMs
      }
    });
    updateConsensusTrace(trace, {
      cache: { status: "miss", cacheVersion: getCacheVersion(), elapsedMs: cacheElapsedMs },
      retrievedSourceCount: sources.length,
      retainedSources: sources.map(toTraceSource),
      discardedSources: searchDiagnostics?.discardedSources.flatMap((item) => (item.source ? [item.source] : [])) ?? [],
      sourceDiagnostics: searchDiagnostics?.sourceDiagnostics ?? [],
      latency: { cacheMs: cacheElapsedMs, tavilyMs: tavilyElapsedMs, filteringMs: filteringElapsedMs },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    const openAIStartedAt = Date.now();
    let consensus: ConsensusResponse;
    let openAITimedOut = false;
    try {
      consensus = await analyzeConsensus(body.data.query, sources, externalCallCounts, analyzeDiagnostics);
      updateTraceFromConsensus(trace, consensus, "initial_analysis");
      updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
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
          "Vera found relevant sources, but not enough clean agreement to separate one clear favorite from the alternatives."
        ) ??
        (await buildProductFallbackConsensus(
          body.data.query,
          sources,
          "Vera found product-review sources, but not enough clean agreement to make a confident recommendation.",
          externalCallCounts,
          analyzeDiagnostics
        )) ??
        (await buildDestinationFallbackConsensus(
          body.data.query,
          sources,
          externalCallCounts,
          analyzeDiagnostics
        )) ??
        (await buildLocalFallbackConsensus(
          body.data.query,
          sources,
          "Vera could not confidently separate one clear favorite from several local contenders.",
          externalCallCounts
        )) ??
        buildNoReliableConsensus(body.data.query, sources);
      updateTraceFromConsensus(trace, consensus, openAITimedOut ? "timeout_fallback" : "analysis_fallback");
      updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
    }

    const openAIElapsedMs = Date.now() - openAIStartedAt;
    recordConsensusStage(trace, {
      stage: "analysis",
      status: "completed",
      startedAt: new Date(openAIStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: openAIElapsedMs,
      output: { mode: consensus.mode, resultCount: consensus.results.length, timedOut: openAITimedOut }
    });
    if (evidenceType === "product_recommendation" && consensus.results.length === 0) {
      consensus =
        (await buildProductFallbackConsensus(
          body.data.query,
          sources,
          NO_RELIABLE_CONSENSUS_BODY,
          externalCallCounts,
          analyzeDiagnostics,
          { allowGenericRecoveredSignals: openAITimedOut }
        )) ?? consensus;
      updateTraceFromConsensus(trace, consensus, "product_fallback");
      updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
    }
    if (evidenceType === "local_recommendation" && consensus.results.length < 3) {
      consensus =
        (await buildLocalFallbackConsensus(
          body.data.query,
          sources,
          "Vera found local sources, but not enough clean business-specific agreement to rank confidently.",
          externalCallCounts
        )) ?? consensus;
      updateTraceFromConsensus(trace, consensus, "local_fallback");
      updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
    }
    if (evidenceType === "local_recommendation" && validLocalResultCount(consensus) < 3) {
      const recoveryStartedAt = Date.now();
      let recoveredSources = sources;

      try {
        recoveredSources = await recoverLocalSparseSources(body.data.query, sources, externalCallCounts, searchDiagnostics);
      } catch (error) {
        console.warn("[vera:search] local sparse recovery failed softly", {
          query: body.data.query,
          elapsedMs: Date.now() - recoveryStartedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (recoveredSources.length > sources.length) {
        sources = recoveredSources;
        updateConsensusTrace(trace, {
          retrievedSourceCount: sources.length,
          retainedSources: sources.map(toTraceSource),
          discardedSources: searchDiagnostics?.discardedSources.flatMap((item) => (item.source ? [item.source] : [])) ?? [],
          sourceDiagnostics: searchDiagnostics?.sourceDiagnostics ?? [],
          callCounts: snapshotExternalCallCounts(externalCallCounts)
        });
        try {
          const preRecoveryConsensus = consensus;
          const recoveredConsensus = await analyzeConsensus(body.data.query, sources, externalCallCounts, analyzeDiagnostics);
          if (validLocalResultCount(recoveredConsensus) >= validLocalResultCount(preRecoveryConsensus)) {
            consensus = recoveredConsensus;
          } else {
            consensus = preRecoveryConsensus;
          }
          console.log("[vera:search] local sparse recovery analysis returned", {
            query: body.data.query,
            resultCount: recoveredConsensus.results.length,
            keptResultCount: consensus.results.length,
            elapsedMs: Date.now() - recoveryStartedAt,
            storedSources: recoveredConsensus.sources.length,
            results: recoveredConsensus.results.map((result) => result.name),
            keptPreviousConsensus: consensus === preRecoveryConsensus
          });
          recordConsensusStage(trace, {
            stage: "local_sparse_recovery",
            status: "completed",
            startedAt: new Date(recoveryStartedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - recoveryStartedAt,
            output: {
              recoveredSourceCount: recoveredSources.length,
              resultCount: recoveredConsensus.results.length,
              keptPreviousConsensus: consensus === preRecoveryConsensus
            }
          });
          updateTraceFromConsensus(trace, consensus, "local_sparse_recovery");
          updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
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
            (await buildLocalFallbackConsensus(
              body.data.query,
              sources,
              "Vera found additional local evidence, but still could not confidently separate the strongest local contenders.",
              externalCallCounts
            )) ?? consensus;
          updateTraceFromConsensus(trace, consensus, "local_sparse_recovery_timeout_fallback");
          updateTraceFromAnalyzeDiagnostics(trace, analyzeDiagnostics);
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
        updateTraceFromConsensus(trace, stale, "stale_empty_local");
        updateConsensusTrace(trace, {
          cache: {
            status: "stale_hit",
            cacheVersion: stale.cacheVersion ?? null,
            searchId: stale.id,
            cacheHitType: "stale_empty_local"
          },
          latency: { cacheMs: cacheElapsedMs, tavilyMs: tavilyElapsedMs, openAiMs: openAIElapsedMs, totalMs: Date.now() - requestStartedAt },
          callCounts: snapshotExternalCallCounts(externalCallCounts)
        });
        await recordSearchEvent({
          ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
          searchId: stale.id,
          consensusMode: stale.mode,
          cacheHit: true,
          cacheHitType: "stale_empty_local",
          cacheVersion: stale.cacheVersion ?? null,
          totalMs: Date.now() - requestStartedAt,
          cacheMs: cacheElapsedMs,
          tavilyMs: tavilyElapsedMs,
          openAiMs: openAIElapsedMs
        });
        return await consensusJson(withHelpfulNoConsensusCopy(stale, body.data.query, evidenceType, queryIntent));
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
    consensus = withHelpfulNoConsensusCopy(consensus, body.data.query, evidenceType, queryIntent);
    updateTraceFromConsensus(trace, consensus, "final_before_cache");
    const cacheWriteStartedAt = Date.now();
    consensus = await cacheConsensus(consensus, externalCallCounts);
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
    updateTraceFromConsensus(trace, consensus, "final");
    updateConsensusTrace(trace, {
      cache: {
        status: "write_completed",
        cacheVersion: consensus.cacheVersion ?? getCacheVersion(),
        searchId: consensus.id,
        elapsedMs: cacheElapsedMs,
        cacheHitType: "miss"
      },
      latency: {
        cacheMs: cacheElapsedMs,
        tavilyMs: tavilyElapsedMs,
        filteringMs: filteringElapsedMs,
        openAiMs: openAIElapsedMs,
        cacheWriteMs: cacheWriteElapsedMs,
        totalMs: Date.now() - requestStartedAt
      },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      searchId: consensus.id,
      consensusMode: consensus.mode,
      cacheHit: false,
      cacheHitType: "miss",
      cacheVersion: consensus.cacheVersion ?? getCacheVersion(),
      totalMs: Date.now() - requestStartedAt,
      cacheMs: cacheElapsedMs,
      tavilyMs: tavilyElapsedMs,
      openAiMs: openAIElapsedMs,
      cacheWriteMs: cacheWriteElapsedMs
    });
    return await consensusJson(consensus);
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
        updateTraceFromConsensus(trace, stale, "stale_error_fallback");
        updateConsensusTrace(trace, {
          cache: {
            status: "stale_hit",
            cacheVersion: stale.cacheVersion ?? null,
            searchId: stale.id,
            cacheHitType: "stale_error_fallback",
            error: error instanceof Error ? error.message : String(error)
          },
          latency: { cacheMs: cacheElapsedMs, totalMs: Date.now() - requestStartedAt },
          callCounts: snapshotExternalCallCounts(externalCallCounts)
        });
        await recordSearchEvent({
          ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
          searchId: stale.id,
          consensusMode: stale.mode,
          cacheHit: true,
          cacheHitType: "stale_error_fallback",
          cacheVersion: stale.cacheVersion ?? null,
          totalMs: Date.now() - requestStartedAt,
          cacheMs: cacheElapsedMs,
          error: error instanceof Error ? error.message : String(error)
        });
        return await consensusJson(withHelpfulNoConsensusCopy(stale, body.data.query, evidenceType, queryIntent));
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
    console.error("[vera:search] request failed", {
      normalizedQuery,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
    console.log("EXTERNAL_CALL_COUNTS", externalCallCounts);
    updateConsensusTrace(trace, {
      cache: { status: "error", cacheVersion: getCacheVersion(), cacheHitType: "error", error: error instanceof Error ? error.message : String(error) },
      latency: { cacheMs: cacheElapsedMs, totalMs: Date.now() - requestStartedAt },
      callCounts: snapshotExternalCallCounts(externalCallCounts)
    });
    await recordSearchEvent({
      ...baseSearchEvent(body.data.query, normalizedQuery, canonicalQuery, evidenceType, externalCallCounts),
      cacheHit: false,
      cacheHitType: "error",
      cacheVersion: getCacheVersion(),
      totalMs: Date.now() - requestStartedAt,
      cacheMs: cacheElapsedMs,
      error: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({ error: "Vera couldn't complete this search. Please try again." }, { status: 500 });
  }
}
}

function updateTraceFromConsensus(trace: ConsensusTrace | undefined, consensus: ConsensusResponse, source: string) {
  const structured = consensus.structuredConsensus;
  const extractionCandidates = structured?.localPlaceExtraction?.candidates ?? [];
  const rejectedEntities = extractionCandidates
    .filter((candidate) => !candidate.accepted)
    .map((candidate) => {
      const discardReason = localExtractionDiscard(candidate.rejectionReason, candidate.name, candidate.sourceUrl);
      return {
        name: candidate.name,
        sourceUrl: candidate.sourceUrl,
        sourceTitle: candidate.sourceTitle,
        status: "rejected" as const,
        discardReason,
        metadata: {
          extractionSource: candidate.extractionSource,
          confidence: candidate.confidence,
          rejectionReason: candidate.rejectionReason
        }
      };
    });
  const acceptedExtractionEntities = extractionCandidates
    .filter((candidate) => candidate.accepted)
    .map((candidate) => ({
      name: candidate.name,
      sourceUrl: candidate.sourceUrl,
      sourceTitle: candidate.sourceTitle,
      status: "accepted" as const,
      metadata: {
        extractionSource: candidate.extractionSource,
        confidence: candidate.confidence
      }
    }));
  const finalistEntities = consensus.results.map((result) => ({
    name: result.name,
    status: "finalist" as const,
    metadata: {
      rank: result.rank,
      consensusPercentage: result.consensusPercentage,
      verifiedAddress: result.verifiedAddress
    }
  }));
  const contenderMetrics: ContenderMetrics[] = structured?.contenders ?? consensus.results.flatMap((result) => (result.metrics ? [result.metrics] : []));
  const aggregationEntrants = contenderMetrics
    .map((metrics) => ({
      name: metrics.name,
      status: "entered_aggregation" as const,
      metadata: {
        sourceCount: metrics.sourceCount,
        positiveMentionCount: metrics.positiveMentionCount,
        negativeMentionCount: metrics.negativeMentionCount,
        netWeightedScore: metrics.netWeightedScore,
        localFinalScore: metrics.localRanking?.finalScore
      }
    }));

  for (const entity of rejectedEntities) {
    if (entity.discardReason) addConsensusDiscard(trace, entity.discardReason);
  }

  updateConsensusTrace(trace, {
    retainedSources: trace?.retainedSources.length ? trace.retainedSources : consensus.sources.map(toTraceSource),
    extractedSignals: structured?.signals ?? [],
    candidateEntities: mergeTraceEntities(trace?.candidateEntities ?? [], [...acceptedExtractionEntities, ...rejectedEntities, ...aggregationEntrants, ...finalistEntities]),
    validationOutcomes: mergeTraceEntities(trace?.validationOutcomes ?? [], [...acceptedExtractionEntities, ...rejectedEntities, ...finalistEntities]),
    acceptedEntities: mergeTraceEntities(trace?.acceptedEntities ?? [], [...acceptedExtractionEntities, ...finalistEntities]),
    rejectedEntities: mergeTraceEntities(trace?.rejectedEntities ?? [], rejectedEntities),
    downgradedEntities: trace?.downgradedEntities ?? [],
    aggregationEntrants,
    contenderScores: contenderMetrics.map((metrics) => ({
      name: metrics.name,
      netWeightedScore: metrics.netWeightedScore,
      weightedPositiveScore: metrics.weightedPositiveScore,
      weightedNegativeScore: metrics.weightedNegativeScore,
      sourceCount: metrics.sourceCount,
      positiveMentionCount: metrics.positiveMentionCount,
      negativeMentionCount: metrics.negativeMentionCount,
      localFinalScore: metrics.localRanking?.finalScore,
      localBaseScore: metrics.localRanking?.baseScore,
      metrics
    })),
    classification: {
      mode: consensus.mode,
      resultNames: consensus.results.map((result) => result.name),
      resultCount: consensus.results.length,
      rationale: structured?.confidenceReasoning ?? consensus.explanation,
      source,
      decisionPath: trace?.classification?.decisionPath
    },
    unavailable: [
      "Some fallback consensus builders do not expose the same classifier internals as the main analyzer path."
    ]
  });
}

function updateTraceFromAnalyzeDiagnostics(trace: ConsensusTrace | undefined, diagnostics: ReturnType<typeof createAnalyzeDiagnostics> | undefined) {
  if (!diagnostics) return;

  const rejectedEntities = diagnostics.entityValidationDiagnostics
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => ({
      name: outcome.originalName,
      sourceUrl: outcome.sourceUrl,
      status: "rejected" as const,
      discardReason: {
        stage: outcome.validator,
        code: outcome.reasonCode,
        message: String(outcome.metadata?.reason ?? outcome.metadata?.rejectionReason ?? outcome.reasonCode),
        contenderName: outcome.originalName,
        sourceUrl: outcome.sourceUrl,
        metadata: outcome.metadata
      }
    }));
  const acceptedEntities = diagnostics.entityValidationDiagnostics
    .filter((outcome) => outcome.status === "accepted")
    .map((outcome) => ({
      name: outcome.canonicalName ?? outcome.originalName,
      sourceUrl: outcome.sourceUrl,
      status: "accepted" as const,
      metadata: {
        validator: outcome.validator,
        originalName: outcome.originalName,
        ...outcome.metadata
      }
    }));
  const downgradedEntities = diagnostics.entityValidationDiagnostics
    .filter((outcome) => outcome.status === "downgraded")
    .map((outcome) => ({
      name: outcome.canonicalName ?? outcome.originalName,
      sourceUrl: outcome.sourceUrl,
      status: "downgraded" as const,
      metadata: {
        validator: outcome.validator,
        reasonCode: outcome.reasonCode,
        originalName: outcome.originalName,
        ...outcome.metadata
      }
    }));
  const cleanupDiscards: DiscardReason[] = diagnostics.cleanupDiagnostics.map((cleanup) => ({
    stage: cleanup.stage,
    code: cleanup.reasonCode,
    message: cleanup.message,
    contenderName: cleanup.contenderName,
    metadata: cleanup.metadata
  }));

  for (const entity of rejectedEntities) {
    addConsensusDiscard(trace, entity.discardReason);
  }
  for (const discard of cleanupDiscards) {
    addConsensusDiscard(trace, discard);
  }

  updateConsensusTrace(trace, {
    entityResolutionDiagnostics: diagnostics.entityResolutionDiagnostics,
    entityValidationDiagnostics: diagnostics.entityValidationDiagnostics,
    validationOutcomes: mergeTraceEntities(trace?.validationOutcomes ?? [], [...acceptedEntities, ...rejectedEntities, ...downgradedEntities]),
    acceptedEntities: mergeTraceEntities(trace?.acceptedEntities ?? [], acceptedEntities),
    rejectedEntities: mergeTraceEntities(trace?.rejectedEntities ?? [], rejectedEntities),
    downgradedEntities: mergeTraceEntities(trace?.downgradedEntities ?? [], downgradedEntities),
    cleanupDiagnostics: diagnostics.cleanupDiagnostics,
    finalCleanupRemovals: cleanupDiscards,
    classification: diagnostics.classificationDecision
      ? {
          ...(trace?.classification ?? {
            mode: diagnostics.classificationDecision.finalClassification,
            resultNames: [],
            resultCount: 0
          }),
          decisionPath: diagnostics.classificationDecision
        }
      : trace?.classification
  });
}

function mergeTraceEntities<T extends { name: string; status?: string; sourceUrl?: string }>(existing: T[], next: T[]) {
  const merged = [...existing];
  const keys = new Set(existing.map((item) => `${item.status ?? ""}|${item.name}|${item.sourceUrl ?? ""}`));

  for (const item of next) {
    const key = `${item.status ?? ""}|${item.name}|${item.sourceUrl ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(item);
  }

  return merged;
}

function localExtractionDiscard(reason: string | undefined, contenderName: string, sourceUrl: string): DiscardReason {
  return {
    stage: "local_place_extraction",
    code: mapDiscardReasonCode(reason),
    message: reason ?? "Local place extraction rejected this candidate without a structured reason.",
    contenderName,
    sourceUrl,
    metadata: { rawReason: reason ?? null }
  };
}

function toTraceSource(source: ConsensusResponse["sources"][number]) {
  return {
    title: source.title,
    url: source.url,
    domain: source.domain,
    queryVariant: source.queryVariant,
    relevanceScore: source.relevanceScore,
    supportingContender: source.supportingContender
  };
}

function snapshotExternalCallCounts(externalCallCounts: ReturnType<typeof createExternalCallCounts>) {
  return {
    supabaseReads: externalCallCounts.supabaseReads,
    tavilyCalls: externalCallCounts.tavilyCalls,
    openAiCalls: externalCallCounts.openAiCalls,
    placesApiCalls: externalCallCounts.placesApiCalls,
    placesCacheHits: externalCallCounts.placesCacheHits,
    placesValidationAttempts: externalCallCounts.placesValidationAttempts,
    placesValidationsSucceeded: externalCallCounts.placesValidationsSucceeded,
    placesValidationsRejected: externalCallCounts.placesValidationsRejected,
    supabaseWrites: externalCallCounts.supabaseWrites,
    tavilyCallReasons: externalCallCounts.tavilyCallReasons,
    openAiCallReasons: externalCallCounts.openAiCallReasons,
    finalVerifiedPlacesContenders: externalCallCounts.finalVerifiedPlacesContenders
  };
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

function vagueRecommendationGuardExplanation(query: string, evidenceType: ReturnType<typeof inferQueryEvidenceType>) {
  if (evidenceType === "local_recommendation" && isVagueLocalQueryWithoutLocation(query)) {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (evidenceType === "destination_recommendation" && isVagueHiddenDestinationQueryWithoutGeography(query)) {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (evidenceType === "product_recommendation" && isVagueUnknownProductQuery(query)) {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  return null;
}

function withHelpfulNoConsensusCopy(
  consensus: ConsensusResponse,
  query: string,
  evidenceType: ReturnType<typeof inferQueryEvidenceType>,
  queryIntent: ReturnType<typeof inferQueryIntent>
): ConsensusResponse {
  if (consensus.mode !== "no_reliable_consensus") {
    return consensus;
  }

  return {
    ...consensus,
    explanation: consensus.results.length
      ? noClearConsensusWithContendersExplanation(consensus)
      : noConsensusExplanationForQuery(query, evidenceType, queryIntent)
  };
}

function noClearConsensusWithContendersExplanation(consensus: ConsensusResponse) {
  const names = naturalList(consensus.results.slice(0, 5).map((result) => result.name));
  return `The available evidence does not support a single winner. Vera found recurring support for ${names}, but the evidence is not strong or consistent enough to confidently declare one best choice.`;
}

function naturalList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function noConsensusExplanationForQuery(query: string, evidenceType: ReturnType<typeof inferQueryEvidenceType>, queryIntent: ReturnType<typeof inferQueryIntent>) {
  if (isUnsupportedAdultLocalCategory(query)) {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (queryIntent === "negative_avoidance" || queryIntent === "reliability_risk") {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (evidenceType === "local_recommendation") {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (evidenceType === "destination_recommendation") {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (evidenceType === "product_recommendation" || evidenceType === "provider_or_brand_recommendation" || evidenceType === "software_tool") {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  return consensusFallbackNoConsensusExplanation();
}

function consensusFallbackNoConsensusExplanation() {
  return NO_RELIABLE_CONSENSUS_BODY;
}

function isUnsupportedAdultLocalCategory(query: string) {
  const normalized = normalizeQuery(query);
  return /\b(sex shops?|adult stores?|sex toy shops?|sex toys?|erotic massage|strip clubs?|adult entertainment|adult shop|adult bookstore)\b/.test(normalized);
}

function isVagueLocalQueryWithoutLocation(query: string) {
  const normalized = normalizeQuery(query);

  if (/\b(?:near me|in|near|around|on|at)\b/.test(normalized) || /\b\d{5}(?:\s*-\s*\d{4})?\b/.test(normalized)) {
    return false;
  }

  if (
    !/\b(?:restaurant|restaurants|coffee shop|coffee shops|coffee|cafe|cafes|barber|barbers|barber shop|barber shops|gym|gyms|doctor|doctors|dentist|dentists|plumber|plumbers|tattoo shop|tattoo shops|salon|salons|spa|spas|bakery|bakeries|bar|bars|hotel|hotels)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  return !/\b(?:nyc|new york|queens|brooklyn|manhattan|bronx|staten island|astoria|long island|wantagh|seaford|massapequa|huntington|williamsburg|tampa|rome|portugal|europe)\b/.test(
    normalized
  );
}

function isVagueHiddenDestinationQueryWithoutGeography(query: string) {
  const normalized = normalizeQuery(query);

  if (!/\b(?:unknown|hidden gem|hidden gems|secret|underrated|no one talks about|nobody talks about)\b/.test(normalized)) {
    return false;
  }

  if (!/\b(?:island|islands|beach|beaches|destination|destinations|trip|trips|place|places|town|towns|region|regions)\b/.test(normalized)) {
    return false;
  }

  return !/\b(?:in|near|around|from|to|within)\b.+\b[a-z]{3,}\b/.test(normalized);
}

function isVagueUnknownProductQuery(query: string) {
  const normalized = normalizeQuery(query);

  if (!/\b(?:unknown|hidden gem|hidden gems|secret|underrated|no one talks about|nobody talks about)\b/.test(normalized)) {
    return false;
  }

  if (!/\b(?:product|products|thing|things|item|items|buy|purchase)\b/.test(normalized)) {
    return false;
  }

  return !/\b(?:headphones|laptop|router|mouse|keyboard|suitcase|luggage|shoes|running shoes|air purifier|robot vacuum|mattress|camera|monitor|backpack|phone|car|vehicle)\b/.test(
    normalized
  );
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
    cacheVersion: getCacheVersion(query),
    cached,
    cacheHit,
    abortedBeforeLiveSearch,
    counts: {
      supabaseReads: externalCallCounts.supabaseReads,
      tavilyCalls: externalCallCounts.tavilyCalls,
      openAiCalls: externalCallCounts.openAiCalls,
      placesApiCalls: externalCallCounts.placesApiCalls,
      placesCacheHits: externalCallCounts.placesCacheHits,
      placesValidationAttempts: externalCallCounts.placesValidationAttempts,
      placesValidationsSucceeded: externalCallCounts.placesValidationsSucceeded,
      placesValidationsRejected: externalCallCounts.placesValidationsRejected,
      supabaseWrites: externalCallCounts.supabaseWrites
    },
    tavilyCallReasons: externalCallCounts.tavilyCallReasons,
    openAiCallReasons: externalCallCounts.openAiCallReasons,
    finalVerifiedPlacesContenders: externalCallCounts.finalVerifiedPlacesContenders,
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

function baseSearchEvent(
  originalQuery: string,
  normalizedQuery: string,
  canonicalQuery: string,
  evidenceType: ReturnType<typeof inferQueryEvidenceType>,
  externalCallCounts: ReturnType<typeof createExternalCallCounts>
) {
  return {
    originalQuery,
    normalizedQuery,
    canonicalQuery,
    evidenceType,
    tavilyCalls: externalCallCounts.tavilyCalls,
    openAiCalls: externalCallCounts.openAiCalls,
    placesApiCalls: externalCallCounts.placesApiCalls,
    placesCacheHits: externalCallCounts.placesCacheHits,
    placesValidationAttempts: externalCallCounts.placesValidationAttempts
  };
}

async function consensusJson(consensus: ConsensusResponse) {
  return NextResponse.json(await attachPostDecisionActions(consensus));
}
