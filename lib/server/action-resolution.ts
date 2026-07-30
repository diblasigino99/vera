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
const actionResolutionGlobalBudgetMs = 800;
const actionResolutionMaxResults = 8;
const actionResolutionCacheTtlMs = 1000 * 60 * 60 * 12;
const actionResolutionCache = new Map<string, { expiresAt: number; candidates: ActionResolutionCandidate[] }>();

export async function attachPostDecisionActions(consensus: ConsensusResponse): Promise<ConsensusResponse> {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    return attachContenderActions(consensus);
  }

  return attachPostDecisionActionsWithBudget(consensus, (result, signal) => resolveProductActionCandidates(result, key, signal), actionResolutionGlobalBudgetMs);
}

export async function attachPostDecisionActionsWithBudget(
  consensus: ConsensusResponse,
  resolveCandidates: (result: ConsensusResult, signal: AbortSignal) => Promise<ActionResolutionCandidate[]>,
  budgetMs = actionResolutionGlobalBudgetMs
): Promise<ConsensusResponse> {
  const sourceDecorated = attachContenderActions(consensus);

  if (!sourceDecorated.results.length || sourceDecorated.structuredConsensus?.queryEvidenceType !== "product_recommendation") {
    return sourceDecorated;
  }

  try {
    return await resolveProductActionsWithinBudget(consensus, sourceDecorated.results, resolveCandidates, budgetMs);
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
  budgetMs: number
) {
  return new Promise<ConsensusResponse>((resolve) => {
    if (!productResults.length) {
      resolve(attachContenderActions(consensus));
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
      resolve(attachContenderActions(consensus, candidatesByResult));
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
  const cacheKey = normalizedActionLookupKey(result.name);
  const cached = actionResolutionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  try {
    const query = `"${result.name}" official product page Amazon`;
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

function domainFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
