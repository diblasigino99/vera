import {
  attachContenderActions,
  productAmazonDestinationAccepted,
  productOfficialDestinationAccepted,
  type ActionResolutionCandidate,
  type ResolvedActionCandidates
} from "@/lib/action-links";
import type { ConsensusResponse, ConsensusResult } from "@/lib/types";

type TavilyActionResult = {
  title?: string;
  url?: string;
  content?: string;
};

const actionResolutionTimeoutMs = 3500;
const actionResolutionMaxResults = 8;
const actionResolutionCacheTtlMs = 1000 * 60 * 60 * 12;
const actionResolutionCache = new Map<string, { expiresAt: number; candidates: ActionResolutionCandidate[] }>();

export async function attachPostDecisionActions(consensus: ConsensusResponse): Promise<ConsensusResponse> {
  const sourceDecorated = attachContenderActions(consensus);

  if (!sourceDecorated.results.length || sourceDecorated.structuredConsensus?.queryEvidenceType !== "product_recommendation") {
    return sourceDecorated;
  }

  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return sourceDecorated;
  }

  const candidatesByResult: ResolvedActionCandidates = {};
  const productResults = sourceDecorated.results;
  const settled = await Promise.allSettled(productResults.map((result) => resolveProductActionCandidates(result, key)));

  for (let index = 0; index < settled.length; index += 1) {
    const response = settled[index];
    const result = productResults[index];

    if (!result || response.status !== "fulfilled" || !response.value.length) {
      continue;
    }

    candidatesByResult[result.id] = response.value;
  }

  return attachContenderActions(consensus, candidatesByResult);
}

async function resolveProductActionCandidates(result: ConsensusResult, apiKey: string): Promise<ActionResolutionCandidate[]> {
  const cacheKey = normalizedActionLookupKey(result.name);
  const cached = actionResolutionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  try {
    const query = `"${result.name}" official product page Amazon`;
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
      signal: AbortSignal.timeout(actionResolutionTimeoutMs)
    });

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
        url: candidate.url,
        domain: candidate.domain,
        official,
        amazon,
        accepted: acceptedCandidate
      });

      return acceptedCandidate;
    });

    actionResolutionCache.set(cacheKey, {
      expiresAt: Date.now() + actionResolutionCacheTtlMs,
      candidates: accepted
    });

    return accepted;
  } catch (error) {
    console.warn("[vera:action-resolution] lookup exception", {
      contender: result.name,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

function normalizedActionLookupKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function domainFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
