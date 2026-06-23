import type { VeraSource } from "@/lib/types";
import { domainFromUrl, normalizeQuery } from "@/lib/utils";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

export async function searchPublicWeb(query: string): Promise<VeraSource[]> {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    throw new Error("TAVILY_API_KEY is required to search real public sources.");
  }

  const startedAt = Date.now();
  const variants = buildSearchVariants(query);
  const responses = await Promise.all(
    variants.map(async (variant) => searchVariant(variant, key))
  );
  const rawSources = responses.flat();
  const dedupedSources = dedupeSources(rawSources);
  const filteredSources = filterSources(dedupedSources);
  const balancedSources = reduceDuplicateDomains(filteredSources).slice(0, 32);

  console.log("[vera:sources] source pipeline", {
    query,
    variants: variants.length,
    tavilyResults: rawSources.length,
    afterUrlDedupe: dedupedSources.length,
    afterFiltering: filteredSources.length,
    afterDomainBalancing: balancedSources.length,
    openAIInput: balancedSources.length,
    elapsedMs: Date.now() - startedAt,
    domains: domainCounts(balancedSources)
  });

  return balancedSources;
}

async function searchVariant(queryVariant: string, key: string): Promise<VeraSource[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-API-Key": key
    },
    body: JSON.stringify({
      query: `${queryVariant} recommendations reviews reddit forum best`,
      search_depth: "advanced",
      include_answer: false,
      include_raw_content: false,
      max_results: 10
    }),
    cache: "no-store"
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
  const normalized = normalizeQuery(query);
  const variants = new Set<string>([
    query,
    `${query} reddit`,
    `${query} reviews`,
    `${query} recommendations`,
    `${query} forum`
  ]);
  const location = extractLocation(query);
  const firstDate = normalized.includes("first date") || normalized.includes("date night");
  const restaurant = normalized.includes("restaurant") || normalized.includes("bar") || firstDate;

  if (location && firstDate && restaurant) {
    [
      `best date spots ${location}`,
      `romantic restaurants ${location}`,
      `${location} date night restaurants`,
      `best first date bar ${location}`,
      `where should I take a first date ${location}`,
      `${location} restaurant recommendations`,
      `${location} restaurants reddit`,
      `romantic dinner ${location}`,
      `best places for a date ${location}`,
      `${location} date ideas restaurant`
    ].forEach((variant) => variants.add(variant));
  } else if (location && restaurant) {
    [
      `best restaurants ${location}`,
      `${location} restaurant recommendations`,
      `${location} restaurants reddit`,
      `${location} best places to eat`,
      `${location} local food guide`
    ].forEach((variant) => variants.add(variant));
  } else if (location) {
    [
      `${query} reddit`,
      `${query} forum`,
      `${query} reviews`,
      `best ${normalized.replace(location.toLowerCase(), "").trim()} ${location}`
    ].forEach((variant) => variants.add(variant));
  }

  return Array.from(variants)
    .map((variant) => variant.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function extractLocation(query: string) {
  const match = query.match(/\b(?:in|near|around)\s+([a-zA-Z][a-zA-Z\s'-]{2,})$/i);

  if (match?.[1]) {
    return match[1].trim();
  }

  const words = query.trim().split(/\s+/);
  const capitalizedTail: string[] = [];

  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];

    if (!/^[A-Z][a-zA-Z'-]*$/.test(word)) {
      break;
    }

    capitalizedTail.unshift(word);
  }

  if (capitalizedTail.length) {
    return capitalizedTail.join(" ");
  }

  return "";
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
