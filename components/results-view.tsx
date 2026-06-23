"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { BadgeCheck, Bookmark, CheckCircle2, Split, TriangleAlert } from "lucide-react";
import type { ConsensusResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VeraThinking } from "@/components/vera-thinking";
import { buildResultSlug } from "@/lib/result-slug";
import { getAnonymousId } from "@/lib/client/anonymous-id";

type ResultsViewProps = {
  query: string;
  initialResult: ConsensusResponse | null;
  showThinking?: boolean;
};

type SavedState = {
  savedSearch: boolean;
  savedResults: Record<string, boolean>;
};

const emptySavedState: SavedState = {
  savedSearch: false,
  savedResults: {}
};

const modeCopy = {
  clear_consensus: {
    icon: BadgeCheck,
    label: "Clear Consensus",
    description: "One winner is clearly supported by the sources."
  },
  strong_consensus: {
    icon: CheckCircle2,
    label: "Strong Consensus",
    description: "One option leads, with credible alternatives below."
  },
  moderate_consensus: {
    icon: CheckCircle2,
    label: "Moderate Consensus",
    description: "One option has a meaningful lead, but the field is not settled."
  },
  split_consensus: {
    icon: Split,
    label: "Split Consensus",
    description: "Several options are strongly recommended. The best choice depends on what you value most."
  },
  no_reliable_consensus: {
    icon: TriangleAlert,
    label: "No Reliable Consensus",
    description: "The sources do not support a reliable consensus."
  }
};

