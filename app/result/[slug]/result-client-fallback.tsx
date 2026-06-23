"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ConsensusResponse, ConsensusResult, VeraSource } from "@/lib/types";

type ResultClientFallbackProps = {
  searchId: string;
  resultId: string;
};

const modeLabel: Record<ConsensusResponse["mode"], string> = {
  clear_consensus: "Clear Consensus",
  strong_consensus: "Strong Consensus",
  moderate_consensus: "Moderate Consensus",
  split_consensus: "Split Consensus",
  no_reliable_consensus: "No Reliable Consensus"
};

export function ResultClientFallback({ searchId, resultId }: ResultClientFallbackProps) {
  const [consensus, setConsensus] = useState<ConsensusResponse | null>(null);
  const result = consensus?.results.find((item) => item.id === resultId);

  useEffect(() => {
    const stored = window.localStorage.getItem(`vera_result_${searchId}`);

    if (!stored) {
      return;
    }

    try {
      setConsensus(JSON.parse(stored) as ConsensusResponse);
    } catch {
      setConsensus(null);
    }
  }, [searchId]);

  if (!consensus || !result) {
    return (
      <main className="min-h-screen bg-white px-5 py-8 text-ink">
        <nav className="mx-auto flex w-full max-w-5xl items-center justify-between">
          <Link href="/" className="font-serif text-3xl text-ink">
            Vera
          </Link>
          <Link href="/search" className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-ink">
            <ArrowLeft className="h-4 w-4" />
            Back to results
          </Link>
        </nav>
        <section className="mx-auto mt-16 max-w-3xl rounded-2xl border border-line bg-white p-8 shadow-[0_20px_70px_rgba(0,0,0,0.045)]">
          <p className="text-2xl font-semibold tracking-normal text-ink">This result is not available.</p>
          <p className="mt-4 leading-7 text-muted">
            Vera could not find the saved result for this detail page. Run the search again and open Learn Why from the results.
          </p>
        </section>
      </main>
    );
  }

  const sources = uniqueSources(result.sources.length ? result.sources : consensus.sources).slice(0, 8);

  return (
    <main className="min-h-screen bg-white px-5 py-8 text-ink">
      <nav className="sticky top-0 z-20 mx-auto flex w-full max-w-5xl items-center justify-between border-b border-transparent bg-white/88 py-3 backdrop-blur">
        <Link href="/" className="font-serif text-3xl text-ink">
          Vera
        </Link>
        <Link
          href={`/search?q=${encodeURIComponent(consensus.query)}`}
          className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to results
        </Link>
      </nav>

      <article className="mx-auto mt-14 max-w-5xl">
        <header className="max-w-4xl">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span className="rounded-full border border-line bg-white px-3.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.03)]">
              {modeLabel[consensus.mode]}
            </span>
            {result.consensusPercentage ? (
              <span className="rounded-full border border-line bg-[#FAFAFB] px-3.5 py-2 font-medium text-ink">
                {result.consensusPercentage}% Consensus
              </span>
            ) : null}
          </div>

          <h1 className="mt-7 text-4xl font-semibold tracking-normal text-ink sm:text-5xl">
            Why people recommend {result.name}
          </h1>
          <p className="mt-5 max-w-3xl text-xl leading-8 text-graphite">{result.summary}</p>
        </header>

        <div className="mt-10 grid gap-9">
          <DetailBlock eyebrow="Patterns across sources" title="What keeps showing up">
            <div className="grid gap-3">
              {result.reasons.slice(0, 6).map((reason) => (
                <div className="rounded-2xl border border-line bg-white p-5 shadow-[0_12px_44px_rgba(0,0,0,0.02)]" key={reason}>
                  <p className="text-xl font-semibold tracking-normal text-ink">{reason}</p>
                  <p className="mt-3 leading-7 text-graphite">{evidenceForReason(result, reason)}</p>
                </div>
              ))}
            </div>
          </DetailBlock>

          <DetailBlock eyebrow="Tradeoffs" title="Common downsides">
            {result.downsides.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {result.downsides.map((downside) => (
                  <p className="border-t border-line pt-4 leading-7 text-graphite" key={downside}>
                    {downside}
                  </p>
                ))}
              </div>
            ) : (
              <p className="leading-7 text-muted">No recurring downside showed up clearly in the evidence.</p>
            )}
          </DetailBlock>

          <DetailBlock eyebrow="Evidence" title="Why Vera believes this">
            <div className="grid gap-4 rounded-3xl border border-line bg-[#FAFAFB] p-5 sm:grid-cols-3 sm:p-7">
              {result.metrics ? <Metric label="Positive recommendations" value={String(result.metrics.positiveMentionCount)} /> : null}
              {result.metrics ? <Metric label="Sources mentioning it" value={String(result.metrics.sourceCount)} /> : null}
              {result.metrics ? <Metric label="Source diversity score" value={String(result.metrics.sourceDiversityScore)} /> : null}
            </div>
          </DetailBlock>

          <DetailBlock eyebrow="Sources" title="Sources behind this result">
            <div className="grid gap-3">
              {sources.map((source) => (
                <a
                  className="flex flex-col gap-2 border-t border-line py-4 transition hover:border-[#C9CBD1] sm:flex-row sm:items-center sm:justify-between"
                  href={source.url}
                  key={source.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <div>
                    <p className="font-medium text-ink">{source.title}</p>
                    <p className="mt-1 text-sm text-muted">{source.domain}</p>
                  </div>
                  <ExternalLink className="h-4 w-4 shrink-0 text-muted" />
                </a>
              ))}
            </div>
          </DetailBlock>
        </div>
      </article>
    </main>
  );
}

function DetailBlock({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      <div className="mt-2 border-t border-line pt-4">
        <h2 className="text-[1.7rem] font-semibold tracking-normal text-ink">{title}</h2>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold leading-7 tracking-normal text-ink">{value}</p>
    </div>
  );
}

function evidenceForReason(result: ConsensusResult, reason: string) {
  const tokens = reason.toLowerCase().split(/\s+/).filter((token) => token.length > 3);
  const evidence = result.evidence.find((item) => tokens.some((token) => item.toLowerCase().includes(token)));
  return evidence ?? `This appears as one of the recurring reasons for ${result.name}.`;
}

function uniqueSources(sources: VeraSource[]) {
  const seen = new Set<string>();

  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }

    seen.add(source.url);
    return true;
  });
}
