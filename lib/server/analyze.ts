import OpenAI from "openai";
import { z } from "zod";
import type {
  ConsensusMode,
  ConsensusResponse,
  ContenderMetrics,
  SourceSignal,
  StructuredConsensus,
  ThemeMetric,
  VeraSource,
  VeraSourceType
} from "@/lib/types";
import { normalizeQuery, slugify } from "@/lib/utils";

const sourceTypes = [
  "reddit",
  "forum",
  "review_site",
  "editorial",
  "local_guide",
  "professional_review",
  "official",
  "other"
] as const;

const SignalSchema = z.object({
  intent: z.object({
    category: z.string(),
    location: z.string().optional(),
    constraints: z.array(z.string()),
    optimizeFor: z.array(z.string()),
    avoid: z.array(z.string())
  }),
  sourceSignals: z.array(
    z.object({
      sourceUrl: z.string(),
      sourceType: z.enum(sourceTypes),
      sourceQuality: z.enum(["low", "medium", "high"]),
      mentions: z.array(
        z.object({
          contenderName: z.string(),
          sentiment: z.enum(["positive", "neutral", "negative"]),
          mentionStrength: z.enum(["weak", "moderate", "strong"]),
          positiveMention: z.string().nullable(),
          negativeMention: z.string().nullable(),
          extractedReason: z.string(),
          themes: z.array(z.string())
        })
      )
    })
  )
});

type SignalPayload = z.infer<typeof SignalSchema>;

const classificationThresholds = {
  minimumSourceCount: 3,
  minimumTotalPositiveMentions: 3,
  minimumPositiveSourceCount: 3,
  minimumTopPositiveMentions: 3,
  minimumTopSourceCount: 3,
  singleContenderModerateSourceCount: 5,
  singleContenderModeratePositiveMentions: 5,
  splitGapPoints: 8,
  splitWeightedGap: 3,
  clearScore: 85,
  clearGapPoints: 20,
  clearWeightedGap: 8,
  clearSourceCount: 8,
  clearSourceDiversityScore: 4,
  strongScore: 75,
  strongGapPoints: 12,
  strongWeightedGap: 5,
  strongSourceCount: 5,
  moderateScore: 60,
  moderateGapPoints: 8,
  moderateSourceCount: 3
} as const;

export async function analyzeConsensus(query: string, sources: VeraSource[]): Promise<ConsensusResponse> {
  const debug = await analyzeConsensusWithDebug(query, sources);
  return debug.consensus;
}

export async function analyzeConsensusWithDebug(query: string, sources: VeraSource[]) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    throw new Error("OPENAI_API_KEY is required to extract consensus from real sources.");
  }

  if (sources.length < 3) {
    const consensus = notEnoughData(query, sources, "Not enough reliable data to form a consensus.");
    return {
      rawOpenAIContent: null,
      parsedOpenAIAnalysis: null,
      consensus
    };
  }

  const sourceSignals = await extractSourceSignals(query, sources, key);
  const structuredConsensus = aggregateSignals(sourceSignals.signals, sources);

  if (structuredConsensus.contenders.length === 0) {
    const consensus = notEnoughData(query, sources, "Not enough reliable data to form a consensus.");
    consensus.intent = sourceSignals.intent;
    consensus.structuredConsensus = structuredConsensus;
    return {
      rawOpenAIContent: sourceSignals.rawOpenAIContent,
      parsedOpenAIAnalysis: sourceSignals.parsedOpenAIAnalysis,
      consensus
    };
  }

  const consensus = buildConsensus(query, sources, sourceSignals.intent, structuredConsensus);

  return {
    rawOpenAIContent: sourceSignals.rawOpenAIContent,
    parsedOpenAIAnalysis: sourceSignals.parsedOpenAIAnalysis,
    consensus
  };
}

