import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { getConsensusById } from "@/lib/server/cache";
import { parseResultSlug } from "@/lib/result-slug";
import type { ConsensusResponse, ConsensusResult, VeraSource } from "@/lib/types";
import { ResultClientFallback } from "./result-client-fallback";

type ResultPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

const modeLabel: Record<ConsensusResponse["mode"], string> = {
  clear_consensus: "Clear Consensus",
  strong_consensus: "Strong Consensus",
  moderate_consensus: "Moderate Consensus",
  split_consensus: "Split Consensus",
  no_reliable_consensus: "No Reliable Consensus"
};

export default async function ResultPage({ params }: ResultPageProps) {
  const { slug } = await params;
  const parsed = parseResultSlug(slug);

  if (!parsed) {
    notFound();
  }

  console.log("LEARN_WHY_READ_ONLY_FETCH", {
    searchId: parsed.searchId,
    resultId: parsed.resultId
  });

  const consensus = await getConsensusById(parsed.searchId);
  const result = consensus?.results.find((item) => item.id === parsed.resultId);

  if (!consensus || !result) {
    return <ResultClientFallback resultId={parsed.resultId} searchId={parsed.searchId} />;
  }

  const contenders = consensus.results.filter((item) => item.id !== result.id);
  const sourceSet = uniqueSources(consensus.sources.length ? consensus.sources : result.sources);
  const resultSourceSet = uniqueSources(result.sources);
  const influentialSources = (resultSourceSet.length ? resultSourceSet : sourceSet).slice(0, 3);
  const influentialUrls = new Set(influentialSources.map((source) => source.url));
  const supportingSources = sourceSet.filter((source) => !influentialUrls.has(source.url));
  const discussionSources = sourceSet.filter(isCommunitySource);
  const communities = Array.from(new Set(discussionSources.map((source) => source.domain))).slice(0, 4);
  const sourceTypes = sourceDiversity(sourceSet);
  const patternSummaries = buildPatternSummaries(result, sourceSet);

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
            {buildAnswerTitle(consensus, result)}
          </h1>
          <p className="mt-5 max-w-3xl text-xl leading-8 text-graphite">
            {buildVerdict(consensus, result)}
          </p>
        </header>

        <section className="mt-8 max-w-4xl border-t border-line pt-6">
          <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">Consensus Story</p>
          <p className="mt-4 text-xl leading-9 text-graphite">
            {buildConsensusStory(consensus, result, contenders, sourceTypes)}
          </p>
        </section>

        <ConsensusOverview
          consensus={consensus}
          result={result}
          sourceCount={sourceSet.length}
          discussionCount={discussionSources.length}
        />

        <div className="mt-9 grid gap-9">
          <DetailSection
            eyebrow="Patterns across sources"
            title="What keeps showing up"
            intro="The same themes appear in different parts of the source set."
          >
            <div className="grid gap-3">
              {patternSummaries.map((pattern) => (
                <EvidencePoint key={pattern.title} pattern={pattern} />
              ))}
            </div>
          </DetailSection>

          <DetailSection eyebrow="Tradeoffs" title="Common downsides">
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
          </DetailSection>

          <DetailSection eyebrow="Fit" title="Best for">
            <p className="max-w-3xl text-2xl font-medium leading-10 tracking-normal text-ink">
              {buildBestFor(consensus, result)}
            </p>
          </DetailSection>

          <DetailSection
            eyebrow="Decision Context"
            title="Compared with other contenders"
            intro="The useful part is the tradeoff: what each option is known for, and who it fits."
          >
            <div className="grid gap-3">
              {buildComparisons(result, contenders).map((comparison) => (
                <div className="rounded-2xl border border-line bg-white p-5 shadow-[0_14px_44px_rgba(0,0,0,0.02)]" key={comparison.name}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 className="text-xl font-semibold tracking-normal text-ink">{comparison.name}</h3>
                      <p className="mt-2 leading-7 text-graphite">{comparison.knownFor}</p>
                    </div>
                    {comparison.score ? (
                      <span className="w-fit rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink">
                        {comparison.score}% Consensus
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-5 leading-7 text-graphite">{comparison.tradeoff}</p>
                  <p className="mt-3 text-sm font-medium text-muted">{comparison.bestFor}</p>
                </div>
              ))}
            </div>
          </DetailSection>

          <DetailSection eyebrow="What people consistently agree on" title="Why Vera believes this">
            <div className="grid gap-6 rounded-3xl border border-line bg-[#FAFAFB] p-5 sm:grid-cols-[0.9fr_1.1fr] sm:p-7">
              <div className="grid gap-4">
                <Metric label="Sources reviewed" value={String(sourceSet.length)} />
                {result.metrics ? <Metric label="Positive recommendations" value={String(result.metrics.positiveMentionCount)} /> : null}
                {result.metrics ? <Metric label="Negative mentions" value={String(result.metrics.negativeMentionCount)} /> : null}
                {result.metrics ? <Metric label="Source diversity score" value={String(result.metrics.sourceDiversityScore)} /> : null}
                {discussionSources.length ? <Metric label="Community discussions reviewed" value={String(discussionSources.length)} /> : null}
                {communities.length ? <Metric label="Communities referenced" value={communities.join(", ")} /> : null}
                {sourceTypes.length ? <Metric label="Source mix" value={sourceTypes.join(", ")} /> : null}
              </div>
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">Recurring themes</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {result.reasons.slice(0, 5).map((reason) => (
                    <span className="rounded-full border border-line bg-white px-3 py-1.5 text-sm text-graphite" key={reason}>
                      {reason}
                    </span>
                  ))}
                </div>
                <p className="mt-6 leading-8 text-graphite">{buildConfidenceExplanation(consensus, result, sourceSet.length)}</p>
              </div>
            </div>
          </DetailSection>

          <DetailSection eyebrow="Source diversity" title="Sources behind the consensus">
            {sourceTypes.length ? (
              <p className="mb-5 leading-7 text-graphite">Sources include {sourceTypes.join(", ").toLowerCase()}.</p>
            ) : null}
            <div className="grid gap-6">
              <SourceGroup title="Most Influential Sources" sources={influentialSources} />
              {supportingSources.length ? <SourceGroup title="Additional Supporting Sources" sources={supportingSources} /> : null}
            </div>
          </DetailSection>
        </div>
      </article>
    </main>
  );
}

