import type { VeraSource } from "@/lib/types";
import {
  domainFromUrl,
  evidenceStrategyFor,
  inferQueryEvidenceType,
  isSpecializedDominantPlatformQuery,
  normalizeLocalQueryIntent,
  parseLocalIntent,
  parseLocalQueryConstraints
} from "@/lib/utils";
import type { ExternalCallCounts } from "@/lib/server/external-call-counts";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

const maxTavilyCallsPerRequest = 2;
const maxLocalTavilyCallsPerRequest = 3;
const maxLocalNamedDiscoveryCalls = 2;
const maxLocalSparseRecoveryCalls = 2;
const maxLocalTotalTavilyCallsPerRequest = 6;
const tavilyTimeoutMs = 6000;
const tavilyRetryDelayMs = 350;
const maxLocalEnrichmentPages = 3;
const localEnrichmentPageTimeoutMs = 2500;
const maxLocalEnrichedTextChars = 2400;

export type SearchPublicWebTimings = {
  tavilyMs: number;
  filteringMs: number;
};

export async function searchPublicWeb(query: string, callCounts?: ExternalCallCounts, timings?: SearchPublicWebTimings): Promise<VeraSource[]> {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    throw new Error("TAVILY_API_KEY is required to search real public sources.");
  }

  const startedAt = Date.now();
  let tavilyMs = 0;
  const evidenceType = inferQueryEvidenceType(query);
  const effectiveQuery = evidenceType === "local_recommendation" ? normalizeLocalQueryIntent(query) : query;
  const tavilyCallsBefore = callCounts?.tavilyCalls ?? 0;
  const tavilyCallLimit = evidenceType === "local_recommendation" ? maxLocalTavilyCallsPerRequest : maxTavilyCallsPerRequest;
  const variants = buildSearchVariants(effectiveQuery);
  const guardedVariants = variants.slice(0, tavilyCallLimit);

  if (variants.length > tavilyCallLimit) {
    console.warn("[vera:sources] Tavily variant cap applied", {
      query,
      requestedVariants: variants.length,
      usedVariants: guardedVariants.length
    });
  }

  const variantsToFetch = [];

  for (const variant of guardedVariants) {
    if (callCounts && callCounts.tavilyCalls + variantsToFetch.length >= tavilyCallLimit) {
      console.warn("[vera:sources] Tavily hard guard skipped extra search", {
        query,
        variant,
        tavilyCalls: callCounts.tavilyCalls + variantsToFetch.length,
        maxTavilyCallsPerRequest: tavilyCallLimit
      });
      continue;
    }

    variantsToFetch.push(variant);
  }

  const settledResponses = await Promise.allSettled(
    variantsToFetch.map((variant) =>
      searchVariantWithRetry(variant, key, callCounts, {
        retry: false
      })
    )
  );
  const failures = settledResponses.filter((response) => response.status === "rejected");

  if (failures.length) {
    console.warn("[vera:sources] Tavily lane failures", {
      query,
      failedLanes: failures.length,
      totalLanes: settledResponses.length,
      errors: failures.map((failure) => (failure.status === "rejected" && failure.reason instanceof Error ? failure.reason.message : String(failure)))
    });
  }

  const responses = settledResponses.flatMap((response) => (response.status === "fulfilled" ? [response.value] : []));

  if (responses.length === 0 && failures.length > 0 && evidenceType !== "local_recommendation") {
    const firstFailure = failures[0];
    throw firstFailure.status === "rejected" && firstFailure.reason instanceof Error ? firstFailure.reason : new Error("All Tavily retrieval lanes failed.");
  }

  let namedDiscoveryResponses: VeraSource[][] = [];

  if (evidenceType === "local_recommendation" && shouldRunLocalNamedCandidateDiscovery(effectiveQuery, responses.flat())) {
    namedDiscoveryResponses = await runLocalNamedCandidateDiscovery(effectiveQuery, key, callCounts);
  }

  tavilyMs = Date.now() - startedAt;
  const filteringStartedAt = Date.now();
  const rawSources = [...responses.flat(), ...namedDiscoveryResponses.flat()];
  const dedupedSources = dedupeSources(rawSources);
  const filteredSources = filterSources(dedupedSources);
  const balancedSources = reduceDuplicateDomains(filteredSources).slice(0, evidenceType === "local_recommendation" ? 28 : 18);
  const finalSources = evidenceType === "local_recommendation" ? await enrichLocalAuthoritySources(effectiveQuery, balancedSources) : balancedSources;
  const filteringMs = Date.now() - filteringStartedAt;

  if (timings) {
    timings.tavilyMs = tavilyMs;
    timings.filteringMs = filteringMs;
  }

  console.log("[vera:sources] source pipeline", {
    query,
    variants: variants.length,
    tavilyResults: rawSources.length,
    afterUrlDedupe: dedupedSources.length,
    afterFiltering: filteredSources.length,
    afterDomainBalancing: balancedSources.length,
    afterEnrichment: finalSources.length,
    openAIInput: finalSources.length,
    tavilyMs,
    filteringMs,
    elapsedMs: Date.now() - startedAt,
    domains: domainCounts(finalSources)
  });
  console.log("TAVILY_CALL_COUNT", {
    evidenceType,
    phase: "initial_retrieval",
    calls: (callCounts?.tavilyCalls ?? 0) - tavilyCallsBefore,
    total: callCounts?.tavilyCalls ?? 0,
    limit: tavilyCallLimit
  });

  return finalSources;
}