async function extractSourceSignals(query: string, sources: VeraSource[], key: string) {
  const openai = new OpenAI({ apiKey: key });
  const sourceText = sources
    .map((source, index) => {
      return [
        `SOURCE ${index + 1}`,
        `Title: ${source.title}`,
        `URL: ${source.url}`,
        `Domain: ${source.domain}`,
        `Query variant: ${source.queryVariant ?? query}`,
        `Inferred source type: ${inferSourceType(source)}`,
        `Snippet: ${source.snippet ?? ""}`
      ].join("\n");
    })
    .join("\n\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "vera_source_signals",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["intent", "sourceSignals"],
          properties: {
            intent: {
              type: "object",
              additionalProperties: false,
              required: ["category", "location", "constraints", "optimizeFor", "avoid"],
              properties: {
                category: { type: "string" },
                location: { type: "string" },
                constraints: { type: "array", items: { type: "string" } },
                optimizeFor: { type: "array", items: { type: "string" } },
                avoid: { type: "array", items: { type: "string" } }
              }
            },
            sourceSignals: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["sourceUrl", "sourceType", "sourceQuality", "mentions"],
                properties: {
                  sourceUrl: { type: "string" },
                  sourceType: { type: "string", enum: [...sourceTypes] },
                  sourceQuality: { type: "string", enum: ["low", "medium", "high"] },
                  mentions: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "contenderName",
                        "sentiment",
                        "mentionStrength",
                        "positiveMention",
                        "negativeMention",
                        "extractedReason",
                        "themes"
                      ],
                      properties: {
                        contenderName: { type: "string" },
                        sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                        mentionStrength: { type: "string", enum: ["weak", "moderate", "strong"] },
                        positiveMention: { anyOf: [{ type: "string" }, { type: "null" }] },
                        negativeMention: { anyOf: [{ type: "string" }, { type: "null" }] },
                        extractedReason: { type: "string" },
                        themes: { type: "array", items: { type: "string" } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    messages: [
      {
        role: "system",
        content: [
          "You are Vera's source-signal extractor.",
          "Extract evidence signals only; do not rank, score, summarize, or decide a winner.",
          "Use only the provided source snippets and titles.",
          "Every mention must belong to one named contender. Do not combine contenders.",
          "Do not use generic categories, product types, or technologies as contender names when a specific named product, place, service, or option is present.",
          "sentiment must be positive, neutral, or negative.",
          "mentionStrength must be weak for passing mentions, moderate for clear recommendations, and strong for explicit best/top/ideal recommendations.",
          "positiveMention and negativeMention must be short source-grounded phrases, or null if not present.",
          "extractedReason must be a short decision-oriented reason grounded in the mention.",
          "Themes should be useful decision patterns such as romantic atmosphere, excellent cocktail program, conversation-friendly layout, strong wine program, good value, family friendly, reliable coverage, central location.",
          "Avoid shallow one-word themes when a decision-oriented phrase is supported.",
          "If a source is irrelevant or has no specific contender, return that source with an empty mentions array.",
          "Classify sourceType as reddit, forum, review_site, editorial, local_guide, professional_review, official, or other.",
          "sourceQuality should be high for reputable editorial/professional/local guides with specific recommendations, medium for useful discussions/review platforms, and low for thin, vague, promotional, or irrelevant pages."
        ].join(" ")
      },
      {
        role: "user",
        content: [`Query: ${query}`, "", sourceText].join("\n")
      }
    ]
  });

  const content = completion.choices[0]?.message.content;

  if (!content) {
    throw new Error("OpenAI did not return source signals.");
  }

  const parsed = SignalSchema.safeParse(JSON.parse(content));

  if (!parsed.success) {
    throw new Error("OpenAI returned invalid source signal JSON.");
  }

  const signals = normalizeSignals(parsed.data, sources);

  return {
    rawOpenAIContent: content,
    parsedOpenAIAnalysis: parsed.data,
    intent: parsed.data.intent,
    signals
  };
}

function normalizeSignals(payload: SignalPayload, sources: VeraSource[]): SourceSignal[] {
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));

  const rawSignals = payload.sourceSignals.flatMap((sourceSignal) => {
    const source = sourceByUrl.get(sourceSignal.sourceUrl);

    if (!source) {
      return [];
    }

    const sourceType = sourceSignal.sourceType || inferSourceType(source);
    const sourceWeight = sourceTypeWeight(sourceType);
    const sourceQuality = sourceSignal.sourceQuality || inferSourceQuality(source, sourceType);
    const sourceQualityWeight = sourceQualityWeightFor(sourceQuality);

    return sourceSignal.mentions
      .filter((mention) => mention.contenderName.trim())
      .map((mention) => ({
        sourceUrl: source.url,
        sourceTitle: source.title,
        domain: source.domain,
        sourceType,
        sourceWeight,
        sourceQuality,
        sourceQualityWeight,
        queryVariant: source.queryVariant,
        contenderName: cleanName(mention.contenderName),
        sentiment: mention.sentiment,
        mentionStrength: mention.mentionStrength,
        positiveMention: mention.sentiment === "positive" ? mention.positiveMention?.trim() || mention.extractedReason?.trim() || undefined : undefined,
        negativeMention: mention.sentiment === "negative" ? mention.negativeMention?.trim() || mention.extractedReason?.trim() || undefined : undefined,
        extractedReason: mention.extractedReason?.trim() || mention.positiveMention?.trim() || mention.negativeMention?.trim() || "Mentioned as a contender",
        themes: mention.themes.map(normalizeTheme).filter(Boolean).slice(0, 8)
      }));
  });

  const dedupedSignals = dedupeSignals(rawSignals);

  console.log("[vera:consensus] source signal extraction", {
    sourceCount: sources.length,
    rawSignalCount: rawSignals.length,
    dedupedSignalCount: dedupedSignals.length,
    removedBySourceContenderDedupe: rawSignals.length - dedupedSignals.length,
    positiveRawSignals: rawSignals.filter((signal) => signal.sentiment === "positive").length,
    positiveDedupedSignals: dedupedSignals.filter((signal) => signal.sentiment === "positive").length,
    sourceTypeBreakdown: sourceTypes.reduce(
      (breakdown, type) => ({
        ...breakdown,
        [type]: dedupedSignals.filter((signal) => signal.sourceType === type).length
      }),
      {} as Record<VeraSourceType, number>
    )
  });

  return dedupedSignals;
}

