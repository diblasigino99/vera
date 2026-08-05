import type { ConsensusResponse, ConsensusResult, ContenderAction, ContenderActionType, VeraSource } from "@/lib/types";
import type { QueryEvidenceType } from "@/lib/utils";

type ActionCategory = "product" | "software" | "local" | "provider" | "travel_business" | "none";

export type ActionResolutionCandidate = VeraSource & {
  resolutionType?: "official_product" | "amazon";
};

export type ResolvedActionCandidates = Record<string, ActionResolutionCandidate[]>;

const aggregatorDomains = [
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
  "babylist.com",
  "bestbuy.com",
  "ebay.com",
  "reddit.com",
  "target.com",
  "theinfatuation.com",
  "tripadvisor.com",
  "tiktok.com",
  "usnews.com",
  "walmart.com",
  "wirecutter.com",
  "yelp.com",
  "youtube.com",
  "zocdoc.com"
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

export function attachContenderActions(consensus: ConsensusResponse, resolvedCandidates: ResolvedActionCandidates = {}, evidenceTypeOverride?: QueryEvidenceType): ConsensusResponse {
  if (!consensus.results.length) {
    return consensus;
  }

  const evidenceType = evidenceTypeOverride ?? consensus.structuredConsensus?.queryEvidenceType;
  const results = consensus.results.map((result, index) => {
    const actions = resolveContenderActions(consensus, result, resolvedCandidates[result.id] ?? resolvedCandidates[result.name] ?? [], evidenceTypeOverride);
    const rank = result.rank || index + 1;

    return {
      ...result,
      rank,
      action: actions[0],
      actions
    };
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
  return resolveContenderActions(consensus, result)[0];
}

export function resolveContenderActions(
  consensus: ConsensusResponse,
  result: ConsensusResult,
  resolvedCandidates: ActionResolutionCandidate[] = [],
  evidenceTypeOverride?: QueryEvidenceType
): ContenderAction[] {
  const category = actionCategoryForResult(consensus, result, evidenceTypeOverride);

  if (category === "none") {
    return [];
  }

  if (category === "product") {
    return resolveProductActions(consensus, result, resolvedCandidates);
  }

  if (category === "local") {
    return resolveLocalActions(consensus, result);
  }

  const sources = candidateSources(consensus, result);
  const official = sources.find((source) => sourceLooksOfficialForContender(source, result.name));
  const action = official ? buildAction(actionTypeForCategory(category), official, "official_source") : undefined;

  return action ? [action] : [];
}

export function productOfficialDestinationAccepted(source: VeraSource, contenderName: string) {
  if (!source.url || !isHttpUrl(source.url)) {
    return { accepted: false, reason: "invalid_url" };
  }

  if (genericOrSearchUrl(source.url)) {
    return { accepted: false, reason: "generic_search_url" };
  }

  const domain = source.domain || domainFromUrl(source.url);

  if (!domain) {
    return { accepted: false, reason: "missing_domain" };
  }

  if (domainMatchesAny(domain, aggregatorDomains) || domainMatchesAny(domain, ["amazon.com"])) {
    return { accepted: false, reason: "not_official_manufacturer_domain" };
  }

  if (productActionCandidateLooksAccessoryOrPart(source)) {
    return { accepted: false, reason: "product_accessory_or_part" };
  }

  if (!sourceLooksOfficialForContender(source, contenderName)) {
    return { accepted: false, reason: "domain_does_not_match_brand" };
  }

  const sourceText = `${source.title ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`;
  const modelMatch = productModelIdentityMatch(contenderName, sourceText);

  if (modelMatch.conflict) {
    return { accepted: false, reason: "model_identifier_mismatch" };
  }

  if (officialProductUrlLooksInformational(source.url) && !officialProductSupportUrlLooksExact(source.url, modelMatch.accepted)) {
    return { accepted: false, reason: "official_url_not_product_destination" };
  }

  const textTokens = meaningfulTokens(sourceText);
  const contenderTokens = meaningfulTokens(contenderName);
  const overlap = tokenOverlapScore(contenderTokens, textTokens);
  const contenderIdentity = productActionIdentity(contenderName);

  if (contenderIdentity.modelIdentifiers.length && !modelMatch.accepted) {
    return { accepted: false, reason: "official_product_model_not_confident_match" };
  }

  if (!modelMatch.accepted && overlap < Math.min(2, contenderTokens.length) && !officialDomainAndProductLineMatch(domain, contenderTokens, textTokens)) {
    return { accepted: false, reason: "page_does_not_match_product" };
  }

  return { accepted: true, reason: modelMatch.accepted ? "official_brand_and_model_match" : "official_domain_and_product_match" };
}

export function productAmazonDestinationAccepted(source: VeraSource, contenderName: string) {
  if (!source.url || !isHttpUrl(source.url)) {
    return { accepted: false, reason: "invalid_url" };
  }

  const domain = source.domain || domainFromUrl(source.url);

  if (!domainMatchesAny(domain, ["amazon.com"])) {
    return { accepted: false, reason: "not_amazon" };
  }

  if (genericOrSearchUrl(source.url)) {
    return { accepted: false, reason: "generic_amazon_search_url" };
  }

  if (!amazonProductDetailUrl(source.url)) {
    return { accepted: false, reason: "not_amazon_product_detail" };
  }

  if (productActionCandidateLooksAccessoryOrPart(source)) {
    return { accepted: false, reason: "product_accessory_or_part" };
  }

  const contenderTokens = meaningfulTokens(contenderName);
  const sourceText = `${source.title ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`;
  const modelMatch = productModelIdentityMatch(contenderName, sourceText);

  if (modelMatch.conflict) {
    return { accepted: false, reason: "model_identifier_mismatch" };
  }

  const textTokens = meaningfulTokens(sourceText);
  const overlap = tokenOverlapScore(contenderTokens, textTokens);
  const distinctiveTokens = contenderTokens.filter((token) => token.length >= 4);
  const contenderIdentity = productActionIdentity(contenderName);

  if (contenderIdentity.modelIdentifiers.length && !modelMatch.accepted) {
    return { accepted: false, reason: "amazon_product_model_not_confident_match" };
  }

  if (overlap < Math.min(2, distinctiveTokens.length || contenderTokens.length)) {
    return { accepted: false, reason: "amazon_product_not_confident_match" };
  }

  return { accepted: true, reason: modelMatch.accepted ? "amazon_product_model_match" : "amazon_product_detail_match" };
}

function resolveProductActions(consensus: ConsensusResponse, result: ConsensusResult, resolvedCandidates: ActionResolutionCandidate[]) {
  const sources = candidateSources(consensus, result);
  const actionCandidates = uniqueSources([...resolvedCandidates, ...sources]);
  const official = actionCandidates.find((source) => productOfficialDestinationAccepted(source, result.name).accepted);
  const amazon = actionCandidates.find((source) => productAmazonDestinationAccepted(source, result.name).accepted);
  const actions: ContenderAction[] = [];

  if (official) {
    const action = buildAction("official_product", official, resolvedCandidates.includes(official) ? "official_destination_resolution" : "official_source");

    if (action) {
      actions.push(action);
    }
  }

  if (amazon) {
    const action = buildAction("amazon", amazon, resolvedCandidates.includes(amazon) ? "amazon_destination_resolution" : "trusted_retailer_source");

    if (action) {
      actions.push(action);
    }
  }

  return dedupeActions(actions);
}

function resolveLocalActions(consensus: ConsensusResponse, result: ConsensusResult) {
  const sources = candidateSources(consensus, result);
  const official = sources.find((source) => sourceLooksOfficialForContender(source, result.name));
  const actions: ContenderAction[] = [];
  const website = official ? buildAction("website", official, "verified_local_source") : undefined;
  const maps = buildMapsAction(localPlaceIdForResult(consensus, result), result.name);

  if (website) {
    actions.push(website);
  }

  if (maps) {
    actions.push(maps);
  }

  return dedupeActions(actions);
}

function actionCategoryForResult(consensus: ConsensusResponse, result: ConsensusResult, evidenceTypeOverride?: QueryEvidenceType): ActionCategory {
  const evidenceType = evidenceTypeOverride ?? consensus.structuredConsensus?.queryEvidenceType;
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

function actionTypeForCategory(category: Exclude<ActionCategory, "none" | "product">): ContenderActionType {
  if (category === "local") {
    return "website";
  }

  if (category === "travel_business") {
    return "view_website";
  }

  return "visit_website";
}

function buildAction(type: ContenderActionType, source: VeraSource, actionSource: ContenderAction["source"]): ContenderAction | undefined {
  const cleanedUrl = cleanOutboundUrl(source.url);

  if (!cleanedUrl) {
    return undefined;
  }

  const domain = domainFromUrl(cleanedUrl);

  if (!domain) {
    return undefined;
  }

  const label =
    type === "official_product"
      ? "View Product"
      : type === "amazon"
        ? "Amazon"
        : type === "maps"
          ? "View on Maps"
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

function buildMapsAction(placeId?: string, query?: string): ContenderAction | undefined {
  const cleanPlaceId = placeId?.trim();
  const cleanQuery = query?.trim();

  if (!cleanPlaceId || !/^[A-Za-z0-9_-]+$/.test(cleanPlaceId)) {
    return undefined;
  }

  return {
    type: "maps",
    label: "View on Maps",
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cleanQuery || cleanPlaceId)}&query_place_id=${encodeURIComponent(cleanPlaceId)}`,
    domain: "google.com",
    source: "google_places"
  };
}

function localPlaceIdForResult(consensus: ConsensusResponse, result: ConsensusResult) {
  const resultPlaceId = result.placesPlaceId?.trim();

  if (resultPlaceId) {
    return resultPlaceId;
  }

  return consensus.structuredConsensus?.signals
    .filter((signal) => signal.contenderName === result.name && signal.placesVerified)
    .map((signal) => signal.placesPlaceId?.trim())
    .find((placeId): placeId is string => Boolean(placeId));
}

function candidateSources(consensus: ConsensusResponse, result: ConsensusResult) {
  const sources = uniqueSources([...consensus.sources, ...result.sources]);
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

  const hostLabels = domain
    .replace(/^www\./, "")
    .split(".")
    .filter((label) => label && !/^(?:com|net|org|co|us|ca|uk|au|store|shop|www)$/.test(label));
  const compactDomain = compact(hostLabels.join(" "));
  const compactName = compact(contenderName);
  const nameTokens = meaningfulTokens(contenderName);

  if (compactName.length >= 5 && (compactDomain.includes(compactName) || compactName.includes(compactDomain))) {
    return true;
  }

  return nameTokens.some((token) => token.length >= 4 && compactDomain.includes(token));
}

function officialProductUrlLooksInformational(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();

    return /\/(?:about|article|articles|blog|blogs|journal|magazine|manual|manuals|news|newsroom|press|press-release|press-releases|review|reviews|support|video|videos)\b/.test(
      path
    );
  } catch {
    return true;
  }
}

function officialProductSupportUrlLooksExact(rawUrl: string, exactModelMatch: boolean) {
  if (!exactModelMatch) {
    return false;
  }

  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    return /\/support\//.test(path);
  } catch {
    return false;
  }
}

type ProductActionIdentity = {
  normalizedName: string;
  brandHint?: string;
  modelIdentifiers: string[];
};

function productActionIdentity(value: string): ProductActionIdentity {
  const normalizedName = normalizeProductActionText(value);
  const brandHint = productActionBrandHint(normalizedName);
  const modelIdentifiers = normalizedProductModelIdentifiers(normalizedName, brandHint);

  return {
    normalizedName,
    brandHint,
    modelIdentifiers
  };
}

function productModelIdentityMatch(contenderName: string, sourceText: string) {
  const contender = productActionIdentity(contenderName);

  if (!contender.modelIdentifiers.length) {
    return { accepted: false, conflict: false };
  }

  const source = productActionIdentity(sourceText);

  if (!source.modelIdentifiers.length) {
    return { accepted: false, conflict: false };
  }

  const contenderModels = new Set(contender.modelIdentifiers);
  const sourceModels = new Set(source.modelIdentifiers);
  const accepted = Array.from(contenderModels).some((model) => sourceModels.has(model));

  if (accepted) {
    return { accepted: true, conflict: false };
  }

  const sameBrand = contender.brandHint && source.brandHint && contender.brandHint === source.brandHint;
  const sourceLooksProductSpecific = /\b(?:product|baby monitor|video monitor|camera|amazon|dp|shop|buy|model)\b/.test(source.normalizedName);

  return {
    accepted: false,
    conflict: Boolean(sameBrand && sourceLooksProductSpecific)
  };
}

function normalizedProductModelIdentifiers(normalizedText: string, brandHint?: string) {
  const models = new Set<string>();
  const add = (value: string) => {
    const normalized = canonicalProductModelIdentifier(value, normalizedText, brandHint);
    if (normalized) {
      models.add(normalized);
    }
  };

  const compactText = compact(normalizedText);

  if (/\bdxr\s*[- ]?\s*8\s*[- ]?\s*pro\b/.test(normalizedText) || /dxr8pro/.test(compactText)) add("dxr8pro");
  if (/\bdxr\s*[- ]?\s*pro\b/.test(normalizedText) || /dxrpro/.test(compactText)) add("dxrpro");
  if (brandHint === "babysense" && /\bhd\s*[- ]?\s*s2\b/.test(normalizedText)) add("hds2");

  for (const match of normalizedText.matchAll(/\b[a-z]{1,8}\s*[- ]?\s*\d{1,5}[a-z0-9]*(?:\s*[- ]?\s*(?:pro|max|plus|ultra|iii|iv|ii))?\b/g)) {
    add(match[0]);
  }

  for (const match of normalizedText.matchAll(/\b\d{1,5}\s*[- ]?\s*[a-z]{1,5}\b/g)) {
    add(match[0]);
  }

  return Array.from(models);
}

function canonicalProductModelIdentifier(value: string, sourceText: string, brandHint?: string) {
  const compactValue = compact(value);
  const brand = brandHint ?? productActionBrandHint(sourceText);

  if (brand === "infantoptics") {
    if (compactValue === "dxrpro" || compactValue === "dxr8pro") return "dxr8pro";
  }

  if (brand === "babysense") {
    if (compactValue === "hds2") return "hds2";
  }

  if (/^b0[a-z0-9]{8}$/.test(compactValue)) {
    return "";
  }

  return compactValue.length >= 3 ? compactValue : "";
}

function productActionBrandHint(normalizedText: string) {
  const compactText = compact(normalizedText);
  const knownBrands = [
    "infant optics",
    "vtech",
    "nanit",
    "eufy",
    "babysense",
    "tp link",
    "tp-link",
    "tapo",
    "away",
    "travelpro",
    "brooks",
    "nike",
    "asics",
    "hoka",
    "sony",
    "canon"
  ];
  const brand = knownBrands.find((candidate) => compactText.includes(compact(candidate)));

  return brand ? compact(brand) : undefined;
}

function productActionCandidateLooksAccessoryOrPart(source: VeraSource) {
  const title = normalizeProductActionText(source.title ?? "");
  const text = normalizeProductActionText(`${source.title ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`);

  if (/\b(?:bundle|parent unit|camera unit|replacement|accessory|accessories|add on camera|add-on camera|additional camera|extra camera|floor stand)\b/.test(title)) {
    return true;
  }

  if (/\b(?:replacement|spare|add on|add-on|additional|extra)\b.{0,40}\b(?:battery|batteries|charger|charging cable|power cord|adapter|mount|stand|case|screen protector|part|parts|camera|unit)\b/.test(text)) {
    return true;
  }

  return /\b(?:replacement part|replacement parts|screen protector)\b/.test(text);
}

function officialDomainAndProductLineMatch(domain: string, contenderTokens: string[], textTokens: string[]) {
  if (contenderTokens.length < 2) {
    return false;
  }

  const compactDomain = compact(
    domain
      .replace(/^www\./, "")
      .split(".")
      .filter((label) => label && !/^(?:com|net|org|co|us|ca|uk|au|store|shop|www)$/.test(label))
      .join(" ")
  );
  const domainMatchedTokens = contenderTokens.filter((token) => token.length >= 4 && compactDomain.includes(token));

  if (!domainMatchedTokens.length) {
    return false;
  }

  const textTokenSet = new Set(textTokens);
  return contenderTokens.some((token) => !domainMatchedTokens.includes(token) && token.length >= 4 && textTokenSet.has(token));
}

function amazonProductDetailUrl(rawUrl: string) {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();

    return /\/(?:dp|gp\/product)\//.test(path);
  } catch {
    return false;
  }
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

    return /\/(search|s)\b/.test(path) || url.searchParams.has("q") || url.searchParams.has("query") || url.searchParams.has("keyword") || url.searchParams.has("k");
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

function uniqueSources<TSource extends VeraSource>(sources: TSource[]) {
  const seen = new Set<string>();
  const unique: TSource[] = [];

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

function dedupeActions(actions: ContenderAction[]) {
  const seen = new Set<string>();
  const unique: ContenderAction[] = [];

  for (const action of actions) {
    const key = `${action.type}:${action.url}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(action);
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

function normalizeProductActionText(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:video baby monitor|baby monitor|smart baby monitor|baby camera|nursery camera|with camera|product page|official product page)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