async function enrichLocalAuthoritySources(query: string, sources: VeraSource[]) {
  const candidates = sources
    .filter(isHighAuthorityLocalPage)
    .filter((source) => localSourceMatchesRequestedGeography(query, source))
    .sort((a, b) => localEnrichmentSourceScore(b) - localEnrichmentSourceScore(a))
    .slice(0, maxLocalEnrichmentPages);

  console.log("LOCAL_CONTENT_ENRICHMENT_ATTEMPTED", {
    query,
    candidateCount: candidates.length,
    urls: candidates.map((source) => source.url)
  });

  if (!candidates.length) {
    console.log("LOCAL_ENRICHED_SOURCE_COUNT", { query, count: 0 });
    return sources;
  }

  const enrichedByUrl = new Map<string, VeraSource>();
  const settled = await Promise.allSettled(candidates.map((source) => enrichLocalSource(source)));

  for (const response of settled) {
    if (response.status === "fulfilled" && response.value) {
      enrichedByUrl.set(response.value.url, response.value);
    }
  }

  console.log("LOCAL_ENRICHED_SOURCE_COUNT", {
    query,
    count: enrichedByUrl.size
  });

  return sources.map((source) => enrichedByUrl.get(source.url) ?? source);
}

async function enrichLocalSource(source: VeraSource): Promise<VeraSource | null> {
  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VeraConsensusBot/1.0; +https://vera.app)",
        Accept: "text/html,application/xhtml+xml"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(localEnrichmentPageTimeoutMs)
    });

    if (!response.ok) {
      console.log("LOCAL_CONTENT_ENRICHMENT_FAILED", {
        url: source.url,
        domain: source.domain,
        status: response.status
      });
      return { ...source, enrichmentFailed: true };
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      console.log("LOCAL_CONTENT_ENRICHMENT_FAILED", {
        url: source.url,
        domain: source.domain,
        reason: "non_html",
        contentType
      });
      return { ...source, enrichmentFailed: true };
    }

    const html = await response.text();
    const extracted = extractLocalArticleText(html);
    const enrichedText = extracted.visibleText.slice(0, maxLocalEnrichedTextChars).trim();
    const enrichedBodyText = extracted.bodyText.slice(0, maxLocalEnrichedTextChars).trim();

    if (enrichedText.length < 160) {
      console.log("LOCAL_CONTENT_ENRICHMENT_FAILED", {
        url: source.url,
        domain: source.domain,
        reason: "too_little_text",
        chars: enrichedText.length
      });
      return { ...source, enrichmentFailed: true };
    }

    console.log("LOCAL_CONTENT_ENRICHMENT_SUCCESS", {
      url: source.url,
      domain: source.domain,
      title: source.title,
      chars: enrichedText.length
    });
    console.log("LOCAL_ENRICHED_TEXT_CHARS", {
      url: source.url,
      chars: enrichedText.length
    });

    return {
      ...source,
      enriched: true,
      enrichedText,
      enrichedBodyText: enrichedBodyText || enrichedText,
      snippet: mergeSnippetWithEnrichedText(source.snippet, enrichedText)
    };
  } catch (error) {
    console.log("LOCAL_CONTENT_ENRICHMENT_FAILED", {
      url: source.url,
      domain: source.domain,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ...source, enrichmentFailed: true };
  }
}

function mergeSnippetWithEnrichedText(snippet: string | undefined, enrichedText: string) {
  const existing = snippet?.trim();

  if (!existing) return enrichedText;

  return `${existing}\n\n${enrichedText}`.slice(0, maxLocalEnrichedTextChars + 520);
}