function dedupeSignals(signals: SourceSignal[]) {
  const bySourceAndContender = new Map<string, SourceSignal>();

  for (const signal of signals) {
    const key = `${signal.sourceUrl}::${signal.contenderName.toLowerCase()}`;
    const existing = bySourceAndContender.get(key);

    if (!existing) {
      bySourceAndContender.set(key, signal);
      continue;
    }

    bySourceAndContender.set(key, mergeSignals(existing, signal));
  }

  return Array.from(bySourceAndContender.values());
}

function mergeSignals(a: SourceSignal, b: SourceSignal): SourceSignal {
  const chosen = signalPower(b) > signalPower(a) ? b : a;
  const themes = Array.from(new Set([...a.themes, ...b.themes])).slice(0, 8);

  return {
    ...chosen,
    positiveMention: chosen.positiveMention ?? a.positiveMention ?? b.positiveMention,
    negativeMention: chosen.negativeMention ?? a.negativeMention ?? b.negativeMention,
    extractedReason: chosen.extractedReason || a.extractedReason || b.extractedReason,
    themes
  };
}

function signalPower(signal: SourceSignal) {
  return sentimentWeight(signal.sentiment) + mentionStrengthWeight(signal.mentionStrength) + signal.sourceQualityWeight + signal.sourceWeight;
}

function aggregateSignals(signals: SourceSignal[], sources: VeraSource[]): StructuredConsensus {
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of signals) {
    const existing = byName.get(signal.contenderName) ?? [];
    existing.push(signal);
    byName.set(signal.contenderName, existing);
  }

  const contenders = Array.from(byName.entries())
    .map(([name, contenderSignals]) => buildContenderMetrics(name, contenderSignals))
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount);

  const themeCounts = aggregateThemeCounts(signals);
  const sourceBreakdown = aggregateSourceBreakdown(sources, signals);
  const consensusClassification = classifyFromMetrics(contenders, sources.length);
  logConsensusDiagnostics(contenders, sources.length, consensusClassification);
  const winner = consensusClassification === "no_reliable_consensus" ? undefined : contenders[0]?.name;
  const mentionCounts = Object.fromEntries(
    contenders.map((contender) => [
      contender.name,
      {
        mentionCount: contender.mentionCount,
        positiveMentionCount: contender.positiveMentionCount,
        negativeMentionCount: contender.negativeMentionCount,
        sourceCount: contender.sourceCount,
        sourceDiversityScore: contender.sourceDiversityScore,
        sourceQualityScore: contender.sourceQualityScore,
        strongMentionCount: contender.strongMentionCount,
        editorialSupportCount: contender.editorialSupportCount,
        communitySupportCount: contender.communitySupportCount,
        weightedPositiveScore: contender.weightedPositiveScore,
        weightedNegativeScore: contender.weightedNegativeScore,
        netWeightedScore: contender.netWeightedScore
      }
    ])
  );

  return {
    winner,
    contenders,
    mentionCounts,
    themeCounts,
    sourceBreakdown,
    confidenceReasoning: confidenceReasoning(contenders, consensusClassification, sources.length),
    consensusClassification,
    signals
  };
}

