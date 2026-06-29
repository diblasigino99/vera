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

export type QueryEvidenceType = "local_recommendation" | "product_recommendation" | "software_tool" | "dominant_platform";

export function inferQueryEvidenceType(query: string): QueryEvidenceType {
  const normalized = normalizeQuery(query);

  if (/\b(team chat|work chat|business chat|workplace chat)\b/.test(normalized)) {
    return "software_tool";
  }

  if (
    /\b(search engine|browser|email provider|email service|mail provider|maps app|map app|navigation app|video platform|video site|messaging app|messenger|music streaming|streaming music|cloud storage|spreadsheet app|spreadsheet|calendar app|calendar)\b/.test(
      normalized
    )
  ) {
    return "dominant_platform";
  }

  if (
    /\b(restaurant|restaurants|pizza|pizzeria|sushi|ramen|taco|tacos|taqueria|brunch|bakery|bakeries|bar|bars|pub|cocktail|espresso martini|hotel|hotels|motel|inn|resort|coffee shop|coffee shops|coffee|cafe|cafes|café|golf course|gym|gyms|dentist|dentists|plumber|plumbers|attraction|attractions|museum|spa|salon|place to eat|place to stay|near me)\b/.test(
      normalized
    ) ||
    /\b\d{5}(?:-\d{4})?\b/.test(normalized)
  ) {
    return "local_recommendation";
  }

  if (/\b(crm|project management|software|saas|app|platform|tool|ai coding assistant|coding assistant)\b/.test(normalized)) {
    return "software_tool";
  }

  if (
    /\b(router|wi-fi|wifi|shoe|shoes|suitcase|luggage|headphones|earbuds|laptop|notebook|phone|smartphone|mattress|carry-on|carry on|keyboard|mouse|office chair|desk chair|espresso machine|coffee machine|robot vacuum|vacuum|camera|monitor|backpack|television|tv|external ssd|portable ssd|ssd|air purifier)\b/.test(
      normalized
    )
  ) {
    return "product_recommendation";
  }

  return "product_recommendation";
}

export function evidenceStrategyFor(type: QueryEvidenceType) {
  if (type === "dominant_platform") {
    return "market dominance, default usage, broad recognition, expert comparisons, major alternatives, and privacy/specialized alternatives";
  }

  if (type === "software_tool") {
    return "expert reviews, comparison sites, user reviews, Reddit/forums, and repeated recommendations";
  }

  if (type === "product_recommendation") {
    return "expert reviews, comparison sites, user reviews, Reddit/forums, and repeated recommendations";
  }

  return "Google Maps-style business listings, Yelp, TripAdvisor, local guides, Reddit local communities, editorial lists, and booking/review platforms";
}

export function isSpecializedDominantPlatformQuery(query: string) {
  return /\b(private|privacy|independent|open source|open-source|secure|encrypted|anonymous|no tracking|without tracking|ad free|ad-free)\b/.test(normalizeQuery(query));
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