function extractLocalArticleText(html: string) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<(h[1-4]|li|p|title|article|section|div)\b[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const lines = withoutNoise
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&[a-z0-9#]+;/gi, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2 && !/^(?:menu|search|subscribe|newsletter|advertisement|log in|sign in)$/i.test(line));

  const visibleLines = Array.from(new Set(lines));
  const bodyLines = trimToEditorialBody(visibleLines);

  console.log("LOCAL_BODY_MATCH", {
    totalLines: visibleLines.length,
    bodyLines: bodyLines.length,
    bodyChars: bodyLines.join("\n").length
  });

  return {
    visibleText: visibleLines.join("\n"),
    bodyText: bodyLines.join("\n")
  };
}

function trimToEditorialBody(lines: string[]) {
  const startIndex = Math.max(
    0,
    lines.findIndex((line) =>
      /\b(the\s+\d+\s+best|best\s+.+\s+in|where to|essential|restaurants?|hotels?|coffee|pizza|brunch|bars?|attractions?|things to do|our favorite|editors?'? picks?)\b/i.test(
        line
      )
    )
  );
  const relatedIndex = lines.findIndex((line, index) => index > startIndex && isRelatedOrFooterLine(line));
  const endIndex = relatedIndex > startIndex ? relatedIndex : lines.length;

  if (relatedIndex > startIndex) {
    console.log("LOCAL_RELATED_CONTENT_REJECTED", {
      marker: lines[relatedIndex],
      removedLines: lines.length - relatedIndex
    });
  }

  return lines
    .slice(startIndex, endIndex)
    .filter((line) => !isRelatedOrFooterLine(line))
    .slice(0, 140);
}

function isRelatedOrFooterLine(line: string) {
  return /\b(related|more from|more in|read next|recommended stories|latest|newsletter|subscribe|sign up|advertisement|sponsored|partner content|footer|follow us|share this|comments?|most popular|nearby|you might also like|around the web)\b/i.test(
    line
  );
}

function isHighAuthorityLocalPage(source: VeraSource) {
  const value = `${source.domain} ${source.title} ${source.url}`.toLowerCase();

  return /\b(eater|infatuation|thevendry|timeout|time.?out|tripadvisor|yelp|booking|opentable|resy|michelin|cntraveler|conde.?nast|travelandleisure|travel.?leisure|seattlemet|nymag|new.?york.?magazine|golfdigest|golfweek|healthgrades|zocdoc|angi|homeadvisor|tourism|visit)\b/.test(
    value
  );
}

function localSourceMatchesRequestedGeography(query: string, source: VeraSource) {
  const context = localRetrievalContext(query);
  const location = context.location.toLowerCase();

  if (!location) return true;

  const text = `${source.domain} ${source.title} ${source.url} ${source.snippet ?? ""}`.toLowerCase();
  const normalizedText = text.replace(/[^a-z0-9\s]/g, " ");

  const outsidePatterns = localOutsideGeographyPatterns(location);
  const insidePatterns = localInsideGeographyPatterns(location);

  if (!outsidePatterns.length) return true;
  if (insidePatterns.some((pattern) => pattern.test(normalizedText))) return true;

  const outsideMatch = outsidePatterns.some((pattern) => pattern.test(normalizedText));

  if (outsideMatch) {
    console.log("LOCAL_CONTENT_ENRICHMENT_SKIPPED_GEOGRAPHY", {
      query,
      url: source.url,
      title: source.title,
      location: context.location
    });
  }

  return !outsideMatch;
}

function localEnrichmentSourceScore(source: VeraSource) {
  const value = `${source.domain} ${source.title} ${source.url}`.toLowerCase();
  const editorialBoost = /\b(eater|infatuation|thevendry|timeout|time.?out|michelin|cntraveler|conde.?nast|travelandleisure|travel.?leisure|seattlemet|nymag|new.?york.?magazine|golfdigest|golfweek)\b/.test(
    value
  )
    ? 8
    : 0;
  const tourismBoost = /\b(tourism|visit|official)\b/.test(value) ? 5 : 0;
  const reviewPlatformBoost = /\b(tripadvisor|booking|opentable|resy|healthgrades|zocdoc|angi|homeadvisor)\b/.test(value) ? 3 : 0;
  const yelpPenalty = /\byelp\b/.test(value) ? 5 : 0;
  const listPageBoost = /\b(best|top|guide|list|where to|right now|hit list|restaurants?|hotels?|attractions?|things to do)\b/.test(value) ? 2 : 0;

  return editorialBoost + tourismBoost + reviewPlatformBoost + listPageBoost - yelpPenalty;
}

export async function recoverLocalSparseSources(query: string, existingSources: VeraSource[], callCounts?: ExternalCallCounts): Promise<VeraSource[]> {
  if (inferQueryEvidenceType(query) !== "local_recommendation") {
    return existingSources;
  }

  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return existingSources;
  }

  const context = localRecoveryContext(query);
  const tavilyCallsBefore = callCounts?.tavilyCalls ?? 0;
  const remainingLocalCalls = Math.max(0, maxLocalTotalTavilyCallsPerRequest - (callCounts?.tavilyCalls ?? 0));
  const variants = buildLocalSparseRecoveryVariants(query, context).slice(0, Math.min(maxLocalSparseRecoveryCalls, remainingLocalCalls));
  console.log("LOCAL_SPARSE_RECOVERY_TRIGGERED", {
    query,
    existingSourceCount: existingSources.length,
    category: context.category,
    location: context.location,
    recoveryQueries: variants.length
  });

  if (!variants.length) {
    console.log("LOCAL_SPARSE_RECOVERY_FINAL_COUNT", {
      query,
      recoveredRawSources: 0,
      existingSourceCount: existingSources.length,
      mergedSourceCount: existingSources.length,
      skipped: "local_tavily_budget_exhausted"
    });
    return existingSources;
  }

  for (const variant of variants) {
    console.log("LOCAL_SPARSE_RECOVERY_QUERY", variant);
  }

  const settledResponses = await Promise.allSettled(variants.map((variant) => searchVariantWithRetry(variant, key, callCounts, { retry: false })));
  const recoveredSources = settledResponses.flatMap((response) => (response.status === "fulfilled" ? response.value : []));
  const failures = settledResponses.filter((response) => response.status === "rejected");

  if (failures.length) {
    console.warn("[vera:sources] local sparse recovery lane failures", {
      query,
      failedLanes: failures.length,
      totalLanes: settledResponses.length,
      errors: failures.map((failure) => (failure.status === "rejected" && failure.reason instanceof Error ? failure.reason.message : String(failure)))
    });
  }

  const merged = reduceDuplicateDomains(filterSources(dedupeSources([...existingSources, ...recoveredSources]))).slice(0, 34);
  console.log("LOCAL_SPARSE_RECOVERY_FINAL_COUNT", {
    query,
    recoveredRawSources: recoveredSources.length,
    existingSourceCount: existingSources.length,
    mergedSourceCount: merged.length
  });
  console.log("TAVILY_CALL_COUNT", {
    evidenceType: "local_recommendation",
    phase: "local_sparse_recovery",
    calls: (callCounts?.tavilyCalls ?? 0) - tavilyCallsBefore,
    total: callCounts?.tavilyCalls ?? 0,
    limit: maxLocalTotalTavilyCallsPerRequest
  });

  return merged;
}