function buildContenderMetrics(name: string, signals: SourceSignal[]): ContenderMetrics {
  const sourceUrls = Array.from(new Set(signals.map((signal) => signal.sourceUrl)));
  const sourceTypes = Array.from(new Set(signals.map((signal) => signal.sourceType)));
  const positiveMentionCount = signals.filter((signal) => signal.sentiment === "positive").length;
  const negativeMentionCount = signals.filter((signal) => signal.sentiment === "negative").length;
  const strongMentionCount = signals.filter((signal) => signal.mentionStrength === "strong").length;
  const editorialSupportCount = signals.filter((signal) => isEditorialLike(signal.sourceType) && signal.sentiment === "positive").length;
  const communitySupportCount = signals.filter((signal) => isCommunityLike(signal.sourceType) && signal.sentiment === "positive").length;
  const sourceQualityScore = round1(signals.reduce((total, signal) => total + signal.sourceQualityWeight, 0));
  const weightedPositiveScore = round1(
    signals.reduce((total, signal) => {
      if (signal.sentiment === "negative") {
        return total;
      }

      return total + signal.sourceWeight * signal.sourceQualityWeight * mentionStrengthWeight(signal.mentionStrength) * sentimentWeight(signal.sentiment);
    }, 0)
  );
  const weightedNegativeScore = round1(
    signals.reduce((total, signal) => {
      if (signal.sentiment !== "negative") {
        return total;
      }

      return total + signal.sourceWeight * signal.sourceQualityWeight * mentionStrengthWeight(signal.mentionStrength);
    }, 0)
  );
  const sourceDiversityScore = round1(sourceTypes.reduce((total, type) => total + sourceTypeWeight(type), 0));
  const netWeightedScore = round1(
    weightedPositiveScore -
      weightedNegativeScore * 0.8 +
      sourceUrls.length * 0.45 +
      sourceDiversityScore * 0.7 +
      strongMentionCount * 0.6 +
      Math.min(editorialSupportCount, 4) * 0.8 +
      Math.min(communitySupportCount, 5) * 0.45
  );

  return {
    name,
    mentionCount: signals.length,
    positiveMentionCount,
    negativeMentionCount,
    sourceCount: sourceUrls.length,
    sourceDiversityScore,
    sourceQualityScore,
    strongMentionCount,
    editorialSupportCount,
    communitySupportCount,
    weightedPositiveScore,
    weightedNegativeScore,
    netWeightedScore,
    sourceTypes,
    themeCounts: Object.values(aggregateThemeCounts(signals)).sort((a, b) => b.frequencyCount - a.frequencyCount || b.sourceCount - a.sourceCount),
    sourceUrls
  };
}

function aggregateThemeCounts(signals: SourceSignal[]) {
  const themes = new Map<string, { frequencyCount: number; sourceUrls: Set<string> }>();

  for (const signal of signals) {
    for (const theme of signal.themes) {
      const existing = themes.get(theme) ?? { frequencyCount: 0, sourceUrls: new Set<string>() };
      existing.frequencyCount += 1;
      existing.sourceUrls.add(signal.sourceUrl);
      themes.set(theme, existing);
    }
  }

  return Object.fromEntries(
    Array.from(themes.entries()).map(([theme, metric]) => [
      theme,
      {
        theme,
        frequencyCount: metric.frequencyCount,
        sourceCount: metric.sourceUrls.size,
        sourceUrls: Array.from(metric.sourceUrls)
      } satisfies ThemeMetric
    ])
  );
}

function aggregateSourceBreakdown(sources: VeraSource[], signals: SourceSignal[]) {
  const breakdown = Object.fromEntries(sourceTypes.map((type) => [type, 0])) as Record<VeraSourceType, number>;
  const signalTypeByUrl = new Map(signals.map((signal) => [signal.sourceUrl, signal.sourceType]));

  for (const source of sources) {
    const type = signalTypeByUrl.get(source.url) ?? inferSourceType(source);
    breakdown[type] += 1;
  }

  return breakdown;
}

