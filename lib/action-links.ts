import type { ConsensusResponse, ConsensusResult, ContenderAction, ContenderActionType, VeraSource } from "@/lib/types";

type ActionCategory = "product" | "software" | "local" | "provider" | "travel_business" | "none";

const aggregatorDomains = [
  "amazon.com",
  "bonappetit.com",
  "cntraveler.com",
  "consumerreports.org",
  "eater.com",
  "facebook.com",
  "forbes.com",
  "goodhousekeeping.com",
  "google.com",
  "healthgrades.com",
  "instagram.com",
  "nytimes.com",
  "pcmag.com",
  "reddit.com",
  "theinfatuation.com",
  "tripadvisor.com",
  "tiktok.com",
  "usnews.com",
  "wirecutter.com",
  "yelp.com",
  "youtube.com",
  "zocdoc.com"
];

const trustedRetailDomains = [
  "amazon.com",
  "backcountry.com",
  "bestbuy.com",
  "bloomingdales.com",
  "costco.com",
  "homedepot.com",
  "lowes.com",
  "macys.com",
  "nordstrom.com",
  "rei.com",
  "target.com",
  "walmart.com",
  "wayfair.com",
  "zappos.com"
];

const affiliateParamNames = [
  "affid",
  "affiliate",
  "ascsubtag",
  "camp",
  "irclickid",
  "linkcode",
  "tag",
  "utm_medium"
];

export function attachContenderActions(consensus: ConsensusResponse): ConsensusResponse {
  if (!consensus.results.length) {
    return consensus;
  }

  const evidenceType = consensus.structuredConsensus?.queryEvidenceType;
  const results = consensus.results.map((result, index) => {
    const action = resolveContenderAction(consensus, result);

    return action ? { ...result, rank: result.rank || index + 1, action } : { ...result, rank: result.rank || index + 1, action: undefined };
  });

  return {
    ...consensus,
    results,
    structuredConsensus: consensus.structuredConsensus
      ? {
          ...consensus.structuredConsensus,
          queryEvidenceType: evidenceType ?? consensus.structuredConsensus.queryEvidenceType
        }
      : consensus.structuredConsensus
  };
}

export function resolveContenderAction(consensus: ConsensusResponse, result: ConsensusResult): ContenderAction | undefined {
  const category = actionCategoryForResult(consensus, result);

  if (category === "none") {
    return undefined;
  }

  const sources = candidateSources(consensus, result);
  const official = sources.find((source) => sourceLooksOfficialForContender(source, result.name));

  if (official) {
    return buildAction(category, official, category === "local" ? "verified_local_source" : "official_source");
  }

  if (category === "product") {
    const retailer = sources.find((source) => sourceLooksLikeTrustedRetailerForContender(source, result.name));

    if (retailer) {
      return buildAction(category, retailer, "trusted_retailer_source");
    }
  }

  return undefined;
}

function actionCategoryForResult(consensus: ConsensusResponse, result: ConsensusResult): ActionCategory {
  const evidenceType = consensus.structuredConsensus?.queryEvidenceType;
  const candidateCategory = result.metrics?.contenderCategory;
  const queryCategory = consensus.intent.category.toLowerCase();

  if (evidenceType === "destination_recommendation") {
    if (candidateCategory === "hotel" || /\b(hotel|resort|inn)\b/i.test(result.name)) {
      return "travel_business";
    }

    return "none";
  }

  if (evidenceType === "software_tool" || candidateCategory === "software") {
    return "software";
  }

  if (evidenceType === "local_recommendation") {
    return "local";
  }

  if (evidenceType === "provider_or_brand_recommendation") {
    return "provider";
  }

  if (evidenceType === "product_recommendation" || candidateCategory === "product" || queryCategory.includes("product")) {
    return "product";
  }

  if (candidateCategory === "service") {
    return "provider";
  }

  return "none";
}

function buildAction(category: Exclude<ActionCategory, "none">, source: VeraSource, actionSource: ContenderAction["source"]): ContenderAction | undefined {
  const cleanedUrl = cleanOutboundUrl(source.url);

  if (!cleanedUrl) {
    return undefined;
  }

  const domain = domainFromUrl(cleanedUrl);

  if (!domain) {
    return undefined;
  }

  const type: ContenderActionType =
    category === "product"
      ? "view_product"
      : category === "local"
        ? "website"
        : category === "travel_business"
          ? "view_website"
          : "visit_website";

  const label =
    type === "view_product"
      ? "View Product"
      : type === "website"
        ? "Website"
        : type === "view_website"
          ? "View Website"
          : "Visit Website";

  return {
    type,
    label,
    url: cleanedUrl,
    domain,
    source: actionSource
  };
}

function candidateSources(consensus: ConsensusResponse, result: ConsensusResult) {
  const sources = uniqueSources([...result.sources, ...consensus.sources]);
  const resultTokens = meaningfulTokens(result.name);

  return sources.filter((source) => {
    if (!source.url || !isHttpUrl(source.url)) {
      return false;
    }

    if (genericOrSearchUrl(source.url)) {
      return false;
    }

    if (source.supportingContender && normalizedKey(source.supportingContender) === normalizedKey(result.name)) {
      return true;
    }

    const text = `${source.title ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`;
    return tokenOverlapScore(resultTokens, meaningfulTokens(text)) >= Math.min(2, resultTokens.length);
  });
}

function sourceLooksOfficialForContender(source: VeraSource, contenderName: string) {
  const domain = source.domain || domainFromUrl(source.url);

  if (!domain || domainMatchesAny(domain, aggregatorDomains)) {
    return false;
  }

  const compactDomain = compact(domain.replace(/^www\./, "").split(".")[0] ?? "");
  const compactName = compact(contenderName);
  const nameTokens = meaningfulTokens(contenderName);

  if (compactName.length >= 5 && (compactDomain.includes(compactName) || compactName.includes(compactDomain))) {
    return true;
  }

  return nameTokens.some((token) => token.length >= 4 && compactDomain.includes(token));
}

function sourceLooksLikeTrustedRetailerForContender(source: VeraSource, contenderName: string) {
  const domain = source.domain || domainFromUrl(source.url);

  if (!domain || !domainMatchesAny(domain, trustedRetailDomains)) {
    return false;
  }

  const textTokens = meaningfulTokens(`${source.title ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`);
  const contenderTokens = meaningfulTokens(contenderName);

  return tokenOverlapScore(contenderTokens, textTokens) >= Math.min(2, contenderTokens.length);
}

function cleanOutboundUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    if (Array.from(url.searchParams.keys()).some((key) => affiliateParamNames.includes(key.toLowerCase()))) {
      return null;
    }

    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function genericOrSearchUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();

    return /\/(search|s)\b/.test(path) || url.searchParams.has("q") || url.searchParams.has("query") || url.searchParams.has("keyword");
  } catch {
    return true;
  }
}

function isHttpUrl(rawUrl: string) {
  return /^https?:\/\//i.test(rawUrl);
}

function domainFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatchesAny(domain: string, domains: string[]) {
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

function uniqueSources(sources: VeraSource[]) {
  const seen = new Set<string>();
  const unique: VeraSource[] = [];

  for (const source of sources) {
    const key = cleanOutboundUrl(source.url) ?? source.url;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(source);
  }

  return unique;
}

function meaningfulTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !["best", "the", "and", "for", "with", "official", "website", "review", "reviews"].includes(token));
}

function tokenOverlapScore(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function normalizedKey(value: string) {
  return meaningfulTokens(value).join(" ");
}

function compact(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
