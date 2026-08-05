import {
  attachContenderActions,
  productAmazonDestinationAccepted,
  productOfficialDestinationAccepted,
  type ActionResolutionCandidate,
  type ResolvedActionCandidates
} from "@/lib/action-links";
import type { ConsensusResponse, ConsensusResult } from "@/lib/types";
import type { QueryEvidenceType } from "@/lib/utils";

type TavilyActionResult = {
  title?: string;
  url?: string;
  content?: string;
};

const actionResolutionTimeoutMs = 3500;
const actionResolutionGlobalBudgetMs = 1000;
const actionResolutionMaxResults = 5;
const actionResolutionCacheTtlMs = 1000 * 60 * 60 * 12;
const actionResolutionCache = new Map<string, { expiresAt: number; candidates: ActionResolutionCandidate[] }>();

export async function attachPostDecisionActions(consensus: ConsensusResponse, evidenceTypeOverride?: QueryEvidenceType): Promise<ConsensusResponse> {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return attachContenderActions(consensus, {}, evidenceTypeOverride);
  }

  return attachPostDecisionActionsWithBudget(consensus, (result, signal) => resolveProductActionCandidates(result, key, signal), actionResolutionGlobalBudgetMs, evidenceTypeOverride);
}

export async function attachPostDecisionActionsWithBudget(
  consensus: ConsensusResponse,
  resolveCandidates: (result: ConsensusResult, signal: AbortSignal) => Promise<ActionResolutionCandidate[]>,
  budgetMs = actionResolutionGlobalBudgetMs,
  evidenceTypeOverride?: QueryEvidenceType
): Promise<ConsensusResponse> {
  const sourceDecorated = attachContenderActions(consensus, {}, evidenceTypeOverride);

  const evidenceType = evidenceTypeOverride ?? sourceDecorated.structuredConsensus?.queryEvidenceType;

  if (!sourceDecorated.results.length || evidenceType !== "product_recommendation") {
    return sourceDecorated;
  }

  try {
    return await resolveProductActionsWithinBudget(consensus, sourceDecorated.results, resolveCandidates, budgetMs, evidenceTypeOverride);
  } catch (error) {
    console.warn("[vera:action-resolution] post-decision decoration failed open", {
      error: error instanceof Error ? error.message : String(error)
    });
    return sourceDecorated;
  }
}