function buildConsensus(
  query: string,
  sources: VeraSource[],
  intent: ConsensusResponse["intent"],
  structuredConsensus: StructuredConsensus
): ConsensusResponse {
  const id = crypto.randomUUID();
  const normalizedQuery = normalizeQuery(query);
  const mode = structuredConsensus.consensusClassification;
  const contenders = structuredConsensus.contenders.slice(0, 5);

  return {
    id,
    query,
    normalizedQuery,
    mode,
    headline: consensusHeadline(mode, contenders, intent),
    explanation: consensusExplanation(mode, contenders, intent),
    intent,
    results: contenders.map((contender, index) => buildResult(contender, structuredConsensus, sources, index)),
    sources,
    structuredConsensus,
    createdAt: new Date().toISOString(),
    cached: false
  };
}

function buildResult(
  contender: ContenderMetrics,
  structuredConsensus: StructuredConsensus,
  sources: VeraSource[],
  index: number
) {
  const resultSources = sources.filter((source) => contender.sourceUrls.includes(source.url));
  const contenderSignals = structuredConsensus.signals.filter((signal) => signal.contenderName === contender.name);
  const reasons = contender.themeCounts.slice(0, 6).map((theme) => humanizeTheme(theme.theme));
  const downsides = contenderSignals.map((signal) => signal.negativeMention).filter((item): item is string => Boolean(item)).slice(0, 5);
  const evidence = contenderSignals
    .map((signal) => signal.positiveMention)
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);

  return {
    id: `${slugify(contender.name)}-${index + 1}`,
    rank: index + 1,
    name: contender.name,
    consensusPercentage: consensusScore(contender),
    summary: summaryForContender(contender),
    reasons: reasons.length ? reasons : ["Recurring recommendation"],
    downsides,
    evidence,
    sources: resultSources.length ? resultSources : sources.slice(0, 3),
    metrics: contender
  };
}

function notEnoughData(query: string, sources: VeraSource[], explanation: string): ConsensusResponse {
  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    mode: "no_reliable_consensus",
    headline: "No reliable consensus.",
    explanation,
    intent: {
      category: "Decision",
      constraints: [],
      optimizeFor: [],
      avoid: []
    },
    results: [],
    sources,
    createdAt: new Date().toISOString(),
    cached: false
  };
}

function classifyFromMetrics(contenders: ContenderMetrics[], sourceCount: number): ConsensusMode {
  if (sourceCount < classificationThresholds.minimumSourceCount || contenders.length === 0) {
    return "no_reliable_consensus";
  }

  const totalPositiveMentions = contenders.reduce((total, contender) => total + contender.positiveMentionCount, 0);
  const positiveSourceCount = new Set(contenders.flatMap((contender) => (contender.positiveMentionCount > 0 ? contender.sourceUrls : []))).size;

  if (
    totalPositiveMentions < classificationThresholds.minimumTotalPositiveMentions ||
    positiveSourceCount < classificationThresholds.minimumPositiveSourceCount
  ) {
    return "no_reliable_consensus";
  }

  const top = contenders[0];
  const second = contenders[1];

  if (!top) {
    return "no_reliable_consensus";
  }

  if (top.positiveMentionCount < classificationThresholds.minimumTopPositiveMentions || top.sourceCount < classificationThresholds.minimumTopSourceCount) {
    return "split_consensus";
  }

  if (!second) {
    return top.sourceCount >= classificationThresholds.singleContenderModerateSourceCount &&
      top.positiveMentionCount >= classificationThresholds.singleContenderModeratePositiveMentions
      ? "moderate_consensus"
      : "no_reliable_consensus";
  }

  const topScore = consensusScore(top);
  const secondScore = consensusScore(second);
  const gap = topScore - secondScore;
  const weightedGap = top.netWeightedScore - second.netWeightedScore;

  if (gap < classificationThresholds.splitGapPoints || weightedGap < classificationThresholds.splitWeightedGap) {
    return "split_consensus";
  }

  if (
    topScore >= classificationThresholds.clearScore &&
    gap >= classificationThresholds.clearGapPoints &&
    weightedGap >= classificationThresholds.clearWeightedGap &&
    top.sourceCount >= classificationThresholds.clearSourceCount &&
    top.sourceDiversityScore >= classificationThresholds.clearSourceDiversityScore
  ) {
    return "clear_consensus";
  }

  if (
    topScore >= classificationThresholds.strongScore &&
    gap >= classificationThresholds.strongGapPoints &&
    weightedGap >= classificationThresholds.strongWeightedGap &&
    top.sourceCount >= classificationThresholds.strongSourceCount
  ) {
    return "strong_consensus";
  }

  if (
    topScore >= classificationThresholds.moderateScore &&
    gap >= classificationThresholds.moderateGapPoints &&
    top.sourceCount >= classificationThresholds.moderateSourceCount
  ) {
    return "moderate_consensus";
  }

  return "split_consensus";
}

