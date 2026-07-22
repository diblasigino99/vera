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

export function normalizeLocalQueryIntent(query: string) {
  let normalized = normalizeQuery(query)
    .replace(/\brestaraunt\b/g, "restaurant")
    .replace(/\bresturant\b/g, "restaurant")
    .replace(/\bpizzaria\b/g, "pizzeria")
    .replace(/\bpiza\b/g, "pizza")
    .replace(/\bexpresso martini\b/g, "espresso martini")
    .replace(/\bcofee\b/g, "coffee")
    .replace(/\bdirty martini\b/g, "cocktail bar")
    .replace(/\bsteak house\b/g, "steakhouse")
    .replace(/\btaco place\b/g, "mexican restaurant")
    .replace(/\btacos\b/g, "mexican restaurant")
    .replace(/\bfish restaurant\b/g, "seafood restaurant")
    .replace(/\bfish\b/g, "seafood")
    .replace(/\bitalian food\b/g, "italian restaurant")
    .replace(/\bsushi spot\b/g, "sushi restaurant")
    .replace(/\bsushi\b/g, "sushi restaurant")
    .replace(/\bbrunch spot\b/g, "brunch restaurant")
    .replace(/\bcoffee spot\b/g, "coffee shop")
    .replace(/\bcocktail spot\b/g, "cocktail bar")
    .replace(/\bdrinks\b/g, "cocktail bar")
    .replace(/\bpizza place\b/g, "pizza")
    .replace(/\bpizzeria\b/g, "pizza italian restaurant")
    .replace(/\bseafood\b/g, "seafood restaurant")
    .replace(/\bsteak\b/g, "steakhouse");

  normalized = normalized
    .replace(/\b(sushi restaurant)\s+restaurant\b/g, "$1")
    .replace(/\b(seafood restaurant)\s+restaurant\b/g, "$1")
    .replace(/\b(italian restaurant)\s+restaurant\b/g, "$1")
    .replace(/\b(brunch restaurant)\s+restaurant\b/g, "$1")
    .replace(/\b(mexican restaurant)\s+restaurant\b/g, "$1")
    .replace(/\b(cocktail bar)\s+bar\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return normalized;
}

export type ParsedLocalIntent = {
  category: string;
  location: string;
  locationForSearch: string;
};

export function parseLocalIntent(query: string): ParsedLocalIntent {
  const normalized = normalizeLocalQueryIntent(query);
  const locationMatch = normalized.match(/\b(?:in|near|around|on)\s+(.+?)$/);
  const rawLocation = cleanLocalLocationPhrase(locationMatch?.[1] ?? "");
  const rawCategory = (locationMatch ? normalized.slice(0, locationMatch.index).trim() : normalized).trim();
  const category = normalizeLocalCategoryPhrase(rawCategory);

  return {
    category,
    location: titleCaseLocalLocation(rawLocation),
    locationForSearch: canonicalizeLocalLocationForSearch(rawLocation)
  };
}

function normalizeLocalCategoryPhrase(value: string) {
  const normalized = value
    .replace(/\b(best|top|great|good|recommended|highest rated|most recommended|find|show me|nearby)\b/g, " ")
    .replace(/\b(cheap|affordable|budget|decent priced|reasonably priced|inexpensive|expensive|upscale|luxury|romantic|date night|casual|cozy|cosy|lively|quiet|rooftop|waterfront|outdoor seating|outdoor|patio|live music|sports bar|family friendly|kid friendly|dog friendly|pet friendly|late night|happy hour|homemade|authentic|fresh|healthy)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\b(espresso martini|dirty martini|martini|cocktail bar|cocktail)\b/.test(normalized)) return "cocktail bar";
  if (/\b(coffee shop|coffee|cafe|cafes|café)\b/.test(normalized)) return "coffee shop";
  if (/\b(tattoo shop|tattoo studio|tattoo)\b/.test(normalized)) return "tattoo shop";
  if (/\b(golf course|golf)\b/.test(normalized)) return "golf course";
  if (/\b(dentist|dental)\b/.test(normalized)) return "dentist";
  if (/\b(plumber|plumbing)\b/.test(normalized)) return "plumber";
  if (/\b(gym|fitness)\b/.test(normalized)) return "gym";
  if (/\b(hotel|hotels|motel|inn|resort)\b/.test(normalized)) return "hotel";
  if (/\b(clothing boutique|boutique|clothing store|jewelry store|jewellery store|shoe store|gift shop|home decor store|bookstore|book shop|furniture store|retail store|local store)\b/.test(normalized))
    return "retail store";
  if (/\b(bar|bars|pub)\b/.test(normalized)) return "bar";
  if (/\b(italian)\b/.test(normalized)) return "Italian restaurant";
  if (/\b(seafood)\b/.test(normalized)) return "seafood restaurant";
  if (/\b(sushi|japanese)\b/.test(normalized)) return "sushi restaurant";
  if (/\b(pizza|pizzeria)\b/.test(normalized)) return "pizza";
  if (/\b(brunch)\b/.test(normalized)) return "brunch restaurant";
  if (/\b(ramen)\b/.test(normalized)) return "ramen";
  if (/\b(mexican|taqueria|taco)\b/.test(normalized)) return "Mexican restaurant";
  if (/\b(steakhouse|steak house|steak)\b/.test(normalized)) return "steakhouse";
  if (/\b(restaurant|restaurants|place to eat|places to eat)\b/.test(normalized)) return "restaurant";

  return normalized || "local business";
}

function cleanLocalLocationPhrase(value: string) {
  return normalizeQuery(value)
    .replace(
      /\b(best|top|recommended|reviews?|reddit|yelp|tripadvisor|google maps|eater|infatuation|booking|opentable|restaurants?|restaurant|bars?|bar|coffee shops?|coffee|cafes?|hotels?|hotel|tattoo shops?|tattoo|near me)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeLocalLocationForSearch(location: string) {
  const normalized = cleanLocalLocationPhrase(location);

  if (!normalized) return "";
  if (/\bnyc\b|\bnew york city\b/.test(normalized)) return "New York City, NY";
  if (/^(?:queens|brooklyn|manhattan|bronx|staten island)$/.test(normalized)) return `${titleCaseLocalLocation(normalized)}, NY`;
  if (normalized === "williamsburg" || normalized === "williamsburg brooklyn") return "Williamsburg, Brooklyn, NY";
  if (/^(?:wantagh|seaford|massapequa|massapequa park|huntington|huntington station|bellmore|long island)$/.test(normalized)) {
    return `${titleCaseLocalLocation(normalized)}, NY`;
  }
  if (normalized === "delray" || normalized === "delray beach") return "Delray Beach, FL";
  if (/\b(?:ny|new york|fl|florida|ca|california|tx|texas|wa|washington)\b/.test(normalized)) {
    return titleCaseLocalLocation(normalized);
  }

  return titleCaseLocalLocation(normalized);
}

function titleCaseLocalLocation(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(ny|nyc|fl|ca|tx|wa)$/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export type LocalQueryConstraint = {
  key: string;
  type: "price" | "atmosphere" | "experience" | "food_quality";
  label: string;
  retrievalTerms: string[];
};

export function parseLocalQueryConstraints(query: string): LocalQueryConstraint[] {
  const normalized = normalizeLocalQueryIntent(query);
  const constraints: LocalQueryConstraint[] = [];
  const add = (constraint: LocalQueryConstraint) => {
    if (!constraints.some((item) => item.key === constraint.key)) {
      constraints.push(constraint);
    }
  };

  if (/\b(cheap|affordable|budget|decent priced|reasonably priced|inexpensive|best value|value)\b/.test(normalized)) {
    add({ key: "affordable", type: "price", label: "Affordable", retrievalTerms: ["affordable", "best value", "reasonably priced"] });
  }
  if (/\b(expensive|upscale|luxury|high end|fancy)\b/.test(normalized)) {
    add({ key: "upscale", type: "price", label: "Upscale", retrievalTerms: ["upscale", "high end", "luxury"] });
  }
  if (/\b(romantic|date night|date-night)\b/.test(normalized)) {
    add({ key: "romantic", type: "atmosphere", label: "Date-night atmosphere", retrievalTerms: ["romantic", "date night"] });
  }
  if (/\b(casual|cozy|cosy|lively|quiet)\b/.test(normalized)) {
    const key = normalized.match(/\b(casual|cozy|cosy|lively|quiet)\b/)?.[1]?.replace("cosy", "cozy") ?? "atmosphere";
    add({ key, type: "atmosphere", label: key === "cozy" ? "Cozy" : `${key.charAt(0).toUpperCase()}${key.slice(1)}`, retrievalTerms: [key] });
  }
  if (/\brooftop\b/.test(normalized)) {
    add({ key: "rooftop", type: "experience", label: "Rooftop", retrievalTerms: ["rooftop"] });
  }
  if (/\bwaterfront|water view|on the water\b/.test(normalized)) {
    add({ key: "waterfront", type: "experience", label: "Waterfront", retrievalTerms: ["waterfront", "water view"] });
  }
  if (/\boutdoor seating|outdoor|patio\b/.test(normalized)) {
    add({ key: "outdoor_seating", type: "experience", label: "Outdoor seating", retrievalTerms: ["outdoor seating", "patio"] });
  }
  if (/\blive music\b/.test(normalized)) {
    add({ key: "live_music", type: "experience", label: "Live music", retrievalTerms: ["live music"] });
  }
  if (/\bsports bar\b/.test(normalized)) {
    add({ key: "sports_bar", type: "experience", label: "Sports bar", retrievalTerms: ["sports bar"] });
  }
  if (/\bfamily friendly|kid friendly|kids friendly|good for kids\b/.test(normalized)) {
    add({ key: "family_friendly", type: "experience", label: "Family friendly", retrievalTerms: ["family friendly", "kid friendly"] });
  }
  if (/\bdog friendly|pet friendly\b/.test(normalized)) {
    add({ key: "dog_friendly", type: "experience", label: "Dog friendly", retrievalTerms: ["dog friendly", "pet friendly"] });
  }
  if (/\blate night\b/.test(normalized)) {
    add({ key: "late_night", type: "experience", label: "Late night", retrievalTerms: ["late night"] });
  }
  if (/\bhappy hour\b/.test(normalized)) {
    add({ key: "happy_hour", type: "experience", label: "Happy hour", retrievalTerms: ["happy hour"] });
  }
  if (/\bhomemade\b/.test(normalized)) {
    add({ key: "homemade", type: "food_quality", label: "Homemade", retrievalTerms: ["homemade"] });
  }
  if (/\bauthentic\b/.test(normalized)) {
    add({ key: "authentic", type: "food_quality", label: "Authentic", retrievalTerms: ["authentic"] });
  }
  if (/\bfresh\b/.test(normalized)) {
    add({ key: "fresh", type: "food_quality", label: "Fresh", retrievalTerms: ["fresh"] });
  }
  if (/\bhealthy\b/.test(normalized)) {
    add({ key: "healthy", type: "food_quality", label: "Healthy", retrievalTerms: ["healthy"] });
  }

  return constraints;
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

export type QueryEvidenceType =
  | "local_recommendation"
  | "product_recommendation"
  | "software_tool"
  | "dominant_platform"
  | "destination_recommendation"
  | "provider_or_brand_recommendation";

export type QueryIntent = "positive_recommendation" | "negative_avoidance" | "reliability_risk";

export function inferQueryIntent(query: string): QueryIntent {
  const normalized = normalizeLocalQueryIntent(query);

  if (/\b(least reliable|unreliable|reliability problems?|reliability issues?|not reliable)\b/.test(normalized)) {
    return "reliability_risk";
  }

  if (/\b(worst|avoid|to avoid|not recommended|stay away from|do not buy|don t buy)\b/.test(normalized)) {
    return "negative_avoidance";
  }

  return "positive_recommendation";
}

export function inferQueryEvidenceType(query: string): QueryEvidenceType {
  const normalized = normalizeLocalQueryIntent(query);

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
    /\b(airline|airlines|hotel chain|hotel chains|bank|banks|wireless carrier|wireless carriers|cell carrier|cell carriers|mobile carrier|mobile carriers|insurance provider|insurance providers|insurance company|insurance companies|laptop brand|laptop brands|phone carrier|phone carriers)\b/.test(
      normalized
    )
  ) {
    return "provider_or_brand_recommendation";
  }

  if (
    /\b(restaurant|restaurants|pizza|pizzeria|sushi|ramen|taco|tacos|taqueria|brunch|bakery|bakeries|bar|bars|pub|cocktail|espresso martini|dirty martini|martini|hotel|hotels|motel|inn|resort|coffee shop|coffee shops|coffee|cafe|cafes|café|golf course|gym|gyms|dentist|dentists|plumber|plumbers|tattoo shop|tattoo shops|tattoo studio|tattoo studios|tattoo|museum|spa|salon|clothing boutique|boutique|clothing store|jewelry store|jewellery store|shoe store|gift shop|home decor store|bookstore|book shop|furniture store|retail store|local store|place to eat|place to stay|near me)\b/.test(
      normalized
    ) ||
    /\b\d{5}(?:-\d{4})?\b/.test(normalized)
  ) {
    return "local_recommendation";
  }

  if (
    /\b(beach|beaches|neighborhood|neighborhoods|neighbourhood|neighbourhoods|where to stay|area to stay|areas to stay|island|islands|weekend trip|weekend trips|day trip|day trips|destination|destinations|town|towns|region|regions|places to visit|place to visit|visit|attraction|attractions|landmark|landmarks|things to do)\b/.test(
      normalized
    )
  ) {
    return "destination_recommendation";
  }

  if (/\b(crm|project management|software|saas|app|platform|tool|ai coding assistant|coding assistant)\b/.test(normalized)) {
    return "software_tool";
  }

  if (
    /\b(router|wi-fi|wifi|shoe|shoes|suitcase|luggage|headphones|earbuds|laptop|notebook|phone|smartphone|mattress|carry-on|carry on|keyboard|mouse|office chair|desk chair|espresso machine|coffee machine|robot vacuum|vacuum|camera|monitor|backpack|television|tv|external ssd|portable ssd|ssd|air purifier|board game|board games|tabletop game|tabletop games|car|cars|vehicle|vehicles|sedan|sedans|midsize sedan|mid size sedan|compact suv|midsize suv|mid size suv|suv|suvs|minivan|minivans|family car|family vehicle)\b/.test(
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

  if (type === "destination_recommendation") {
    return "official tourism boards, reputable travel publications, local guides, TripAdvisor, Reddit travel/local communities, and destination-focused editorial recommendations";
  }

  if (type === "provider_or_brand_recommendation") {
    return "expert comparisons, customer satisfaction, reliability, service quality, value, industry sources, and supporting user discussion";
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