export function ResultsView({ query, initialResult, showThinking = false }: ResultsViewProps) {
  const [result, setResult] = useState<ConsensusResponse | null>(initialResult);
  const [requestLoading, setRequestLoading] = useState(Boolean(query && !initialResult));
  const [minimumThinking, setMinimumThinking] = useState(Boolean(query && showThinking));
  const [error, setError] = useState<string | null>(null);
  const [savedState, setSavedState] = useState<SavedState>(emptySavedState);
  const fetchedQueryRef = useRef<string | null>(initialResult?.query ?? null);

  useEffect(() => {
    if (initialResult?.query === query) {
      console.log("showing results", {
        query,
        cached: initialResult.cached,
        mode: initialResult.mode
      });
    }
  }, [initialResult, query]);

  useEffect(() => {
    if (result && result.results.length) {
      window.localStorage.setItem(resultStorageKey(result.id), JSON.stringify(result));
    }
  }, [result]);

  useEffect(() => {
    if (!query) {
      return;
    }

    setMinimumThinking(Boolean(showThinking));

    if (showThinking) {
      console.log("thinking state visible", { query, source: "results-page-handoff" });
      const minimumThinkingTimer = window.setTimeout(() => {
        setMinimumThinking(false);
      }, 1600);

      return () => window.clearTimeout(minimumThinkingTimer);
    }
  }, [query, showThinking]);

  useEffect(() => {
    if (!query) {
      return;
    }

    if (initialResult?.query === query) {
      setResult(initialResult);
      setRequestLoading(false);
      fetchedQueryRef.current = query;
      return;
    }

    if (fetchedQueryRef.current === query) {
      return;
    }

    fetchedQueryRef.current = query;

    const controller = new AbortController();
    setRequestLoading(true);
    setError(null);
    console.log("fetch started", { query });

    fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query }),
      signal: controller.signal
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error ?? "Search failed.");
        }
        return body as ConsensusResponse;
      })
      .then((nextResult) => {
        console.log("fetch completed", { query, cached: nextResult.cached, mode: nextResult.mode });
        setResult(nextResult);
        console.log("showing results", { query, mode: nextResult.mode });
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") {
          fetchedQueryRef.current = null;
          setError(reason.message);
        }
      })
      .finally(() => setRequestLoading(false));

    return () => controller.abort();
  }, [initialResult, query]);

  useEffect(() => {
    if (!result) {
      setSavedState(emptySavedState);
      return;
    }

    const resultIds = result.results.map((item) => item.id);

    if (!resultIds.length) {
      setSavedState(emptySavedState);
      return;
    }

    loadSavedStateBatch(result.id, resultIds)
      .then(setSavedState)
      .catch(() => setSavedState(emptySavedState));
  }, [result]);

  const mode = result ? modeCopy[result.mode] : null;
  const ModeIcon = mode?.icon;
  const hasWinner =
    result?.mode === "clear_consensus" ||
    result?.mode === "strong_consensus" ||
    result?.mode === "moderate_consensus";
  const winner = hasWinner ? result?.results[0] : null;
  const alternatives = hasWinner ? result?.results.slice(1) ?? [] : result?.results ?? [];

  const intentLine = useMemo(() => {
    if (!result) {
      return "";
    }

    const parts = [
      result.intent.category,
      result.intent.location,
      ...result.intent.optimizeFor.slice(0, 3)
    ].filter(Boolean);

    return parts.join(" · ");
  }, [result]);

  const rankingExplanation = useMemo(() => {
    return result ? buildRankingExplanation(result) : "";
  }, [result]);

  const sourceMixLine = useMemo(() => {
    return result ? buildSourceMixLine(result) : "";
  }, [result]);

  if (!query) {
    return null;
  }

  if (requestLoading || minimumThinking) {
    return <VeraThinking className="mt-12" />;
  }

  if (error) {
    return (
      <div className="mx-auto mt-16 max-w-2xl rounded-2xl border border-line bg-white p-8 text-center shadow-[0_20px_70px_rgba(0,0,0,0.045)]">
        <p className="text-lg font-medium text-ink">Vera could not complete this search.</p>
        <p className="mt-3 leading-7 text-muted">{error}</p>
      </div>
    );
  }

  if (!result || !mode || !ModeIcon) {
    return null;
  }

  return (
    <section className="mt-16 animate-result-enter">
      <div className="border-b border-line pb-10">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.035)]">
            <ModeIcon className="h-4 w-4" />
            {mode.label}
          </span>
          {result.cached ? <span>Instant cached result</span> : null}
          {intentLine ? <span>{intentLine}</span> : null}
        </div>
        <h1 className="mt-7 max-w-3xl text-4xl font-semibold tracking-normal text-ink sm:text-5xl">
          {result.headline}
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-graphite">{result.explanation}</p>
        <SaveSearchButton initialSaved={savedState.savedSearch} searchId={result.id} />
      </div>

      <div className="mt-8 rounded-2xl border border-line bg-white p-6 shadow-[0_12px_44px_rgba(0,0,0,0.035)] sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">Agreement Level</p>
            <p className="mt-2 text-3xl font-semibold tracking-normal text-ink">{mode.label}</p>
            <p className="mt-3 max-w-2xl leading-7 text-graphite">{mode.description}</p>
            {rankingExplanation ? (
              <div className="mt-5 max-w-2xl border-t border-line pt-4">
                <p className="text-sm font-medium text-ink">Why this ranking?</p>
                <p className="mt-2 leading-7 text-graphite">{rankingExplanation}</p>
                {sourceMixLine ? <p className="mt-2 text-sm leading-6 text-muted">{sourceMixLine}</p> : null}
              </div>
            ) : null}
          </div>
          {winner?.consensusPercentage ? (
            <div className="w-fit shrink-0 rounded-2xl border border-[#E1E3E8] bg-[#FAFAFB] px-5 py-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <div className="text-4xl font-semibold tracking-normal text-ink">{winner.consensusPercentage}%</div>
              <div className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-muted">Consensus Strength</div>
            </div>
          ) : null}
        </div>
      </div>

      {result.mode === "no_reliable_consensus" && result.results.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-line bg-white p-8 shadow-[0_20px_70px_rgba(0,0,0,0.045)]">
          <p className="text-2xl font-semibold tracking-normal text-ink">No reliable consensus.</p>
          <p className="mt-4 max-w-2xl leading-7 text-muted">
            The available sources are too thin, too divided, or not specific enough to support a confident answer.
          </p>
        </div>
      ) : (
        <div className="mt-10 grid gap-8">
          {winner ? (
            <div>
              <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-muted">Consensus Winner</p>
              <ResultCard
                consensus={result}
                initialSaved={Boolean(savedState.savedResults[winner.id])}
                item={winner}
                searchId={result.id}
                featured
              />
            </div>
          ) : null}

          {alternatives.length ? (
            <div>
              <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-muted">
                {hasWinner ? "Alternatives" : "Top Contenders"}
              </p>
              <div className="grid gap-6">
                {alternatives.map((item) => (
                  <ResultCard
                    consensus={result}
                    initialSaved={Boolean(savedState.savedResults[item.id])}
                    item={item}
                    searchId={result.id}
                    key={item.id}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function resultStorageKey(searchId: string) {
  return `vera_result_${searchId}`;
}

function buildRankingExplanation(result: ConsensusResponse) {
  if (result.mode === "no_reliable_consensus") {
    return "Vera did not find enough reliable source agreement to name a winner.";
  }

  const [top, second] = result.results;

  if (result.mode === "split_consensus" && top && second) {
    const topScore = scoreLabel(top);
    const secondScore = scoreLabel(second);

    if (topScore && secondScore) {
      return `Top contenders are close: ${top.name} ${topScore}, ${second.name} ${secondScore}. The internet appears divided.`;
    }

    return "Top contenders are close. The internet appears divided.";
  }

  const metrics = top?.metrics;

  if (!metrics) {
    return "Vera ranked these results by recurring recommendations, source support, and visible disagreement.";
  }

  const support = sourceSupportLabel(result, metrics.sourceTypes);
  const mentions = pluralize(metrics.positiveMentionCount, "positive mention");
  const sources = pluralize(metrics.sourceCount, "source");

  return `Vera found ${mentions} across ${sources}${support ? `, with support from ${support}` : ""}.`;
}

function buildSourceMixLine(result: ConsensusResponse) {
  const sourceTypes = sourceTypesFromResult(result);
  const support = sourceSupportLabel(result, sourceTypes);

  return support ? `Sources include ${support}.` : "";
}

function buildResultTrustMetrics(item: ConsensusResponse["results"][number]) {
  const metrics = item.metrics;

  if (!metrics) {
    return "";
  }

  const parts = [
    pluralize(metrics.positiveMentionCount, "positive mention"),
    pluralize(metrics.sourceCount, "source"),
    pluralize(metrics.sourceTypes.length, "source type")
  ];

  if (metrics.editorialSupportCount > 0) {
    parts.push(pluralize(metrics.editorialSupportCount, "editorial signal"));
  }

  if (metrics.communitySupportCount > 0) {
    parts.push(pluralize(metrics.communitySupportCount, "community signal"));
  }

  if (metrics.negativeMentionCount > 0) {
    parts.push(`${pluralize(metrics.negativeMentionCount, "concern")} found`);
  }

  return parts.join(" · ");
}

function sourceTypesFromResult(result: ConsensusResponse) {
  const breakdown = result.structuredConsensus?.sourceBreakdown;

  if (breakdown) {
    return Object.entries(breakdown)
      .filter(([, count]) => count > 0)
      .map(([type]) => type);
  }

  return Array.from(new Set(result.results.flatMap((item) => item.metrics?.sourceTypes ?? [])));
}

function sourceSupportLabel(result: ConsensusResponse, sourceTypes: string[]) {
  const labels = new Set<string>();
  const hasCommunity =
    sourceTypes.includes("reddit") ||
    sourceTypes.includes("forum") ||
    result.sources.some((source) => /reddit|forum|quora|ycombinator|hacker news/i.test(`${source.domain} ${source.title}`));

  if (hasCommunity) {
    labels.add("community discussions");
  }

  if (sourceTypes.includes("editorial") || sourceTypes.includes("local_guide") || sourceTypes.includes("professional_review")) {
    labels.add("editorial guides");
  }

  if (sourceTypes.includes("review_site")) {
    labels.add("review sites");
  }

  if (sourceTypes.includes("official")) {
    labels.add("official sources");
  }

  if (!labels.size && sourceTypes.length) {
    labels.add("multiple source types");
  }

  return naturalList(Array.from(labels));
}

function scoreLabel(item: ConsensusResponse["results"][number]) {
  return item.consensusPercentage ? `${item.consensusPercentage}%` : "";
}

function pluralize(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function naturalList(items: string[]) {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function ResultCard({
  consensus,
  initialSaved = false,
  item,
  searchId,
  featured = false
}: {
  consensus: ConsensusResponse;
  initialSaved?: boolean;
  item: ConsensusResponse["results"][number];
  searchId: string;
  featured?: boolean;
}) {
  const resultHref = `/result/${buildResultSlug(item.name, searchId, item.id)}` as Route;
  const trustMetrics = buildResultTrustMetrics(item);

  useEffect(() => {
    console.log("RESULT_CARD_RENDER_NO_FETCH", { searchId, resultId: item.id });
  }, [item.id, searchId]);

  return (
    <article
      className={cn(
        "rounded-2xl border border-line bg-white p-7 transition duration-300 hover:border-[#D1D1D6] hover:shadow-[0_22px_70px_rgba(0,0,0,0.055)] sm:p-8",
        featured ? "shadow-[0_24px_80px_rgba(0,0,0,0.07)]" : "shadow-[0_12px_44px_rgba(0,0,0,0.035)]"
      )}
    >
      <div className="flex flex-col gap-7 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mist text-sm font-semibold text-ink">
              {item.rank}
            </span>
            <h2 className={cn("font-semibold tracking-normal text-ink", featured ? "text-4xl" : "text-3xl")}>
              {item.name}
            </h2>
          </div>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-graphite">{item.summary}</p>
        </div>
        {item.consensusPercentage ? (
          <div className="w-fit shrink-0 rounded-2xl border border-[#E1E3E8] bg-[#FAFAFB] px-5 py-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
            <div className="text-3xl font-semibold tracking-normal text-ink">{item.consensusPercentage}%</div>
            <div className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-muted">Consensus Strength</div>
          </div>
        ) : null}
      </div>

      {trustMetrics ? <p className="mt-5 text-sm leading-6 text-muted">{trustMetrics}</p> : null}

      <div className="mt-8">
        <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">Why people recommend it</p>
        <div className="mt-3 flex flex-wrap gap-2.5">
          {item.reasons.slice(0, 4).map((reason) => (
            <span className="rounded-full bg-mist px-3.5 py-2 text-sm text-graphite" key={reason}>
              {reason}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href={resultHref}
          prefetch={false}
          onClick={() => storeResult(consensus)}
          onMouseDown={() => storeResult(consensus)}
          onTouchStart={() => storeResult(consensus)}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-graphite"
        >
          Learn Why
        </Link>
        <SaveResultButton initialSaved={initialSaved} resultId={item.id} searchId={searchId} />
      </div>
    </article>
  );
}

function storeResult(result: ConsensusResponse) {
  window.localStorage.setItem(resultStorageKey(result.id), JSON.stringify(result));
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

function SaveSearchButton({ initialSaved = false, searchId }: { initialSaved?: boolean; searchId: string }) {
  const [status, setStatus] = useState<SaveStatus>(initialSaved ? "saved" : "idle");

  useEffect(() => {
    setStatus(initialSaved ? "saved" : "idle");
  }, [initialSaved, searchId]);

  return (
    <button
      type="button"
      disabled={status === "saving" || status === "saved"}
      onClick={() => saveSearch(searchId, setStatus)}
      className="mt-7 inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition hover:bg-mist disabled:cursor-default disabled:opacity-70"
    >
      <Bookmark className="h-4 w-4" />
      {statusLabel(status, "Save search")}
    </button>
  );
}

function SaveResultButton({
  initialSaved = false,
  searchId,
  resultId
}: {
  initialSaved?: boolean;
  searchId: string;
  resultId: string;
}) {
  const [status, setStatus] = useState<SaveStatus>(initialSaved ? "saved" : "idle");

  useEffect(() => {
    setStatus(initialSaved ? "saved" : "idle");
  }, [initialSaved, searchId, resultId]);

  return (
    <button
      type="button"
      disabled={status === "saving" || status === "saved"}
      onClick={() => saveResult(searchId, resultId, setStatus)}
      className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition hover:bg-mist disabled:cursor-default disabled:opacity-70"
    >
      <Bookmark className="h-4 w-4" />
      {statusLabel(status, "Save")}
    </button>
  );
}

function statusLabel(status: SaveStatus, idleLabel: string) {
  if (status === "saving") return "Saving...";
  if (status === "saved") return "Saved";
  if (status === "failed") return "Failed to save";
  return idleLabel;
}

async function loadSavedStateBatch(searchId: string, resultIds: string[]) {
  const actorId = getAnonymousId();
  const params = new URLSearchParams({ actorId, searchId });

  params.set("resultIds", resultIds.join(","));

  const response = await fetch(`/api/save?${params.toString()}`);

  if (!response.ok) {
    throw new Error("Could not load save state.");
  }

  return response.json() as Promise<SavedState>;
}

async function saveResult(searchId: string, resultId: string, setStatus: (status: SaveStatus) => void) {
  setStatus("saving");

  const response = await fetch("/api/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ searchId, resultId, kind: "result", actorId: getAnonymousId() })
  });

  if (!response.ok) {
    setStatus("failed");
    return;
  }

  setStatus("saved");
}

async function saveSearch(searchId: string, setStatus: (status: SaveStatus) => void) {
  setStatus("saving");

  const response = await fetch("/api/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ searchId, kind: "search", actorId: getAnonymousId() })
  });

  if (!response.ok) {
    setStatus("failed");
    return;
  }

  setStatus("saved");
}