function logConsensusDiagnostics(contenders: ContenderMetrics[], sourceCount: number, classification: ConsensusMode) {
  const top = contenders[0];
  const second = contenders[1];
  const totalPositiveMentions = contenders.reduce((total, contender) => total + contender.positiveMentionCount, 0);
  const positiveSourceCount = new Set(contenders.flatMap((contender) => (contender.positiveMentionCount > 0 ? contender.sourceUrls : []))).size;
  const topScore = top ? consensusScore(top) : 0;
  const secondScore = second ? consensusScore(second) : 0;
  const gap = top && second ? topScore - secondScore : null;
  const weightedGap = top && second ? round1(top.netWeightedScore - second.netWeightedScore) : null;

  console.log("[vera:consensus] thresholds", classificationThresholds);
  console.log(
    "[vera:consensus] top contender scores",
    contenders.slice(0, 5).map((contender, index) => ({
      rank: index + 1,
      name: contender.name,
      consensusScore: consensusScore(contender),
      mentionCount: contender.mentionCount,
      positiveMentionCount: contender.positiveMentionCount,
      negativeMentionCount: contender.negativeMentionCount,
      sourceCount: contender.sourceCount,
      sourceDiversityScore: contender.sourceDiversityScore,
      sourceQualityScore: contender.sourceQualityScore,
      strongMentionCount: contender.strongMentionCount,
      editorialSupportCount: contender.editorialSupportCount,
      communitySupportCount: contender.communitySupportCount,
      weightedPositiveScore: contender.weightedPositiveScore,
      weightedNegativeScore: contender.weightedNegativeScore,
      netWeightedScore: contender.netWeightedScore,
      sourceTypes: contender.sourceTypes
    }))
  );
  console.log("[vera:consensus] contender qualification failures", contenders.slice(0, 5).map(contenderQualificationDiagnostics));
  console.log("[vera:consensus] classification decision path", {
    sourceCount,
    contenderCount: contenders.length,
    totalPositiveMentions,
    positiveSourceCount,
    top: top?.name,
    second: second?.name,
    topScore,
    secondScore,
    gap,
    weightedGap,
    earlyNoReliableBecauseSourceCount: sourceCount < classificationThresholds.minimumSourceCount,
    earlyNoReliableBecauseNoContenders: contenders.length === 0,
    earlyNoReliableBecauseTotalPositiveMentions: totalPositiveMentions < classificationThresholds.minimumTotalPositiveMentions,
    earlyNoReliableBecausePositiveSourceCount: positiveSourceCount < classificationThresholds.minimumPositiveSourceCount,
    splitBecauseTopPositiveMentionsTooThin: Boolean(top && top.positiveMentionCount < classificationThresholds.minimumTopPositiveMentions),
    splitBecauseTopSourceCountTooThin: Boolean(top && top.sourceCount < classificationThresholds.minimumTopSourceCount),
    splitBecauseCloseScoreGap: gap !== null ? gap < classificationThresholds.splitGapPoints : false,
    splitBecauseCloseWeightedGap: weightedGap !== null ? weightedGap < classificationThresholds.splitWeightedGap : false,
    qualifiesClear: Boolean(
      top &&
        gap !== null &&
        weightedGap !== null &&
        topScore >= classificationThresholds.clearScore &&
        gap >= classificationThresholds.clearGapPoints &&
        weightedGap >= classificationThresholds.clearWeightedGap &&
        top.sourceCount >= classificationThresholds.clearSourceCount &&
        top.sourceDiversityScore >= classificationThresholds.clearSourceDiversityScore
    ),
    qualifiesStrong: Boolean(
      top &&
        gap !== null &&
        weightedGap !== null &&
        topScore >= classificationThresholds.strongScore &&
        gap >= classificationThresholds.strongGapPoints &&
        weightedGap >= classificationThresholds.strongWeightedGap &&
        top.sourceCount >= classificationThresholds.strongSourceCount
    ),
    qualifiesModerate: Boolean(
      top &&
        gap !== null &&
        topScore >= classificationThresholds.moderateScore &&
        gap >= classificationThresholds.moderateGapPoints &&
        top.sourceCount >= classificationThresholds.moderateSourceCount
    ),
    finalClassification: classification
  });
}