function ConsensusOverview({
  consensus,
  result,
  sourceCount,
  discussionCount
}: {
  consensus: ConsensusResponse;
  result: ConsensusResult;
  sourceCount: number;
  discussionCount: number;
}) {
  const confidence = confidenceLevel(consensus, result);

  return (
    <section className="mt-8 rounded-3xl border border-line bg-white p-5 shadow-[0_22px_70px_rgba(0,0,0,0.035)] sm:p-7">
      <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">Consensus Overview</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Consensus Level" value={modeLabel[consensus.mode]} />
        {result.consensusPercentage ? <Metric label="Consensus Strength" value={`${result.consensusPercentage}%`} /> : null}
        <Metric label="Confidence Level" value={confidence} />
        <Metric label="Sources Analyzed" value={String(sourceCount)} />
        {discussionCount ? <Metric label="Community Discussions Reviewed" value={String(discussionCount)} /> : null}
      </div>
    </section>
  );
}

function DetailSection({
  eyebrow,
  title,
  intro,
  children
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <p className="text-sm font-medium uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      <div className="mt-2 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[1.7rem] font-semibold tracking-normal text-ink">{title}</h2>
          {intro ? <p className="mt-3 max-w-2xl leading-7 text-muted">{intro}</p> : null}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function EvidencePoint({ pattern }: { pattern: PatternSummary }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-[0_12px_44px_rgba(0,0,0,0.02)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <h3 className="text-xl font-semibold tracking-normal text-ink">{pattern.title}</h3>
        {pattern.frequency ? (
          <span className="w-fit rounded-full border border-line bg-[#FAFAFB] px-3 py-1.5 text-sm font-medium text-muted">
            {pattern.frequency}
          </span>
        ) : null}
      </div>
      <p className="mt-4 leading-7 text-graphite">{pattern.summary}</p>
      {pattern.sources.length ? (
        <p className="mt-3 text-sm text-muted">Seen in {pattern.sources.join(", ")}</p>
      ) : null}
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold leading-7 tracking-normal text-ink">{value}</p>
    </div>
  );
}

type PatternSummary = {
  title: string;
  summary: string;
  frequency?: string;
  sources: string[];
};

function buildAnswerTitle(consensus: ConsensusResponse, result: ConsensusResult) {
  const decision = decisionPhrase(consensus);

  if (result.rank === 1 && consensus.mode !== "split_consensus") {
    return `Why ${result.name} is one of the strongest picks for ${decision}`;
  }

  return `Why people recommend ${result.name} for ${decision}`;
}

function buildVerdict(consensus: ConsensusResponse, result: ConsensusResult) {
  if (result.rank === 1 && consensus.mode === "clear_consensus") {
    return `${result.name} is recommended far more consistently than the rest. The same reasons keep appearing across the source set.`;
  }

  if (result.rank === 1 && consensus.mode === "strong_consensus") {
    return `${result.name} leads the conversation, with a stronger pattern of recommendations than the alternatives.`;
  }

  if (result.rank === 1 && consensus.mode === "moderate_consensus") {
    return `${result.name} has the strongest overall case, though the internet is not fully settled.`;
  }

  if (consensus.mode === "split_consensus") {
    return `${result.name} is a serious contender, but no single option dominates the conversation. The recommendation depends on which tradeoffs matter most.`;
  }

  return `${result.name} appears in the evidence, but Vera does not have enough reliable agreement to call it a consensus pick.`;
}

function buildConsensusStory(
  consensus: ConsensusResponse,
  result: ConsensusResult,
  contenders: ConsensusResult[],
  sourceTypes: string[]
) {
  const themes = naturalList(result.reasons.slice(0, 3).map((reason) => reason.toLowerCase()));
  const contender = contenders[0];
  const sourceIntro = sourceTypes.length ? `Across ${sourceTypes.join(", ").toLowerCase()}` : "Across the available sources";
  const recommendation = `${sourceIntro}, ${result.name} repeatedly appears as a serious recommendation.`;
  const agreement = themes
    ? `People consistently point to ${themes}.`
    : "The same strengths appear repeatedly enough to make it worth considering.";

  if (consensus.mode === "split_consensus" && contender) {
    return `${recommendation} ${agreement} However, ${contender.name} appears in the same conversation, which creates a split consensus rather than a clear winner.`;
  }

  if (consensus.mode === "clear_consensus") {
    return `${recommendation} ${agreement} Unlike the alternatives, it shows a clear lead in both score and consistency.`;
  }

  return `${recommendation} ${agreement} The result is a useful consensus signal, while still leaving room for personal preference.`;
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

function buildComparisons(result: ConsensusResult, contenders: ConsensusResult[]) {
  const comparisons = [result, ...contenders.slice(0, 2)];

  return comparisons.map((item) => {
    const primaryReason = item.reasons[0]?.toLowerCase() ?? "its recurring strengths";
    const secondaryReason = item.reasons[1]?.toLowerCase();
    const downside = item.downsides[0]?.toLowerCase();
    const isSelected = item.id === result.id;

    return {
      name: item.name,
      score: item.consensusPercentage,
      knownFor: secondaryReason ? `Known for ${primaryReason} and ${secondaryReason}.` : `Known for ${primaryReason}.`,
      tradeoff: isSelected
        ? `Choose ${item.name} when ${primaryReason} is the deciding factor${metricComparison(item)}${downside ? `, while accepting that ${downside}` : ""}.`
        : `Choose ${item.name} when you care more about ${primaryReason}${metricComparison(item)}${downside ? `, while accepting that ${downside}` : ""}.`,
      bestFor: `Best fit: ${item.summary}`
    };
  });
}

function metricComparison(item: ConsensusResult) {
  if (!item.metrics) {
    return "";
  }

  return `; it has ${item.metrics.positiveMentionCount} positive mention${item.metrics.positiveMentionCount === 1 ? "" : "s"} across ${item.metrics.sourceCount} source${item.metrics.sourceCount === 1 ? "" : "s"}`;
}

function buildPatternSummaries(result: ConsensusResult, sources: VeraSource[]) {
  if (result.metrics?.themeCounts.length) {
    return result.metrics.themeCounts.slice(0, 6).map((theme, index) =>
      buildPatternSummary(theme.theme, result, sources, index, {
        frequencyCount: theme.frequencyCount,
        sourceCount: theme.sourceCount,
        sourceUrls: theme.sourceUrls
      })
    );
  }

  return result.reasons.map((reason, index) => buildPatternSummary(reason, result, sources, index));
}

function buildPatternSummary(
  reason: string,
  result: ConsensusResult,
  sources: VeraSource[],
  index: number,
  metric?: { frequencyCount: number; sourceCount: number; sourceUrls: string[] }
): PatternSummary {
  const tokens = meaningfulTokens(reason);
  const matchingEvidence = uniqueText(result.evidence.filter((item) => hasTokenOverlap(item, tokens)));
  const metricUrlSet = new Set(metric?.sourceUrls ?? []);
  const matchingSources = sources.filter((source) =>
    metricUrlSet.size ? metricUrlSet.has(source.url) : source.snippet && hasTokenOverlap(`${source.title} ${source.snippet}`, tokens)
  );
  const sourceDomains = Array.from(new Set(matchingSources.map((source) => source.domain))).slice(0, 3);
  const fallbackEvidence = result.evidence[index] ?? result.evidence[0];
  const fallbackSource = sources[index] ?? sources[0];
  const sourceCount = Math.max(sourceDomains.length, matchingSources.length);
  const evidenceCount = matchingEvidence.length;
  const summarySource = matchingEvidence[0] ?? matchingSources[0]?.snippet ?? fallbackEvidence ?? fallbackSource?.snippet;

  return {
    title: reason,
    summary: summarySource
      ? patternSentence(reason, summarySource)
      : `This theme appears as one of the recurring reasons for ${result.name}.`,
    frequency: metric
      ? `Mentioned in ${metric.sourceCount} source${metric.sourceCount === 1 ? "" : "s"}`
      : frequencyLabel(sourceCount, evidenceCount, matchingSources),
    sources: sourceDomains.length ? sourceDomains : fallbackSource ? [fallbackSource.domain] : []
  };
}

function patternSentence(reason: string, source: string) {
  const lowerReason = reason.toLowerCase();
  const snippet = shorten(source, 135);

  if (lowerReason.includes("atmosphere") || lowerReason.includes("vibe") || lowerReason.includes("ambiance")) {
    return `Atmosphere is a repeated signal. ${snippet}`;
  }

  if (lowerReason.includes("cocktail") || lowerReason.includes("drink")) {
    return `The drinks program comes up as part of the recommendation. ${snippet}`;
  }

  if (lowerReason.includes("conversation") || lowerReason.includes("noise") || lowerReason.includes("intimate")) {
    return `Conversation quality is part of the pattern. ${snippet}`;
  }

  return `This theme appears more than once in the source set. ${snippet}`;
}

function frequencyLabel(sourceCount: number, evidenceCount: number, sources: VeraSource[]) {
  if (sourceCount >= 2) {
    return `Seen across ${sourceCount} sources`;
  }

  const discussions = sources.filter(isCommunitySource).length;

  if (discussions >= 1) {
    return `Seen in ${discussions} discussion${discussions === 1 ? "" : "s"}`;
  }

  if (evidenceCount >= 2) {
    return `Repeated ${evidenceCount} times`;
  }

  return undefined;
}

function buildConfidenceExplanation(consensus: ConsensusResponse, result: ConsensusResult, sourceCount: number) {
  const structured = consensus.structuredConsensus;
  const contender = result.metrics;
  const runnerUp = structured?.contenders.find((item) => item.name !== result.name);

  if (contender) {
    const runnerUpText = runnerUp
      ? ` ${runnerUp.name} appeared in ${runnerUp.positiveMentionCount} positive recommendation${runnerUp.positiveMentionCount === 1 ? "" : "s"} across ${runnerUp.sourceCount} source${runnerUp.sourceCount === 1 ? "" : "s"}.`
      : "";

    return `${result.name} appeared in ${contender.positiveMentionCount} positive recommendation${contender.positiveMentionCount === 1 ? "" : "s"} across ${contender.sourceCount} source${contender.sourceCount === 1 ? "" : "s"}.${runnerUpText} Vera classifies this as ${modeLabel[consensus.mode].toLowerCase()} because the weighted source signal, source diversity, and gap between contenders support that level of confidence.`;
  }

  const score = result.consensusPercentage ? `${result.consensusPercentage}% consensus score` : "qualitative agreement";
  const themes = result.reasons.slice(0, 3).join(", ").toLowerCase();

  if (consensus.mode === "clear_consensus") {
    return `Vera has high confidence because ${result.name} shows a strong lead and the same themes repeat across ${sourceCount} sources: ${themes}.`;
  }

  if (consensus.mode === "strong_consensus" || consensus.mode === "moderate_consensus") {
    return `Vera has ${confidenceLevel(consensus, result).toLowerCase()} confidence because ${result.name} has a meaningful pattern of support, but alternatives still appear in the evidence. The current signal is based on ${score}.`;
  }

  if (consensus.mode === "split_consensus") {
    return `Vera has measured confidence in this recommendation because the evidence supports ${result.name}, but other contenders are also repeatedly recommended. This is a tradeoff decision, not a runaway winner.`;
  }

  return "Vera does not have enough reliable agreement to make a confident recommendation from the available sources.";
}

function confidenceLevel(consensus: ConsensusResponse, result: ConsensusResult) {
  if (consensus.mode === "clear_consensus") {
    return "High";
  }

  if (consensus.mode === "strong_consensus") {
    return "Medium-high";
  }

  if (consensus.mode === "moderate_consensus") {
    return "Medium";
  }

  if (result.consensusPercentage && result.consensusPercentage >= 70) {
    return "Medium";
  }

  if (consensus.mode === "split_consensus") {
    return "Mixed";
  }

  return "Low";
}

function decisionPhrase(consensus: ConsensusResponse) {
  const query = consensus.query;
  const location = consensus.intent.location;
  const normalized = query.toLowerCase();

  if (normalized.includes("first date") && location) {
    return `first dates in ${location}`;
  }

  if (normalized.includes("first date")) {
    return "first dates";
  }

  return query
    .trim()
    .replace(/^best\s+/i, "")
    .replace(/\?+$/g, "")
    .toLowerCase();
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
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function uniqueText(items: string[]) {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = item.toLowerCase().replace(/\s+/g, " ").slice(0, 80);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isCommunitySource(source: VeraSource) {
  const value = `${source.domain} ${source.title}`.toLowerCase();
  return value.includes("reddit") || value.includes("forum") || value.includes("tripadvisor") || value.includes("community");
}

function meaningfulTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3 && !["with", "from", "that", "this", "good", "great", "best"].includes(token));
}

function hasTokenOverlap(value: string, tokens: string[]) {
  const normalized = value.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}

function shorten(value: string, maxLength = 155) {
  const cleaned = value.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength - 3).trim()}...`;
}
