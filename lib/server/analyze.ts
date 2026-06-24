import OpenAI from "openai";
import { z } from "zod";
import type {
  ConsensusMode,
  ConsensusResponse,
  ContenderMetrics,
  VeraEntityCategory,
  SourceSignal,
  StructuredConsensus,
  ThemeMetric,
  VeraSource,
  VeraSourceType
} from "@/lib/types";
import {
  canonicalizeQuery,
  evidenceStrategyFor,
  inferQueryEvidenceType,
  isSpecializedDominantPlatformQuery,
  normalizeQuery,
  slugify
} from "@/lib/utils";
import type { QueryEvidenceType } from "@/lib/utils";

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

const openAIModel = "gpt-4.1-mini";
const openAITimeoutMs = 8000;
const dominantPlatformOpenAITimeoutMs = 12000;
const maxOpenAISources = 5;
const maxOpenAISnippetChars = 150;
const maxOpenAICompletionTokens = 700;

const SignalSchema = z.object({
  extractions: z.array(
    z.object({
      sourceUrl: z.string(),
      contender: z.string(),
      sentiment: z.enum(["positive", "neutral", "negative"]),
      reason: z.string(),
      sourceType: z.enum(sourceTypes),
      noContender: z.boolean()
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
  clearSourceCount: 5,
  clearSourceDiversityScore: 3,
  strongScore: 75,
  strongGapPoints: 12,
  strongWeightedGap: 5,
  strongSourceCount: 4,
  moderateScore: 60,
  moderateGapPoints: 8,
  moderateSourceCount: 3
} as const;

const categoryMismatchPenalty = 12;

export async function analyzeConsensus(query: string, sources: VeraSource[]): Promise<ConsensusResponse> {
  const debug = await analyzeConsensusWithDebug(query, sources);
  return debug.consensus;
}

export function buildNoReliableConsensus(query: string, sources: VeraSource[], explanation = "Not enough reliable data to form a consensus.") {
  return notEnoughData(query, sources, explanation);
}

export async function analyzeConsensusWithDebug(query: string, sources: VeraSource[]) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    throw new Error("OPENAI_API_KEY is required to extract consensus from real sources.");
  }

  const evidenceType = inferQueryEvidenceType(query);
  const modelSources = prepareSourcesForOpenAI(sources);

  if (modelSources.length < 3) {
    const consensus = notEnoughData(query, sources, "Not enough reliable data to form a consensus.");
    return {
      rawOpenAIContent: null,
      parsedOpenAIAnalysis: null,
      consensus
    };
  }

  const sourceSignals = await extractSourceSignals(query, modelSources, key, evidenceType);
  const structuredConsensus = aggregateSignals(sourceSignals.signals, modelSources, query);

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

  const consensus = buildConsensus(query, modelSources, sourceSignals.intent, structuredConsensus);

  return {
    rawOpenAIContent: sourceSignals.rawOpenAIContent,
    parsedOpenAIAnalysis: sourceSignals.parsedOpenAIAnalysis,
    consensus
  };
}

async function extractSourceSignals(query: string, sources: VeraSource[], key: string, evidenceType: QueryEvidenceType) {
  const timeoutMs = evidenceType === "dominant_platform" ? dominantPlatformOpenAITimeoutMs : openAITimeoutMs;
  const maxSnippetChars = maxOpenAISnippetChars;
  const maxCompletionTokens = maxOpenAICompletionTokens;
  const openai = new OpenAI({ apiKey: key, timeout: timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  console.log("[vera:openai] input prepared", {
    query,
    openAIInputSources: sources.length,
    model: openAIModel,
    evidenceType,
    evidenceStrategy: evidenceStrategyFor(evidenceType),
    timeoutMs,
    maxSnippetChars,
    maxCompletionTokens
  });
  console.log("OPENAI_EXTRACTION_CONFIG", {
    evidenceType,
    inputSourceCount: sources.length,
    maxSnippetChars,
    maxCompletionTokens,
    timeoutMs
  });
  console.log("EXTRACTION_SOURCE_COUNT", sources.length);
  const sourceText = sources
    .map((source, index) => {
      return [
        `SOURCE ${index + 1}`,
        `Title: ${source.title}`,
        `URL: ${source.url}`,
        `Domain: ${source.domain}`,
        `Query variant: ${source.queryVariant ?? query}`,
        `Inferred source type: ${inferSourceType(source)}`,
        `Snippet: ${trimForOpenAI(source.snippet ?? "", maxSnippetChars)}`
      ].join("\n");
    })
    .join("\n\n");

  const completion = await openai.chat.completions.create({
    model: openAIModel,
    temperature: 0,
    max_completion_tokens: maxCompletionTokens,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          'Return exactly this JSON shape: {"extractions":[{"sourceUrl":"","contender":"","sentiment":"positive","reason":"","sourceType":"other","noContender":false}]}',
          "Extract one simple evidence record per source.",
          "Analyze each source independently.",
          "Do not rank, summarize, compare, explain consensus, or mention multiple contenders.",
          "For each source choose the single most supported named contender, if one exists.",
          "If no named contender is present, set noContender true and contender/reason to empty strings.",
          "sentiment must be positive, negative, or neutral.",
          "reason must be a short phrase grounded only in that source.",
          "sourceType must be reddit, forum, review_site, editorial, local_guide, professional_review, official, or other.",
          "Return JSON only."
        ].join(" ")
      },
      {
        role: "user",
        content: [`Query: ${query}`, "", sourceText].join("\n")
      }
    ]
  }, {
    timeout: timeoutMs,
    maxRetries: 0
  });

  const content = completion.choices[0]?.message.content;

  if (!content) {
    throw new Error("OpenAI did not return source signals.");
  }

  const parsed = SignalSchema.safeParse(JSON.parse(content));

  if (!parsed.success) {
    throw new Error("OpenAI returned invalid source signal JSON.");
  }

  const signals = normalizeSignals(parsed.data, sources, evidenceType);
  const durationMs = Date.now() - startedAt;

  console.log("[vera:openai] output received", {
    query,
    elapsedMs: durationMs,
    extractionOutputCount: parsed.data.extractions.length,
    normalizedSignals: signals.length
  });
  console.log("EXTRACTION_OUTPUT_COUNT", parsed.data.extractions.length);
  console.log("EXTRACTION_DURATION", durationMs);

  return {
    rawOpenAIContent: content,
    parsedOpenAIAnalysis: parsed.data,
    intent: intentFromQuery(query),
    signals
  };
}

function prepareSourcesForOpenAI(sources: VeraSource[]) {
  return sources.slice(0, maxOpenAISources).map((source) => ({
    ...source,
    snippet: trimForOpenAI(source.snippet ?? "", maxOpenAISnippetChars)
  }));
}

function trimForOpenAI(text: string, maxChars: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars).trim()}...` : compact;
}

function intentFromQuery(query: string): ConsensusResponse["intent"] {
  const normalized = normalizeQuery(query);
  const category = normalized
    .replace(/\b(best|top|great|good|recommended|highest rated|most recommended)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    category: category || "Decision",
    location: "",
    constraints: [],
    optimizeFor: [],
    avoid: []
  };
}

function inferMentionStrength(reason: string): SourceSignal["mentionStrength"] {
  const normalized = normalizeQuery(reason);

  if (/\b(best|top|favorite|strongly recommend|most recommended|clear winner|dominant|default)\b/.test(normalized)) {
    return "strong";
  }

  if (/\b(recommend|recommended|good|great|useful|popular|credible|strong)\b/.test(normalized)) {
    return "moderate";
  }

  return "weak";
}

function normalizeSignals(payload: SignalPayload, sources: VeraSource[], evidenceType: QueryEvidenceType): SourceSignal[] {
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));

  const rawSignals = payload.extractions.flatMap((extraction) => {
    const source = sourceByUrl.get(extraction.sourceUrl);

    if (!source || extraction.noContender || !extraction.contender.trim()) {
      return [];
    }

    const sourceType = extraction.sourceType || inferSourceType(source);
    const sourceWeight = sourceTypeWeight(sourceType, evidenceType);
    const sourceQuality = inferSourceQuality(source, sourceType);
    const sourceQualityWeight = sourceQualityWeightFor(sourceQuality);
    const reason = extraction.reason.trim() || "Mentioned as a contender";
    const sentiment = extraction.sentiment;

    return [
      {
        sourceUrl: source.url,
        sourceTitle: source.title,
        domain: source.domain,
        sourceType,
        sourceWeight,
        sourceQuality,
        sourceQualityWeight,
        queryVariant: source.queryVariant,
        contenderName: cleanName(extraction.contender),
        sentiment,
        mentionStrength: inferMentionStrength(reason),
        positiveMention: sentiment === "positive" ? reason : undefined,
        negativeMention: sentiment === "negative" ? reason : undefined,
        extractedReason: reason,
        themes: [normalizeTheme(reason)].filter(Boolean).slice(0, 1)
      } satisfies SourceSignal
    ];
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

function aggregateSignals(signals: SourceSignal[], sources: VeraSource[], query: string): StructuredConsensus {
  const intendedCategory = inferIntendedCategory(query);
  const queryEvidenceType = inferQueryEvidenceType(query);
  const evidenceStrategy = evidenceStrategyFor(queryEvidenceType);
  const specializedDominantPlatformQuery = queryEvidenceType === "dominant_platform" && isSpecializedDominantPlatformQuery(query);
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of signals) {
    const existing = byName.get(signal.contenderName) ?? [];
    existing.push(signal);
    byName.set(signal.contenderName, existing);
  }

  const contendersBeforeFiltering = Array.from(byName.entries())
    .map(([name, contenderSignals]) =>
      applyEvidenceStrategy(
        applyCategoryRelevance(buildContenderMetrics(name, contenderSignals, queryEvidenceType), intendedCategory, contenderSignals),
        query,
        queryEvidenceType,
        specializedDominantPlatformQuery,
        contenderSignals
      )
    )
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount);

  const { contenders, removed } = filterContendersByCategory(contendersBeforeFiltering, intendedCategory);
  const contenderNames = new Set(contenders.map((contender) => contender.name));
  const filteredSignals = signals.filter((signal) => contenderNames.has(signal.contenderName));
  console.log("INTENDED_CATEGORY", intendedCategory);
  console.log(
    "CONTENDER_CATEGORY",
    contendersBeforeFiltering.map((contender) => ({
      name: contender.name,
      contenderCategory: contender.contenderCategory,
      categoryConfidence: contender.categoryConfidence,
      netWeightedScore: contender.netWeightedScore
    }))
  );
  console.log(
    "CATEGORY_CONFIDENCE",
    contendersBeforeFiltering.map((contender) => ({
      name: contender.name,
      confidence: contender.categoryConfidence
    }))
  );
  console.log("FILTERED_CONTENDERS", removed);
  console.log("QUERY_EVIDENCE_TYPE", queryEvidenceType);
  console.log("EVIDENCE_STRATEGY", evidenceStrategy);
  console.log("WEIGHTED_SOURCE_TYPES", weightedSourceTypes(queryEvidenceType));

  const themeCounts = aggregateThemeCounts(filteredSignals);
  const sourceBreakdown = aggregateSourceBreakdown(sources, filteredSignals);
  const consensusClassification = classifyFromMetrics(contenders, sources.length, queryEvidenceType);
  logConsensusDiagnostics(contenders, sources.length, consensusClassification);
  console.log(
    "FINAL_CONTENDERS",
    contenders.slice(0, 5).map((contender, index) => ({
      rank: index + 1,
      name: contender.name,
      consensusScore: consensusScore(contender),
      netWeightedScore: contender.netWeightedScore,
      positiveMentionCount: contender.positiveMentionCount,
      sourceCount: contender.sourceCount,
      sourceTypes: contender.sourceTypes
    }))
  );
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
    intendedCategory,
    queryEvidenceType,
    evidenceStrategy,
    contenders,
    mentionCounts,
    themeCounts,
    sourceBreakdown,
    confidenceReasoning: confidenceReasoning(contenders, consensusClassification, sources.length),
    consensusClassification,
    signals: filteredSignals
  };
}

function buildContenderMetrics(name: string, signals: SourceSignal[], evidenceType: QueryEvidenceType): ContenderMetrics {
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
  const sourceDiversityScore = round1(sourceTypes.reduce((total, type) => total + sourceTypeWeight(type, evidenceType), 0));
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
    contenderCategory: "other",
    categoryConfidence: "low",
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

function applyCategoryRelevance(metrics: ContenderMetrics, intendedCategory: VeraEntityCategory, signals: SourceSignal[]): ContenderMetrics {
  const detected = inferContenderCategory(metrics.name, signals);
  const shouldPenalty = intendedCategory !== "other" && detected.categoryConfidence !== "high" && !isAllowedCategory(intendedCategory, detected.contenderCategory, signals);

  return {
    ...metrics,
    contenderCategory: detected.contenderCategory,
    categoryConfidence: detected.categoryConfidence,
    netWeightedScore: shouldPenalty ? round1(metrics.netWeightedScore - categoryMismatchPenalty) : metrics.netWeightedScore
  };
}

function applyEvidenceStrategy(
  metrics: ContenderMetrics,
  query: string,
  evidenceType: QueryEvidenceType,
  specializedDominantPlatformQuery: boolean,
  signals: SourceSignal[]
): ContenderMetrics {
  if (evidenceType !== "dominant_platform") {
    return metrics;
  }

  const defaultPlatform = dominantPlatformForQuery(query);
  const isDefaultPlatform = defaultPlatform ? contenderMatchesPlatform(metrics.name, defaultPlatform.aliases) : false;
  const broadEvidenceSignals = signals.filter((signal) => {
    const text = normalizeQuery(`${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""} ${signal.themes.join(" ")}`);
    return /\b(market share|dominant|default|most used|widely used|usage|leader|standard|popular|mainstream)\b/.test(text);
  }).length;
  const expertSignals = signals.filter((signal) => isEditorialLike(signal.sourceType)).length;
  const privacySignals = signals.filter((signal) => {
    const text = normalizeQuery(`${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""} ${signal.themes.join(" ")}`);
    return /\b(private|privacy|independent|secure|anonymous|tracking|no tracking)\b/.test(text);
  }).length;
  const defaultBoost = !specializedDominantPlatformQuery && isDefaultPlatform ? 18 : 0;
  const broadEvidenceBoost = Math.min(broadEvidenceSignals, 4) * 2.2;
  const expertEvidenceBoost = Math.min(expertSignals, 4) * 1.4;
  const nichePenalty = !specializedDominantPlatformQuery && !isDefaultPlatform && privacySignals >= 2 ? 5 : 0;
  const privacyBoost = specializedDominantPlatformQuery && privacySignals > 0 ? Math.min(privacySignals, 4) * 2.5 : 0;
  const netWeightedScore = round1(metrics.netWeightedScore + defaultBoost + broadEvidenceBoost + expertEvidenceBoost + privacyBoost - nichePenalty);

  return {
    ...metrics,
    weightedPositiveScore: round1(metrics.weightedPositiveScore + defaultBoost / 4 + broadEvidenceBoost / 3 + expertEvidenceBoost / 4 + privacyBoost / 3),
    netWeightedScore
  };
}

function dominantPlatformForQuery(query: string) {
  const normalized = normalizeQuery(query);

  if (/\bsearch engine\b/.test(normalized)) {
    return { label: "Google", aliases: ["google", "google search"] };
  }

  if (/\bbrowser\b/.test(normalized)) {
    return { label: "Google Chrome", aliases: ["chrome", "google chrome"] };
  }

  if (/\b(email provider|email service|mail provider)\b/.test(normalized)) {
    return { label: "Gmail", aliases: ["gmail", "google mail"] };
  }

  if (/\b(maps app|map app|navigation app)\b/.test(normalized)) {
    return { label: "Google Maps", aliases: ["google maps"] };
  }

  if (/\b(video platform|video site)\b/.test(normalized)) {
    return { label: "YouTube", aliases: ["youtube"] };
  }

  return null;
}

function contenderMatchesPlatform(name: string, aliases: string[]) {
  const normalized = normalizeQuery(name);
  return aliases.some((alias) => normalized === alias || normalized.includes(alias));
}

function filterContendersByCategory(contenders: ContenderMetrics[], intendedCategory: VeraEntityCategory) {
  const removed: Array<{
    name: string;
    contenderCategory: VeraEntityCategory;
    categoryConfidence: ContenderMetrics["categoryConfidence"];
    reason: string;
  }> = [];
  const kept = contenders.filter((contender) => {
    if (intendedCategory === "other" || isAllowedCategory(intendedCategory, contender.contenderCategory)) {
      return true;
    }

    if (contender.categoryConfidence !== "high") {
      return true;
    }

    removed.push({
      name: contender.name,
      contenderCategory: contender.contenderCategory,
      categoryConfidence: contender.categoryConfidence,
      reason: `Removed because ${contender.contenderCategory} does not match requested ${intendedCategory}.`
    });
    return false;
  });

  return {
    contenders: kept.sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount),
    removed
  };
}

function inferIntendedCategory(query: string): VeraEntityCategory {
  const normalized = normalizeQuery(query);

  if (/\b(coffee shop|cafe|café|espresso)\b/.test(normalized)) return "cafe";
  if (/\b(bar|pub|cocktail|brewery|taproom|speakeasy)\b/.test(normalized)) return "bar";
  if (/\b(restaurant|pizza|pizzeria|sushi|steakhouse|diner|brunch|lunch|dinner|place to eat|food)\b/.test(normalized)) return "restaurant";
  if (/\b(hotel|motel|inn|resort|lodging|place to stay)\b/.test(normalized)) return "hotel";
  if (/\b(golf course|golf club|country club|links)\b/.test(normalized)) return "golf_course";
  if (/\b(crm|software|app|platform|tool|ai coding assistant|coding assistant)\b/.test(normalized)) return "software";
  if (/\b(shoe|shoes|suitcase|router|headphones|laptop|phone|mattress|product)\b/.test(normalized)) return "product";
  if (/\b(service|contractor|agency|consultant)\b/.test(normalized)) return "service";

  return "other";
}

function inferContenderCategory(name: string, signals: SourceSignal[]): {
  contenderCategory: VeraEntityCategory;
  categoryConfidence: ContenderMetrics["categoryConfidence"];
} {
  const nameText = normalizeQuery(name);
  const signalText = normalizeQuery(
    signals
      .map((signal) => [signal.sourceTitle, signal.domain, signal.extractedReason, signal.positiveMention, signal.negativeMention, signal.themes.join(" ")].filter(Boolean).join(" "))
      .join(" ")
  );
  const combined = `${nameText} ${signalText}`;

  const named = categoryFromText(nameText);
  if (named) {
    return { contenderCategory: named, categoryConfidence: "high" };
  }

  const contextual = categoryFromText(combined);
  if (contextual) {
    return { contenderCategory: contextual, categoryConfidence: "medium" };
  }

  return { contenderCategory: "other", categoryConfidence: "low" };
}

function categoryFromText(text: string): VeraEntityCategory | null {
  if (/\b(liquor|liquors|wine|wines|spirits|package store|bottle shop)\b/.test(text)) return "liquor_store";
  if (/\b(grocery|supermarket|market|food market|whole foods|trader joe)\b/.test(text)) return "grocery_store";
  if (/\b(hotel|motel|inn|resort|lodge|lodging)\b/.test(text)) return "hotel";
  if (/\b(golf course|golf club|country club|links|fairway|tee time)\b/.test(text)) return "golf_course";
  if (/\b(coffee shop|cafe|café|espresso|roaster|roastery)\b/.test(text)) return "cafe";
  if (/\b(bar|pub|tavern|cocktail|brewery|taproom|speakeasy)\b/.test(text)) return "bar";
  if (/\b(restaurant|pizzeria|pizza|trattoria|bistro|diner|grill|taqueria|sushi|steakhouse|brasserie|osteria|ramen|noodle|kitchen|eatery|cuisine)\b/.test(text)) {
    return "restaurant";
  }
  if (/\b(crm|software|saas|platform|app|ai coding assistant|coding assistant)\b/.test(text)) return "software";
  if (/\b(shoe|shoes|suitcase|router|headphones|laptop|phone|mattress)\b/.test(text)) return "product";
  if (/\b(shop|store|retail|boutique|mall|pharmacy|hardware)\b/.test(text)) return "retail";
  if (/\b(museum|park|beach|theater|theatre|attraction|landmark)\b/.test(text)) return "attraction";
  if (/\b(service|agency|consultant|contractor)\b/.test(text)) return "service";

  return null;
}

function isAllowedCategory(intendedCategory: VeraEntityCategory, contenderCategory: VeraEntityCategory, signals: SourceSignal[] = []) {
  if (intendedCategory === "other") return true;
  if (intendedCategory === contenderCategory) return true;

  const signalText = normalizeQuery(signals.map((signal) => `${signal.sourceTitle} ${signal.extractedReason} ${signal.themes.join(" ")}`).join(" "));

  if (intendedCategory === "restaurant") {
    return contenderCategory === "bar" && /\b(food|menu|dining|restaurant|kitchen|grill|pizza|dinner|brunch)\b/.test(signalText);
  }

  if (intendedCategory === "bar") {
    return contenderCategory === "restaurant" && /\b(bar|cocktail|drinks|pub|brewery|wine bar)\b/.test(signalText);
  }

  if (intendedCategory === "software") {
    return contenderCategory === "product" || contenderCategory === "service";
  }

  if (intendedCategory === "product") {
    return contenderCategory === "software" || contenderCategory === "service" || contenderCategory === "other";
  }

  return false;
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
  const createdAt = new Date().toISOString();

  return {
    id,
    query,
    normalizedQuery,
    canonicalQuery: canonicalizeQuery(query),
    generated_at: createdAt,
    model: openAIModel,
    mode,
    headline: consensusHeadline(mode, contenders, intent),
    explanation: consensusExplanation(mode, contenders, intent),
    intent,
    results: contenders.map((contender, index) => buildResult(contender, structuredConsensus, sources, index)),
    sources,
    structuredConsensus,
    createdAt,
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
  const createdAt = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    generated_at: createdAt,
    model: openAIModel,
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
    createdAt,
    cached: false
  };
}

function classifyFromMetrics(contenders: ContenderMetrics[], sourceCount: number, evidenceType: QueryEvidenceType): ConsensusMode {
  if (sourceCount < classificationThresholds.minimumSourceCount || contenders.length === 0) {
    return "no_reliable_consensus";
  }

  const totalPositiveMentions = contenders.reduce((total, contender) => total + contender.positiveMentionCount, 0);
  const positiveSourceCount = new Set(contenders.flatMap((contender) => (contender.positiveMentionCount > 0 ? contender.sourceUrls : []))).size;
  const top = contenders[0];
  const hasDominantPlatformEvidence =
    evidenceType === "dominant_platform" &&
    Boolean(top) &&
    top.sourceCount >= classificationThresholds.minimumTopSourceCount &&
    top.netWeightedScore >= 12;

  if (
    !hasDominantPlatformEvidence &&
    (totalPositiveMentions < classificationThresholds.minimumTotalPositiveMentions ||
      positiveSourceCount < classificationThresholds.minimumPositiveSourceCount)
  ) {
    return "no_reliable_consensus";
  }

  const second = contenders[1];

  if (!top) {
    return "no_reliable_consensus";
  }

  if (top.positiveMentionCount < classificationThresholds.minimumTopPositiveMentions || top.sourceCount < classificationThresholds.minimumTopSourceCount) {
    return "split_consensus";
  }

  if (!second) {
    return top.sourceCount >= classificationThresholds.moderateSourceCount &&
      top.positiveMentionCount >= classificationThresholds.minimumTotalPositiveMentions
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

function weightedSourceTypes(evidenceType: QueryEvidenceType) {
  return Object.fromEntries(sourceTypes.map((type) => [type, sourceTypeWeight(type, evidenceType)]));
}

function sourceTypeWeight(type: VeraSourceType, evidenceType: QueryEvidenceType = "local_recommendation") {
  if (evidenceType === "dominant_platform") {
    if (type === "professional_review") return 2.2;
    if (type === "editorial") return 2;
    if (type === "review_site") return 1.4;
    if (type === "official") return 1.2;
    if (type === "reddit" || type === "forum") return 0.8;
    if (type === "local_guide") return 1;
    return 1;
  }

  if (evidenceType === "product_recommendation" || evidenceType === "software_tool") {
    if (type === "professional_review") return 2.2;
    if (type === "editorial") return 1.8;
    if (type === "review_site") return 1.4;
    if (type === "reddit" || type === "forum") return 1;
    if (type === "local_guide") return 1;
    if (type === "official") return 0.5;
    return 1;
  }

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