function contenderQualificationDiagnostics(contender: ContenderMetrics) {
  const score = consensusScore(contender);

  return {
    name: contender.name,
    consensusScore: score,
    failsMinimumTopPositiveMentions: contender.positiveMentionCount < classificationThresholds.minimumTopPositiveMentions,
    failsMinimumTopSourceCount: contender.sourceCount < classificationThresholds.minimumTopSourceCount,
    failsClearScore: score < classificationThresholds.clearScore,
    failsClearGap: "depends_on_gap",
    failsClearWeightedGap: "depends_on_weighted_gap",
    failsClearSourceCount: contender.sourceCount < classificationThresholds.clearSourceCount,
    failsClearSourceDiversity: contender.sourceDiversityScore < classificationThresholds.clearSourceDiversityScore,
    failsStrongScore: score < classificationThresholds.strongScore,
    failsStrongGap: "depends_on_gap",
    failsStrongWeightedGap: "depends_on_weighted_gap",
    failsStrongSourceCount: contender.sourceCount < classificationThresholds.strongSourceCount,
    failsModerateScore: score < classificationThresholds.moderateScore,
    failsModerateGap: "depends_on_gap",
    failsModerateSourceCount: contender.sourceCount < classificationThresholds.moderateSourceCount
  };
}

function consensusScore(contender: ContenderMetrics) {
  const raw =
    contender.weightedPositiveScore * 4.4 +
    contender.sourceCount * 3.2 +
    contender.sourceDiversityScore * 4.8 +
    contender.strongMentionCount * 2.8 +
    contender.editorialSupportCount * 2.6 +
    contender.communitySupportCount * 1.8 -
    contender.weightedNegativeScore * 4.5;
  return Math.max(1, Math.min(95, Math.round(raw)));
}

function consensusHeadline(mode: ConsensusMode, contenders: ContenderMetrics[], intent: ConsensusResponse["intent"]) {
  const winner = contenders[0];

  if (mode === "clear_consensus") {
    return `${winner?.name ?? "One option"} is the clear consensus pick.`;
  }

  if (mode === "strong_consensus") {
    return `${winner?.name ?? "One option"} is the consensus pick.`;
  }

  if (mode === "moderate_consensus") {
    return `${winner?.name ?? "One option"} leads, but not by enough to end the debate.`;
  }

  if (mode === "split_consensus") {
    return `The internet does not agree on one best ${decisionSubject(intent)}.`;
  }

  return "No reliable consensus.";
}

function consensusExplanation(mode: ConsensusMode, contenders: ContenderMetrics[], intent: ConsensusResponse["intent"]) {
  const winner = contenders[0];
  const second = contenders[1];
  const criteria = intent.optimizeFor.slice(0, 4);

  if (mode === "clear_consensus") {
    return `One option is recommended far more consistently than the rest. ${winner?.name ?? "The winner"} appears across ${winner?.sourceCount ?? 0} sources with ${winner?.positiveMentionCount ?? 0} positive recommendations.`;
  }

  if (mode === "strong_consensus") {
    return `${winner?.name ?? "The leading option"} has the strongest evidence pattern, with credible alternatives still present.`;
  }

  if (mode === "moderate_consensus") {
    return `${winner?.name ?? "The leading option"} has a real lead, but the gap is not large enough to call it settled.`;
  }

  if (mode === "split_consensus") {
    const comparison = winner && second ? ` ${winner.name} and ${second.name} are close in the evidence.` : "";
    return `Several options are strongly recommended.${comparison} The best choice depends on ${criteriaPhrase(criteria)}.`;
  }

  return "The available sources are too thin, too conflicting, or too weak to support a reliable consensus.";
}

