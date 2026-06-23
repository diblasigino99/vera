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

  const variants = buildSearchVariants(query);
  const responses = await Promise.all(
    variants.map(async (variant) => searchVariant(variant, key))
  );

  return dedupeSources(responses.flat()).slice(0, 45);
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
      max_results: 8
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
    .slice(0, 12);
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
