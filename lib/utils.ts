import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 72);
}

export function normalizeQuery(query: string) {
  return query
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, "")
    .replace(/\s+/g, " ");
}

export function canonicalizeQuery(query: string) {
  const normalized = normalizeQuery(query)
    .replace(/\b(highest rated|most recommended|recommended|recommendations|recommendation|best|top|great|good)\b/g, " ")
    .replace(/\b(places to eat|place to eat|spots to eat|spot to eat|places for food|food places)\b/g, " restaurant ")
    .replace(/\b(new york|n y)\b/g, "ny")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|really|very|please|near|around|for|to|in|find|show|me)\b/g, " ");
  const singularized = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map(singularizeCanonicalToken);

  return singularized.join(" ").replace(/\s+/g, " ").trim();
}

function singularizeCanonicalToken(token: string) {
  const map: Record<string, string> = {
    restaurants: "restaurant",
    hotels: "hotel",
    bars: "bar",
    cafes: "cafe",
    cafés: "cafe",
    coffee: "cafe",
    routers: "router",
    shoes: "shoe",
    suitcases: "suitcase",
    businesses: "business",
    assistants: "assistant"
  };

  if (isStateToken(token)) {
    return "";
  }

  return map[token] ?? token;
}

function isStateToken(token: string) {
  return /^(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)$/.test(token);
}

export function domainFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
