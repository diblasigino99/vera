"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Bookmark } from "lucide-react";
import { NO_RELIABLE_CONSENSUS_BODY, NO_RELIABLE_CONSENSUS_TITLE } from "@/lib/types";
import type { ConsensusResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VeraThinking } from "@/components/vera-thinking";
import { SearchExperience } from "@/components/search-experience";
import { FeedbackWidget } from "@/components/feedback-widget";
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
    label: "Clear Consensus",
    description: "One winner is clearly supported by the sources."
  },
  strong_consensus: {
    label: "Strong Consensus",
    description: "One option leads, with credible alternatives below."
  },
  moderate_consensus: {
    label: "Moderate Consensus",
    description: "One option has a meaningful lead, but the field is not settled."
  },
  split_consensus: {
    label: "Split Consensus",
    description: "Several options are strongly recommended. The best choice depends on what you value most."
  },
  no_reliable_consensus: {
    label: NO_RELIABLE_CONSENSUS_TITLE,
    description: NO_RELIABLE_CONSENSUS_BODY
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
      body: JSON.stringify({ query, actorId: getAnonymousId() }),
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
  const hasWinner =
    result?.mode === "clear_consensus" ||
    result?.mode === "strong_consensus" ||
    result?.mode === "moderate_consensus";
  const winner = hasWinner ? result?.results[0] : null;
  const alternatives = hasWinner ? result?.results.slice(1) ?? [] : result?.results ?? [];

  const rankingExplanation = useMemo(() => {
    return result ? buildRankingExplanation(result) : "";
  }, [result]);

  const sourceMixLine = useMemo(() => {
    return result ? buildSourceMixLine(result) : "";
  }, [result]);

  const howVeraDecided = useMemo(() => {
    return result ? buildDecisionBullets(result) : [];
  }, [result]);

  const evidenceSummary = useMemo(() => {
    return result ? buildEvidenceSummary(result) : null;
  }, [result]);
  const isThinking = Boolean(query && (requestLoading || minimumThinking));

  if (!query) {
    return (
      <section className="mx-auto flex min-h-[72vh] w-full max-w-4xl items-center justify-center">
        <div className="w-full search-handoff-enter">
          <SearchExperience compact />
        </div>
      </section>
    );
  }

  if (isThinking) {
    return (
      <section className="mx-auto flex min-h-[76vh] w-full max-w-4xl items-center justify-center">
        <div className="w-full search-handoff-enter">
          <SearchExperience initialQuery={query} compact />
          <VeraThinking className="mt-6" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <>
        <SearchResultsNav />
        <section className="mx-auto mt-10 w-full max-w-4xl search-settle-enter">
          <SearchExperience initialQuery={query} compact />
          <div className="mx-auto mt-14 max-w-2xl rounded-2xl border border-line bg-white p-8 text-center shadow-[0_20px_70px_rgba(0,0,0,0.045)]">
            <p className="text-lg font-medium text-ink">Vera could not complete this search.</p>
            <p className="mt-3 leading-7 text-muted">{error}</p>
          </div>
        </section>
      </>
    );
  }

  if (!result || !mode) {
    return (
      <section className="mx-auto flex min-h-[72vh] w-full max-w-4xl items-center justify-center">
        <div className="w-full search-handoff-enter">
          <SearchExperience initialQuery={query} compact />
        </div>
      </section>
    );
  }

  return (
    <>
      <SearchResultsNav />
      <section className="mx-auto mt-10 w-full max-w-4xl search-settle-enter">
        <SearchExperience initialQuery={query} compact />
        <section className="mt-14 animate-result-enter">
          <div className="border-b border-[#ECECF0] pb-12">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Results for</p>
            <p className="mt-3 max-w-3xl text-lg leading-8 text-[#62626A]">{result.query}</p>
            <h1 className="mt-8 max-w-4xl text-5xl font-semibold tracking-[-0.025em] text-[#111114] sm:text-6xl">
              {buildEditorialVerdict(result, winner)}
            </h1>
            <p className="mt-7 max-w-3xl text-xl leading-9 text-[#3B3B42]">{buildEditorialExplanation(result, winner)}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3 text-sm text-[#73737C]">
              <span className="rounded-full border border-[#E8E8EC] bg-white px-3.5 py-2 font-medium text-[#111114] shadow-[0_6px_20px_rgba(17,17,20,0.035)]">
                {mode.label}
                {winner?.consensusPercentage ? ` · ${winner.consensusPercentage}%` : ""}
              </span>
              <span>{sourceMixLine || "Based on public discussions, reviews, and expert sources."}</span>
            </div>
          </div>

          {result.mode === "no_reliable_consensus" && result.results.length === 0 ? (
            <NoConsensusPanel />
          ) : (
            <div className="mt-12 grid gap-14">
              {winner ? (
                <section>
                  <ResultCard
                    consensus={result}
                    initialSaved={Boolean(savedState.savedResults[winner.id])}
                    item={winner}
                    searchId={result.id}
                    featured
                  />
                </section>
              ) : null}

              {alternatives.length ? (
                <section>
                  <p className="mb-5 text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">
                    {hasWinner ? "Other Strong Contenders" : "Strongest Contenders"}
                  </p>
                  <div className={cn("grid gap-4", !hasWinner ? "sm:grid-cols-2" : "")}>
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
                </section>
              ) : null}

              <section className="border-t border-[#ECECF0] pt-10">
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Why Vera Trusts This</p>
                <div className="mt-5 grid gap-5 text-[15px] leading-7 text-[#4B4B52] sm:grid-cols-[1.15fr_0.85fr]">
                  <div>
                    {rankingExplanation ? <p>{rankingExplanation}</p> : null}
                    {evidenceSummary ? <p className="mt-3">{evidenceSummary.primary}</p> : null}
                    {evidenceSummary?.secondary ? <p className="mt-3 text-[#73737C]">{evidenceSummary.secondary}</p> : null}
                  </div>
                  {howVeraDecided.length ? (
                    <ul className="grid gap-2.5 text-[#62626A]">
                      {howVeraDecided.slice(0, 3).map((item) => (
                        <li className="flex gap-2.5" key={item}>
                          <span className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-[#C8CBD2]" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <SaveSearchButton initialSaved={savedState.savedSearch} searchId={result.id} />
              </section>

              <SourcesSection sources={result.sources} />
              <FeedbackWidget
                consensusClassification={result.mode}
                evidenceType={result.structuredConsensus?.queryEvidenceType}
                searchQuery={result.query}
              />
            </div>
          )}
        </section>
      </section>
    </>
  );
}

function SearchResultsNav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between search-nav-enter">
      <Link href="/vera" className="font-serif text-3xl text-ink">
        Vera
      </Link>
      <Link href="/vera/profile" className="text-sm text-muted transition hover:text-ink">
        Profile
      </Link>
    </nav>
  );
}

function resultStorageKey(searchId: string) {
  return `vera_result_${searchId}`;
}

function buildEditorialVerdict(result: ConsensusResponse, winner?: ConsensusResponse["results"][number] | null) {
  if (result.mode === "split_consensus") {
    return "The internet is divided.";
  }

  if (result.mode === "no_reliable_consensus") {
    return "The internet doesn't agree.";
  }

  if (!winner) {
    return result.headline;
  }

  if (result.mode === "clear_consensus") {
    return `The internet overwhelmingly recommends ${winner.name}.`;
  }

  if (result.mode === "strong_consensus") {
    return `The internet consistently recommends ${winner.name}.`;
  }

  return `${winner.name} leads the conversation.`;
}

function buildEditorialExplanation(result: ConsensusResponse, winner?: ConsensusResponse["results"][number] | null) {
  const explanation = result.explanation || winner?.summary || "";

  if (result.mode === "no_reliable_consensus") {
    return NO_RELIABLE_CONSENSUS_BODY;
  }

  if (result.mode === "split_consensus") {
    return conciseEditorialText(explanation || "Several options received meaningful support, but no single choice clearly outperformed the rest.");
  }

  if (!winner) {
    return conciseEditorialText(explanation);
  }

  return conciseEditorialText(explanation);
}

function conciseEditorialText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [normalized];
  const concise = sentences.slice(0, 3).join(" ");

  return concise.length > 460 ? `${concise.slice(0, 457).trim()}...` : concise;
}

function NoConsensusPanel() {
  return (
    <section className="mt-12 rounded-[1.75rem] border border-[#ECECF0] bg-white p-8 shadow-[0_20px_70px_rgba(17,17,20,0.045)] sm:p-10">
      <p className="text-2xl font-semibold tracking-[-0.01em] text-[#111114]">{NO_RELIABLE_CONSENSUS_TITLE}</p>
      <p className="mt-4 max-w-2xl whitespace-pre-line text-lg leading-8 text-[#62626A]">{NO_RELIABLE_CONSENSUS_BODY}</p>
    </section>
  );
}

function SourcesSection({ sources }: { sources: ConsensusResponse["sources"] }) {
  if (!sources.length) {
    return null;
  }

  const mostInfluential = sources.slice(0, 3);
  const additional = sources.slice(3, 8);

  return (
    <section className="border-t border-[#ECECF0] pt-10">
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Sources</p>
      <div className="mt-6 grid gap-10 sm:grid-cols-2">
        <SourceList title="Most Influential Sources" sources={mostInfluential} />
        {additional.length ? <SourceList title="Additional Supporting Sources" sources={additional} quiet /> : null}
      </div>
    </section>
  );
}

function SourceList({ quiet = false, sources, title }: { quiet?: boolean; sources: ConsensusResponse["sources"]; title: string }) {
  return (
    <div>
      <p className="text-lg font-semibold tracking-[-0.01em] text-[#111114]">{title}</p>
      <div className="mt-4 border-t border-[#EFEFF2]">
        {sources.map((source) => (
          <a
            className={cn(
              "group block border-b border-[#EFEFF2] py-4 transition duration-300 hover:border-[#D9DAE0]",
              quiet ? "text-[#4B4B52]" : "text-[#202024]"
            )}
            href={source.url}
            key={`${source.url}-${source.title}`}
            rel="noreferrer"
            target="_blank"
          >
            <p className="line-clamp-2 text-sm font-medium leading-6 group-hover:text-[#111114]">{source.title}</p>
            <p className="mt-1 text-xs text-[#8A8A92]">{source.domain}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

function buildRankingExplanation(result: ConsensusResponse) {
  if (result.mode === "no_reliable_consensus") {
    return NO_RELIABLE_CONSENSUS_BODY;
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

function buildDecisionBullets(result: ConsensusResponse) {
  const sourceCount = result.sources.length;
  const support = sourceSupportLabel(result, sourceTypesFromResult(result));
  const analyzed = sourceCount ? `Vera analyzed ${pluralize(sourceCount, "source")}.` : "Vera reviewed the available source set.";

  if (result.mode === "clear_consensus" || result.mode === "strong_consensus") {
    return [
      analyzed,
      support ? `Support appeared across ${support}.` : "Support appeared across multiple source types.",
      "One contender consistently received more support than alternatives."
    ];
  }

  if (result.mode === "moderate_consensus") {
    return [
      "Multiple contenders received support.",
      "One option led the discussion but did not dominate.",
      "Consensus exists, but competing alternatives remain."
    ];
  }

  if (result.mode === "split_consensus") {
    return [
      analyzed,
      "Several contenders received similar levels of support.",
      "No single option received substantially more support than the others."
    ];
  }

  return NO_RELIABLE_CONSENSUS_BODY.split("\n\n");
}

function buildEvidenceSummary(result: ConsensusResponse) {
  const signalCount = result.structuredConsensus?.signals.length ?? result.results.reduce((total, item) => total + (item.metrics?.mentionCount ?? 0), 0);
  const support = sourceSupportLabel(result, sourceTypesFromResult(result));
  const primary = `Vera analyzed ${pluralize(result.sources.length, "source")} and found ${pluralize(signalCount, "recommendation signal")}.`;

  return {
    primary,
    secondary: support ? `Sources included ${support}.` : ""
  };
}

function buildSourceMixLine(result: ConsensusResponse) {
  const sourceTypes = sourceTypesFromResult(result);
  const support = sourceSupportLabel(result, sourceTypes);

  return support ? `Sources include ${support}.` : "";
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
  const resultHref = `/vera/result/${buildResultSlug(item.name, searchId, item.id)}` as Route;

  useEffect(() => {
    console.log("RESULT_CARD_RENDER_NO_FETCH", { searchId, resultId: item.id });
  }, [item.id, searchId]);

  return (
    <article
      className={cn(
        "rounded-[1.75rem] border border-[#EEEEF2] bg-white transition duration-300 hover:border-[#DCDDDF]",
        featured
          ? "p-8 shadow-[0_18px_54px_rgba(17,17,20,0.055),0_1px_2px_rgba(17,17,20,0.035)] sm:p-10"
          : "p-6 shadow-[0_12px_34px_rgba(17,17,20,0.035),0_1px_2px_rgba(17,17,20,0.028)] sm:p-7"
      )}
    >
      {featured ? (
        <p className="mb-5 text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Primary Recommendation</p>
      ) : null}
      <div className="min-w-0">
        <h2 className={cn("font-semibold tracking-[-0.02em] text-[#111114]", featured ? "text-4xl sm:text-5xl" : "text-2xl sm:text-3xl")}>
          {item.name}
        </h2>
        {item.verifiedAddress ? (
          <p className={cn("mt-2 leading-6 text-[#8A8A92]", featured ? "text-base" : "text-sm")}>{item.verifiedAddress}</p>
        ) : null}
        <p className={cn("mt-4 max-w-2xl leading-8 text-[#4B4B52]", featured ? "text-lg" : "text-base")}>{item.summary}</p>
      </div>

      <div className={cn("flex flex-wrap gap-2.5", featured ? "mt-7" : "mt-5")}>
        {item.reasons.slice(0, featured ? 3 : 3).map((reason) => (
          <span className="rounded-full bg-[#F6F6F8] px-3.5 py-2 text-sm text-[#4B4B52]" key={reason}>
              {reason}
            </span>
        ))}
      </div>

      <div className={cn("flex flex-wrap gap-3", featured ? "mt-8" : "mt-6")}>
        <Link
          href={resultHref}
          prefetch={false}
          onClick={() => storeResult(consensus)}
          onMouseDown={() => storeResult(consensus)}
          onTouchStart={() => storeResult(consensus)}
          className="rounded-full bg-[#111114] px-5 py-2.5 text-sm font-medium text-white shadow-[0_10px_26px_rgba(17,17,20,0.16)] transition hover:bg-[#2C2C30] hover:shadow-[0_12px_32px_rgba(17,17,20,0.2)]"
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
      className="mt-7 inline-flex items-center gap-2 rounded-full px-0 py-1 text-sm font-medium text-[#7A7A82] transition hover:text-[#111114] disabled:cursor-default disabled:opacity-70"
    >
      <Bookmark className="h-3.5 w-3.5" />
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
      className="inline-flex items-center gap-2 rounded-full border border-transparent px-3 py-2 text-sm font-medium text-[#73737C] transition hover:bg-[#F6F6F8] hover:text-[#111114] disabled:cursor-default disabled:opacity-70"
    >
      <Bookmark className="h-3.5 w-3.5" />
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
