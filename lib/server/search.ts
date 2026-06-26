import type { VeraSource } from "@/lib/types";
import { domainFromUrl, evidenceStrategyFor, inferQueryEvidenceType, isSpecializedDominantPlatformQuery } from "@/lib/utils";
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
  const tavilyCallLimit = evidenceType === "local_recommendation" ? maxLocalTavilyCallsPerRequest : maxTavilyCallsPerRequest;
  const variants = buildSearchVariants(query);
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
        retry: evidenceType !== "local_recommendation"
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

  if (evidenceType === "local_recommendation") {
    namedDiscoveryResponses = await runLocalNamedCandidateDiscovery(query, key, callCounts);
  }

  tavilyMs = Date.now() - startedAt;
  const filteringStartedAt = Date.now();
  const rawSources = [...responses.flat(), ...namedDiscoveryResponses.flat()];
  const dedupedSources = dedupeSources(rawSources);
  const filteredSources = filterSources(dedupedSources);
  const balancedSources = reduceDuplicateDomains(filteredSources).slice(0, evidenceType === "local_recommendation" ? 28 : 18);
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
    openAIInput: balancedSources.length,
    tavilyMs,
    filteringMs,
    elapsedMs: Date.now() - startedAt,
    domains: domainCounts(balancedSources)
  });

  return balancedSources;
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
  if (callCounts) {
    callCounts.tavilyCalls += 1;
  }

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
      max_results: inferQueryEvidenceType(queryVariant) === "local_recommendation" ? 10 : 24
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
  const locationQuery = context.location ? `${context.categoryLabel} ${context.location}` : query;
  const lanes = localRetrievalLanes(category);

  console.log("LOCAL_RETRIEVAL_CATEGORY", category);
  console.log("LOCAL_LOCATION_CONTEXT", context);
  console.log("LOCAL_RETRIEVAL_VARIANTS", lanes.map((lane) => `${locationQuery} ${lane}`));

  return lanes.map((lane) => `${locationQuery} ${lane}`);
}

function localRetrievalCategory(normalized: string) {
  if (/\b(hotel|motel|inn|resort|lodging|place to stay)\b/.test(normalized)) return "hotel";
  if (/\b(coffee shop|coffee shops|coffee|cafe|cafes|café)\b/.test(normalized)) return "coffee";
  if (/\b(pizza|pizzeria)\b/.test(normalized)) return "pizza";
  if (/\b(brunch)\b/.test(normalized)) return "brunch";
  if (/\b(bakery|bakeries)\b/.test(normalized)) return "bakery";
  if (/\b(bar|bars|pub|cocktail|brewery|taproom|espresso martini)\b/.test(normalized)) return "bar";
  if (/\b(gym|gyms|fitness)\b/.test(normalized)) return "gym";
  if (/\b(dentist|dentists|dental)\b/.test(normalized)) return "dentist";
  if (/\b(plumber|plumbers|plumbing)\b/.test(normalized)) return "plumber";
  if (/\b(attraction|attractions|museum|landmark|things to do)\b/.test(normalized)) return "attraction";
  if (/\b(golf course|golf club)\b/.test(normalized)) return "golf_course";
  if (/\b(restaurant|restaurants|place to eat|dinner|lunch|ramen|sushi|tacos)\b/.test(normalized)) return "restaurant";
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
      "Reddit local coffee recommendations",
      "Google Maps coffee shop reviews",
      "Yelp coffee shops",
      "local coffee guide",
      "best specialty coffee local publication"
    ];
  }

  if (category === "bar") {
    return [
      "Reddit local bar recommendations",
      "Infatuation best bars",
      "Time Out cocktail bars",
      "Eater best bars",
      "Yelp cocktail bar reviews"
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

  if (category === "dentist") {
    return ["Google Maps dentist reviews", "Healthgrades dentists", "Zocdoc dentists", "Yelp dentists reviews"];
  }

  if (category === "plumber") {
    return ["Google Maps plumber reviews", "Angi plumbers reviews", "Yelp plumbers reviews", "HomeAdvisor plumbers"];
  }

  if (category === "pizza") {
    return ["Reddit local pizza recommendations", "Eater best pizza", "Infatuation best pizza", "Yelp pizzeria reviews", "Google Maps pizza reviews"];
  }

  if (category === "brunch") {
    return ["Reddit local brunch recommendations", "OpenTable brunch", "Resy brunch", "Eater best brunch", "Infatuation best brunch", "Yelp brunch reviews"];
  }

  if (category === "bakery") {
    return ["Reddit local bakery recommendations", "Yelp bakeries reviews", "Google Maps bakery reviews", "Eater bakeries", "local magazine bakery guide"];
  }

  if (category === "golf_course") {
    return ["Golf Digest golf course rankings", "Golfweek best courses", "Reddit golf recommendations", "Google Maps golf course reviews", "TripAdvisor golf course reviews"];
  }

  if (category === "restaurant") {
    return [
      "Reddit local restaurant recommendations",
      "Yelp restaurant reviews",
      "Google Maps restaurant reviews",
      "Eater best restaurants",
      "Infatuation best restaurants",
      "OpenTable restaurant reviews",
      "local publication restaurant guide"
    ];
  }

  return ["Reddit local recommendations", "Yelp reviews", "Google Maps reviews", "TripAdvisor reviews", "local guide best recommended"];
}

function localRecoveryContext(query: string) {
  const context = localRetrievalContext(query);

  return {
    category: context.category,
    categoryLabel: context.categoryLabel,
    location: context.location
  };
}

function localRetrievalContext(query: string) {
  const normalized = query.toLowerCase();
  const category = localRetrievalCategory(normalized);
  const location = expandLocalLocation(extractLocalLocation(normalized));

  return {
    category,
    categoryLabel: localRecoveryCategoryLabel(category, normalized),
    location: location || ""
  };
}

function extractLocalLocation(normalized: string) {
  const locationMatch = normalized.match(/\b(?:in|near|around)\s+(.+?)$/);
  return (
    locationMatch?.[1]
      ?.replace(/\b(best|top|recommended|reviews?|reddit|yelp|tripadvisor|google maps|eater|infatuation|booking|opentable|restaurants?|bars?|coffee shops?|hotels?)\b/g, " ")
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

function localRecoveryCategoryLabel(category: string, normalizedQuery: string) {
  if (category === "restaurant" && /\bsushi\b/.test(normalizedQuery)) return "sushi";
  if (category === "restaurant" && /\bramen\b/.test(normalizedQuery)) return "ramen";
  if (category === "restaurant" && /\btacos?\b/.test(normalizedQuery)) return "tacos";
  if (category === "restaurant") return "restaurant";
  if (category === "coffee") return "coffee shop";
  if (category === "bar" && /\bespresso martini\b/.test(normalizedQuery)) return "espresso martini bar";
  if (category === "bar") return "bar";
  if (category === "golf_course") return "golf course";
  if (category === "dentist") return "dentist";
  if (category === "plumber") return "plumber";
  return category.replace(/_/g, " ");
}

function buildLocalSparseRecoveryVariants(query: string, context: ReturnType<typeof localRecoveryContext>) {
  const location = context.location;
  const category = context.categoryLabel;
  const base = location ? `${category} ${location}` : `${query} ${category}`;

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
  const base = location ? `${category} ${location}` : `${query} ${category}`;
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