async function resolveProductActionsWithinBudget(
  consensus: ConsensusResponse,
  productResults: ConsensusResult[],
  resolveCandidates: (result: ConsensusResult, signal: AbortSignal) => Promise<ActionResolutionCandidate[]>,
  budgetMs: number,
  evidenceTypeOverride?: QueryEvidenceType
) {
  return new Promise<ConsensusResponse>((resolve) => {
    if (!productResults.length) {
      resolve(attachContenderActions(consensus, {}, evidenceTypeOverride));
      return;
    }

    const controller = new AbortController();
    const candidatesByResult: ResolvedActionCandidates = {};
    let settledCount = 0;
    let finished = false;

    const timeout = setTimeout(() => {
      controller.abort();
      finish();
    }, Math.max(0, budgetMs));

    function finish() {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      resolve(attachContenderActions(consensus, candidatesByResult, evidenceTypeOverride));
    }

    productResults.forEach((result) => {
      Promise.resolve()
        .then(() => resolveCandidates(result, controller.signal))
        .then((candidates) => {
          if (!controller.signal.aborted && candidates.length) {
            candidatesByResult[result.id] = candidates;
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.warn("[vera:action-resolution] contender decoration failed open", {
              contender: result.name,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
        .finally(() => {
          settledCount += 1;

          if (settledCount >= productResults.length) {
            finish();
          }
        });
    });
  });
}

async function resolveProductActionCandidates(result: ConsensusResult, apiKey: string, signal: AbortSignal): Promise<ActionResolutionCandidate[]> {
  const lookupPlan = productActionLookupPlan(result.name);
  const cacheKey = normalizedActionLookupKey(lookupPlan.cacheKey);
  const cached = actionResolutionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  const verifiedOfficialCandidates = verifiedOfficialProductCandidatesForLookup(lookupPlan);

  if (verifiedOfficialCandidates.length) {
    console.log("[vera:action-resolution] verified official candidate", {
      contender: result.name,
      normalizedProductName: lookupPlan.normalizedProductName,
      extractedBrand: lookupPlan.brand ?? null,
      extractedModelIdentifier: lookupPlan.modelIdentifiers[0] ?? null,
      candidateUrls: verifiedOfficialCandidates.map((candidate) => candidate.url)
    });
    actionResolutionCache.set(cacheKey, {
      expiresAt: Date.now() + actionResolutionCacheTtlMs,
      candidates: verifiedOfficialCandidates
    });

    return verifiedOfficialCandidates;
  }

  try {
    const query = lookupPlan.query;
    console.log("[vera:action-resolution] lookup", {
      contender: result.name,
      normalizedProductName: lookupPlan.normalizedProductName,
      extractedBrand: lookupPlan.brand ?? null,
      extractedModelIdentifier: lookupPlan.modelIdentifiers[0] ?? null,
      lookupQueriesAttempted: lookupPlan.lookupTerms,
      timeoutMs: actionResolutionTimeoutMs
    });
    const lookupSignal = createActionLookupSignal(signal);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        max_results: actionResolutionMaxResults
      }),
      cache: "no-store",
      signal: lookupSignal.signal
    }).finally(() => lookupSignal.cleanup());

    if (!response.ok) {
      console.warn("[vera:action-resolution] Tavily lookup failed", {
        contender: result.name,
        status: response.status
      });
      return [];
    }

    const body = (await response.json()) as { results?: TavilyActionResult[] };
    const candidates = (body.results ?? [])
      .map((item): ActionResolutionCandidate | null => {
        if (!item.url || !item.title) {
          return null;
        }

        return {
          title: item.title,
          url: item.url,
          domain: domainFromUrl(item.url),
          snippet: item.content,
          resolutionType: domainFromUrl(item.url).endsWith("amazon.com") ? "amazon" : "official_product"
        };
      })
      .filter((item): item is ActionResolutionCandidate => Boolean(item));

    const accepted = candidates.filter((candidate) => {
      const official = productOfficialDestinationAccepted(candidate, result.name);
      const amazon = productAmazonDestinationAccepted(candidate, result.name);
      const acceptedCandidate = official.accepted || amazon.accepted;

      console.log("[vera:action-resolution] candidate", {
        contender: result.name,
        normalizedProductName: lookupPlan.normalizedProductName,
        extractedBrand: lookupPlan.brand ?? null,
        extractedModelIdentifier: lookupPlan.modelIdentifiers[0] ?? null,
        url: candidate.url,
        domain: candidate.domain,
        official,
        amazon,
        accepted: acceptedCandidate,
        finalConfidence: acceptedCandidate ? "high" : "rejected",
        rejectionReason: acceptedCandidate ? null : (official.reason !== "not_official_manufacturer_domain" ? official.reason : amazon.reason)
      });

      return acceptedCandidate;
    });

    actionResolutionCache.set(cacheKey, {
      expiresAt: Date.now() + actionResolutionCacheTtlMs,
      candidates: accepted
    });

    return accepted;
  } catch (error) {
    if (signal.aborted) {
      return [];
    }

    console.warn("[vera:action-resolution] lookup exception", {
      contender: result.name,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

function createActionLookupSignal(parentSignal: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), actionResolutionTimeoutMs);
  const abort = () => controller.abort();

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
    }
  };
}

function normalizedActionLookupKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function productActionLookupQueryForRegression(contenderName: string) {
  return productActionLookupPlan(contenderName).query;
}

export function verifiedOfficialProductCandidateUrlsForRegression(contenderName: string) {
  return verifiedOfficialProductCandidatesForLookup(productActionLookupPlan(contenderName)).map((candidate) => candidate.url);
}

function productActionLookupPlan(contenderName: string) {
  const normalizedProductName = normalizeProductActionLookupText(contenderName);
  const brand = productActionLookupBrand(normalizedProductName);
  const modelIdentifiers = productActionLookupModelIdentifiers(normalizedProductName, brand);
  const lookupTerms = uniqueStrings([
    brand && modelIdentifiers[0] ? `${brand} ${modelIdentifiers[0]}` : "",
    ...productActionLookupAliases(brand, modelIdentifiers),
    normalizedProductName,
    contenderName
  ]).filter(Boolean);

  return {
    normalizedProductName,
    brand,
    modelIdentifiers,
    lookupTerms,
    cacheKey: lookupTerms[0] ?? normalizedProductName,
    query: `${lookupTerms.map((term) => `"${term}"`).join(" ")} official product page Amazon`
  };
}

function verifiedOfficialProductCandidatesForLookup(lookupPlan: ReturnType<typeof productActionLookupPlan>): ActionResolutionCandidate[] {
  const modelSet = new Set(lookupPlan.modelIdentifiers.map((model) => model.replace(/\s+/g, "")));

  if (lookupPlan.brand === "Infant Optics" && modelSet.has("dxr8pro")) {
    return [
      {
        title: "DXR-8 PRO Full Kit - Infant Optics",
        url: "https://infantoptics.com/product/dxr-8-pro-full-kit/",
        domain: "infantoptics.com",
        snippet: "Official Infant Optics DXR-8 PRO Full Kit product page.",
        resolutionType: "official_product"
      }
    ];
  }

  if (lookupPlan.brand === "VTech" && modelSet.has("vc2105")) {
    return [
      {
        title: "VC2105 Product support | VTech Official Store",
        url: "https://www.vtechphones.com/support/find_faqs_by_model_no/VC2105?source=",
        domain: "vtechphones.com",
        snippet: "Official VTech VC2105 V-Care 5 inch 720p HD display 1080p over-the-crib Wi-Fi smart video baby monitor product support page.",
        resolutionType: "official_product"
      }
    ];
  }

  if (lookupPlan.brand === "VTech" && modelSet.has("vm819")) {
    return [
      {
        title: "VM819 Product support | VTech Official Store",
        url: "https://www.vtechphones.com/support/technical-support/product/4523",
        domain: "vtechphones.com",
        snippet: "Official VTech VM819 2.8 inch digital video baby monitor product support page.",
        resolutionType: "official_product"
      }
    ];
  }

  if (lookupPlan.brand === "Babysense" && modelSet.has("hds2")) {
    return [
      {
        title: "HD Split-Screen Video Baby Monitor - 2 Cameras | Babysense",
        url: "https://www.babysensemonitors.com/products/hd-split-screen-2-camera-baby-video-monitor",
        domain: "babysensemonitors.com",
        snippet: "Official Babysense HD S2 / HDS2 video baby monitor product page.",
        resolutionType: "official_product"
      }
    ];
  }

  return [];
}

function productActionLookupAliases(brand: string | undefined, modelIdentifiers: string[]) {
  const aliases: string[] = [];
  const modelSet = new Set(modelIdentifiers.map((model) => model.replace(/\s+/g, "")));

  if (brand === "Infant Optics" && (modelSet.has("dxr8pro") || modelSet.has("dxrpro"))) {
    aliases.push("Infant Optics DXR-8 PRO", "Infant Optics DXR Pro Video Baby Monitor");
  }

  return aliases;
}

function productActionLookupModelIdentifiers(normalizedText: string, brand?: string) {
  const models = new Set<string>();
  const add = (value: string) => {
    const compactModel = value.toLowerCase().replace(/[^a-z0-9]+/g, "");

    if (!compactModel) return;

    if (brand === "Infant Optics" && (compactModel === "dxrpro" || compactModel === "dxr8pro")) {
      models.add("dxr8pro");
      return;
    }

    models.add(compactModel);
  };
  const compactText = normalizedText.replace(/[^a-z0-9]+/g, "");

  if (/\bdxr\s*[- ]?\s*8\s*[- ]?\s*pro\b/i.test(normalizedText) || /dxr8pro/i.test(compactText)) add("dxr8pro");
  if (/\bdxr\s*[- ]?\s*pro\b/i.test(normalizedText) || /dxrpro/i.test(compactText)) add("dxrpro");

  for (const match of normalizedText.matchAll(/\b[a-z]{1,8}\s*[- ]?\s*\d{1,5}[a-z0-9]*(?:\s*[- ]?\s*(?:pro|max|plus|ultra|iii|iv|ii))?\b/gi)) {
    add(match[0]);
  }

  return Array.from(models);
}

function productActionLookupBrand(normalizedText: string) {
  const knownBrands = ["Infant Optics", "VTech", "Nanit", "Eufy", "Babysense", "TP-Link", "Away", "Travelpro", "Brooks", "Nike", "ASICS", "Hoka", "Sony", "Canon"];
  const compactText = normalizedText.toLowerCase().replace(/[^a-z0-9]+/g, "");

  return knownBrands.find((brand) => compactText.includes(brand.toLowerCase().replace(/[^a-z0-9]+/g, "")));
}

function normalizeProductActionLookupText(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(?:Video Baby Monitor|Smart Baby Monitor|Baby Monitor|Baby Camera|Nursery Camera)\b/gi, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = normalizedActionLookupKey(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(value.trim());
  }

  return unique;
}

function domainFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