function confidenceReasoning(contenders: ContenderMetrics[], mode: ConsensusMode, sourceCount: number) {
  const top = contenders[0];
  const second = contenders[1];

  if (!top) {
    return "There were not enough contender-specific signals to form a reliable consensus.";
  }

  const topLine = `${top.name} appeared in ${top.positiveMentionCount} positive recommendation${top.positiveMentionCount === 1 ? "" : "s"} across ${top.sourceCount} source${top.sourceCount === 1 ? "" : "s"}.`;
  const secondLine = second
    ? ` ${second.name} appeared in ${second.positiveMentionCount} positive recommendation${second.positiveMentionCount === 1 ? "" : "s"} across ${second.sourceCount} source${second.sourceCount === 1 ? "" : "s"}.`
    : "";

  if (mode === "split_consensus") {
    return `${topLine}${secondLine} The top contenders are close enough that Vera treats this as split consensus.`;
  }

  if (mode === "no_reliable_consensus") {
    return `Only ${sourceCount} sources were available, and the contender-specific evidence was too thin or conflicting.`;
  }

  return `${topLine}${secondLine} The weighted evidence gives ${top.name} the strongest consensus signal.`;
}

function summaryForContender(contender: ContenderMetrics) {
  const themes = contender.themeCounts.slice(0, 3).map((theme) => humanizeTheme(theme.theme).toLowerCase());

  if (themes.length) {
    return `${contender.name} is supported most often for ${criteriaPhrase(themes)}.`;
  }

  return `${contender.name} appears repeatedly in the recommendation evidence.`;
}

function decisionSubject(intent: ConsensusResponse["intent"]) {
  const rawCategory = intent.category.toLowerCase().trim();
  const location = intent.location?.trim();
  const category = cleanCategory(rawCategory);

  if (category && location && !category.includes(location.toLowerCase())) {
    return `${category} in ${location}`;
  }

  return category || "option";
}

function cleanCategory(category: string) {
  if (category.includes("restaurant") && category.includes("first date")) {
    return "first date restaurant";
  }

  return category
    .replace(/\bselection for\b/g, "")
    .replace(/\bselection\b/g, "")
    .replace(/\bchoice for\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function criteriaPhrase(criteria: string[]) {
  if (!criteria.length) {
    return "what you value most";
  }

  if (criteria.length === 1) {
    return criteria[0].toLowerCase();
  }

  const lowered = criteria.map((item) => item.toLowerCase());
  const last = lowered.pop();

  return `${lowered.join(", ")}, and ${last}`;
}

function inferSourceType(source: VeraSource): VeraSourceType {
  const value = `${source.domain} ${source.title}`.toLowerCase();

  if (value.includes("reddit")) return "reddit";
  if (value.includes("forum") || value.includes("community")) return "forum";
  if (value.includes("tripadvisor") || value.includes("booking") || value.includes("expedia") || value.includes("kayak") || value.includes("yelp")) return "review_site";
  if (value.includes("infatuation") || value.includes("eater") || value.includes("timeout") || value.includes("conde") || value.includes("cntraveler")) return "editorial";
  if (value.includes("forbes") || value.includes("wirecutter") || value.includes("consumer reports") || value.includes("usnews")) return "professional_review";
  if (value.includes("guide") || value.includes("wanderlust") || value.includes("local")) return "local_guide";
  if (value.includes("official")) return "official";

  return "other";
}

function sourceTypeWeight(type: VeraSourceType) {
  if (type === "reddit" || type === "forum" || type === "review_site") return 1;
  if (type === "editorial" || type === "local_guide" || type === "professional_review") return 2;
  if (type === "official") return 0.5;
  return 1;
}

function inferSourceQuality(source: VeraSource, type: VeraSourceType): "low" | "medium" | "high" {
  if (type === "editorial" || type === "local_guide" || type === "professional_review") {
    return "high";
  }

  if ((source.snippet?.length ?? 0) < 80 || type === "official") {
    return "low";
  }

  return "medium";
}

function sourceQualityWeightFor(quality: "low" | "medium" | "high") {
  if (quality === "high") return 1.35;
  if (quality === "medium") return 1;
  return 0.65;
}

function mentionStrengthWeight(strength: "weak" | "moderate" | "strong") {
  if (strength === "strong") return 1.45;
  if (strength === "moderate") return 1;
  return 0.45;
}

function sentimentWeight(sentiment: "positive" | "neutral" | "negative") {
  if (sentiment === "positive") return 1;
  if (sentiment === "neutral") return 0.25;
  return -1;
}

function isEditorialLike(type: VeraSourceType) {
  return type === "editorial" || type === "local_guide" || type === "professional_review";
}

function isCommunityLike(type: VeraSourceType) {
  return type === "reddit" || type === "forum";
}

function cleanName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeTheme(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeTheme(value: string) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}
