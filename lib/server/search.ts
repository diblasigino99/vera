import type { VeraSource } from "@/lib/types";
import { domainFromUrl, evidenceStrategyFor, inferQueryEvidenceType, isSpecializedDominantPlatformQuery } from "@/lib/utils";
import type { ExternalCallCounts } from "@/lib/server/external-call-counts";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

const maxTavilyCallsPerRequest = 2;
const tavilyTimeoutMs = 6000;

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
  const variants = buildSearchVariants(query);
  const guardedVariants = variants.slice(0, maxTavilyCallsPerRequest);

  if (variants.length > maxTavilyCallsPerRequest) {
    console.warn("[vera:sources] Tavily variant cap applied", {
      query,
      requestedVariants: variants.length,
      usedVariants: guardedVariants.length
    });
  }

  const responses = [];

  for (const variant of guardedVariants) {
    if (callCounts && callCounts.tavilyCalls >= maxTavilyCallsPerRequest) {
      console.warn("[vera:sources] Tavily hard guard skipped extra search", {
        query,
        variant,
        tavilyCalls: callCounts.tavilyCalls,
        maxTavilyCallsPerRequest
      });
      continue;
    }

    responses.push(await searchVariant(variant, key, callCounts));
  }

  tavilyMs = Date.now() - startedAt;
  const filteringStartedAt = Date.now();
  const rawSources = responses.flat();
  const dedupedSources = dedupeSources(rawSources);
  const filteredSources = filterSources(dedupedSources);
  const balancedSources = reduceDuplicateDomains(filteredSources).slice(0, 18);
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
      max_results: 24
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(tavilyTimeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily search failed with ${response.status}. ${detail || "No response body returned."}`);
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

function buildSearchVariants(query: string) {
  return [buildPrimarySearchQuery(query)]
    .map((variant) => variant.trim())
    .filter(Boolean)
    .slice(0, maxTavilyCallsPerRequest);
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

  console.log("QUERY_EVIDENCE_TYPE", evidenceType);
  console.log("EVIDENCE_STRATEGY", evidenceStrategyFor(evidenceType));
  return `${query} recommendations reviews reddit forum best comparison consensus`;
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

    if (!snippet || snippet.length < 80) {
      return false;
    }

    if (domain.includes("pinterest") || domain.includes("facebook") || domain.includes("instagram") || domain.includes("tiktok")) {
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