async function runLocalNamedCandidateDiscovery(query: string, key: string, callCounts?: ExternalCallCounts): Promise<VeraSource[][]> {
  const remainingLocalCalls = Math.max(0, maxLocalTotalTavilyCallsPerRequest - (callCounts?.tavilyCalls ?? 0));
  const variants = buildLocalNamedCandidateVariants(query).slice(0, Math.min(maxLocalNamedDiscoveryCalls, remainingLocalCalls));

  console.log("LOCAL_NAMED_CANDIDATE_DISCOVERY", {
    query,
    variants,
    remainingLocalCalls
  });

  if (!variants.length) {
    return [];
  }

  const settledResponses = await Promise.allSettled(variants.map((variant) => searchVariantWithRetry(variant, key, callCounts, { retry: false })));
  const failures = settledResponses.filter((response) => response.status === "rejected");

  if (failures.length) {
    console.warn("[vera:sources] local named-candidate lane failures", {
      query,
      failedLanes: failures.length,
      totalLanes: settledResponses.length,
      errors: failures.map((failure) => (failure.status === "rejected" && failure.reason instanceof Error ? failure.reason.message : String(failure)))
    });
  }

  return settledResponses.flatMap((response) => (response.status === "fulfilled" ? [response.value] : []));
}

function shouldRunLocalNamedCandidateDiscovery(query: string, initialSources: VeraSource[]) {
  const context = localRetrievalContext(query);
  const cleanCandidateCount = countCleanLocalCandidateSources(query, initialSources);
  const majorMarket = isMajorEditorialLocalMarket(context.location);
  const shouldRun = majorMarket || cleanCandidateCount < 3;

  console.log("LOCAL_NAMED_CANDIDATE_DISCOVERY_DECISION", {
    query,
    location: context.location,
    majorMarket,
    cleanCandidateCount,
    shouldRun
  });

  return shouldRun;
}

function countCleanLocalCandidateSources(query: string, sources: VeraSource[]) {
  const keys = new Set<string>();

  for (const source of sources) {
    const candidates = [
      localSourceBusinessNameFromUrl(source.url),
      localSourceBusinessNameFromTitle(source.title)
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      const key = cheapLocalBusinessKey(candidate);

      if (!key || isCheapLocalGenericCandidate(query, key)) continue;
      keys.add(key);
    }
  }

  return keys.size;
}

function localSourceBusinessNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const bizIndex = segments.findIndex((segment) => segment.toLowerCase() === "biz");
    const selected = bizIndex >= 0 ? segments[bizIndex + 1] : segments.at(-1);

    if (!selected) return "";

    return decodeURIComponent(selected)
      .replace(/\.(html?|php)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function localSourceBusinessNameFromTitle(title: string) {
  return title
    .replace(/\s+[-–—|:]\s+.*$/g, "")
    .replace(/\b(?:updated|reviewed)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)?\s*\d{4}\b/gi, "")
    .replace(/\b(?:reviews?|reservations?|menu|photos?|ratings?|near me|official site|comments?|threads?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cheapLocalBusinessKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(?:restaurant|restaurants|cafe|coffee shop|hotel|inn|pizzeria|pizza|italian|seafood|sushi|brunch|bar|reviews?|review|menu|reservations?|official|site|wantagh|seaford|massapequa|huntington|delray|beach|ny|new york|long island)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isCheapLocalGenericCandidate(query: string, key: string) {
  const normalizedQuery = query.toLowerCase();

  if (!key || key.length < 3) return true;
  if (/^(?:best|top|where|guide|local|near|food|restaurant|restaurants|pizza|sushi|coffee|bar|hotel|reddit|yelp|tripadvisor|google|maps|eater|infatuation)$/.test(key)) return true;
  if (normalizedQuery.includes(key) && key.split(/\s+/).length <= 2) return true;
  return false;
}

function isMajorEditorialLocalMarket(location: string) {
  const normalized = location.toLowerCase();

  return /\b(nyc|new york city|new york|manhattan|brooklyn|williamsburg|los angeles|san francisco|chicago|seattle|austin|miami|boston|washington dc|philadelphia|new orleans|las vegas)\b/.test(
    normalized
  );
}

async function searchVariantWithRetry(
  queryVariant: string,
  key: string,
  callCounts?: ExternalCallCounts,
  options: { retry?: boolean } = { retry: true }
): Promise<VeraSource[]> {
  try {
    return await searchVariant(queryVariant, key, callCounts);
  } catch (error) {
    if (!options.retry || !isRetryableTavilyError(error)) {
      throw error;
    }

    console.warn("[vera:sources] Tavily retrieval failed; retrying once", {
      queryVariant,
      error: error instanceof Error ? error.message : String(error)
    });
    await sleep(tavilyRetryDelayMs);
    return searchVariant(queryVariant, key, callCounts);
  }
}

async function searchVariant(queryVariant: string, key: string, callCounts?: ExternalCallCounts): Promise<VeraSource[]> {
  const evidenceType = inferQueryEvidenceType(queryVariant);
  if (callCounts) {
    callCounts.tavilyCalls += 1;
    callCounts.tavilyCallReasons.push({
      evidenceType,
      queryVariant,
      phase: "tavily_search"
    });
  }
  console.log("TAVILY_CALL_REASON", {
    evidenceType,
    queryVariant,
    phase: "tavily_search",
    callNumber: callCounts?.tavilyCalls ?? null
  });

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-API-Key": key
    },
    body: JSON.stringify({
      query: queryVariant,
      search_depth: "advanced",
      include_answer: false,
      include_raw_content: false,
      max_results: evidenceType === "local_recommendation" ? 10 : 24
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(tavilyTimeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new TavilySearchError(response.status, `Tavily search failed with ${response.status}. ${detail || "No response body returned."}`);
  }

  const body = (await response.json()) as { results?: TavilyResult[] };

  return (body.results ?? [])
    .filter((item): item is Required<Pick<TavilyResult, "title" | "url">> & TavilyResult => Boolean(item.title && item.url))
    .map((item) => ({
      title: item.title,
      url: item.url,
      domain: domainFromUrl(item.url),
      snippet: item.content?.slice(0, 520),
      queryVariant,
      canonicalUrl: canonicalizeUrl(item.url)
    }));
}

class TavilySearchError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "TavilySearchError";
  }
}

function isRetryableTavilyError(error: unknown) {
  if (error instanceof TavilySearchError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError" || /fetch failed|network|timeout/i.test(error.message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchVariants(query: string) {
  const evidenceType = inferQueryEvidenceType(query);
  const variants = evidenceType === "local_recommendation" ? buildLocalSearchVariants(query) : [buildPrimarySearchQuery(query)];

  return variants
    .map((variant) => variant.trim())
    .filter(Boolean)
    .slice(0, evidenceType === "local_recommendation" ? maxLocalTavilyCallsPerRequest : maxTavilyCallsPerRequest);
}

function buildPrimarySearchQuery(query: string) {
  const evidenceType = inferQueryEvidenceType(query);

  if (evidenceType === "dominant_platform") {
    const specialized = isSpecializedDominantPlatformQuery(query);
    const strategyTerms = specialized
      ? "privacy alternatives independent secure expert comparison reviews recommendations"
      : "market share default usage most used dominant expert comparison alternatives reviews";

    console.log("QUERY_EVIDENCE_TYPE", evidenceType);
    console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
    return `${query} ${strategyTerms}`;
  }

  if (evidenceType === "product_recommendation") {
    const productQuery = normalizeProductSearchQuery(query);
    console.log("QUERY_EVIDENCE_TYPE", evidenceType);
    console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
    return `${productQuery} product reviews expert testing best overall rtings wirecutter pcmag techradar toms guide consumer reports reddit long term owner consensus`;
  }

  if (evidenceType === "destination_recommendation") {
    console.log("QUERY_EVIDENCE_TYPE", evidenceType);
    console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
    return `${query} travel guide recommendations official tourism tripadvisor reddit travel local guide conde nast traveler travel and leisure time out best places consensus`;
  }

  if (evidenceType === "provider_or_brand_recommendation") {
    console.log("QUERY_EVIDENCE_TYPE", evidenceType);
    console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
    return `${query} expert comparison customer satisfaction reliability service quality value industry rankings consumer reports reddit discussion consensus`;
  }

  if (evidenceType === "local_recommendation") {
    console.log("QUERY_EVIDENCE_TYPE", evidenceType);
    console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
    return buildLocalSearchQuery(query);
  }

  console.log("QUERY_EVIDENCE_TYPE", evidenceType);
  console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
  return `${query} recommendations reviews reddit forum best comparison consensus`;
}

function buildLocalSearchQuery(query: string) {
  return buildLocalSearchVariants(query)[0] ?? query;
}

function buildLocalSearchVariants(query: string) {
  const context = localRetrievalContext(query);
  const category = context.category;
  const constraintPrefix = localConstraintRetrievalPrefix(context.constraints);
  const baseLocationQuery = context.location ? `${context.categoryLabel} ${context.location}` : query;
  const locationQuery = [constraintPrefix, baseLocationQuery].filter(Boolean).join(" ");
  const lanes = localRetrievalLanes(category);

  console.log("LOCAL_RETRIEVAL_CATEGORY", category);
  console.log("LOCAL_LOCATION_CONTEXT", context);
  console.log("LOCAL_QUERY_CONSTRAINTS", context.constraints);
  console.log("LOCAL_RETRIEVAL_VARIANTS", lanes.map((lane) => `${locationQuery} ${lane}`));

  return lanes.map((lane) => `${locationQuery} ${lane}`);
}

function localRetrievalCategory(normalized: string) {
  normalized = normalizeLocalQueryIntent(normalized);
  if (/\b(hotel|motel|inn|resort|lodging|place to stay)\b/.test(normalized)) return "hotel";
  if (/\b(coffee shop|coffee shops|coffee|cafe|cafes|café)\b/.test(normalized)) return "coffee";
  if (/\b(pizza|pizzeria)\b/.test(normalized)) return "pizza";
  if (/\b(brunch)\b/.test(normalized)) return "brunch";
  if (/\b(bakery|bakeries)\b/.test(normalized)) return "bakery";
  if (/\b(bar|bars|pub|cocktail|brewery|taproom|espresso martini|dirty martini|martini)\b/.test(normalized)) return "bar";
  if (/\b(gym|gyms|fitness)\b/.test(normalized)) return "gym";
  if (/\b(tattoo shop|tattoo shops|tattoo studio|tattoo studios|tattoo)\b/.test(normalized)) return "tattoo";
  if (/\b(dentist|dentists|dental)\b/.test(normalized)) return "dentist";
  if (/\b(plumber|plumbers|plumbing)\b/.test(normalized)) return "plumber";
  if (/\b(attraction|attractions|museum|landmark|things to do)\b/.test(normalized)) return "attraction";
  if (/\b(golf course|golf club)\b/.test(normalized)) return "golf_course";
  if (/\b(restaurant|restaurants|place to eat|dinner|lunch|ramen|sushi|tacos|italian|mexican|seafood|steakhouse|steak house)\b/.test(normalized)) return "restaurant";
  return "local_business";
}

function localRetrievalLanes(category: string) {
  if (category === "hotel") {
    return [
      "Booking.com hotels reviews",
      "TripAdvisor hotel reviews",
      "Google Maps hotel reviews",
      "Reddit travel hotel recommendations",
      "Conde Nast Traveler best hotels",
      "Travel + Leisure hotel guide"
    ];
  }

  if (category === "coffee") {
    return [
      "Google Maps coffee shop reviews",
      "Yelp coffee shops",
      "Reddit local coffee recommendations"
    ];
  }

  if (category === "bar") {
    return [
      "Yelp cocktail bar reviews",
      "Google Maps bar reviews",
      "Reddit local bar recommendations",
    ];
  }

  if (category === "attraction") {
    return [
      "official tourism attractions",
      "TripAdvisor attractions reviews",
      "Reddit travel things to do",
      "Google Maps attractions reviews",
      "local guide attractions"
    ];
  }

  if (category === "gym") {
    return ["Google Maps gym reviews", "Reddit local gyms", "Yelp gyms reviews", "fitness studio reviews"];
  }

  if (category === "tattoo") {
    return ["Google Maps tattoo shop reviews", "Yelp tattoo shop reviews", "Reddit local tattoo recommendations", "local tattoo studio reviews"];
  }

  if (category === "dentist") {
    return ["Google Maps dentist reviews", "Healthgrades dentists", "Zocdoc dentists", "Yelp dentists reviews"];
  }

  if (category === "plumber") {
    return ["Google Maps plumber reviews", "Angi plumbers reviews", "Yelp plumbers reviews", "HomeAdvisor plumbers"];
  }

  if (category === "pizza") {
    return ["Yelp pizzeria reviews", "Google Maps pizza reviews", "Reddit local pizza recommendations"];
  }

  if (category === "brunch") {
    return ["Yelp brunch reviews", "Google Maps brunch reviews", "Reddit local brunch recommendations"];
  }

  if (category === "bakery") {
    return ["Reddit local bakery recommendations", "Yelp bakeries reviews", "Google Maps bakery reviews", "Eater bakeries", "local magazine bakery guide"];
  }

  if (category === "golf_course") {
    return ["Golf Digest golf course rankings", "Golfweek best courses", "Reddit golf recommendations", "Google Maps golf course reviews", "TripAdvisor golf course reviews"];
  }

  if (category === "restaurant") {
    return [
      "Yelp restaurant reviews",
      "Google Maps restaurant reviews",
      "Reddit local restaurant recommendations"
    ];
  }

  return ["Reddit local recommendations", "Yelp reviews", "Google Maps reviews", "TripAdvisor reviews", "local guide best recommended"];
}

function localRecoveryContext(query: string) {
  const context = localRetrievalContext(query);

  return {
    category: context.category,
    categoryLabel: context.categoryLabel,
    location: context.location,
    constraints: context.constraints
  };
}

function localRetrievalContext(query: string) {
  const normalized = normalizeLocalQueryIntent(query);
  const parsedIntent = parseLocalIntent(query);
  const category = localRetrievalCategory(parsedIntent.category || normalized);
  const location = expandLocalLocation(parsedIntent.locationForSearch || extractLocalLocation(normalized));
  const constraints = parseLocalQueryConstraints(normalized);

  return {
    category,
    categoryLabel: localRecoveryCategoryLabel(category, normalized),
    location: location || "",
    constraints
  };
}

function localConstraintRetrievalPrefix(constraints: ReturnType<typeof parseLocalQueryConstraints>) {
  return Array.from(new Set(constraints.flatMap((constraint) => constraint.retrievalTerms))).slice(0, 4).join(" ");
}

function extractLocalLocation(normalized: string) {
  const locationMatch = normalized.match(/\b(?:in|near|around|on)\s+(.+?)$/);
  return (
    locationMatch?.[1]
      ?.replace(
        /\b(best|top|recommended|reviews?|reddit|yelp|tripadvisor|google maps|eater|infatuation|booking|opentable|restaurants?|bars?|coffee shops?|hotels?|cheap|affordable|budget|decent priced|reasonably priced|inexpensive|expensive|upscale|luxury|romantic|date night|casual|cozy|cosy|lively|quiet|rooftop|waterfront|outdoor seating|outdoor|patio|live music|sports bar|family friendly|kid friendly|dog friendly|pet friendly|late night|happy hour|homemade|authentic|fresh|healthy)\b/g,
        " "
      )
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function expandLocalLocation(location: string) {
  const normalized = location.toLowerCase().trim();

  if (!normalized) return "";
  if (/\bwilliamsburg\b/.test(normalized) && !/\b(virginia|va)\b/.test(normalized)) return "Williamsburg Brooklyn NY";
  if (/\bmassapequa\b/.test(normalized) && !/\b(ny|new york|long island)\b/.test(normalized)) return "Massapequa NY Long Island";
  if (/\blong island\b/.test(normalized) && !/\b(nassau|suffolk|ny|new york)\b/.test(normalized)) return "Long Island Nassau Suffolk NY";
  if (/\bmanhattan\b/.test(normalized) && !/\bny|new york|nyc\b/.test(normalized)) return "Manhattan New York City";
  if (/\bnyc\b/.test(normalized)) return normalized.replace(/\bnyc\b/g, "New York City");
  if (/\bbrooklyn\b/.test(normalized) && !/\bny|new york|nyc\b/.test(normalized)) return `${location} NY`;
  return location;
}

function localInsideGeographyPatterns(location: string) {
  if (/\bwantagh\b/.test(location)) return [/\bwantagh\b/, /\bseaford\b/, /\bbellmore\b/, /\bmassapequa\b/, /\blevittown\b/];
  if (/\bseaford\b/.test(location)) return [/\bseaford\b/, /\bwantagh\b/, /\bmassapequa\b/, /\bbellmore\b/, /\bmerrick\b/, /\blevittown\b/];
  if (/\bmassapequa\b/.test(location)) return [/\bmassapequa\b/, /\bseaford\b/, /\bwantagh\b/, /\bamityville\b/, /\bfarmingdale\b/, /\bbellmore\b/];
  if (/\bhuntington\b/.test(location)) return [/\bhuntington\b(?!\s+beach)/, /\bhuntington station\b/, /\bgreenlawn\b/, /\bcenterport\b/, /\bnorthport\b/, /\bmelville\b/];
  if (/\bdelray beach\b/.test(location)) return [/\bdelray beach\b/, /\bboca raton\b/, /\bboynton beach\b/, /\bhighland beach\b/];
  return [];
}

function localOutsideGeographyPatterns(location: string) {
  if (/\b(wantagh|seaford|massapequa)\b/.test(location)) {
    return [/\bnyc\b/, /\bnew york city\b/, /\bmanhattan\b/, /\bbrooklyn\b/, /\bqueens\b/, /\bbronx\b/, /\bstaten island\b/, /\bchicago\b/, /\bseattle\b/, /\bbeverly hills\b/, /\bsan francisco\b/, /\blos angeles\b/];
  }

  if (/\bhuntington\b/.test(location)) {
    return [/\bhuntington beach\b/, /\borange county\b/, /\bcalifornia\b/, /\bmanhattan\b/, /\bbrooklyn\b/, /\bqueens\b/, /\bbronx\b/, /\bstaten island\b/];
  }

  if (/\bdelray beach\b/.test(location)) {
    return [/\bnyc\b/, /\bnew york city\b/, /\bmanhattan\b/, /\bbrooklyn\b/, /\borlando\b/, /\btampa\b/, /\bjacksonville\b/];
  }

  return [];
}

function localRecoveryCategoryLabel(category: string, normalizedQuery: string) {
  if (category === "restaurant" && /\bitalian\b/.test(normalizedQuery)) return "Italian restaurant";
  if (category === "restaurant" && /\bseafood\b/.test(normalizedQuery)) return "seafood restaurant";
  if (category === "restaurant" && /\bsushi\b/.test(normalizedQuery)) return "sushi";
  if (category === "restaurant" && /\bramen\b/.test(normalizedQuery)) return "ramen";
  if (category === "restaurant" && /\btacos?\b/.test(normalizedQuery)) return "tacos";
  if (category === "restaurant" && /\b(mexican|taqueria)\b/.test(normalizedQuery)) return "Mexican restaurant";
  if (category === "restaurant" && /\b(steakhouse|steak house|steak)\b/.test(normalizedQuery)) return "steakhouse";
  if (category === "restaurant") return "restaurant";
  if (category === "coffee") return "coffee shop";
  if (category === "bar" && /\b(?:espresso martini|dirty martini|martini)\b/.test(normalizedQuery)) return "martini bar";
  if (category === "bar" && /\bcocktail\b/.test(normalizedQuery)) return "cocktail bar";
  if (category === "bar") return "bar";
  if (category === "golf_course") return "golf course";
  if (category === "dentist") return "dentist";
  if (category === "plumber") return "plumber";
  if (category === "tattoo") return "tattoo shop";
  return category.replace(/_/g, " ");
}

function buildLocalSparseRecoveryVariants(query: string, context: ReturnType<typeof localRecoveryContext>) {
  const location = context.location;
  const category = context.categoryLabel;
  const constraintPrefix = localConstraintRetrievalPrefix(context.constraints);
  const base = [constraintPrefix, location ? `${category} ${location}` : `${query} ${category}`].filter(Boolean).join(" ");

  if (context.category === "hotel") {
    return [
      `${query} best ${category} in ${location}`,
      `top ${category} ${location} TripAdvisor`,
      `${location} ${category} Booking.com`,
      `${location} ${category} Expedia hotels`,
      `${location} ${category} Conde Nast Traveler`,
      `${location} ${category} Travel + Leisure`
    ];
  }

  if (context.category === "dentist") {
    return [
      `${base} Healthgrades`,
      `${base} Zocdoc`,
      `${base} Google reviews`,
      `${base} Yelp`,
      `best ${category} near ${location}`
    ];
  }

  if (context.category === "plumber") {
    return [`${base} Angi`, `${base} HomeAdvisor`, `${base} Yelp`, `${base} Google reviews`, `best ${category} near ${location}`];
  }

  if (context.category === "tattoo") {
    return [`${base} Yelp`, `${base} Google reviews`, `${base} Reddit recommendations`, `${base} local reviews`, `best ${category} near ${location}`];
  }

  if (context.category === "attraction") {
    return [`${base} official tourism`, `${base} TripAdvisor`, `${base} Reddit recommendations`, `${base} Google reviews`, `best ${category} near ${location}`];
  }

  if (context.category === "golf_course") {
    return [`${base} Golf Digest`, `${base} Golfweek`, `${base} TripAdvisor`, `${base} Reddit recommendations`, `${base} Google reviews`];
  }

  if (context.category === "gym") {
    return [`${base} Google reviews`, `${base} Yelp`, `${base} Reddit recommendations`, `best ${category} near ${location}`];
  }

  if (["restaurant", "pizza", "brunch", "bakery", "coffee", "bar"].includes(context.category)) {
    return [
      `${query} best ${category} in ${location}`,
      `top ${category} ${location}`,
      `${base} Yelp`,
      `${base} TripAdvisor`,
      `${base} Eater`,
      `${base} Infatuation`,
      `${base} Reddit recommendations`
    ];
  }

  return [`${query} best ${category} in ${location}`, `top ${category} ${location}`, `${base} Yelp`, `${base} Google reviews`, `${base} Reddit recommendations`];
}

function buildLocalNamedCandidateVariants(query: string) {
  const context = localRetrievalContext(query);
  const location = context.location;
  const category = context.categoryLabel;
  const constraintPrefix = localConstraintRetrievalPrefix(context.constraints);
  const base = [constraintPrefix, location ? `${category} ${location}` : `${query} ${category}`].filter(Boolean).join(" ");
  const genericVariants = [
    `best ${category} in ${location || query} names`,
    `top ${category} in ${location || query} list`,
    `where locals recommend ${category} ${location || query}`,
    `${location || query} ${category} recommendations reddit`
  ];
  const sourceVariants: string[] = [];

  if (["restaurant", "pizza", "brunch", "bakery", "bar"].includes(context.category)) {
    sourceVariants.push(
      `${base} Eater named restaurants`,
      `${base} Infatuation named places`,
      `${base} Time Out named places`,
      `site:eater.com ${category} ${location || query}`,
      `site:theinfatuation.com ${category} ${location || query}`,
      `site:reddit.com ${category} ${location || query}`
    );
  } else if (context.category === "coffee") {
    sourceVariants.push(`${base} Sprudge`, `${base} Eater`, `${base} Google Maps`, `site:reddit.com ${category} ${location || query}`);
  } else if (context.category === "hotel") {
    sourceVariants.push(`${base} TripAdvisor`, `${base} Booking`, `${base} Expedia`, `${base} Conde Nast Traveler`);
  } else if (context.category === "dentist") {
    sourceVariants.push(`${base} Healthgrades`, `${base} Zocdoc`, `${base} Google reviews`);
  } else if (context.category === "plumber") {
    sourceVariants.push(`${base} Angi`, `${base} Yelp`, `${base} local reviews`);
  } else if (context.category === "tattoo") {
    sourceVariants.push(`${base} Yelp`, `${base} Google reviews`, `${base} Reddit recommendations`, `${base} local reviews`);
  } else if (context.category === "attraction") {
    sourceVariants.push(`${base} tourism`, `${base} TripAdvisor`, `${base} official`);
  } else if (context.category === "golf_course") {
    sourceVariants.push(`${base} Golf Digest`, `${base} Golfweek`, `${base} courses`);
  }

  return [...sourceVariants, ...genericVariants];
}

function normalizeProductSearchQuery(query: string) {
  const normalized = query.toLowerCase();

  if (/\bbest television\b|\bbest tv\b/.test(normalized)) {
    return "best TV television product";
  }

  if (/\bbest camera\b/.test(normalized)) {
    return "best mirrorless camera product";
  }

  if (/\bbest phone\b/.test(normalized)) {
    return "best smartphone product";
  }

  return query;
}

function dedupeSources(sources: VeraSource[]) {
  const byUrl = new Map<string, VeraSource>();

  for (const source of sources) {
    const key = source.canonicalUrl ?? canonicalizeUrl(source.url);
    const existing = byUrl.get(key);

    if (!existing) {
      byUrl.set(key, source);
      continue;
    }

    byUrl.set(key, {
      ...existing,
      snippet: longer(existing.snippet, source.snippet),
      queryVariant: existing.queryVariant === source.queryVariant ? existing.queryVariant : `${existing.queryVariant}; ${source.queryVariant}`
    });
  }

  return Array.from(byUrl.values());
}

function filterSources(sources: VeraSource[]) {
  return sources.filter((source) => {
    const snippet = source.snippet?.trim() ?? "";
    const domain = source.domain.toLowerCase();
    const title = source.title.toLowerCase();
    const combined = `${title} ${snippet.toLowerCase()} ${source.url.toLowerCase()}`;
    const queryVariant = (source.queryVariant ?? "").toLowerCase();

    if (!snippet || snippet.length < 80) {
      return false;
    }

    if (domain.includes("pinterest") || domain.includes("facebook") || domain.includes("instagram") || domain.includes("tiktok")) {
      return false;
    }

    if (queryVariant.includes("williamsburg brooklyn") && /\b(williamsburg,\s*va|williamsburg va|virginia|23185)\b/.test(combined)) {
      return false;
    }

    if (title.includes("coupon") || title.includes("promo code") || title.includes("sale")) {
      return false;
    }

    return true;
  });
}

function reduceDuplicateDomains(sources: VeraSource[]) {
  const byDomain = new Map<string, VeraSource[]>();

  sources.forEach((source) => {
    const existing = byDomain.get(source.domain) ?? [];
    existing.push(source);
    byDomain.set(source.domain, existing);
  });

  const primaryPass = Array.from(byDomain.values()).flatMap((items) => items.slice(0, 2));
  const overflow = Array.from(byDomain.values()).flatMap((items) => items.slice(2));

  return [...primaryPass, ...overflow];
}

function domainCounts(sources: VeraSource[]) {
  return sources.reduce<Record<string, number>>((counts, source) => {
    counts[source.domain] = (counts[source.domain] ?? 0) + 1;
    return counts;
  }, {});
}

function canonicalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function longer(a?: string, b?: string) {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}
