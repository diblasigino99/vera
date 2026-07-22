"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { NO_RELIABLE_CONSENSUS_TITLE } from "@/lib/types";
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
  no_reliable_consensus: NO_RELIABLE_CONSENSUS_TITLE
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
          <Link href="/vera" className="font-serif text-3xl text-ink">
            Vera
          </Link>
          <Link href="/vera/search" className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-ink">
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

  const sources = uniqueSources(result.sources.length ? result.sources : consensus.sources);
  const sourceTypes = sourceDiversity(sources);
  const contenders = consensus.results.filter((item) => item.id !== result.id);

  return (
    <main className="min-h-screen bg-white px-5 py-8 text-ink">
      <nav className="sticky top-0 z-20 mx-auto flex w-full max-w-5xl items-center justify-between border-b border-transparent bg-white/88 py-3 backdrop-blur">
        <Link href="/vera" className="font-serif text-3xl text-ink">
          Vera
        </Link>
        <Link
          href={`/vera/search?q=${encodeURIComponent(consensus.query)}`}
          className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to results
        </Link>
      </nav>

      <article className="mx-auto mt-14 max-w-4xl">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Backstage of the verdict</p>
          <h1 className="mt-5 text-5xl font-semibold tracking-[-0.025em] text-[#111114] sm:text-6xl">
            Why Vera trusts {result.name}
          </h1>
          <p className="mt-6 max-w-3xl text-xl leading-9 text-[#3B3B42]">{buildContextParagraph(consensus, result)}</p>
          <div className="mt-7 flex flex-wrap items-center gap-3 text-sm text-[#73737C]">
            <span className="rounded-full border border-[#E8E8EC] bg-white px-3.5 py-2 font-medium text-[#111114] shadow-[0_6px_20px_rgba(17,17,20,0.035)]">
              {modeLabel[consensus.mode]}
              {result.consensusPercentage ? ` · ${result.consensusPercentage}%` : ""}
            </span>
            <span>{sourceTypes.length ? `Based on ${sourceTypes.join(", ").toLowerCase()}.` : "Based on the stored source set."}</span>
          </div>
        </header>

        <div className="mt-14 grid gap-14">
          <DetailBlock eyebrow="Why Vera believes this" title="The evidence behind the verdict">
            <p className="max-w-3xl text-xl leading-9 text-[#3B3B42]">
              {buildFallbackStory(consensus, result, contenders, sourceTypes)}
            </p>
          </DetailBlock>

          <DetailBlock eyebrow="What keeps showing up" title="What keeps showing up">
            <div className="border-t border-[#ECECF0]">
              {result.reasons.slice(0, 6).map((reason) => (
                <EvidenceRow key={reason} reason={reason} result={result} />
              ))}
            </div>
          </DetailBlock>

          <DetailBlock eyebrow="The tradeoffs" title="Where the recommendation has limits">
            {result.downsides.length ? (
              <div className="border-t border-[#ECECF0]">
                {result.downsides.map((downside) => (
                  <p className="border-b border-[#ECECF0] py-4 leading-7 text-[#4B4B52]" key={downside}>
                    {downside}
                  </p>
                ))}
              </div>
            ) : (
              <p className="leading-7 text-muted">No recurring downside showed up clearly in the evidence.</p>
            )}
          </DetailBlock>

          <DetailBlock eyebrow="Best for" title="Best for">
            <p className="max-w-3xl text-2xl font-medium leading-10 tracking-normal text-ink">{buildBestFor(consensus, result)}</p>
          </DetailBlock>

          {contenders.length ? (
            <DetailBlock eyebrow="How it compares" title="Compared with other contenders">
              <div className="border-t border-[#ECECF0]">
                {[result, ...contenders.slice(0, 2)].map((item) => (
                  <ComparisonRow item={item} selected={item.id === result.id} key={item.id} />
                ))}
              </div>
            </DetailBlock>
          ) : null}

          <DetailBlock eyebrow="Why Vera trusts this" title="How strong the evidence is">
            <div className="grid gap-8 border-t border-[#ECECF0] pt-5 sm:grid-cols-[0.8fr_1.2fr]">
              <div className="grid gap-4">
                {buildTrustFacts(result, sources, sourceTypes).map((fact) => (
                  <div key={fact.label}>
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#9B9BA3]">{fact.label}</p>
                    <p className="mt-1 text-base font-medium leading-7 text-[#111114]">{fact.value}</p>
                  </div>
                ))}
              </div>
              <p className="leading-8 text-[#4B4B52]">{buildConfidenceExplanation(consensus, result, sources.length)}</p>
            </div>
          </DetailBlock>

          <DetailBlock eyebrow="Sources behind the consensus" title="Sources behind the consensus">
            <div className="grid gap-10 sm:grid-cols-2">
              <SourceGroup title="Most Influential Sources" sources={sources.slice(0, 3)} />
              {sources.length > 3 ? <SourceGroup title="Additional Supporting Sources" sources={sources.slice(3, 8)} /> : null}
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

function EvidenceRow({ reason, result }: { reason: string; result: ConsensusResult }) {
  return (
    <div className="border-b border-[#ECECF0] py-5">
      <div className="grid gap-3 sm:grid-cols-[0.38fr_0.62fr]">
        <h3 className="text-xl font-semibold tracking-normal text-ink">{reason}</h3>
        <p className="leading-7 text-graphite">{evidenceForReason(result, reason)}</p>
      </div>
    </div>
  );
}

function ComparisonRow({ item, selected }: { item: ConsensusResult; selected: boolean }) {
  const primaryReason = item.reasons[0]?.toLowerCase() ?? "its recurring strengths";

  return (
    <div className="border-b border-[#ECECF0] py-5">
      <div className="grid gap-3 sm:grid-cols-[0.38fr_0.62fr]">
        <div>
          <h3 className="text-xl font-semibold tracking-normal text-ink">{item.name}</h3>
          {item.consensusPercentage ? <p className="mt-2 text-sm font-medium text-muted">{item.consensusPercentage}% consensus</p> : null}
        </div>
        <div>
          <p className="leading-7 text-graphite">
            {selected ? `Choose ${item.name}` : `${item.name} is a stronger fit`} when {primaryReason} matters most.
          </p>
          <p className="mt-3 text-sm font-medium text-muted">Best fit: {item.summary}</p>
        </div>
      </div>
    </div>
  );
}

function SourceGroup({ title, sources }: { title: string; sources: VeraSource[] }) {
  return (
    <div>
      <h3 className="text-xl font-semibold tracking-normal text-ink">{title}</h3>
      <div className="mt-4 grid gap-3">
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
    </div>
  );
}

function buildContextParagraph(consensus: ConsensusResponse, result: ConsensusResult) {
  const query = consensus.query.replace(/\?+$/g, "");
  const reasons = naturalList(result.reasons.slice(0, 3).map((reason) => reason.toLowerCase()));

  if (reasons) {
    return `For "${query}," Vera is looking one layer deeper at ${result.name}: where the support came from, what kept repeating, and why ${reasons} shaped the verdict.`;
  }

  return `For "${query}," Vera is looking one layer deeper at ${result.name}: where the support came from, what repeated, and why it mattered.`;
}

function buildFallbackStory(
  consensus: ConsensusResponse,
  result: ConsensusResult,
  contenders: ConsensusResult[],
  sourceTypes: string[]
) {
  const themes = naturalList(result.reasons.slice(0, 3).map((reason) => reason.toLowerCase()));
  const sourceIntro = sourceTypes.length ? `Across ${sourceTypes.join(", ").toLowerCase()}` : "Across the available sources";
  const contender = contenders[0];

  if (consensus.mode === "split_consensus" && contender) {
    return `${sourceIntro}, ${result.name} appears as a serious recommendation. People point to ${themes || "the same recurring strengths"}, but ${contender.name} appears in the same conversation, so Vera treats this as divided rather than settled.`;
  }

  return `${sourceIntro}, ${result.name} appears as a serious recommendation. People point to ${themes || "the same recurring strengths"}, which is why Vera treats it as evidence behind the verdict.`;
}

function buildBestFor(consensus: ConsensusResponse, result: ConsensusResult) {
  const strongestReason = result.reasons[0]?.toLowerCase();
  const priority = consensus.intent.optimizeFor[0]?.toLowerCase();

  if (strongestReason && priority && !strongestReason.includes(priority)) {
    return `Best for someone who values ${strongestReason}, especially when ${priority} matters.`;
  }

  if (strongestReason) {
    return `Best for someone who values ${strongestReason}.`;
  }

  if (priority) {
    return `Best for someone optimizing for ${priority}.`;
  }

  return "Best for users who want the option most consistently supported by the available sources.";
}

function buildTrustFacts(result: ConsensusResult, sources: VeraSource[], sourceTypes: string[]) {
  const facts = [
    { label: "Sources reviewed", value: String(sources.length) },
    { label: "Source mix", value: sourceTypes.length ? sourceTypes.join(", ") : "Available sources" }
  ];

  if (result.metrics) {
    facts.splice(1, 0, { label: "Positive recommendations", value: String(result.metrics.positiveMentionCount) });

    if (result.metrics.negativeMentionCount > 0) {
      facts.push({ label: "Negative mentions", value: String(result.metrics.negativeMentionCount) });
    }
  }

  return facts.slice(0, 5);
}

function buildConfidenceExplanation(consensus: ConsensusResponse, result: ConsensusResult, sourceCount: number) {
  if (result.metrics) {
    return `${result.name} appeared in ${result.metrics.positiveMentionCount} positive recommendation${result.metrics.positiveMentionCount === 1 ? "" : "s"} across ${result.metrics.sourceCount} source${result.metrics.sourceCount === 1 ? "" : "s"}. Vera classifies this as ${modeLabel[consensus.mode].toLowerCase()} because the stored source signal, source diversity, and gap between contenders support that level of confidence.`;
  }

  if (consensus.mode === "split_consensus") {
    return `Vera has measured confidence in this recommendation because the evidence supports ${result.name}, but other contenders are also repeatedly recommended.`;
  }

  return `Vera reviewed ${sourceCount} source${sourceCount === 1 ? "" : "s"} and found enough recurring support to explain why ${result.name} appears in the verdict.`;
}

function sourceDiversity(sources: VeraSource[]) {
  const types = new Set<string>();

  for (const source of sources) {
    const value = `${source.domain} ${source.title}`.toLowerCase();

    if (value.includes("reddit") || value.includes("forum")) {
      types.add("Reddit discussions");
    } else if (value.includes("tripadvisor") || value.includes("booking") || value.includes("expedia") || value.includes("kayak")) {
      types.add("review and booking sites");
    } else if (value.includes("infatuation") || value.includes("eater") || value.includes("timeout") || value.includes("conde") || value.includes("forbes")) {
      types.add("editorial reviews");
    } else {
      types.add("local guides");
    }
  }

  return Array.from(types).slice(0, 4);
}

function naturalList(items: string[]) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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
