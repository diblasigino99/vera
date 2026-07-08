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
  normalizeLocalQueryIntent,
  parseLocalIntent,
  parseLocalQueryConstraints,
  slugify
} from "@/lib/utils";
import type { ExternalCallCounts } from "@/lib/server/external-call-counts";
import { getCachedPlacesValidationSnapshot, validateLocalSignalsWithPlaces } from "@/lib/server/places";
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
const openAITimeoutMs = 10000;
const dominantPlatformOpenAITimeoutMs = 12000;
const localRecommendationOpenAITimeoutMs = 5500;
const maxOpenAISources = 8;
const maxLocalOpenAISources = 8;
const maxOpenAISnippetChars = 150;
const maxLocalOpenAISnippetChars = 120;
const maxLocalEnrichedOpenAIChars = 1800;
const maxOpenAICompletionTokens = 1400;
const maxLocalOpenAICompletionTokens = 1000;
const localRecoveryOpenAITimeoutMs = 6500;
const maxLocalRecoverySources = 10;
const maxLocalRecoverySnippetChars = 180;
const maxLocalRecoveryCompletionTokens = 700;
const maxOpenAICallsPerRequest = 3;

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

const LocalBusinessNameRecoverySchema = z.object({
  businesses: z.array(
    z.object({
      name: z.string(),
      sourceUrl: z.string()
    })
  )
});

type LocalPlaceCandidate = {
  name: string;
  evidenceText: string;
  sourceUrl: string;
  sourceTitle: string;
  queryVariant?: string;
  extractionSource: "title" | "snippet" | "url" | "metadata";
  confidence: number;
  editorialContextScore?: number;
  positionScore?: number;
  positionIndex?: number;
  bodyMatch?: boolean;
};

type LocalCandidateConfidenceLevel = "high" | "medium" | "low";

type LocalPlaceExtractionDiagnostic = LocalPlaceCandidate & {
  accepted: boolean;
  rejectionReason?: string;
};

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

export async function analyzeConsensus(query: string, sources: VeraSource[], callCounts?: ExternalCallCounts): Promise<ConsensusResponse> {
  const debug = await analyzeConsensusWithDebug(query, sources, callCounts);
  return debug.consensus;
}

export function buildNoReliableConsensus(query: string, sources: VeraSource[], explanation = "Not enough reliable data to form a consensus.") {
  return notEnoughData(query, sources, explanation);
}

export function buildDominantPlatformFallbackConsensus(
  query: string,
  sources: VeraSource[],
  explanation = "Vera found strong platform-default evidence, but not enough clean agreement to compare every alternative confidently."
): ConsensusResponse | null {
  const evidenceType = inferQueryEvidenceType(query);
  const incumbent = dominantPlatformForQuery(query);

  if (evidenceType !== "dominant_platform" || isSpecializedDominantPlatformQuery(query) || !incumbent || sources.length < 3) {
    return null;
  }

  const supportSources = sources.filter((source) => sourceMentionsPlatform(source, incumbent.aliases));
  const resultSources = (supportSources.length ? supportSources : sources).slice(0, 5);
  const createdAt = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    generated_at: createdAt,
    model: openAIModel,
    mode: "moderate_consensus",
    headline: `${incumbent.label} is the default consensus pick.`,
    explanation,
    intent: intentFromQuery(query),
    results: [
      {
        id: `${slugify(incumbent.label)}-1`,
        rank: 1,
        name: incumbent.label,
        consensusPercentage: 70,
        summary: `${incumbent.label} appears as the broad default for this platform category, with alternatives still worth comparing.`,
        reasons: ["Default incumbent", "Broad recognition", "Market-leading usage"],
        downsides: [],
        evidence: [explanation],
        sources: resultSources
      }
    ],
    sources,
    createdAt,
    cached: false
  };
}

export function buildProductFallbackConsensus(
  query: string,
  sources: VeraSource[],
  explanation = "Vera found product-review sources, but not enough clean agreement to compare every alternative confidently."
): ConsensusResponse | null {
  const evidenceType = inferQueryEvidenceType(query);
  const category = productCategoryForQuery(query);

  if (evidenceType !== "product_recommendation" || isAutomotiveAvoidanceQuery(query) || !category || sources.length < 3) {
    return null;
  }

  const leaders = category.leaders
    .map((leader, index) => ({
      leader,
      index,
      supportingSources: sources.filter((source) => sourceMentionsPlatform(source, leader.aliases))
    }))
    .filter((item) => item.supportingSources.length > 0)
    .slice(0, 3);

  const fallbackLeaders = leaders.length
    ? leaders
    : category.leaders.slice(0, 2).map((leader, index) => ({
        leader,
        index,
        supportingSources: sources.slice(0, 3)
      }));
  const createdAt = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    generated_at: createdAt,
    model: openAIModel,
    mode: "moderate_consensus",
    headline: `${fallbackLeaders[0]?.leader.label ?? "One product"} has the strongest product-review signal.`,
    explanation,
    intent: intentFromQuery(query),
    results: fallbackLeaders.map((item, index) => ({
      id: `${slugify(item.leader.label)}-${index + 1}`,
      rank: index + 1,
      name: item.leader.label,
      consensusPercentage: Math.max(58, 72 - index * 7),
      summary: `${item.leader.label} appears as a category leader in product-review evidence.`,
      reasons: ["Product-review leader", "Expert-source support", "Broad category recognition"],
      downsides: [],
      evidence: [explanation],
      sources: item.supportingSources.slice(0, 5)
    })),
    sources,
    createdAt,
    cached: false
  };
}

export async function buildLocalFallbackConsensus(
  query: string,
  sources: VeraSource[],
  explanation = "Vera found local sources, but could not confidently separate one clear favorite from several local contenders.",
  callCounts?: ExternalCallCounts
): Promise<ConsensusResponse | null> {
  const evidenceType = inferQueryEvidenceType(query);

  if (evidenceType !== "local_recommendation" || sources.length < 3) {
    return null;
  }

  const fallbackSignals = dedupeSignals([...localFallbackSignals(query, sources), ...localRecommendationPrior(query, sources, [], evidenceType).signals]);

  if (fallbackSignals.length < 1) {
    return null;
  }

  const structuredConsensus = await aggregateSignals(fallbackSignals, sources, query, callCounts);

  if (structuredConsensus.contenders.length < 1) {
    return null;
  }

  const consensus = buildConsensus(query, sources, intentFromQuery(query), structuredConsensus);

  return {
    ...consensus,
    mode: consensus.mode === "clear_consensus" ? "strong_consensus" : consensus.mode,
    explanation
  };
}

export async function debugLocalCandidateDiscovery(query: string) {
  const { sources, signals } = localCandidateDiscoveryDebugFixture(query);
  const intendedCategory = inferIntendedCategory(query);
  const queryEvidenceType = inferQueryEvidenceType(query);
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of mergeLocalBusinessSignalNames(signals)) {
    const existing = byName.get(signal.contenderName) ?? [];
    existing.push(signal);
    byName.set(signal.contenderName, existing);
  }

  const rawCandidates = Array.from(byName.entries())
    .map(([name, contenderSignals]) =>
      applyEvidenceStrategy(
        applyDominantPlatformCategory(
          applyCategoryRelevanceForEvidenceType(buildContenderMetrics(name, contenderSignals, queryEvidenceType), intendedCategory, contenderSignals, queryEvidenceType),
          queryEvidenceType
        ),
        query,
        queryEvidenceType,
        false,
        contenderSignals
      )
    )
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount);

  const rawExtractedCandidates = rawCandidates.map((candidate) => {
    const candidateSignals = byName.get(candidate.name) ?? [];
    return {
      name: candidate.name,
      sourceCount: candidate.sourceCount,
      positiveMentionCount: candidate.positiveMentionCount,
      score: candidate.netWeightedScore,
      rejectionReason: localCandidateDiscoveryRejectionReason(query, candidate, candidateSignals)
    };
  });
  const discoveredCandidates = rawCandidates.filter((candidate) => localCandidatePassesDiscovery(query, candidate, byName.get(candidate.name) ?? []));
  const { contenders } = filterContendersByCategory(discoveredCandidates, intendedCategory);
  const structuredConsensus = await aggregateSignals(signals, sources, query);
  const finalResult = buildConsensus(query, sources, intentFromQuery(query), structuredConsensus);
  const thinSignals = signals.filter((signal) => !["TO GO AND DELIVERY", "Keens Steakhouse"].includes(signal.contenderName)).slice(0, 2);
  const thinSourceUrls = new Set(thinSignals.map((signal) => signal.sourceUrl));
  const thinSources = sources.filter((source) => thinSourceUrls.has(source.url));
  const thinConsensus = buildConsensus(query, thinSources, intentFromQuery(query), await aggregateSignals(thinSignals, thinSources, query));

  return {
    query,
    rawExtractedCandidates,
    rejectedCandidates: rawExtractedCandidates.filter((candidate) => candidate.rejectionReason),
    finalValidCandidates: contenders.map((candidate, index) => ({
      rank: index + 1,
      name: candidate.name,
      sourceCount: candidate.sourceCount,
      positiveMentionCount: candidate.positiveMentionCount,
      score: candidate.netWeightedScore
    })),
    finalUserFacingResult: {
      mode: finalResult.mode,
      headline: finalResult.headline,
      explanation: finalResult.explanation,
      results: finalResult.results.map((result) => ({
        rank: result.rank,
        name: result.name,
        summary: result.summary
      }))
    },
    thinCandidateCheck: {
      mode: thinConsensus.mode,
      headline: thinConsensus.headline,
      resultCount: thinConsensus.results.length
    }
  };
}

function localCandidateDiscoveryDebugFixture(query: string) {
  const normalized = normalizeQuery(query);
  const location = normalized.includes("delray")
    ? "Delray Beach FL"
    : normalized.includes("huntington")
      ? "Huntington NY"
      : normalized.includes("massapequa")
        ? "Massapequa NY"
        : /\b(nyc|new york|manhattan|brooklyn|queens)\b/.test(normalized)
          ? "NYC"
          : "Seaford NY";
  const cuisine = localSpecificIntentForQuery(query)?.label ?? localCategoryForQuery(query);
  const validNames = localCandidateDiscoveryFixtureNames(normalized);
  const invalidNames = [
    {
      name: "Espresso Martini",
      title: "Best Espresso Martini in NYC",
      domain: "cocktail-guide.example",
      text: "Best espresso martini in NYC cocktail guide."
    },
    {
      name: "Upper East Side",
      title: "Upper East Side cocktail bars",
      domain: "nyc-guide.example",
      text: "Upper East Side neighborhood guide for cocktail bars."
    },
    {
      name: "RESERVE A TABLE WITH",
      title: "Reservations for NYC cocktail bars",
      domain: "reservation-widget.example",
      text: "RESERVE A TABLE WITH book a table view menu order delivery."
    },
    {
      name: "Italian Food and Pizza",
      title: "Best Italian Food and Pizza in Seaford NY",
      domain: "local-list.example",
      text: "Italian food and pizza restaurant guide for Seaford NY."
    },
    {
      name: "TO GO AND DELIVERY",
      title: "Pasta Eater: Authentic Italian Restaurant in New York",
      domain: "pasta-eater.com",
      text: "TO GO AND DELIVERY order online menu hours catering"
    },
    {
      name: "Keens Steakhouse",
      title: "Keens Steakhouse - New York City steakhouse",
      domain: "keens.com",
      text: "Keens Steakhouse is a classic steakhouse in Manhattan New York City."
    }
  ];
  const sources: VeraSource[] = [
    ...validNames.map((item, index) => ({
      title: `${item.name} ${cuisine} recommendation in ${location}`,
      url: `https://debug.local/${slugify(item.name)}-${index + 1}`,
      domain: index % 2 === 0 ? "yelp.com" : "tripadvisor.com",
      snippet: `${item.name} is recommended for ${item.evidence} in ${location}.`,
      queryVariant: `${cuisine} ${location} local debug`
    })),
    ...invalidNames.map((item, index) => ({
      title: item.title,
      url: `https://debug.local/invalid-${index + 1}`,
      domain: item.domain,
      snippet: item.text,
      queryVariant: `${cuisine} ${location} local debug`
    }))
  ];
  const signals: SourceSignal[] = [
    ...validNames.map((item, index) =>
      localDebugSignal({
        source: sources[index],
        contenderName: item.name,
        reason: `Recommended for ${item.evidence} in ${location}`,
        themes: [item.evidence]
      })
    ),
    ...invalidNames.map((item, index) =>
      localDebugSignal({
        source: sources[validNames.length + index],
        contenderName: item.name,
        reason: item.text,
        themes: ["local source support"]
      })
    )
  ];

  return { sources, signals };
}

function localCandidateDiscoveryFixtureNames(normalizedQuery: string) {
  if (/\bespresso martini\b/.test(normalizedQuery)) {
    return [
      { name: "Dante", evidence: "espresso martinis and cocktail bar atmosphere" },
      { name: "Temple Bar", evidence: "excellent cocktails and date-night drinks" },
      { name: "Bar Pisellino", evidence: "cocktails and Italian aperitivo bar" }
    ];
  }

  if (/\bseafood\b/.test(normalizedQuery)) {
    return [
      { name: "The White Whale", evidence: "seafood and raw bar dishes" },
      { name: "Anchor Down Dockside", evidence: "seafood by the water" },
      { name: "Cardoon Mediterranean Grill", evidence: "fish and seafood specials" }
    ];
  }

  if (/\bsushi\b/.test(normalizedQuery)) {
    return [
      { name: "Kashi Japanese", evidence: "sushi and Japanese food" },
      { name: "Umami Japan", evidence: "sushi rolls and sashimi" },
      { name: "Sushi Day", evidence: "sushi and Japanese lunch specials" }
    ];
  }

  if (/\bbrunch\b/.test(normalizedQuery)) {
    return [
      { name: "Hatch", evidence: "brunch and breakfast dishes" },
      { name: "Toast & Co.", evidence: "brunch staples and coffee" },
      { name: "Besito Mexican", evidence: "weekend brunch in Huntington" }
    ];
  }

  if (/\bcoffee\b/.test(normalizedQuery)) {
    return [
      { name: "Subculture Coffee", evidence: "coffee and espresso drinks" },
      { name: "The Seed Coffee", evidence: "local coffee and cafe seating" },
      { name: "Carmela Coffee Company", evidence: "coffee shop and pastries" }
    ];
  }

  if (/\bpizza\b/.test(normalizedQuery)) {
    return [
      { name: "Phil's Pizzeria", evidence: "pizza and pizzeria slices" },
      { name: "Saverio's Authentic Pizza Napoletana", evidence: "pizza and Neapolitan pies" },
      { name: "Calda Pizzeria", evidence: "pizza and pizzeria dishes in Massapequa" }
    ];
  }

  if (/\bdelray\b/.test(normalizedQuery)) {
    return [
      { name: "Elisabetta's Ristorante", evidence: "Italian pasta and pizza" },
      { name: "Tramonti", evidence: "Italian restaurant classics" },
      { name: "Vic & Angelo's", evidence: "Italian dining and pasta" }
    ];
  }

  return [
    { name: "Gusto Divino Trattoria", evidence: "Italian food and trattoria dishes" },
    { name: "Cara Mia", evidence: "Italian restaurant recommendations" },
    { name: "Il Bacetto Restaurant", evidence: "Italian food in Seaford" },
    { name: "IL BACETTO ITALIAN", evidence: "Italian restaurant in Seaford" },
    { name: "Gino's of Seaford", evidence: "pizzeria and Italian cuisine" }
  ];
}

function localDebugSignal({ source, contenderName, reason, themes }: { source: VeraSource; contenderName: string; reason: string; themes: string[] }): SourceSignal {
  const sourceType = inferSourceType(source);
  const sourceQuality = inferSourceQuality(source, sourceType);

  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    domain: source.domain,
    sourceType,
    sourceWeight: sourceTypeWeight(sourceType, "local_recommendation"),
    sourceQuality,
    sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
    queryVariant: source.queryVariant,
    contenderName,
    sentiment: "positive",
    mentionStrength: "strong",
    positiveMention: reason,
    extractedReason: reason,
    themes
  };
}

export async function analyzeConsensusWithDebug(query: string, sources: VeraSource[], callCounts?: ExternalCallCounts) {
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    throw new Error("OPENAI_API_KEY is required to extract consensus from real sources.");
  }

  const evidenceType = inferQueryEvidenceType(query);
  const modelSources = prepareSourcesForOpenAI(sources, evidenceType);

  if (modelSources.length < 3) {
    const consensus = notEnoughData(query, sources, "Not enough reliable data to form a consensus.");
    return {
      rawOpenAIContent: null,
      parsedOpenAIAnalysis: null,
      consensus
    };
  }

  const deterministicLocalSignals =
    evidenceType === "local_recommendation" ? deterministicLocalSignalsForOpenAISkip(query, modelSources, evidenceType) : [];
  const skipLocalOpenAI = evidenceType === "local_recommendation" && countCleanLocalSignalCandidates(query, deterministicLocalSignals) >= 5;
  const sourceSignals = skipLocalOpenAI
    ? {
        rawOpenAIContent: null,
        parsedOpenAIAnalysis: null,
        intent: intentFromQuery(query),
        signals: deterministicLocalSignals
      }
    : await extractSourceSignals(query, modelSources, key, evidenceType, callCounts);
  if (skipLocalOpenAI) {
    console.log("LOCAL_OPENAI_SKIPPED", {
      query,
      reason: "deterministic_extraction_found_enough_clean_candidates",
      cleanCandidateCount: countCleanLocalSignalCandidates(query, deterministicLocalSignals)
    });
  }
  const recoveredSignals =
    evidenceType === "local_recommendation" && !skipLocalOpenAI ? await recoverSparseLocalBusinessNames(query, modelSources, sourceSignals.signals, key, callCounts) : [];
  const allSignals =
    evidenceType === "local_recommendation"
      ? dedupeSignals([...(skipLocalOpenAI ? [] : sourceSignals.signals), ...deterministicLocalSignals, ...recoveredSignals])
      : sourceSignals.signals;
  const structuredConsensus = await aggregateSignals(allSignals, modelSources, query, callCounts);

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

function deterministicLocalSignalsForOpenAISkip(query: string, sources: VeraSource[], evidenceType: QueryEvidenceType) {
  if (evidenceType !== "local_recommendation") return [];

  return dedupeSignals([...localFallbackSignals(query, sources), ...localRecommendationPrior(query, sources, [], evidenceType).signals]);
}

function countCleanLocalSignalCandidates(query: string, signals: SourceSignal[]) {
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of signals) {
    const key = localBusinessKey(signal.contenderName);

    if (!key) continue;
    const existing = byName.get(key) ?? [];
    existing.push(signal);
    byName.set(key, existing);
  }

  let count = 0;

  for (const [key, candidateSignals] of byName.entries()) {
    const displayName = candidateSignals[0]?.contenderName ?? key;

    if (!localUniversalEntityRejectionReason(query, displayName, { signals: candidateSignals })) {
      count += 1;
    }
  }

  return count;
}

async function recoverSparseLocalBusinessNames(query: string, sources: VeraSource[], signals: SourceSignal[], key: string, callCounts?: ExternalCallCounts) {
  const validBusinessKeys = new Set(
    signals
      .map((signal) => signal.contenderName)
      .filter((name) => !isGenericLocalContender(query, name))
      .map((name) => localBusinessKey(name))
      .filter(Boolean)
  );

  if (validBusinessKeys.size >= 5) {
    console.log("LOCAL_FINAL_RESULT_COUNT", {
      query,
      validLocalContenders: validBusinessKeys.size,
      recoveredBusinesses: 0,
      skipped: "enough_initial_businesses"
    });
    return [];
  }

  const recoverySources = rankLocalSourcesForRecovery(sources).slice(0, maxLocalRecoverySources);

  console.log("LOCAL_RECOVERY_TRIGGERED", {
    query,
    validLocalContenders: validBusinessKeys.size,
    sourceCount: sources.length,
    recoverySourceCount: recoverySources.length
  });
  console.log("LOCAL_RECOVERY_SOURCE_COUNT", recoverySources.length);

  if (recoverySources.length < 3) {
    console.log("LOCAL_RECOVERY_BUSINESSES_FOUND", {
      query,
      rawBusinesses: 0,
      acceptedBusinesses: 0,
      skipped: "not_enough_sources"
    });
    console.log("LOCAL_FINAL_RESULT_COUNT", {
      query,
      validLocalContenders: validBusinessKeys.size,
      recoveredBusinesses: 0
    });
    return [];
  }

  try {
    if (!canMakeOpenAICall(callCounts, "local_recommendation", "local_business_name_recovery")) {
      console.warn("OPENAI_CALL_CEILING_REACHED", {
        query,
        phase: "local_business_name_recovery",
        currentCalls: callCounts?.openAiCalls ?? null,
        maxOpenAICallsPerRequest
      });
      return [];
    }

    const openai = new OpenAI({ apiKey: key, timeout: localRecoveryOpenAITimeoutMs, maxRetries: 0 });
    const sourceByUrl = new Map(recoverySources.map((source) => [source.url, source]));
    const sourceText = recoverySources
      .map((source, index) =>
        [
          `SOURCE ${index + 1}`,
          `Title: ${source.title}`,
          `URL: ${source.url}`,
          `Domain: ${source.domain}`,
          `Query variant: ${source.queryVariant ?? query}`,
          `Snippet: ${trimForOpenAI(localSourceEvidenceText(source), maxLocalRecoverySnippetChars)}`
        ].join("\n")
      )
      .join("\n\n");

    recordOpenAICall(callCounts, "local_recommendation", "local_business_name_recovery");
    console.log("OPENAI_CALL_COUNT", {
      evidenceType: "local_recommendation",
      phase: "local_business_name_recovery",
      total: callCounts?.openAiCalls ?? null
    });

    const completion = await openai.chat.completions.create(
      {
        model: openAIModel,
        temperature: 0,
        max_completion_tokens: maxLocalRecoveryCompletionTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              'Return exactly this JSON shape: {"businesses":[{"name":"","sourceUrl":""}]}',
              "List every named business recommended for this local query.",
              "Return only business or place names that appear in the provided sources.",
              "No summaries. No rankings. No reasoning. No categories. No article titles. No source names.",
              "If a source lists multiple businesses, include the named businesses.",
              "Use the exact sourceUrl where each business appears.",
              "Return JSON only."
            ].join(" ")
          },
          {
            role: "user",
            content: [`Query: ${query}`, "", sourceText].join("\n")
          }
        ]
      },
      {
        timeout: localRecoveryOpenAITimeoutMs,
        maxRetries: 0
      }
    );

    const content = completion.choices[0]?.message.content;

    if (!content) {
      throw new Error("OpenAI did not return local recovery names.");
    }

    const parsed = LocalBusinessNameRecoverySchema.safeParse(JSON.parse(content));

    if (!parsed.success) {
      throw new Error("OpenAI returned invalid local recovery JSON.");
    }

    const recoveredSignals = parsed.data.businesses.flatMap((business) => {
      const source = sourceByUrl.get(business.sourceUrl) ?? recoverySources.find((candidateSource) => candidateSource.url === business.sourceUrl);
      const name = localBusinessDisplayName(business.name);

      if (!source) return [];

      const candidate: LocalPlaceCandidate = {
        name,
        evidenceText: localSourceEvidenceText(source) || source.title,
        sourceUrl: source.url,
        sourceTitle: source.title,
        queryVariant: source.queryVariant,
        extractionSource: "metadata",
        confidence: round2(0.58 + (localSourceAuthorityFromSource(source) === "high" ? 0.06 : 0))
      };
      const rejectedReason = localRecoveryRejectionReason(query, candidate.name, candidate);
      const confidenceLevel = localCandidateConfidenceLevel(query, candidate, source);
      console.log("LOCAL_CANDIDATE_CONFIDENCE", {
        candidate: candidate.name,
        source: source.url,
        confidence: candidate.confidence,
        level: confidenceLevel,
        extractionSource: candidate.extractionSource,
        stage: "business_name_recovery"
      });

      if (rejectedReason) {
        console.log("LOCAL_SPARSE_RECOVERY_REJECTED", {
          candidate: candidate.name,
          source: source.url,
          reason: rejectedReason,
          stage: "business_name_recovery"
        });
        return [];
      }

      return [localPriorSignal(source, candidate.name, "local_recommendation", candidate, confidenceLevel)];
    });

    const deduped = dedupeSignals(recoveredSignals);
    console.log("LOCAL_RECOVERY_BUSINESSES_FOUND", {
      query,
      rawBusinesses: parsed.data.businesses.length,
      acceptedBusinesses: deduped.length,
      businesses: Array.from(new Set(deduped.map((signal) => signal.contenderName))).slice(0, 20)
    });
    console.log("LOCAL_FINAL_RESULT_COUNT", {
      query,
      validLocalContenders: validBusinessKeys.size,
      recoveredBusinesses: new Set(deduped.map((signal) => localBusinessKey(signal.contenderName))).size
    });

    return deduped;
  } catch (error) {
    console.warn("[vera:consensus] local business-name recovery failed softly", {
      query,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log("LOCAL_RECOVERY_BUSINESSES_FOUND", {
      query,
      rawBusinesses: 0,
      acceptedBusinesses: 0,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log("LOCAL_FINAL_RESULT_COUNT", {
      query,
      validLocalContenders: validBusinessKeys.size,
      recoveredBusinesses: 0
    });
    return [];
  }
}

async function extractSourceSignals(query: string, sources: VeraSource[], key: string, evidenceType: QueryEvidenceType, callCounts?: ExternalCallCounts) {
  const timeoutMs =
    evidenceType === "dominant_platform"
      ? dominantPlatformOpenAITimeoutMs
      : evidenceType === "local_recommendation"
        ? localRecommendationOpenAITimeoutMs
        : openAITimeoutMs;
  const maxSnippetChars = evidenceType === "local_recommendation" ? maxLocalEnrichedOpenAIChars : maxOpenAISnippetChars;
  const maxCompletionTokens = evidenceType === "local_recommendation" ? maxLocalOpenAICompletionTokens : maxOpenAICompletionTokens;
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

  if (!canMakeOpenAICall(callCounts, evidenceType, "source_signal_extraction")) {
    console.warn("OPENAI_CALL_CEILING_REACHED", {
      query,
      phase: "source_signal_extraction",
      evidenceType,
      currentCalls: callCounts?.openAiCalls ?? null,
      maxOpenAICallsPerRequest
    });
    return {
      rawOpenAIContent: null,
      parsedOpenAIAnalysis: null,
      intent: intentFromQuery(query),
      signals: []
    };
  }

  recordOpenAICall(callCounts, evidenceType, "source_signal_extraction");
  console.log("OPENAI_CALL_COUNT", {
    evidenceType,
    phase: "source_signal_extraction",
    total: callCounts?.openAiCalls ?? null
  });

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
          "Extract up to three simple evidence records per source.",
          "Analyze each source independently.",
          "Do not rank, summarize, compare, or explain consensus.",
          "For each source choose the named contenders that receive clear support or criticism.",
          extractionEntityGuidance(evidenceType),
          evidenceType === "local_recommendation"
            ? "For local searches, extract only actual business or place names; never extract source names, list titles, addresses, recommendation phrases, or generic categories."
            : "",
          "If a source names several credible contenders, include up to three of the strongest.",
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

  const signals = normalizeSignals(query, parsed.data, sources, evidenceType);
  const durationMs = Date.now() - startedAt;

  console.log("[vera:openai] output received", {
    query,
    elapsedMs: durationMs,
    extractionOutputCount: parsed.data.extractions.length,
    normalizedSignals: signals.length
  });
  console.log("EXTRACTION_OUTPUT_COUNT", parsed.data.extractions.length);
  console.log("EXTRACTION_SIGNAL_COUNT", signals.length);
  console.log(
    "UNIQUE_CONTENDERS_EXTRACTED",
    Array.from(new Set(signals.map((signal) => signal.contenderName))).sort()
  );
  console.log("EXTRACTION_DURATION", durationMs);

  return {
    rawOpenAIContent: content,
    parsedOpenAIAnalysis: parsed.data,
    intent: intentFromQuery(query),
    signals
  };
}

function canMakeOpenAICall(callCounts: ExternalCallCounts | undefined, evidenceType: QueryEvidenceType, phase: string) {
  if (!callCounts) return true;
  if (callCounts.openAiCalls < maxOpenAICallsPerRequest) return true;

  callCounts.openAiCallReasons.push({
    evidenceType,
    phase: `${phase}_skipped_ceiling`
  });
  return false;
}

function recordOpenAICall(callCounts: ExternalCallCounts | undefined, evidenceType: QueryEvidenceType, phase: string) {
  if (!callCounts) return;

  callCounts.openAiCalls += 1;
  callCounts.openAiCallReasons.push({
    evidenceType,
    phase
  });
}

function extractionEntityGuidance(evidenceType: QueryEvidenceType) {
  if (evidenceType === "destination_recommendation") {
    return [
      "For destination searches, extract named destinations, beaches, neighborhoods, islands, towns, regions, attractions, and day-trip locations.",
      "Valid destination contenders include names like Clearwater Beach, St. Pete Beach, Trastevere, Monti, Naxos, Paros, Beacon, Hudson Valley, and the Catskills.",
      "Do not require product-like names.",
      "Never extract article titles, generic headings, source names, search subjects, or phrases like best beaches or where to stay."
    ].join(" ");
  }

  if (evidenceType === "provider_or_brand_recommendation") {
    return [
      "For provider or brand searches, extract named providers, brands, chains, carriers, airlines, banks, insurers, wireless carriers, and laptop brands.",
      "Valid provider or brand contenders include names like Delta Air Lines, Singapore Airlines, Qatar Airways, Marriott, Hilton, Apple, Lenovo, and T-Mobile.",
      "Do not treat provider or brand names as generic categories.",
      "Never extract article titles, rankings, headings, or vague phrases like top airlines."
    ].join(" ");
  }

  return "Prefer concrete product/tool names over generic categories.";
}

function prepareSourcesForOpenAI(sources: VeraSource[], evidenceType: QueryEvidenceType) {
  const sourceLimit = evidenceType === "local_recommendation" ? maxLocalOpenAISources : maxOpenAISources;
  const snippetLimit = evidenceType === "local_recommendation" ? maxLocalOpenAISnippetChars : maxOpenAISnippetChars;
  const selectedSources = evidenceType === "local_recommendation" ? rankLocalSourcesForExtraction(sources).slice(0, sourceLimit) : sources.slice(0, sourceLimit);

  return selectedSources.map((source) => ({
    ...source,
    snippet:
      evidenceType === "local_recommendation"
        ? trimForOpenAI(localSourceEvidenceText(source), source.enrichedText ? maxLocalEnrichedOpenAIChars : snippetLimit)
        : trimForOpenAI(source.snippet ?? "", snippetLimit)
  }));
}

function trimForOpenAI(text: string, maxChars: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars).trim()}...` : compact;
}

function intentFromQuery(query: string): ConsensusResponse["intent"] {
  if (inferQueryEvidenceType(query) === "local_recommendation") {
    const parsedIntent = parseLocalIntent(query);

    return {
      category: parsedIntent.category || "local business",
      location: parsedIntent.location,
      constraints: parseLocalQueryConstraints(query).map((constraint) => constraint.label),
      optimizeFor: [],
      avoid: []
    };
  }

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

function normalizeSignals(query: string, payload: SignalPayload, sources: VeraSource[], evidenceType: QueryEvidenceType): SourceSignal[] {
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
    const contenderName = cleanName(extraction.contender);
    const reason = extraction.reason.trim() || "Mentioned as a contender";

    if (evidenceType === "local_recommendation") {
      const localRejectedReason = localUniversalEntityRejectionReason(query, contenderName, { source, reason });

      if (localRejectedReason) {
        console.log("LOCAL_UNIVERSAL_VALIDATOR_REJECTED", {
          contender: contenderName,
          reason: localRejectedReason,
          path: "openai_extraction",
          sourceTitle: source.title
        });
        return [];
      }
    }

    if (isRejectableContenderName(contenderName, evidenceType, source, reason)) {
      console.log("CONTENDER_REJECTED", {
        contender: contenderName,
        evidenceType,
        sourceTitle: source.title,
        reason: "non_entity_or_page_title"
      });
      return [];
    }

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
        contenderName,
        sentiment,
        mentionStrength: inferMentionStrength(reason),
        positiveMention: sentiment === "positive" ? reason : undefined,
        negativeMention: sentiment === "negative" ? reason : undefined,
        extractedReason: reason,
        themes: [normalizeTheme(reason)].filter(Boolean).slice(0, 1)
      } satisfies SourceSignal
    ];
  });

  const destinationFallbackSignals =
    evidenceType === "destination_recommendation" ? recoverDestinationSignalsFromSources(query, sources, rawSignals) : [];
  const combinedSignals = [...rawSignals, ...destinationFallbackSignals];
  const normalizedSignals = evidenceType === "destination_recommendation" ? combinedSignals.map(canonicalizeDestinationSignal) : combinedSignals;
  const dedupedSignals = dedupeSignals(normalizedSignals);

  console.log("[vera:consensus] source signal extraction", {
    sourceCount: sources.length,
    rawSignalCount: normalizedSignals.length,
    dedupedSignalCount: dedupedSignals.length,
    removedBySourceContenderDedupe: normalizedSignals.length - dedupedSignals.length,
    positiveRawSignals: normalizedSignals.filter((signal) => signal.sentiment === "positive").length,
    positiveDedupedSignals: dedupedSignals.filter((signal) => signal.sentiment === "positive").length,
    destinationFallbackSignalCount: destinationFallbackSignals.length,
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

function recoverDestinationSignalsFromSources(query: string, sources: VeraSource[], existingSignals: SourceSignal[]) {
  const existingBySource = new Set(existingSignals.map((signal) => `${signal.sourceUrl}::${normalizeQuery(signal.contenderName)}`));
  const recovered: SourceSignal[] = [];

  for (const source of sources) {
    const text = `${source.title}. ${source.snippet ?? ""}`;

    if (!hasDestinationRecommendationContext(text)) {
      continue;
    }

    for (const candidate of extractDestinationCandidatesFromText(text)) {
      const contenderName = canonicalDestinationName(candidate);
      const key = `${source.url}::${normalizeQuery(contenderName)}`;

      if (existingBySource.has(key) || isGenericDestinationContender(query, contenderName) || isRejectableContenderName(contenderName, "destination_recommendation", source, text)) {
        continue;
      }

      const sourceType = inferSourceType(source);
      const sourceQuality = inferSourceQuality(source, sourceType);
      recovered.push({
        sourceUrl: source.url,
        sourceTitle: source.title,
        domain: source.domain,
        sourceType,
        sourceWeight: sourceTypeWeight(sourceType, "destination_recommendation"),
        sourceQuality,
        sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
        queryVariant: source.queryVariant,
        contenderName,
        sentiment: "positive",
        mentionStrength: "moderate",
        positiveMention: "Named in a destination recommendation source",
        extractedReason: "Named in a destination recommendation source",
        themes: ["destination recommendation"]
      });
      existingBySource.add(key);
    }
  }

  if (recovered.length) {
    console.log("DESTINATION_FALLBACK_SIGNALS", {
      count: recovered.length,
      contenders: recovered.map((signal) => ({
        name: signal.contenderName,
        sourceTitle: signal.sourceTitle,
        sourceUrl: signal.sourceUrl
      }))
    });
  }

  return recovered;
}

function canonicalizeDestinationSignal(signal: SourceSignal): SourceSignal {
  const canonicalName = canonicalDestinationName(signal.contenderName);

  if (canonicalName === signal.contenderName) {
    return signal;
  }

  return {
    ...signal,
    contenderName: canonicalName
  };
}

function hasDestinationRecommendationContext(text: string) {
  return /\b(recommend|recommended|recommendations?|favorite|favourite|best|top|known for|include|includes|included|made the list|where to|visit|guide|worth visiting|must visit)\b/i.test(text);
}

function extractDestinationCandidatesFromText(text: string) {
  const normalizedText = text.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  const candidates = new Set<string>();
  const suffixPattern =
    /\b((?:St\.?\s+|Saint\s+|Fort\s+)?[A-Z][A-Za-z'.-]*(?:\s+(?:and|of|the|de|del|la|le|du|[A-Z][A-Za-z'.-]*)){0,5}\s+(?:Beach|Beaches|Island|Islands|Park|Parks|Preserve|Trail|Trails|Falls|Valley|Village|Town|City|Neighborhood|Neighbourhood|District|Quarter|Region|Mountains|Mountain|Lake|Springs|Key|Keys|Point|Pier|Bay|Harbor|Harbour|Coast|Shore|Shores|Cove|Caves|Canyon|Gardens|Market|Museum|Monument))\b/g;
  const fortPattern = /\b(Fort\s+[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3})\b/g;

  for (const match of normalizedText.matchAll(suffixPattern)) {
    candidates.add(match[1]);
  }

  for (const match of normalizedText.matchAll(fortPattern)) {
    candidates.add(match[1]);
  }

  return Array.from(candidates).map((candidate) => candidate.replace(/^[#*\d.\s-]+/, "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
}

function canonicalDestinationName(name: string) {
  const compact = name.replace(/\s+/g, " ").trim();
  const normalized = normalizeQuery(compact.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

  if (/^(?:sao miguel|sao miguel island|miguel island)$/.test(normalized)) {
    return "São Miguel Island";
  }

  if (/^(?:the )?(?:portugal s |portuguese )?azores(?: islands?)?$/.test(normalized)) {
    return "Azores";
  }

  const titled = compact
    .split(" ")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "st" || lower === "st.") return "St.";
      if (lower === "de") return "De";
      if (lower === "of" || lower === "the" || lower === "and") return lower;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");

  return titled.replace(/\bSt\. Pete\b/, "St. Pete").replace(/\bDe Soto\b/, "De Soto");
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

async function aggregateSignals(signals: SourceSignal[], sources: VeraSource[], query: string, callCounts?: ExternalCallCounts): Promise<StructuredConsensus> {
  const intendedCategory = inferIntendedCategory(query);
  const queryEvidenceType = inferQueryEvidenceType(query);
  const evidenceStrategy = evidenceStrategyFor(queryEvidenceType);
  const specializedDominantPlatformQuery = queryEvidenceType === "dominant_platform" && isSpecializedDominantPlatformQuery(query);
  const dominantPrior = dominantPlatformPrior(query, sources, signals, queryEvidenceType, specializedDominantPlatformQuery);
  const softwarePrior = softwareToolPrior(query, sources, signals, queryEvidenceType);
  const productPrior = productRecommendationPrior(query, sources, signals, queryEvidenceType);
  const localPrior = localRecommendationPrior(query, sources, signals, queryEvidenceType);
  const rawEvidenceSignals = [...signals, ...dominantPrior.signals, ...softwarePrior.signals, ...productPrior.signals, ...localPrior.signals];
  const evidenceSignals = queryEvidenceType === "destination_recommendation" ? rawEvidenceSignals.map(canonicalizeDestinationSignal) : rawEvidenceSignals;
  const dominantFilteredSignals =
    queryEvidenceType === "dominant_platform"
      ? evidenceSignals.filter((signal) => !isGenericDominantPlatformContender(signal.contenderName))
      : evidenceSignals;
  const preValidationScoringSignals =
    queryEvidenceType === "product_recommendation"
      ? dominantFilteredSignals.filter(
          (signal) => !isGenericProductContender(query, signal.contenderName) && !isRejectableContenderName(signal.contenderName, queryEvidenceType, signal, signal.extractedReason)
        )
      : queryEvidenceType === "destination_recommendation"
        ? dominantFilteredSignals.filter(
            (signal) =>
              !isGenericDestinationContender(query, signal.contenderName) && !isRejectableContenderName(signal.contenderName, queryEvidenceType, signal, signal.extractedReason)
          )
      : queryEvidenceType === "local_recommendation"
        ? dominantFilteredSignals.filter(
            (signal) => !isRejectableLocalSignalName(query, signal.contenderName) && !isRejectableContenderName(signal.contenderName, queryEvidenceType, signal, signal.extractedReason)
        )
      : dominantFilteredSignals.filter((signal) => !isRejectableContenderName(signal.contenderName, queryEvidenceType, signal, signal.extractedReason));
  const rankedLocalCandidateNames =
    queryEvidenceType === "local_recommendation"
      ? rankedLocalCandidateNamesForPlaces(query, preValidationScoringSignals, intendedCategory, specializedDominantPlatformQuery, softwarePrior, productPrior)
      : [];
  if (queryEvidenceType === "local_recommendation") {
    console.log("LOCAL_CANDIDATES_EXTRACTED", new Set(preValidationScoringSignals.map((signal) => localBusinessKey(signal.contenderName)).filter(Boolean)).size);
    console.log("LOCAL_CANDIDATES_AFTER_FILTERS", rankedLocalCandidateNames.length);
  }
  const scoringSignals =
    queryEvidenceType === "local_recommendation" ? await validateLocalSignalsWithPlaces(query, preValidationScoringSignals, rankedLocalCandidateNames, callCounts) : preValidationScoringSignals;
  if (queryEvidenceType === "local_recommendation") {
    console.log(
      "LOCAL_VERIFIED_SIGNAL_AFTER_PLACES",
      scoringSignals
        .filter((signal) => signal.placesVerified)
        .map((signal) => ({
          contender: signal.contenderName,
          verifiedAddress: signal.verifiedAddress ?? null,
          placesCategoryConfidence: signal.placesCategoryConfidence ?? null,
          placesLocationConfidence: signal.placesLocationConfidence ?? null,
          placesTypes: signal.placesTypes ?? []
        }))
    );
  }
  const aggregationSignals = queryEvidenceType === "local_recommendation" ? mergeLocalBusinessSignalNames(scoringSignals) : scoringSignals;
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of aggregationSignals) {
    const existing = byName.get(signal.contenderName) ?? [];
    existing.push(signal);
    byName.set(signal.contenderName, existing);
  }

  const contendersBeforeFiltering = Array.from(byName.entries())
    .map(([name, contenderSignals]) =>
      applyEvidenceStrategy(
        applyDominantPlatformCategory(
          applyCategoryRelevanceForEvidenceType(buildContenderMetrics(name, contenderSignals, queryEvidenceType), intendedCategory, contenderSignals, queryEvidenceType),
          queryEvidenceType
        ),
        query,
        queryEvidenceType,
        specializedDominantPlatformQuery,
        contenderSignals,
        softwarePrior,
        productPrior
      )
    )
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount);

  const qualityFilteredContenders =
    queryEvidenceType === "local_recommendation"
      ? contendersBeforeFiltering.filter((contender) => localCandidatePassesDiscovery(query, contender, byName.get(contender.name) ?? []))
      : queryEvidenceType === "destination_recommendation"
        ? contendersBeforeFiltering.filter((contender) => !isGenericDestinationContender(query, contender.name))
      : queryEvidenceType === "product_recommendation" && isBroadExploratoryQuery(query)
        ? contendersBeforeFiltering.filter((contender) => !isWeakBroadProductContender(contender, query))
        : contendersBeforeFiltering;
  const { contenders, removed } =
    queryEvidenceType === "destination_recommendation" || queryEvidenceType === "provider_or_brand_recommendation"
      ? { contenders: qualityFilteredContenders, removed: [] }
      : filterContendersByCategory(qualityFilteredContenders, intendedCategory);
  const contenderNames = new Set(contenders.map((contender) => contender.name));
  const filteredSignals = aggregationSignals.filter((signal) => contenderNames.has(signal.contenderName));
  if (queryEvidenceType === "local_recommendation") {
    console.log(
      "LOCAL_RAW_EXTRACTED_CANDIDATES",
      contendersBeforeFiltering.map((contender) => ({
        name: contender.name,
        sourceCount: contender.sourceCount,
        positiveMentionCount: contender.positiveMentionCount,
        netWeightedScore: contender.netWeightedScore
      }))
    );
    console.log(
      "LOCAL_FINAL_VALID_CANDIDATES",
      contenders.map((contender, index) => ({
        rank: index + 1,
        name: contender.name,
        sourceCount: contender.sourceCount,
        positiveMentionCount: contender.positiveMentionCount,
        netWeightedScore: contender.netWeightedScore,
        localRanking: contender.localRanking
      }))
    );
  }
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
  if (queryEvidenceType === "dominant_platform") {
    console.log("DOMINANT_PRIOR_APPLIED", dominantPrior.applied);
    console.log("DOMINANT_INCUMBENT", dominantPrior.incumbent?.label ?? null);
    console.log("DOMINANT_INCUMBENT_FOUND_IN_SOURCES", dominantPrior.foundInSources);
  }
  if (queryEvidenceType === "software_tool") {
    console.log("SOFTWARE_TOOL_PRIOR_APPLIED", softwarePrior.applied);
    console.log("SOFTWARE_CATEGORY_DETECTED", softwarePrior.category?.key ?? null);
    console.log("SOFTWARE_LEADERS_FOUND", softwarePrior.leadersFound);
    console.log("SOFTWARE_SOURCE_WEIGHTS", softwareSourceWeightSummary(sources));
  }
  if (queryEvidenceType === "product_recommendation") {
    console.log("PRODUCT_CATEGORY_DETECTED", productPrior.category?.key ?? null);
    console.log("PRODUCT_SOURCE_WEIGHTS", productSourceWeightSummary(sources));
    console.log("PRODUCT_LEADERS_FOUND", productPrior.leadersFound);
  }
  if (queryEvidenceType === "local_recommendation") {
    console.log("LOCAL_CATEGORY_DETECTED", localCategoryForQuery(query));
    console.log("LOCAL_BUSINESSES_FOUND", Array.from(byName.keys()).slice(0, 20));
    console.log("LOCAL_SOURCE_WEIGHTS", localSourceWeightSummary(sources));
    console.log("LOCAL_PRIOR_APPLIED", localPrior.applied);
    console.log("LOCAL_PRIOR_CONTENDERS_FOUND", localPrior.contendersFound);
  }

  const themeCounts = aggregateThemeCounts(filteredSignals);
  const sourceBreakdown = aggregateSourceBreakdown(sources, filteredSignals);
  const initialConsensusClassification = classifyFromMetrics(contenders, sources.length, queryEvidenceType, query);
  const verifiedLocalContenders =
    queryEvidenceType === "local_recommendation"
      ? contenders.filter((contender) => localCandidateHasVerifiedPlacesEvidence(query, byName.get(contender.name) ?? []))
      : [];
  const consensusClassification =
    queryEvidenceType === "local_recommendation" && initialConsensusClassification === "no_reliable_consensus" && verifiedLocalContenders.length > 0
      ? "split_consensus"
      : initialConsensusClassification;
  if (queryEvidenceType === "local_recommendation") {
    console.log(
      "LOCAL_FINAL_VERIFIED_CONTENDERS",
      verifiedLocalContenders.map((contender) => ({
        name: contender.name,
        sourceCount: contender.sourceCount,
        positiveMentionCount: contender.positiveMentionCount,
        verifiedAddresses: (byName.get(contender.name) ?? []).map((signal) => signal.verifiedAddress).filter(Boolean)
      }))
    );
  }
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
  if (queryEvidenceType === "dominant_platform") {
    console.log(
      "DOMINANT_INCUMBENT_FINAL_RANK",
      dominantPrior.incumbent
        ? contenders.findIndex((contender) => contenderMatchesPlatform(contender.name, dominantPrior.incumbent?.aliases ?? [])) + 1 || null
        : null
    );
  }
  if (queryEvidenceType === "software_tool") {
    console.log(
      "SOFTWARE_FINAL_RANKS",
      contenders.slice(0, 8).map((contender, index) => ({
        rank: index + 1,
        name: contender.name,
        netWeightedScore: contender.netWeightedScore,
        positiveMentionCount: contender.positiveMentionCount,
        sourceCount: contender.sourceCount,
        sourceTypes: contender.sourceTypes
      }))
    );
  }
  if (queryEvidenceType === "product_recommendation") {
    console.log(
      "PRODUCT_FINAL_RANKS",
      contenders.slice(0, 8).map((contender, index) => ({
        rank: index + 1,
        name: contender.name,
        netWeightedScore: contender.netWeightedScore,
        positiveMentionCount: contender.positiveMentionCount,
        sourceCount: contender.sourceCount,
        sourceTypes: contender.sourceTypes
      }))
    );
  }
  if (queryEvidenceType === "local_recommendation") {
    console.log(
      "LOCAL_FINAL_RANKS",
      contenders.slice(0, 8).map((contender, index) => ({
        rank: index + 1,
        name: contender.name,
        consensusScore: consensusScore(contender),
        netWeightedScore: contender.netWeightedScore,
        sourceCount: contender.sourceCount,
        averageRating: contender.averageRating,
        sourceTypes: contender.sourceTypes,
        confidence: contender.confidence,
        localRanking: contender.localRanking
      }))
    );
  }
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
        netWeightedScore: contender.netWeightedScore,
        averageRating: contender.averageRating,
        confidence: contender.confidence
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
    signals: filteredSignals,
    localPlaceExtraction:
      queryEvidenceType === "local_recommendation"
        ? {
            candidates: localPrior.diagnostics
          }
        : undefined
  };
}

function rankedLocalCandidateNamesForPlaces(
  query: string,
  signals: SourceSignal[],
  intendedCategory: VeraEntityCategory,
  specializedDominantPlatformQuery: boolean,
  softwarePrior: ReturnType<typeof softwareToolPrior>,
  productPrior: ReturnType<typeof productRecommendationPrior>
) {
  const aggregationSignals = mergeLocalBusinessSignalNames(signals);
  const byName = new Map<string, SourceSignal[]>();

  for (const signal of aggregationSignals) {
    const existing = byName.get(signal.contenderName) ?? [];
    existing.push(signal);
    byName.set(signal.contenderName, existing);
  }

  const rankedCandidates = Array.from(byName.entries())
    .map(([name, contenderSignals]) =>
      applyEvidenceStrategy(
        applyDominantPlatformCategory(
          applyCategoryRelevanceForEvidenceType(buildContenderMetrics(name, contenderSignals, "local_recommendation"), intendedCategory, contenderSignals, "local_recommendation"),
          "local_recommendation"
        ),
        query,
        "local_recommendation",
        specializedDominantPlatformQuery,
        contenderSignals,
        softwarePrior,
        productPrior
      )
    )
    .filter((contender) => !localCandidateDiscoveryRejectionReason(query, contender, byName.get(contender.name) ?? []))
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount);
  const { contenders } = filterContendersByCategory(rankedCandidates, intendedCategory);

  return contenders.map((contender) => contender.name);
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

function applyCategoryRelevanceForEvidenceType(
  metrics: ContenderMetrics,
  intendedCategory: VeraEntityCategory,
  signals: SourceSignal[],
  evidenceType: QueryEvidenceType
): ContenderMetrics {
  if (evidenceType === "dominant_platform" || evidenceType === "destination_recommendation" || evidenceType === "provider_or_brand_recommendation") {
    return metrics;
  }

  return applyCategoryRelevance(metrics, intendedCategory, signals);
}

function applyDominantPlatformCategory(metrics: ContenderMetrics, evidenceType: QueryEvidenceType): ContenderMetrics {
  if (evidenceType !== "dominant_platform") {
    return metrics;
  }

  return {
    ...metrics,
    contenderCategory: "software",
    categoryConfidence: "medium"
  };
}

function applyEvidenceStrategy(
  metrics: ContenderMetrics,
  query: string,
  evidenceType: QueryEvidenceType,
  specializedDominantPlatformQuery: boolean,
  signals: SourceSignal[],
  softwarePrior?: SoftwareToolPriorResult,
  productPrior?: ProductRecommendationPriorResult
): ContenderMetrics {
  if (evidenceType === "software_tool") {
    return applySoftwareToolStrategy(metrics, query, signals, softwarePrior);
  }

  if (evidenceType === "product_recommendation") {
    return applyProductRecommendationStrategy(metrics, query, signals, productPrior);
  }

  if (evidenceType === "local_recommendation") {
    return applyLocalRecommendationStrategy(metrics, query, signals);
  }

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
  const defaultBoost = !specializedDominantPlatformQuery && isDefaultPlatform ? 36 : 0;
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

function applyLocalRecommendationStrategy(metrics: ContenderMetrics, query: string, signals: SourceSignal[]): ContenderMetrics {
  const highAuthoritySignals = signals.filter((signal) => localSourceAuthority(signal) === "high").length;
  const mediumAuthoritySignals = signals.filter((signal) => localSourceAuthority(signal) === "medium").length;
  const lowAuthoritySignals = signals.filter((signal) => localSourceAuthority(signal) === "low").length;
  const averageRating = localAverageRating(signals);
  const ratingBoost = averageRating ? Math.max(0, (averageRating - 4) * 2.5) : 0;
  const sourceAuthorityScore = round1(Math.min(highAuthoritySignals, 5) * 2.2 + Math.min(mediumAuthoritySignals, 5) * 0.65 - Math.min(lowAuthoritySignals, 3) * 0.45);
  const sourceDomains = Array.from(new Set(signals.map((signal) => signal.domain).filter(Boolean)));
  const crossSourceAgreementCount = sourceDomains.length;
  const sourceAgreementScore = round1(Math.min(Math.max(crossSourceAgreementCount - 1, 0), 4) * 3.4 + Math.min(Math.max(metrics.sourceCount - 1, 0), 5) * 1.2);
  const mentionFrequencyScore = round1(Math.min(metrics.positiveMentionCount, 6) * 0.75 + Math.min(metrics.strongMentionCount, 4) * 0.8);
  const geographicPrecision = localBestGeographicPrecision(query, metrics.name, signals);
  const locationMatchScore = localLocationMatchScore(query, metrics.name, signals, geographicPrecision);
  const categoryMatchScore = localCategoryMatchScore(query, metrics.name, signals);
  const extractionConfidence = localExtractionConfidence(signals);
  const extractionConfidenceScore = round1((extractionConfidence - 0.62) * 8);
  const sourceSpecificConfidence = round1(Math.min(highAuthoritySignals, 4) * 0.8 + Math.min(metrics.sourceTypes.length, 3) * 0.55);
  const reviewSourceSignal = round1(localReviewSourceSignal(signals));
  const editorialMentionBoost = localEditorialMentionBoost(query, metrics.name, signals);
  const editorialContextScore = localEditorialContextScore(signals);
  const positionScore = localPositionScore(signals);
  const bodyMatchScore = localBodyMatchScore(signals);
  const candidateConfidenceScore = localCandidateConfidenceScore(signals);
  const contextQualityScore = localContextQualityScore(signals);
  const constraintMatchScore = localConstraintMatchScore(query, metrics.name, signals);
  const specificIntentEvidence = localSpecificIntentEvidence(query, metrics.name, signals);
  const specificIntentScore = localSpecificIntentScore(specificIntentEvidence);
  const specificIntentPenalty = localSpecificIntentPenalty(specificIntentEvidence);
  const wrongCategoryPenalty = localWrongCategoryPenalty(query, metrics.name, signals);
  const weakSingleSourcePenalty = localWeakSingleSourcePenalty(metrics, signals);
  const urlOnlyPenalty = localUrlOnlyPenalty(signals);
  const totalAdjustment = round1(
    sourceAuthorityScore +
      sourceAgreementScore +
      mentionFrequencyScore +
      locationMatchScore +
      categoryMatchScore +
      extractionConfidenceScore +
      sourceSpecificConfidence +
      reviewSourceSignal +
      editorialMentionBoost +
      editorialContextScore +
      positionScore +
      bodyMatchScore +
      candidateConfidenceScore +
      contextQualityScore +
      constraintMatchScore +
      specificIntentScore +
      ratingBoost -
      specificIntentPenalty -
      wrongCategoryPenalty -
      weakSingleSourcePenalty -
      urlOnlyPenalty
  );
  const netWeightedScore = round1(metrics.netWeightedScore + totalAdjustment);

  console.log("LOCAL_EDITORIAL_MENTION_BOOST", {
    name: metrics.name,
    boost: editorialMentionBoost,
    sources: signals
      .filter((signal) => localEditorialMentionSignal(signal))
      .map((signal) => ({ title: signal.sourceTitle, domain: signal.domain, reason: signal.extractedReason }))
      .slice(0, 5)
  });
  console.log("LOCAL_SCORE_BREAKDOWN", {
    name: metrics.name,
    baseScore: metrics.netWeightedScore,
    finalScore: netWeightedScore,
    sourceAuthorityScore,
    sourceAgreementScore,
    mentionFrequencyScore,
    locationMatchScore,
    geographicPrecision,
    categoryMatchScore,
    extractionConfidenceScore,
    sourceSpecificConfidence,
    reviewSourceSignal,
    editorialMentionBoost,
    editorialContextScore,
    positionScore,
    bodyMatchScore,
    candidateConfidenceScore,
    contextQualityScore,
    constraintMatchScore,
    specificIntentScore,
    specificIntentPenalty,
    wrongCategoryPenalty,
    ratingBoost,
    weakSingleSourcePenalty,
    urlOnlyPenalty
  });

  console.log("LOCAL_EDITORIAL_CONTEXT_SCORE", {
    name: metrics.name,
    score: editorialContextScore,
    reasons: signals.map((signal) => signal.extractedReason).filter((reason) => /recommendation context|editorial body/i.test(reason)).slice(0, 5)
  });
  console.log("LOCAL_POSITION_SCORE", {
    name: metrics.name,
    score: positionScore,
    reasons: signals.map((signal) => signal.extractedReason).filter((reason) => /position/i.test(reason)).slice(0, 5)
  });
  console.log("LOCAL_FINAL_SCORE_BREAKDOWN", {
    name: metrics.name,
    finalScore: netWeightedScore,
    sourceAuthorityScore,
    sourceAgreementScore,
    editorialMentionBoost,
    editorialContextScore,
    positionScore,
    bodyMatchScore,
    candidateConfidenceScore,
    contextQualityScore,
    specificIntentScore,
    specificIntentPenalty,
    wrongCategoryPenalty,
    weakSingleSourcePenalty,
    urlOnlyPenalty
  });
  console.log("LOCAL_CATEGORY_MATCH_SCORE", {
    name: metrics.name,
    category: localCategoryForQuery(query),
    specificIntent: specificIntentEvidence.intent?.key ?? null,
    specificIntentMatched: specificIntentEvidence.matched,
    score: categoryMatchScore
  });
  console.log("LOCAL_WRONG_CATEGORY_PENALTY", {
    name: metrics.name,
    category: localCategoryForQuery(query),
    specificIntent: specificIntentEvidence.intent?.key ?? null,
    penalty: wrongCategoryPenalty,
    specificIntentPenalty
  });
  console.log("LOCAL_SPECIFIC_INTENT", {
    name: metrics.name,
    intent: specificIntentEvidence.intent?.key ?? null,
    label: specificIntentEvidence.intent?.label ?? null,
    matched: specificIntentEvidence.matched,
    conflict: specificIntentEvidence.conflict,
    score: specificIntentScore,
    penalty: specificIntentPenalty,
    matchedSignals: specificIntentEvidence.matchedSignals
  });
  console.log("LOCAL_CONTEXT_QUALITY_SCORE", {
    name: metrics.name,
    score: contextQualityScore
  });
  console.log("LOCAL_FINAL_RANKING_INPUTS", {
    name: metrics.name,
    baseScore: metrics.netWeightedScore,
    finalScore: netWeightedScore,
    locationMatchScore,
    geographicPrecision,
    categoryMatchScore,
    sourceAuthorityScore,
    sourceAgreementScore,
    crossSourceAgreementCount,
    mentionFrequencyScore,
    extractionConfidenceScore,
    candidateConfidenceScore,
    contextQualityScore,
    specificIntentScore,
    specificIntentPenalty,
    wrongCategoryPenalty,
    weakSingleSourcePenalty,
    urlOnlyPenalty,
    sourceDomains
  });

  return {
    ...metrics,
    averageRating,
    confidence: localConfidence(metrics.sourceCount, metrics.sourceTypes.length, highAuthoritySignals),
    weightedPositiveScore: round1(metrics.weightedPositiveScore + sourceAuthorityScore / 3 + sourceAgreementScore / 4 + ratingBoost / 3),
    netWeightedScore,
    localRanking: {
      baseScore: metrics.netWeightedScore,
      finalScore: netWeightedScore,
      locationMatchScore,
      geographicPrecision,
      categoryMatchScore,
      sourceAuthorityScore,
      sourceAgreementScore,
      crossSourceAgreementCount,
      mentionFrequencyScore,
      extractionConfidence,
      extractionConfidenceScore,
      sourceSpecificConfidence,
      reviewSourceSignal,
      editorialMentionBoost,
      editorialContextScore,
      positionScore,
      bodyMatchScore,
      candidateConfidenceScore,
      contextQualityScore,
      wrongCategoryPenalty,
      weakSingleSourcePenalty,
      urlOnlyPenalty,
      sourceDomains
    }
  };
}

type LocalGeographicPrecision = {
  tier: string;
  score: number;
};

function localLocationMatchScore(query: string, contenderName: string, signals: SourceSignal[], precision = localBestGeographicPrecision(query, contenderName, signals)) {
  const queryText = normalizeQuery(query);
  const evidenceText = normalizeQuery([contenderName, ...signals.map((signal) => `${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`)].join(" "));
  const tokens = localLocationTokens(queryText);
  let score = 0;

  if (tokens.length) {
    const matches = tokens.filter((token) => evidenceText.includes(token)).length;
    score += Math.min(matches, 3) * 1.4;
  }

  score += precision.score;

  if (/\bwilliamsburg\b/.test(queryText) && /\b(colonial williamsburg|williamsburg va|virginia|va 23185|richmond rd)\b/.test(evidenceText)) score -= 16;
  if (/\bnyc|new york|brooklyn|manhattan|williamsburg\b/.test(queryText) && /\b(las vegas|atlanta|williamsburg va|colonial williamsburg|virginia|richmond rd)\b/.test(evidenceText)) score -= 9;
  if (/\bseattle\b/.test(queryText) && /\b(seatac|bellevue|tacoma)\b/.test(evidenceText)) score -= 1.5;
  if (/\baustin\b/.test(queryText) && /\b(round rock|dallas|houston|san antonio)\b/.test(evidenceText)) score -= 3;
  if (/\bseaford\b/.test(queryText) && /\b(brooklyn|manhattan|nyc|new york city|soho|williamsburg|queens|bronx)\b/.test(evidenceText) && !/\bseaford\b/.test(evidenceText)) score -= 10;
  if (/\bhuntington\b/.test(queryText) && /\b(brooklyn|manhattan|nyc|new york city|soho|williamsburg|queens|bronx)\b/.test(evidenceText) && !/\bhuntington\b/.test(evidenceText)) score -= 10;
  if (/\bdelray beach\b/.test(queryText) && /\b(miami|fort lauderdale|orlando|tampa|jacksonville|new york|nyc|manhattan|brooklyn)\b/.test(evidenceText) && !/\bdelray beach\b/.test(evidenceText)) score -= 10;
  if (/\bmassapequa\b/.test(queryText) && /\b(new york city|manhattan|brooklyn|catskills)\b/.test(evidenceText)) score -= 6;
  if (/\blos angeles\b/.test(queryText) && /\b(instant noodles|consumer reports|wirecutter)\b/.test(evidenceText)) score -= 8;

  return round1(Math.max(-20, Math.min(score, 7)));
}

function localBestGeographicPrecision(query: string, contenderName: string, signals: SourceSignal[]): LocalGeographicPrecision {
  const placesPrecision = localPlacesGeographicPrecision(query, contenderName);

  if (placesPrecision) {
    return placesPrecision;
  }

  return localGeographicPrecisionFromText(
    normalizeQuery(query),
    normalizeQuery([contenderName, ...signals.map((signal) => `${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`)].join(" "))
  );
}

function localGeographicPrecisionFromText(queryText: string, evidenceText: string): LocalGeographicPrecision {
  const tiers: Array<{ query: RegExp; exact: RegExp; adjacent: RegExp; nearby: RegExp; reject?: RegExp }> = [
    {
      query: /\bwantagh\b/,
      exact: /\bwantagh\b/,
      adjacent: /\b(seaford|bellmore|massapequa|levittown)\b/,
      nearby: /\b(farmingdale|hicksville|merrick|long island|nassau)\b/,
      reject: /\b(whitestone|queens|brooklyn|manhattan|bronx|staten island|westchester|connecticut|new jersey|new york city|nyc)\b/
    },
    {
      query: /\bseaford\b/,
      exact: /\bseaford\b/,
      adjacent: /\b(wantagh|massapequa|bellmore|merrick|levittown)\b/,
      nearby: /\b(farmingdale|amityville|freeport|hicksville|long island|nassau)\b/,
      reject: /\b(whitestone|queens|brooklyn|manhattan|bronx|staten island|westchester|connecticut|new jersey|new york city|nyc)\b/
    },
    {
      query: /\bmassapequa\b/,
      exact: /\bmassapequa\b/,
      adjacent: /\b(seaford|wantagh|amityville|farmingdale|bellmore)\b/,
      nearby: /\b(merrick|freeport|hicksville|long island|nassau)\b/,
      reject: /\b(whitestone|queens|brooklyn|manhattan|bronx|staten island|westchester|connecticut|new jersey|new york city|nyc)\b/
    },
    {
      query: /\bhuntington\b/,
      exact: /\bhuntington\b(?!\s+beach)/,
      adjacent: /\b(huntington station|greenlawn|centerport|cold spring harbor|northport|melville)\b/,
      nearby: /\b(syosset|woodbury|commack|long island|suffolk)\b/,
      reject: /\b(huntington beach|orange county|california|ca|queens|brooklyn|manhattan|bronx|staten island|westchester|connecticut|new jersey|new york city|nyc)\b/
    },
    {
      query: /\bdelray beach\b/,
      exact: /\bdelray beach\b/,
      adjacent: /\b(boca raton|boynton beach|highland beach|gulf stream)\b/,
      nearby: /\b(palm beach|deerfield beach|lake worth|south florida)\b/,
      reject: /\b(new york|nyc|manhattan|brooklyn|queens|bronx|staten island|orlando|tampa|jacksonville)\b/
    },
    {
      query: /\bnyc|new york city\b/,
      exact: /\b(nyc|new york city|new york|manhattan|brooklyn|queens|bronx|staten island)\b/,
      adjacent: /\b(williamsburg|soho|west village|east village|upper east side|lower east side|greenwich village|tribeca|chelsea|midtown|downtown|uptown)\b/,
      nearby: /\b(jersey city|hoboken|long island|westchester)\b/
    },
    {
      query: /\bmanhattan\b/,
      exact: /\bmanhattan\b/,
      adjacent: /\b(soho|west village|east village|upper east side|lower east side|greenwich village|tribeca|chelsea|midtown|downtown|uptown)\b/,
      nearby: /\b(brooklyn|queens|new york city|nyc)\b/
    },
    {
      query: /\bbrooklyn\b/,
      exact: /\bbrooklyn\b/,
      adjacent: /\b(williamsburg|greenpoint|bushwick|park slope|dumbo|cobble hill|carroll gardens|fort greene|bed stuy)\b/,
      nearby: /\b(manhattan|queens|new york city|nyc)\b/
    },
    {
      query: /\bwilliamsburg\b/,
      exact: /\bwilliamsburg\b/,
      adjacent: /\b(greenpoint|bushwick|east williamsburg|brooklyn)\b/,
      nearby: /\b(manhattan|queens|new york city|nyc)\b/,
      reject: /\b(colonial williamsburg|williamsburg va|virginia|richmond rd)\b/
    }
  ];

  const tier = tiers.find((candidate) => candidate.query.test(queryText));

  if (!tier) return { tier: "unspecified", score: 0 };
  if (tier.reject?.test(evidenceText) && !tier.exact.test(evidenceText) && !tier.adjacent.test(evidenceText)) return { tier: "far_rejected", score: -18 };
  if (tier.exact.test(evidenceText)) return { tier: "exact", score: 6 };
  if (tier.adjacent.test(evidenceText)) return { tier: "adjacent", score: 1 };
  if (tier.nearby.test(evidenceText)) return { tier: "nearby", score: -2.5 };
  return { tier: "missing", score: -4.5 };
}

function localPlacesGeographicPrecision(query: string, contenderName: string): LocalGeographicPrecision | null {
  const validation = getCachedPlacesValidationSnapshot(query, contenderName);

  if (!validation || validation.status !== "verified") {
    return null;
  }

  const queryText = normalizeQuery(query);
  const address = normalizeQuery(validation.formattedAddress ?? "");
  const coordinatePrecision =
    typeof validation.latitude === "number" && typeof validation.longitude === "number"
      ? localCoordinateGeographicPrecision(queryText, validation.latitude, validation.longitude)
      : null;
  const textPrecision = address ? localGeographicPrecisionFromText(queryText, address) : null;

  if (!coordinatePrecision) return textPrecision;
  if (!textPrecision) return coordinatePrecision;

  if (coordinatePrecision.score <= -10 || textPrecision.score <= -10) {
    return coordinatePrecision.score <= textPrecision.score ? coordinatePrecision : textPrecision;
  }

  return coordinatePrecision.score >= textPrecision.score ? coordinatePrecision : textPrecision;
}

function localCoordinateGeographicPrecision(queryText: string, latitude: number, longitude: number): LocalGeographicPrecision | null {
  const requested = localRequestedGeoCenter(queryText);

  if (!requested) return null;

  const distanceMiles = distanceMilesBetween(latitude, longitude, requested.latitude, requested.longitude);

  if (requested.scope === "metro") {
    if (distanceMiles <= requested.exactMiles) return { tier: "places_exact_metro", score: 5 };
    if (distanceMiles <= requested.nearbyMiles) return { tier: "places_nearby_metro", score: 0.5 };
    return { tier: "places_far_rejected", score: -18 };
  }

  if (distanceMiles <= requested.exactMiles) return { tier: "places_exact", score: 6.5 };
  if (distanceMiles <= requested.adjacentMiles) return { tier: "places_adjacent", score: 1.2 };
  if (distanceMiles <= requested.nearbyMiles) return { tier: "places_nearby", score: -2.4 };
  return { tier: "places_far_rejected", score: -18 };
}

function localRequestedGeoCenter(queryText: string) {
  const centers = [
    { pattern: /\bwantagh\b/, latitude: 40.6837, longitude: -73.5101, exactMiles: 2.5, adjacentMiles: 6.5, nearbyMiles: 13, scope: "town" as const },
    { pattern: /\bseaford\b/, latitude: 40.6659, longitude: -73.4882, exactMiles: 2.5, adjacentMiles: 6.5, nearbyMiles: 13, scope: "town" as const },
    { pattern: /\bmassapequa\b/, latitude: 40.6807, longitude: -73.4743, exactMiles: 2.8, adjacentMiles: 7, nearbyMiles: 14, scope: "town" as const },
    { pattern: /\bhuntington\b/, latitude: 40.8682, longitude: -73.4257, exactMiles: 3, adjacentMiles: 7.5, nearbyMiles: 15, scope: "town" as const },
    { pattern: /\bdelray beach\b/, latitude: 26.4615, longitude: -80.0728, exactMiles: 3.5, adjacentMiles: 8, nearbyMiles: 16, scope: "town" as const },
    { pattern: /\bnyc|new york city\b/, latitude: 40.7128, longitude: -74.006, exactMiles: 16, adjacentMiles: 0, nearbyMiles: 26, scope: "metro" as const },
    { pattern: /\bmanhattan\b/, latitude: 40.7831, longitude: -73.9712, exactMiles: 7, adjacentMiles: 0, nearbyMiles: 14, scope: "metro" as const },
    { pattern: /\bbrooklyn\b/, latitude: 40.6782, longitude: -73.9442, exactMiles: 9, adjacentMiles: 0, nearbyMiles: 16, scope: "metro" as const },
    { pattern: /\bwilliamsburg\b/, latitude: 40.7081, longitude: -73.9571, exactMiles: 2.4, adjacentMiles: 5.5, nearbyMiles: 10, scope: "town" as const }
  ];

  return centers.find((center) => center.pattern.test(queryText)) ?? null;
}

function distanceMilesBetween(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) {
  const radiusMiles = 3958.8;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(latitudeB - latitudeA);
  const deltaLongitude = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(deltaLongitude / 2) * Math.sin(deltaLongitude / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return radiusMiles * c;
}

function localLocationTokens(normalizedQuery: string) {
  const known = [
    "wantagh",
    "williamsburg",
    "brooklyn",
    "manhattan",
    "nyc",
    "new york",
    "seattle",
    "austin",
    "massapequa",
    "seaford",
    "huntington",
    "delray beach",
    "delray",
    "florida",
    "fl",
    "los angeles",
    "long island",
    "chicago",
    "san francisco"
  ];
  return known.filter((token) => normalizedQuery.includes(token));
}

type LocalSpecificIntent = {
  key: string;
  label: string;
  supportPattern: RegExp;
  conflictPattern?: RegExp;
};

type LocalSpecificIntentEvidence = {
  intent: LocalSpecificIntent | null;
  matched: boolean;
  conflict: boolean;
  matchedSignals: number;
};

function localSpecificIntentForQuery(query: string): LocalSpecificIntent | null {
  const normalized = normalizeLocalQueryIntent(query);

  if (/\bespresso martini\b/.test(normalized)) {
    return {
      key: "cocktail",
      label: "cocktail",
      supportPattern: /\b(bar|cocktail|drinks?|pub|tavern|lounge|martini|speakeasy)\b/,
      conflictPattern: /\b(hotel|museum|dentist|plumber|gym)\b/
    };
  }

  const intents: LocalSpecificIntent[] = [
    {
      key: "italian",
      label: "Italian",
      supportPattern: /\b(italian|pasta|trattoria|osteria|ristorante|pizzeria|pizza|parm|parmigiana|red sauce|bolognese|carbonara|gnocchi|ravioli|lasagna|risotto)\b/,
      conflictPattern: /\b(seafood|fish|oyster|clam|lobster|crab|sushi|ramen|taqueria|taco|tacos|barbecue|bbq|steakhouse|burger)\b/
    },
    {
      key: "seafood",
      label: "seafood",
      supportPattern: /\b(seafood|fish|oyster|clam|lobster|crab|shrimp|scallop|raw bar|catch|shellfish|coastal)\b/,
      conflictPattern: /\b(italian|trattoria|osteria|pasta|ramen|taqueria|taco|tacos|steakhouse|burger)\b/
    },
    {
      key: "sushi",
      label: "sushi",
      supportPattern: /\b(sushi|omakase|sashimi|nigiri|handroll|hand roll|izakaya|yakitori|japanese)\b/,
      conflictPattern: /\b(italian|trattoria|pasta|pizza|taqueria|taco|tacos|steakhouse|burger)\b/
    },
    {
      key: "pizza",
      label: "pizza",
      supportPattern: /\b(pizza|pizzeria|slice|slices|neapolitan|sicilian|grandma pie|wood fired|coal fired)\b/,
      conflictPattern: /\b(sushi|ramen|seafood|oyster|steakhouse|burger|hotel)\b/
    },
    {
      key: "mexican",
      label: "Mexican",
      supportPattern: /\b(mexican|taco|tacos|taqueria|burrito|quesadilla|tostada|mezcal|mole|al pastor|birria)\b/,
      conflictPattern: /\b(italian|trattoria|pasta|pizza|sushi|ramen|steakhouse|burger)\b/
    },
    {
      key: "steakhouse",
      label: "steakhouse",
      supportPattern: /\b(steakhouse|steak house|steak|chophouse|prime rib|porterhouse|ribeye|filet mignon)\b/,
      conflictPattern: /\b(sushi|ramen|taqueria|taco|tacos|pizzeria|pizza|coffee|cafe)\b/
    },
    {
      key: "brunch",
      label: "brunch",
      supportPattern: /\b(brunch|breakfast|pancake|waffle|eggs benedict|bloody mary|mimosa)\b/,
      conflictPattern: /\b(hotel|museum|attraction|dentist|plumber)\b/
    },
    {
      key: "coffee",
      label: "coffee",
      supportPattern: /\b(coffee|cafe|café|espresso|latte|cappuccino|roaster|roastery|cold brew)\b/,
      conflictPattern: /\b(hotel|museum|attraction|dentist|plumber|steakhouse|sushi)\b/
    },
    {
      key: "bar",
      label: "bar",
      supportPattern: /\b(bar|cocktail|drinks?|pub|tavern|lounge|brewery|taproom|wine bar|speakeasy)\b/,
      conflictPattern: /\b(hotel|museum|dentist|plumber|gym)\b/
    },
    {
      key: "live_music",
      label: "live music",
      supportPattern: /\b(live music|music venue|jazz|band|concert|performance|stage|venue)\b/,
      conflictPattern: /\b(hotel|dentist|plumber|gym)\b/
    }
  ];

  return (
    intents.find((intent) => {
      if (intent.key === "bar" && /\blive music\b/.test(normalized)) return false;
      return intent.supportPattern.test(normalized);
    }) ?? null
  );
}

function localSignalSpecificIntentEvidenceText(contenderName: string, signal: SourceSignal, intent: LocalSpecificIntent) {
  const sourceTitle = signal.sourceTitle ?? "";
  const normalizedTitle = normalizeQuery(sourceTitle);
  const normalizedContender = normalizeQuery(contenderName);
  const titleLooksGeneric =
    isArticleOrGuideTitle(normalizedTitle) ||
    /\b(?:best|top|guide|where to|restaurants?|places?|spots?|near me)\b/.test(normalizedTitle);
  const titleNamesContender = normalizedContender.length >= 3 && normalizedTitle.includes(normalizedContender);

  return normalizeQuery(
    [
      contenderName,
      titleNamesContender || !titleLooksGeneric ? sourceTitle : "",
      signal.extractedReason,
      signal.positiveMention ?? "",
      signal.negativeMention ?? "",
      signal.themes.join(" "),
      signal.verifiedAddress ?? "",
      placesTypesSupportSpecificIntent(intent, signal.placesTypes ?? []) ? signal.placesTypes?.join(" ") : ""
    ].join(" ")
  );
}

function placesTypesSupportSpecificIntent(intent: LocalSpecificIntent, placesTypes: string[]) {
  const normalizedTypes = normalizeQuery(placesTypes.join(" "));

  if (!normalizedTypes) return false;
  if (intent.key === "coffee") return /\b(coffee shop|cafe|bakery)\b/.test(normalizedTypes);
  if (intent.key === "bar" || intent.key === "cocktail" || intent.key === "live_music") return /\b(bar|night club)\b/.test(normalizedTypes);
  if (intent.key === "pizza") return /\bpizza restaurant\b/.test(normalizedTypes);

  return false;
}

function localSpecificIntentText(contenderName: string, signals: SourceSignal[]) {
  return normalizeQuery(
    [
      contenderName,
      ...signals.map((signal) =>
        [
          signal.sourceTitle,
          signal.queryVariant ?? "",
          signal.extractedReason,
          signal.positiveMention ?? "",
          signal.negativeMention ?? "",
          signal.themes.join(" "),
          signal.verifiedAddress ?? "",
          signal.placesTypes?.join(" ") ?? ""
        ].join(" ")
      )
    ].join(" ")
  );
}

function localCandidateEvidenceText(contenderName: string, signals: SourceSignal[]) {
  return normalizeQuery(
    [
      contenderName,
      ...signals.map((signal) =>
        [
          signal.sourceTitle,
          signal.domain,
          signal.extractedReason,
          signal.positiveMention ?? "",
          signal.negativeMention ?? "",
          signal.themes.join(" "),
          signal.verifiedAddress ?? "",
          signal.placesTypes?.join(" ") ?? ""
        ].join(" ")
      )
    ].join(" ")
  );
}

function localSpecificIntentEvidence(query: string, contenderName: string, signals: SourceSignal[]): LocalSpecificIntentEvidence {
  const intent = localSpecificIntentForQuery(query);

  if (!intent) {
    return { intent: null, matched: true, conflict: false, matchedSignals: 0 };
  }

  const nameText = normalizeQuery(contenderName);
  const matchedSignals = signals.filter((signal) => intent.supportPattern.test(localSignalSpecificIntentEvidenceText(contenderName, signal, intent))).length;
  const evidenceText = normalizeQuery(
    [
      contenderName,
      ...signals.map((signal) => localSignalSpecificIntentEvidenceText(contenderName, signal, intent))
    ].join(" ")
  );
  const matched = intent.supportPattern.test(nameText) || matchedSignals > 0 || intent.supportPattern.test(evidenceText);
  const conflict = Boolean(intent.conflictPattern?.test(evidenceText));

  return { intent, matched, conflict, matchedSignals };
}

function localSpecificIntentScore(evidence: LocalSpecificIntentEvidence) {
  if (!evidence.intent) return 0;
  if (evidence.matched) return round1(Math.min(5.5, 3.5 + evidence.matchedSignals * 0.8));
  return -7;
}

function localSpecificIntentPenalty(evidence: LocalSpecificIntentEvidence) {
  if (!evidence.intent || evidence.matched) return 0;
  return evidence.conflict ? 15 : 11;
}

function localCandidatePassesDiscovery(query: string, contender: ContenderMetrics, signals: SourceSignal[]) {
  const rejectionReason = localCandidateDiscoveryRejectionReason(query, contender, signals);

  if (!rejectionReason) return true;

  console.log("LOCAL_CANDIDATE_DISCOVERY_REJECTED", {
    name: contender.name,
    reason: rejectionReason,
    sourceCount: contender.sourceCount,
    positiveMentionCount: contender.positiveMentionCount,
    localRanking: contender.localRanking,
    verifiedAddresses: signals.map((signal) => signal.verifiedAddress).filter(Boolean),
    placesVerified: signals.some((signal) => signal.placesVerified)
  });

  return false;
}

function localCandidateDiscoveryRejectionReason(query: string, contender: ContenderMetrics, signals: SourceSignal[]) {
  const name = localBusinessDisplayName(contender.name);
  const normalizedName = normalizeQuery(name || contender.name);
  const evidenceText = localCandidateEvidenceText(contender.name, signals);
  const specificIntentEvidence = localSpecificIntentEvidence(query, contender.name, signals);
  const verifiedByPlaces = localCandidateHasVerifiedPlacesEvidence(query, signals);
  const universalRejection = localUniversalEntityRejectionReason(query, contender.name, { signals });

  if (!signals.length) return "no_source_evidence";
  if (verifiedByPlaces && !specificIntentEvidence.intent) return null;
  if (universalRejection) return universalRejection;
  if (!name || !looksLikeNamedPlace(name)) return "not_business_name";
  if (isGenericLocalContender(query, name) || isGenericLocalContender(query, contender.name)) return "generic_or_non_business";
  if (isLocalCandidateControlText(normalizedName)) return "page_control_or_generic_text";
  if (isWeakLocalContender(contender)) return "weak_local_contender";
  if (!localCandidateHasLocationEvidence(query, contender.name, signals)) return "missing_location_evidence";
  if (localCandidateHasLocationLeakage(query, evidenceText)) return "wrong_location_evidence";
  if (!localCandidateHasCategoryEvidence(query, contender.name, signals)) return "missing_category_evidence";

  if (specificIntentEvidence.intent && !specificIntentEvidence.matched) {
    return specificIntentEvidence.conflict ? `wrong_${specificIntentEvidence.intent.key}_conflict` : `missing_${specificIntentEvidence.intent.key}_evidence`;
  }

  return null;
}

function localCandidateHasVerifiedPlacesEvidence(query: string, signals: SourceSignal[]) {
  return signals.some(
    (signal) =>
      signal.placesVerified &&
      Boolean(signal.verifiedAddress) &&
      (signal.placesLocationConfidence ?? 0) >= 0.25 &&
      (signal.placesCategoryConfidence ?? 0) >= 0.2 &&
      localCandidateHasLocationEvidence(query, signal.contenderName, [signal])
  );
}

type LocalUniversalEntityValidationContext = {
  signals?: SourceSignal[];
  source?: VeraSource;
  placeCandidate?: LocalPlaceCandidate;
  reason?: string;
};

function localUniversalEntityRejectionReason(query: string, candidate: string, context: LocalUniversalEntityValidationContext = {}) {
  const displayName = localBusinessDisplayName(candidate);
  const normalized = normalizeQuery(displayName || candidate);
  const rawNormalized = normalizeQuery(candidate);
  const evidenceText = normalizeQuery(
    [
      candidate,
      displayName,
      context.reason ?? "",
      context.source?.title ?? "",
      context.source?.domain ?? "",
      context.source ? localSourceEvidenceText(context.source) : "",
      context.placeCandidate?.evidenceText ?? "",
      ...(context.signals ?? []).map((signal) =>
        [signal.sourceTitle, signal.domain, signal.extractedReason, signal.positiveMention ?? "", signal.negativeMention ?? "", signal.themes.join(" ")].join(" ")
      )
    ].join(" ")
  );

  if (!normalized || normalized.length < 3) return "empty_or_too_short";
  if (isLocalCandidateControlText(normalized) || isLocalCandidateControlText(rawNormalized)) return "page_control_or_generic_text";
  if (isLocalSearchSubjectOnly(query, normalized)) return "search_subject_not_business";
  if (isLocalLocationOnlyEntity(normalized)) return "location_only";
  if (isLocalSourceChromeOrArticleFragment(normalized)) return "source_or_ui_fragment";
  if (isGenericLocalContender(query, displayName || candidate) || isGenericLocalContender(query, candidate)) return "generic_or_non_business";
  if (isArticleOrGuideTitle(normalized)) return "article_title_fragment";
  if (/\b(?:reserve a table with|book a table|view menu|order delivery|to go and delivery|reserve now|make a reservation)\b/.test(evidenceText) && normalized.split(" ").length <= 4) {
    return "page_control_or_generic_text";
  }
  if (!looksLikeNamedPlace(displayName || candidate) && !hasBusinessNameSignal(displayName || candidate)) return "not_business_name";

  return null;
}

function isLocalSearchSubjectOnly(query: string, normalizedCandidate: string) {
  const normalizedQuery = normalizeLocalQueryIntent(query);
  const subjects = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeQuery(value);
    if (normalized.length >= 3) subjects.add(normalized);
  };

  for (const subject of [
    "espresso martini",
    "italian food",
    "italian food and pizza",
    "seafood",
    "sushi",
    "pizza",
    "coffee",
    "brunch",
    "cocktails",
    "cocktail",
    "bar",
    "restaurant",
    "restaurants",
    "things to do",
    "restaurants near me"
  ]) {
    if (normalizedQuery.includes(subject)) add(subject);
  }

  const fromBest = normalizedQuery
    .match(/\b(?:best|top|good|great|recommended)\s+(.+?)(?:\s+(?:in|near|around|for)\b|$)/)?.[1]
    ?.replace(/\b(?:restaurants?|restaurant|places?|spots?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (fromBest) add(fromBest);

  return subjects.has(normalizedCandidate);
}

function isLocalLocationOnlyEntity(normalizedCandidate: string) {
  return /^(?:upper east side|lower east side|west village|east village|greenwich village|soho|tribeca|chelsea|hells kitchen|midtown|downtown|uptown|manhattan|brooklyn|queens|bronx|staten island|williamsburg|seaford|massapequa|massapequa park|huntington|delray beach|nyc|new york|new york city|long island|nassau|suffolk)$/.test(
    normalizedCandidate
  );
}

function isLocalCandidateControlText(normalizedName: string) {
  return (
    /^(?:to go|delivery|order online|reservations?|reserve a table with|book a table|view menu|catering|hours|directions|reviews?|near me|best|restaurants?|food|official website|tripadvisor|yelp|doordash|ubereats|grubhub)$/.test(
      normalizedName
    ) ||
    /\b(?:to go|delivery|order online|reservations?|reserve a table with|book a table|view menu|catering|hours|directions|near me|official website|tripadvisor|yelp|doordash|ubereats|grubhub)\b/.test(
      normalizedName
    ) ||
    /^(?:italian|seafood|sushi|pizza|brunch|coffee|mexican|steakhouse|bar|restaurant)\s+(?:food|restaurants?|places?|spots?|food\s+and|and\s+)?\s*(?:pizza|sushi|seafood|brunch|coffee|bars?|restaurants?)?$/.test(
      normalizedName
    )
  );
}

function localCandidateHasLocationEvidence(query: string, contenderName: string, signals: SourceSignal[]) {
  const terms = localRequestedLocationTerms(query);

  if (!terms.length) return true;

  return signals.some((signal) => {
    const text = normalizeQuery(
      [contenderName, signal.sourceTitle, signal.domain, signal.extractedReason, signal.positiveMention ?? "", signal.negativeMention ?? "", signal.verifiedAddress ?? ""].join(" ")
    );
    return terms.some((term) => text.includes(term));
  });
}

function localRequestedLocationTerms(query: string) {
  const normalized = normalizeLocalQueryIntent(query);
  const terms = new Set<string>();

  const add = (value: string) => {
    const normalizedValue = normalizeQuery(value);
    if (normalizedValue.length >= 3) terms.add(normalizedValue);
  };

  const explicitLocation = normalized
    .match(/\b(?:in|near|around)\s+(.+?)$/)?.[1]
    ?.replace(/\b(?:ny|new york|fl|florida|ca|california|tx|texas|best|top|restaurants?|restaurant|seafood|italian|sushi|pizza|brunch|coffee|bar|bars|mexican|steakhouse)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (explicitLocation) add(explicitLocation);
  if (/\bseaford\b/.test(normalized)) add("seaford");
  if (/\bwantagh\b/.test(normalized)) add("wantagh");
  if (/\bhuntington\b/.test(normalized)) add("huntington");
  if (/\bmassapequa\b/.test(normalized)) add("massapequa");
  if (/\bdelray beach\b/.test(normalized)) {
    add("delray beach");
    add("delray");
  }
  if (/\bwilliamsburg\b/.test(normalized)) add("williamsburg");
  if (/\bbrooklyn\b/.test(normalized)) add("brooklyn");
  if (/\bqueens\b/.test(normalized)) {
    add("queens");
    add("astoria");
    add("flushing");
    add("forest hills");
    add("long island city");
    add("lic");
    add("sunnyside");
    add("jackson heights");
    add("jamaica");
    add("ridgewood");
    add("elmhurst");
    add("woodside");
  }
  if (/\bmanhattan\b/.test(normalized)) add("manhattan");
  if (/\bnyc|new york city\b/.test(normalized)) add("new york");

  return Array.from(terms);
}

function localCandidateHasLocationLeakage(query: string, evidenceText: string) {
  const queryText = normalizeLocalQueryIntent(query);
  const leakagePatterns: Array<[RegExp, RegExp]> = [
    [/\bwantagh\b/, /\b(nyc|new york city|manhattan|brooklyn|queens|bronx|staten island|whitestone|westchester|connecticut|new jersey)\b/],
    [/\bseaford\b/, /\b(nyc|new york city|manhattan|brooklyn|queens|bronx|staten island)\b/],
    [/\bhuntington\b/, /\b(huntington beach|orange county|california|nyc|new york city|manhattan|brooklyn|queens|bronx|staten island)\b/],
    [/\bdelray beach\b/, /\b(nyc|new york city|manhattan|brooklyn|queens|bronx|staten island)\b/]
  ];

  return leakagePatterns.some(([queryPattern, leakagePattern]) => queryPattern.test(queryText) && !leakagePattern.test(queryText) && leakagePattern.test(evidenceText));
}

function localCandidateHasCategoryEvidence(query: string, contenderName: string, signals: SourceSignal[]) {
  const category = localCategoryForQuery(query);
  const specificIntent = localSpecificIntentForQuery(query);

  if (specificIntent) {
    return localSpecificIntentEvidence(query, contenderName, signals).matched;
  }

  if (signals.some((signal) => signal.placesVerified && (signal.placesCategoryConfidence ?? 0) >= 0.2)) {
    return true;
  }

  if (category === "local_business") return true;

  return signals.some((signal) =>
    localCandidateHasCategorySignal(
      category,
      normalizeQuery(
        [
          contenderName,
          signal.sourceTitle,
          signal.domain,
          signal.extractedReason,
          signal.positiveMention ?? "",
          signal.negativeMention ?? "",
          signal.verifiedAddress ?? "",
          signal.placesTypes?.join(" ") ?? ""
        ].join(" ")
      )
    )
  );
}

function localCategoryMatchScore(query: string, contenderName: string, signals: SourceSignal[]) {
  const category = localCategoryForQuery(query);
  const queryText = normalizeLocalQueryIntent(query);
  const evidenceText = normalizeQuery([contenderName, ...signals.map((signal) => `${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`)].join(" "));
  let score = 0;

  if (localCandidateHasCategorySignal(category, evidenceText)) score += 3.5;
  if (localCandidateHasCategorySignal(category, normalizeQuery(contenderName))) score += 2.2;

  if (/\bramen\b/.test(queryText)) score += /\b(ramen|noodle|tsujita|tatsu|menya)\b/.test(evidenceText) ? 4.5 : -4;
  if (/\bsushi\b/.test(queryText)) score += /\b(sushi|omakase|handroll|izakaya)\b/.test(evidenceText) ? 4.5 : -4;
  if (/\btacos?\b/.test(queryText)) score += /\b(taco|tacos|taqueria|discada)\b/.test(evidenceText) ? 4 : -3;
  if (/\bespresso martini\b/.test(queryText)) score += /\b(bar|cocktail|lounge|martini|drinks?)\b/.test(evidenceText) ? 3.5 : -5;

  if (category === "hotel" && /\b(restaurant|bar|cafe|pizza|sushi|ramen)\b/.test(normalizeQuery(contenderName))) score -= 8;
  if ((category === "restaurant" || category === "bar") && /\b(hotel|inn|motel|residence inn|hilton|marriott)\b/.test(normalizeQuery(contenderName))) score -= 8;
  if (category === "dentist" && /\b(directory|dentists?|recommendation|delta dental|metlife|near me|texas|austin dentist office)\b/.test(evidenceText)) score -= 8;
  if (category === "plumber" && /\b(directory|near me|recommendation|king county)\b/.test(evidenceText)) score -= 4;
  if (category === "tattoo" && /\b(directory|near me|recommendation)\b/.test(evidenceText)) score -= 4;

  return round1(Math.max(-10, Math.min(score, 10)));
}

function localConstraintMatchScore(query: string, contenderName: string, signals: SourceSignal[]) {
  const constraints = parseLocalQueryConstraints(query);

  if (!constraints.length) return 0;

  const evidenceText = normalizeLocalQueryIntent(
    [
      contenderName,
      ...signals.map((signal) =>
        [
          signal.sourceTitle,
          signal.domain,
          signal.extractedReason,
          signal.positiveMention ?? "",
          signal.negativeMention ?? "",
          signal.themes.join(" ")
        ].join(" ")
      )
    ].join(" ")
  );
  let score = 0;

  for (const constraint of constraints) {
    const matcher = localConstraintEvidenceMatcher(constraint.key);
    score += matcher.test(evidenceText) ? 2.6 : -0.55;
  }

  return round1(Math.max(-4, Math.min(score, 7)));
}

function localConstraintEvidenceMatcher(key: string) {
  switch (key) {
    case "affordable":
      return /\b(cheap|affordable|budget|inexpensive|reasonable|reasonably priced|decent priced|value|best value|happy hour|deal|deals)\b/;
    case "upscale":
      return /\b(upscale|luxury|expensive|high end|fancy|elegant|special occasion)\b/;
    case "romantic":
      return /\b(romantic|date night|date-night|intimate|candlelit|cozy|quiet)\b/;
    case "casual":
      return /\b(casual|laid back|relaxed|easygoing)\b/;
    case "cozy":
      return /\b(cozy|cosy|intimate|warm|small)\b/;
    case "lively":
      return /\b(lively|energetic|busy|fun|vibrant)\b/;
    case "quiet":
      return /\b(quiet|conversation|low key|calm|relaxed)\b/;
    case "rooftop":
      return /\b(rooftop|roof deck|roof)\b/;
    case "waterfront":
      return /\b(waterfront|water view|on the water|riverfront|oceanfront)\b/;
    case "outdoor_seating":
      return /\b(outdoor|patio|sidewalk seating|garden|terrace)\b/;
    case "live_music":
      return /\b(live music|jazz|band|music venue|performances?)\b/;
    case "sports_bar":
      return /\b(sports bar|screens?|watch the game|game day|tv)\b/;
    case "family_friendly":
      return /\b(family friendly|kid friendly|good for kids|families|children)\b/;
    case "dog_friendly":
      return /\b(dog friendly|pet friendly|dogs allowed|dogs welcome)\b/;
    case "late_night":
      return /\b(late night|open late|after midnight|late-night)\b/;
    case "happy_hour":
      return /\b(happy hour|drink specials?|specials)\b/;
    case "homemade":
      return /\b(homemade|housemade|made in house|from scratch)\b/;
    case "authentic":
      return /\b(authentic|traditional|classic|old school)\b/;
    case "fresh":
      return /\b(fresh|seasonal|freshly made)\b/;
    case "healthy":
      return /\b(healthy|lighter|salad|vegetarian|vegan|organic)\b/;
    default:
      return /$a/;
  }
}

function localExtractionConfidence(signals: SourceSignal[]) {
  if (!signals.length) return 0.5;

  const total = signals.reduce((sum, signal) => {
    const reason = normalizeQuery(signal.extractedReason);
    const sourceBonus = localSourceAuthority(signal) === "high" ? 0.08 : localSourceAuthority(signal) === "medium" ? 0.03 : -0.03;
    const extractionBase = reason.includes("title evidence")
      ? 0.78
      : reason.includes("snippet evidence")
        ? 0.68
        : reason.includes("url evidence")
          ? 0.58
          : 0.66;
    const strengthBonus = signal.mentionStrength === "strong" ? 0.08 : signal.mentionStrength === "moderate" ? 0.04 : 0;
    return sum + extractionBase + sourceBonus + strengthBonus;
  }, 0);

  return round2(Math.max(0.4, Math.min(total / signals.length, 0.96)));
}

function localReviewSourceSignal(signals: SourceSignal[]) {
  const reviewSignals = signals.filter((signal) =>
    /\b(yelp|tripadvisor|opentable|resy|booking|google|maps|healthgrades|zocdoc|angi|homeadvisor|eater|infatuation|timeout|michelin)\b/.test(
      normalizeQuery(`${signal.domain} ${signal.sourceTitle}`)
    )
  ).length;
  return Math.min(reviewSignals, 4) * 0.9;
}

function localEditorialMentionBoost(query: string, contenderName: string, signals: SourceSignal[]) {
  const editorialSignals = signals.filter((signal) => localEditorialMentionSignal(signal));

  if (!editorialSignals.length) return 0;

  const locationScore = localLocationMatchScore(query, contenderName, signals);
  const categoryScore = localCategoryMatchScore(query, contenderName, signals);

  if (locationScore < 0 || categoryScore < 0) return 0;

  const headingSignals = editorialSignals.filter((signal) => normalizeQuery(signal.extractedReason).includes("heading"));
  const boost = Math.min(editorialSignals.length, 3) * 3.4 + Math.min(headingSignals.length, 2) * 2.2;

  return round1(boost);
}

function localEditorialContextScore(signals: SourceSignal[]) {
  const total = signals.reduce((sum, signal) => {
    const reason = normalizeQuery(signal.extractedReason);
    const sourceText = normalizeQuery(`${signal.domain} ${signal.sourceTitle}`);
    const editorial = /\b(eater|infatuation|timeout|time out|michelin|cntraveler|conde nast|travel leisure|nymag|new york magazine|local guide)\b/.test(sourceText);

    if (!editorial) return sum;
    if (reason.includes("related content")) return sum - 6;
    if (reason.includes("recommendation context")) return sum + 6.5;
    if (reason.includes("editorial body")) return sum + 4.2;
    if (reason.includes("heading")) return sum + 2.4;
    return sum;
  }, 0);

  return round1(Math.max(-8, Math.min(total, 14)));
}

function localPositionScore(signals: SourceSignal[]) {
  const scores: number[] = signals.map((signal) => {
    const position = normalizeQuery(signal.extractedReason).match(/position\s+(\d+)/)?.[1];

    if (!position) return 0;

    const numericPosition = Number(position);

    if (!Number.isFinite(numericPosition)) return 0;
    if (numericPosition <= 8) return 7;
    if (numericPosition <= 18) return 4.5;
    if (numericPosition <= 36) return 2;
    return 0.5;
  });

  return round1(Math.min(scores.reduce((sum, score) => sum + score, 0), 10));
}

function localBodyMatchScore(signals: SourceSignal[]) {
  const bodyMatches = signals.filter((signal) => normalizeQuery(signal.extractedReason).includes("editorial body")).length;

  return round1(Math.min(bodyMatches, 3) * 2.2);
}

function localCandidateConfidenceScore(signals: SourceSignal[]) {
  if (!signals.length) return 0;

  const levels = signals.map((signal) => normalizeQuery(signal.extractedReason).match(/candidate confidence (high|medium|low)/)?.[1]);
  const high = levels.filter((level) => level === "high").length;
  const medium = levels.filter((level) => level === "medium").length;
  const low = levels.filter((level) => level === "low").length;
  const unknownSignals = signals.length - high - medium - low;

  return round1(Math.min(high, 3) * 2.4 + Math.min(medium, 4) * 1.1 + Math.min(unknownSignals, 2) * 0.35 - Math.min(low, 4) * 2.2);
}

function localContextQualityScore(signals: SourceSignal[]) {
  const total = signals.reduce((sum, signal) => {
    const text = normalizeQuery(`${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`);
    let score = 0;

    if (/\b(recommendation context|editorial body|heading|position\s+\d+)\b/.test(text)) score += 2.4;
    if (/\b(best|top|favorite|recommended|essential|must try|where to eat|where to stay|editors pick|michelin|eater|infatuation|time out)\b/.test(text)) score += 1.4;
    if (/\b(related content|nearby|sidebar|footer|navigation|subscribe|book now|share|map controls|more recommendations|more editor recommended)\b/.test(text)) score -= 5.5;
    if (/\b(url evidence)\b/.test(text) && !/\b(editorial body|recommendation context)\b/.test(text)) score -= 1.6;

    return sum + score;
  }, 0);

  return round1(Math.max(-10, Math.min(total, 10)));
}

function localWrongCategoryPenalty(query: string, contenderName: string, signals: SourceSignal[]) {
  const category = localCategoryForQuery(query);
  const text = normalizeQuery([contenderName, ...signals.map((signal) => `${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`)].join(" "));
  const name = normalizeQuery(contenderName);
  let penalty = 0;

  const has = (pattern: RegExp) => pattern.test(text);
  const nameHas = (pattern: RegExp) => pattern.test(name);

  if (category === "hotel") {
    if (nameHas(/\b(pizza|pizzeria|taqueria|taco|sushi|ramen|cafe|coffee|bakery|bar|tavern|restaurant|grill)\b/)) penalty += 9;
    if (has(/\b(where to eat|restaurants?|bars?|coffee shops?|pizzerias?|taquerias?)\b/) && !has(/\b(hotel|inn|resort|lodging|rooms?|booking)\b/)) penalty += 5;
  }

  if (category === "restaurant" || category === "pizza" || category === "brunch") {
    if (nameHas(/\b(hotel|inn|motel|resort|suites|museum|park|tour|needle|observatory|aquarium|zoo|gym|fitness|dental|plumbing)\b/)) penalty += 9;
    if (has(/\b(hotels?|attractions?|things to do|dentists?|plumbers?|gyms?)\b/) && !has(/\b(restaurants?|where to eat|pizza|brunch|dining)\b/)) penalty += 4;
  }

  if (category === "coffee") {
    if (nameHas(/\b(router|netgear|orbi|eero|tp link|wifi|wi fi|hotel|inn|museum|park|gym|dental|plumbing)\b/)) penalty += 18;
    if (has(/\b(restaurants?|hotels?|attractions?|routers?|wifi|plumbers?|dentists?)\b/) && !has(/\b(coffee|cafe|espresso|roaster)\b/)) penalty += 5;
  }

  if (category === "bar") {
    if (nameHas(/\b(hotel|inn|museum|park|gym|dental|plumbing)\b/)) penalty += 8;
    if (has(/\b(hotels?|attractions?|dentists?|plumbers?|gyms?)\b/) && !has(/\b(bar|cocktail|drinks?|pub|tavern|lounge)\b/)) penalty += 4;
  }

  if (category === "bakery") {
    if (nameHas(/\b(hotel|inn|museum|park|gym|dental|plumbing|router)\b/)) penalty += 8;
    if (has(/\b(restaurants?|hotels?|attractions?)\b/) && !has(/\b(bakery|bakeries|pastry|bread|croissant|cafe)\b/)) penalty += 3;
  }

  if (category === "attraction") {
    if (nameHas(/\b(restaurant|pizza|pizzeria|bar|hotel|inn|cafe|coffee|bakery|gym|dental|plumbing)\b/)) penalty += 7;
    if (!has(/\b(museum|park|needle|market|aquarium|zoo|landmark|tour|attraction|things to do|garden|observatory)\b/)) penalty += 2;
  }

  if (category === "gym" && !has(/\b(gym|fitness|athletic|training|crossfit|yoga|pilates|barre|club|wellness)\b/)) penalty += 7;
  if (category === "dentist" && !has(/\b(dentist|dental|dds|dmd|orthodont|periodont|smile|oral|practice)\b/)) penalty += 9;
  if (category === "plumber" && !has(/\b(plumber|plumbing|rooter|drain|sewer|pipe|leak|water heater|service)\b/)) penalty += 9;
  if (category === "tattoo" && !has(/\b(tattoo|ink|artist|studio|body art)\b/)) penalty += 8;
  if (category === "golf_course" && !has(/\b(golf|course|club|links|country club)\b/)) penalty += 8;

  if (
    !["dentist", "plumber", "gym", "tattoo"].includes(category) &&
    nameHas(/\b(?:dr|dds|dmd|contributor|editor|writer|author|correspondent)\b/)
  ) {
    penalty += 12;
  }

  return round1(Math.min(penalty, 16));
}

function localEditorialMentionSignal(signal: SourceSignal) {
  const text = normalizeQuery(`${signal.domain} ${signal.sourceTitle} ${signal.extractedReason}`);

  return (
    signal.sentiment === "positive" &&
    (signal.sourceType === "editorial" || signal.sourceType === "local_guide" || signal.sourceType === "professional_review" || localSourceAuthority(signal) === "high") &&
    /\b(eater|infatuation|thevendry|timeout|time out|michelin|new york magazine|nymag|tripadvisor|yelp|booking|conde nast|cntraveler|travel leisure|local guide|magazine)\b/.test(text)
  );
}

function localWeakSingleSourcePenalty(metrics: ContenderMetrics, signals: SourceSignal[]) {
  if (metrics.sourceCount > 1) return 0;

  const signal = signals[0];
  const authority = signal ? localSourceAuthority(signal) : "low";
  const reason = normalizeQuery(signal?.extractedReason ?? "");
  let penalty = authority === "high" ? 2.5 : authority === "medium" ? 4.5 : 7;

  if (reason.includes("editorial body") || reason.includes("recommendation context")) penalty -= 3.5;
  if (reason.includes("url evidence")) penalty += 3;
  if (metrics.positiveMentionCount <= 1) penalty += 2;

  return round1(Math.max(0, penalty));
}

function localUrlOnlyPenalty(signals: SourceSignal[]) {
  if (!signals.length) return 0;

  const urlEvidenceCount = signals.filter((signal) => normalizeQuery(signal.extractedReason).includes("url evidence")).length;
  const corroborated = new Set(signals.map((signal) => signal.domain)).size > 1;

  if (urlEvidenceCount === signals.length) return corroborated ? 3 : 7;
  if (urlEvidenceCount > 0 && !corroborated) return 2.5;
  return 0;
}

function localCategoryForQuery(query: string) {
  const normalized = normalizeLocalQueryIntent(query);

  if (/\b(espresso martini|cocktail|cocktails|speakeasy)\b/.test(normalized)) return "bar";
  if (/\b(hotel|motel|inn|resort|lodging|place to stay)\b/.test(normalized)) return "hotel";
  if (/\b(coffee shop|coffee shops|coffee|cafe|cafes|café)\b/.test(normalized)) return "coffee";
  if (/\b(pizza|pizzeria)\b/.test(normalized)) return "pizza";
  if (/\b(sushi|ramen|taco|tacos|taqueria|italian|mexican|seafood|steakhouse|steak house)\b/.test(normalized)) return "restaurant";
  if (/\b(brunch)\b/.test(normalized)) return "brunch";
  if (/\b(bakery|bakeries)\b/.test(normalized)) return "bakery";
  if (/\b(bar|bars|pub|cocktail|brewery|taproom)\b/.test(normalized)) return "bar";
  if (/\b(gym|gyms|fitness)\b/.test(normalized)) return "gym";
  if (/\b(tattoo shop|tattoo shops|tattoo studio|tattoo studios|tattoo)\b/.test(normalized)) return "tattoo";
  if (/\b(dentist|dentists|dental)\b/.test(normalized)) return "dentist";
  if (/\b(plumber|plumbers|plumbing)\b/.test(normalized)) return "plumber";
  if (/\b(attraction|attractions|museum|landmark|things to do)\b/.test(normalized)) return "attraction";
  if (/\b(golf course|golf club)\b/.test(normalized)) return "golf_course";
  if (/\b(restaurant|restaurants|place to eat|dinner|lunch)\b/.test(normalized)) return "restaurant";

  return "local_business";
}

function localSourceAuthority(signal: SourceSignal): "high" | "medium" | "low" {
  return localSourceAuthorityFromText(`${signal.domain} ${signal.sourceTitle} ${signal.extractedReason}`);
}

function localSourceAuthorityRank(signal: SourceSignal) {
  return localAuthorityRank(localSourceAuthority(signal));
}

function localSourceAuthorityFromSource(source: VeraSource): "high" | "medium" | "low" {
  return localSourceAuthorityFromText(`${source.domain} ${source.title} ${localSourceEvidenceText(source)}`);
}

function localHighAuthorityEditorialSource(source: VeraSource) {
  const text = normalizeQuery(`${source.domain} ${source.title} ${localSourceEvidenceText(source)}`);

  return (
    localSourceAuthorityFromSource(source) === "high" &&
    /\b(eater|infatuation|thevendry|timeout|time out|michelin|new york magazine|nymag|seattle met|thrillist|conde nast|cntraveler|travel leisure|local guide|magazine)\b/.test(text)
  );
}

function localSourceAuthorityFromText(text: string): "high" | "medium" | "low" {
  const normalized = normalizeQuery(text);

  if (
    /\b(google maps|maps.google|yelp|tripadvisor|opentable|resy|booking.com|hotels.com|healthgrades|zocdoc|angi|homeadvisor|eater|infatuation|thevendry|timeout|michelin|cntraveler|conde nast|travel leisure|travelandleisure|golf digest|golfweek|official tourism|tourism|local guide|local guides|new york magazine|nymag|seattle met|thrillist)\b/.test(
      normalized
    )
  ) {
    return "high";
  }

  if (/\b(reddit|local community|forum|neighborhood|facebook group|nextdoor|youtube|blog)\b/.test(normalized)) {
    return "medium";
  }

  if (/\b(official site|sponsored|coupon|deal|advertisement|press release)\b/.test(normalized)) {
    return "low";
  }

  return "medium";
}

function localAverageRating(signals: SourceSignal[]) {
  const ratings = signals
    .flatMap((signal) => {
      const text = `${signal.sourceTitle} ${signal.extractedReason} ${signal.positiveMention ?? ""}`;
      const matches = Array.from(text.matchAll(/\b([3-5](?:\.\d)?)\s*(?:\/\s*5|stars?|rating)\b/gi));
      return matches.map((match) => Number(match[1])).filter((rating) => rating >= 3 && rating <= 5);
    })
    .slice(0, 8);

  if (!ratings.length) {
    return undefined;
  }

  return round1(ratings.reduce((total, rating) => total + rating, 0) / ratings.length);
}

function localConfidence(sourceCount: number, sourceDiversity: number, highAuthoritySignals: number): "low" | "medium" | "high" {
  if (sourceCount >= 4 && sourceDiversity >= 3 && highAuthoritySignals >= 2) return "high";
  if (sourceCount >= 2 && sourceDiversity >= 2) return "medium";
  return "low";
}

function localSourceWeightSummary(sources: VeraSource[]) {
  return sources.reduce(
    (summary, source) => {
      const authority = localSourceAuthorityFromSource(source);
      summary[authority] += 1;
      return summary;
    },
    { high: 0, medium: 0, low: 0 } as Record<"high" | "medium" | "low", number>
  );
}

type LocalPriorResult = {
  applied: boolean;
  contendersFound: string[];
  signals: SourceSignal[];
  diagnostics: LocalPlaceExtractionDiagnostic[];
};

function localRecommendationPrior(query: string, sources: VeraSource[], signals: SourceSignal[], evidenceType: QueryEvidenceType): LocalPriorResult {
  if (evidenceType !== "local_recommendation") {
    return { applied: false, contendersFound: [], signals: [], diagnostics: [] };
  }

  const existingContenders = new Set(
    signals
      .map((signal) => signal.contenderName)
      .filter((name) => !isRejectableLocalSignalName(query, name))
      .map((name) => localBusinessKey(name))
      .filter(Boolean)
  );

  const sparseMode = existingContenders.size < 5;
  const extractionSources = sparseMode ? sources : sources.filter((source) => localHighAuthorityEditorialSource(source));

  if (!sparseMode && extractionSources.length === 0) {
    return { applied: false, contendersFound: [], signals: [], diagnostics: [] };
  }

  console.log("LOCAL_PLACE_EXTRACTOR_RUN", {
    query,
    sourceCount: extractionSources.length,
    existingValidContenders: existingContenders.size,
    mode: sparseMode ? "sparse_recovery" : "high_authority_preservation"
  });
  console.log("LOCAL_SPARSE_RECOVERY_TRIGGERED", {
    query,
    validLocalContenders: existingContenders.size,
    sourceCount: extractionSources.length,
    mode: sparseMode ? "sparse_recovery" : "high_authority_preservation"
  });

  const diagnostics: LocalPlaceExtractionDiagnostic[] = [];
  let eligibleCandidateCount = existingContenders.size;
  const priorSignals = extractionSources.flatMap((source) => {
    console.log("LOCAL_PLACE_EXTRACTOR_SOURCE", {
      title: source.title,
      url: source.url,
      domain: source.domain
    });

    const candidates = sparseMode ? localPlaceCandidatesFromSource(source) : snippetHeadingPlaceCandidates(source);

    return candidates.flatMap((candidate) => {
      console.log("LOCAL_PLACE_EXTRACTOR_CANDIDATE", candidate);
      console.log("LOCAL_SPARSE_RECOVERY_CANDIDATE", {
        candidate: candidate.name,
        source: source.url,
        confidence: candidate.confidence,
        extractionSource: candidate.extractionSource
      });

      const confidenceLevel = localCandidateConfidenceLevel(query, candidate, source);
      console.log("LOCAL_CANDIDATE_CONFIDENCE", {
        candidate: candidate.name,
        source: source.url,
        confidence: candidate.confidence,
        level: confidenceLevel,
        extractionSource: candidate.extractionSource,
        editorialContextScore: candidate.editorialContextScore ?? 0,
        positionScore: candidate.positionScore ?? 0,
        bodyMatch: Boolean(candidate.bodyMatch)
      });

      const rejectedReason = localRecoveryRejectionReason(query, candidate.name, candidate);
      const confidenceRejectedReason = !rejectedReason && confidenceLevel === "low" && eligibleCandidateCount >= 5 ? "low_candidate_confidence" : null;

      if (rejectedReason || confidenceRejectedReason) {
        const reason = rejectedReason ?? confidenceRejectedReason ?? "rejected";
        diagnostics.push({ ...candidate, accepted: false, rejectionReason: reason });
        console.log("LOCAL_ENTITY_FILTERED_REASON", {
          candidate: candidate.name,
          canonical: localBusinessDisplayName(candidate.name),
          source: source.url,
          reason
        });
        console.log("LOCAL_PLACE_EXTRACTOR_REJECTED", {
          candidate: candidate.name,
          source: source.url,
          reason
        });
        console.log("LOCAL_PLACE_EXTRACTOR_REJECTION_REASON", {
          candidate: candidate.name,
          reason
        });
        console.log("LOCAL_CANDIDATE_REJECTED_REASON", {
          candidate: candidate.name,
          source: source.url,
          reason
        });
        console.log("LOCAL_SPARSE_RECOVERY_REJECTED", {
          candidate: candidate.name,
          source: source.url,
          reason
        });
        return [];
      }

      if (confidenceLevel !== "low") {
        eligibleCandidateCount += 1;
      }
      diagnostics.push({ ...candidate, accepted: true });
      console.log("LOCAL_PLACE_EXTRACTOR_ACCEPTED", candidate);
      console.log("LOCAL_SPARSE_RECOVERY_ACCEPTED", {
        candidate: candidate.name,
        source: source.url,
        confidence: candidate.confidence
      });

      return [localPriorSignal(source, localBusinessDisplayName(candidate.name), evidenceType, candidate, confidenceLevel)];
    });
  });

  const dedupedSignals = dedupeSignals(priorSignals)
    .sort((a, b) => signalPower(b) - signalPower(a) || localSourceAuthorityRank(b) - localSourceAuthorityRank(a))
    .slice(0, 60);
  console.log("LOCAL_PLACE_EXTRACTOR_FINAL_COUNT", {
    query,
    candidates: diagnostics.length,
    accepted: diagnostics.filter((candidate) => candidate.accepted).length,
    rejected: diagnostics.filter((candidate) => !candidate.accepted).length
  });
  console.log("LOCAL_SPARSE_RECOVERY_FINAL_COUNT", {
    query,
    recoveredSignalCount: dedupedSignals.length,
    recoveredContenderCount: new Set(dedupedSignals.map((signal) => localBusinessKey(signal.contenderName))).size
  });

  return {
    applied: dedupedSignals.length > 0,
    contendersFound: Array.from(new Set(dedupedSignals.map((signal) => signal.contenderName))),
    signals: dedupedSignals,
    diagnostics: diagnostics.slice(0, 120)
  };
}

function localCandidateConfidenceLevel(query: string, candidate: LocalPlaceCandidate, source: VeraSource): LocalCandidateConfidenceLevel {
  const category = localCategoryForQuery(query);
  const normalizedName = normalizeQuery(candidate.name);
  const evidenceText = normalizeQuery(`${candidate.name} ${candidate.evidenceText} ${source.title} ${source.domain}`);
  const sourceAuthority = localSourceAuthorityFromSource(source);
  const hasCategorySignal = localCandidateHasCategorySignal(category, evidenceText);
  const hasRecommendationContext = (candidate.editorialContextScore ?? 0) > 0;
  const hasPositionSignal = (candidate.positionScore ?? 0) > 0 || candidate.positionIndex !== undefined;
  const isBodyCandidate = Boolean(candidate.bodyMatch);
  const chromeLike = isLocalSourceChromeOrArticleFragment(normalizedName) || isGenericLocalContender(query, candidate.name);
  const weakUrlOnly = candidate.extractionSource === "url" && !hasCategorySignal && !hasRecommendationContext;

  if (chromeLike || weakUrlOnly || candidate.confidence < 0.54) return "low";

  if (
    candidate.confidence >= 0.84 ||
    (sourceAuthority === "high" && isBodyCandidate && (hasRecommendationContext || hasPositionSignal)) ||
    (sourceAuthority === "high" && candidate.extractionSource === "title" && hasCategorySignal)
  ) {
    return "high";
  }

  if (
    candidate.confidence >= 0.66 ||
    (sourceAuthority !== "low" && (hasCategorySignal || hasRecommendationContext || hasPositionSignal || isBodyCandidate)) ||
    hasBusinessNameSignal(candidate.name)
  ) {
    return "medium";
  }

  return "low";
}

function localPriorSignal(
  source: VeraSource,
  contender: string,
  evidenceType: QueryEvidenceType,
  candidate: LocalPlaceCandidate,
  confidenceLevel: LocalCandidateConfidenceLevel
): SourceSignal {
  const sourceType = inferSourceType(source);
  const sourceQuality = inferSourceQuality(source, sourceType);
  const contextParts = [
    `Business name appears in ${candidate.extractionSource} evidence`,
    `candidate confidence ${confidenceLevel}`,
    candidate.bodyMatch ? "editorial body" : "",
    candidate.editorialContextScore ? "recommendation context" : "",
    candidate.positionIndex !== undefined ? `position ${candidate.positionIndex + 1}` : ""
  ].filter(Boolean);
  const themes = localThemesFromEvidence(`${candidate.name} ${candidate.evidenceText} ${source.title}`);

  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    domain: source.domain,
    sourceType,
    sourceWeight: sourceTypeWeight(sourceType, evidenceType),
    sourceQuality,
    sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
    queryVariant: source.queryVariant,
    contenderName: contender,
    sentiment: "positive",
    mentionStrength:
      confidenceLevel === "high" || candidate.editorialContextScore || candidate.positionScore
        ? "strong"
        : confidenceLevel === "medium"
          ? "moderate"
        : candidate.extractionSource === "metadata"
          ? "weak"
          : candidate.confidence >= 0.82 || localSourceAuthorityFromSource(source) === "high"
            ? "moderate"
            : "weak",
    positiveMention: "Business name appears in retrieved local evidence",
    extractedReason: contextParts.join("; "),
    themes: themes.length ? themes : ["frequently recommended"]
  };
}

function localThemesFromEvidence(value: string) {
  const normalized = normalizeQuery(value);
  const themes: string[] = [];
  const add = (theme: string) => {
    if (!themes.includes(theme)) themes.push(theme);
  };

  if (/\b(local|locals|neighborhood|neighbourhood)\b/.test(normalized)) add("neighborhood favorite");
  if (/\b(cocktail|espresso martini|martini|drinks?|bar program|speakeasy|lounge)\b/.test(normalized)) add("excellent cocktails");
  if (/\b(atmosphere|ambiance|ambience|vibe|romantic|cozy|date night|beautiful|setting)\b/.test(normalized)) add("great atmosphere");
  if (/\b(service|staff|attentive|friendly|hospitality)\b/.test(normalized)) add("excellent service");
  if (/\b(review|reviews|rating|rated|stars?)\b/.test(normalized)) add("strong reviews");
  if (/\b(pasta|trattoria|osteria|ristorante|red sauce|gnocchi|ravioli|lasagna|bolognese)\b/.test(normalized)) add("homemade pasta");
  if (/\b(italian|trattoria|osteria|ristorante)\b/.test(normalized)) add("authentic Italian");
  if (/\b(pizza|pizzeria|slice|neapolitan|sicilian)\b/.test(normalized)) add("excellent pizza");
  if (/\b(sushi|omakase|sashimi|nigiri|japanese)\b/.test(normalized)) add("fresh sushi");
  if (/\b(seafood|fish|oyster|clam|lobster|crab|raw bar)\b/.test(normalized)) add("fresh seafood");
  if (/\b(brunch|breakfast|pancake|eggs|mimosa)\b/.test(normalized)) add("popular brunch");
  if (/\b(coffee|espresso|latte|roaster|roastery|cafe)\b/.test(normalized)) add("great coffee");
  if (/\b(family owned|family-run|family run)\b/.test(normalized)) add("family owned");
  if (/\b(worth the drive|destination|drive)\b/.test(normalized)) add("worth the drive");
  if (/\b(recommended|favorite|favourite|best|top|essential|must try|must-try)\b/.test(normalized)) add("popular with locals");

  return themes.slice(0, 4);
}

function localPlaceCandidatesFromSource(source: VeraSource): LocalPlaceCandidate[] {
  const candidates = [
    ...titlePlaceCandidates(source),
    ...urlPlaceCandidates(source),
    ...(localHighAuthorityEditorialSource(source) ? snippetHeadingPlaceCandidates(source) : []),
    ...snippetPlaceCandidates(source),
    ...categoryKeywordPlaceCandidates(source)
  ];
  const byKey = new Map<string, LocalPlaceCandidate>();

  for (const candidate of candidates) {
    const name = localBusinessDisplayName(candidate.name);
    const key = localBusinessKey(name);

    if (!key) continue;

    if (name !== candidate.name) {
      console.log("LOCAL_CANONICAL_NAME", {
        raw: candidate.name,
        canonical: name,
        source: candidate.sourceUrl
      });
    }

    const normalized = { ...candidate, name };
    const existing = byKey.get(key);

    if (!existing || normalized.confidence > existing.confidence) {
      byKey.set(key, normalized);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence).slice(0, 14);
}

function snippetHeadingPlaceCandidates(source: VeraSource): LocalPlaceCandidate[] {
  const snippet = localSourceEvidenceText(source);
  if (!snippet.trim()) return [];

  const sourceKind = inferLocalExtractionSourceType(source);
  const lines = snippet
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const headingCandidates = lines.flatMap((line, index) => {
    if (isRelatedEditorialLine(line)) {
      console.log("LOCAL_RELATED_CONTENT_REJECTED", {
        source: source.url,
        title: source.title,
        line
      });
      return [];
    }

    const cleaned = cleanLocalHeadingLine(line);

    if (!cleaned) return [];
    if (!looksLikeNamedPlace(cleaned) && !hasBusinessNameSignal(cleaned)) return [];

    return [
      {
        name: cleaned,
        index,
        contextScore: recommendationContextScore(lines, index),
        positionScore: editorialPositionScore(index),
        bodyMatch: Boolean(source.enrichedBodyText || source.enrichedText)
      }
    ];
  });

  return headingCandidates.map(({ name, index, contextScore, positionScore, bodyMatch }) => {
    const candidate = {
      name,
      evidenceText: snippet,
      sourceUrl: source.url,
      sourceTitle: source.title,
      queryVariant: source.queryVariant,
      extractionSource: "snippet" as const,
      confidence: round2(0.78 + sourceKind.confidenceBoost + (localSourceAuthorityFromSource(source) === "high" ? 0.08 : 0)),
      editorialContextScore: contextScore,
      positionScore,
      positionIndex: index,
      bodyMatch
    };

    console.log("LOCAL_EXPECTED_ENTITY_PRESENT_IN_SOURCES", {
      entity: localBusinessDisplayName(name),
      source: source.url,
      title: source.title,
      present: true,
      extraction: "snippet_heading"
    });
    if (source.enriched) {
      console.log("LOCAL_ENTITY_FOUND_FROM_ENRICHED_CONTENT", {
        entity: localBusinessDisplayName(name),
        source: source.url,
        title: source.title
      });
    }

    return candidate;
  });
}

function titlePlaceCandidates(source: VeraSource): LocalPlaceCandidate[] {
  const segments = source.title
    .split(/\s(?:[-–—|:•·]\s|\|\s*)|(?:\s-\s)|(?:\s:\s)/g)
    .map((segment) => cleanLocalTitleSegment(segment, source))
    .filter(Boolean);
  const sourceKind = inferLocalExtractionSourceType(source);

  return segments.map((segment, index) => ({
    name: segment,
    evidenceText: source.title,
    sourceUrl: source.url,
    sourceTitle: source.title,
    queryVariant: source.queryVariant,
    extractionSource: "title" as const,
    confidence: round2(Math.max(0.52, 0.86 - index * 0.08 + sourceKind.confidenceBoost))
  }));
}

function snippetPlaceCandidates(source: VeraSource): LocalPlaceCandidate[] {
  const snippet = localSourceEvidenceText(source);
  if (!snippet) return [];

  return capitalizedBusinessPhrases(snippet)
    .filter((phrase) => hasBusinessNameSignal(phrase))
    .map((phrase) => ({
      name: phrase,
      evidenceText: snippet,
      sourceUrl: source.url,
      sourceTitle: source.title,
      queryVariant: source.queryVariant,
      extractionSource: "snippet" as const,
      confidence: round2(0.56 + (localSourceAuthorityFromSource(source) === "high" ? 0.1 : 0))
    }));
}

function categoryKeywordPlaceCandidates(source: VeraSource): LocalPlaceCandidate[] {
  const evidenceText = `${source.title}. ${localSourceEvidenceText(source)}`;
  if (!evidenceText.trim()) return [];

  const keywordPattern =
    "sushi|ramen|pizza|pizzeria|bakery|cafe|coffee|espresso|hotel|inn|bar|pub|tavern|cocktail|gym|fitness|dental|dentistry|plumbing|plumber|golf|course|museum|market|park";
  const placePattern = new RegExp(
    `\\b(?:[A-Z0-9][A-Za-z0-9'&.]+\\s+){0,3}(?:${keywordPattern})(?:\\s+(?:[A-Z0-9][A-Za-z0-9'&.]+|&|and|of|the|at)){0,3}\\b`,
    "gi"
  );
  const matches = Array.from(evidenceText.matchAll(placePattern), (match) => match[0].trim())
    .map((match) => match.replace(/\s+/g, " "))
    .filter((match) => {
      const normalized = normalizeQuery(match);
      const words = normalized.split(/\s+/).filter(Boolean);
      return words.length <= 5 && match.length >= 4 && match.length <= 72 && !/^(?:best|top)\b/i.test(match);
    });

  return matches.map((match) => ({
    name: match,
    evidenceText,
    sourceUrl: source.url,
    sourceTitle: source.title,
    queryVariant: source.queryVariant,
    extractionSource: "snippet" as const,
    confidence: round2(0.6 + (localSourceAuthorityFromSource(source) === "high" ? 0.08 : 0))
  }));
}

function urlPlaceCandidates(source: VeraSource): LocalPlaceCandidate[] {
  return urlBusinessSlugs(source.url).map((slug) => ({
    name: slug,
    evidenceText: source.url,
    sourceUrl: source.url,
    sourceTitle: source.title,
    queryVariant: source.queryVariant,
    extractionSource: "url" as const,
    confidence: round2(0.64 + (localSourceAuthorityFromSource(source) === "high" ? 0.12 : 0))
  }));
}

function inferLocalExtractionSourceType(source: VeraSource) {
  const value = normalizeQuery(`${source.domain} ${source.title}`);

  if (/\b(yelp|tripadvisor|booking|healthgrades|zocdoc|angi|homeadvisor)\b/.test(value)) return { confidenceBoost: 0.08 };
  if (/\b(eater|infatuation|timeout|conde|travel leisure|golf digest|golfweek)\b/.test(value)) return { confidenceBoost: 0.02 };
  if (/\breddit\b/.test(value)) return { confidenceBoost: -0.05 };
  return { confidenceBoost: 0 };
}

function localSourceEvidenceText(source: VeraSource) {
  if (source.enrichedBodyText?.trim()) {
    return source.enrichedBodyText;
  }

  if (source.enrichedText?.trim()) {
    return source.enrichedText;
  }

  return source.snippet ?? "";
}

function recommendationContextScore(lines: string[], index: number) {
  if (index < 0 || index >= lines.length) return 0;

  const context = normalizeQuery(lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join(" "));
  let score = 0;

  if (/\b(best|top|favorite|favourite|recommended|recommendation|must visit|must try|worth visiting|essential|editors? pick|don'?t miss|where to eat|where to stay|best pizza|best coffee|best brunch|hit list|the spots)\b/.test(context)) {
    score += 6;
  }

  if (/^\s*(?:#|\d{1,2}[\).:-])/.test(lines[index])) {
    score += 3;
  }

  if (isRelatedEditorialLine(lines[index]) || /\b(related|nearby|sponsored|advertisement|read next|more from)\b/.test(context)) {
    score -= 8;
  }

  return round1(Math.max(-8, Math.min(score, 9)));
}

function editorialPositionScore(index: number) {
  if (index <= 0 || index >= 999) return 0;
  if (index <= 12) return 7;
  if (index <= 28) return 4.5;
  if (index <= 55) return 2.5;
  return 0.5;
}

function isRelatedEditorialLine(line: string) {
  return /\b(related|nearby|sponsored|advertisement|read next|more from|more in|you might also like|around the web|latest stories|partner content|newsletter|subscribe|sign up|follow us|share this|comments?)\b/i.test(
    line
  );
}

function cleanLocalTitleSegment(segment: string, source: VeraSource) {
  const cleaned = segment
    .replace(/\b(?:Yelp|Tripadvisor|TripAdvisor|OpenTable|Resy|Booking\.com|Healthgrades|Zocdoc|Angi|HomeAdvisor|Eater|The Infatuation|Infatuation|Time Out|Reddit)\b/gi, " ")
    .replace(/\b(?:updated|reviewed)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)?\s*\d{4}\b/gi, " ")
    .replace(/\b(?:reviews?|reservations?|menu|photos?|ratings?|near me|official site|comments?|threads?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sourceDomain = source.domain.split(".")[0]?.toLowerCase();

  if (sourceDomain && normalizeQuery(cleaned) === sourceDomain) return "";

  return cleaned;
}

function cleanLocalHeadingLine(line: string) {
  const compactLine = line.replace(/\s+/g, " ").trim();
  const colonName = compactLine.match(/^(?:an?|the)?\s*(?:excellent|superb|great|favorite|favourite|must-try|must try|most affordable|most luxurious|best overall|best value|editors?'? pick|where to go for)(?:\s+[^:]{0,42})?:\s+(.+)$/i)?.[1];
  const cleaned = (colonName || compactLine)
    .replace(/^[#>*\-\s]+/g, "")
    .replace(/^\d{1,3}\s*[\).:-]\s*/g, "")
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/\s+(?:image|photo|photos|jpg|jpeg|png)$/i, "")
    .replace(/\s+[-–—:]\s+(?:restaurant|bar|hotel|cafe|coffee|reviews?|menu|reservations?|photos?|official|spaces?|seated|standing|brooklyn|nyc|new york).*$/i, "")
    .replace(/^\s*(?:source|venue|venues|spaces?|read more|log in)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = normalizeQuery(cleaned);

  if (!cleaned || cleaned.length > 72) return "";
  if (/^(?:the\s+)?\d+\s+(?:best|top)\b/.test(normalized)) return "";
  if (/^(?:best|top|where to|get|read more|log in|source|venue|venues|spaces?|seated|standing|skip to|see more|more maps|visit website|book online|order now|reserve now|make a reservation|advertising|advertisement|america'?s top|the front of|bars serving|calling all|acclaimed)\b/.test(normalized)) return "";
  if (/\b(?:best|top)\s+(?:restaurants?|bars?|hotels?|coffee shops?|pizza|sushi|ramen|brunch|bakeries|gyms?|dentists?|plumbers?)\b/.test(normalized)) return "";
  if (/\b(?:skip to content|see more|more maps|visit website|book online|order now|reserve now|make a reservation|advertising|advertisement|front of a|serving espresso martinis|america'?s top|google maps api)\b/.test(normalized)) return "";

  return cleaned;
}

function capitalizedBusinessPhrases(text: string) {
  const cleaned = text.replace(/[’]/g, "'").replace(/\s+/g, " ");
  const matches = cleaned.match(/\b(?:[A-Z][A-Za-z0-9'&.]+|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9'&.]+|[A-Z]{2,}|&|and|of|the|at|on)){0,4}\b/g) ?? [];

  return matches
    .map((match) => match.trim())
    .filter((match) => {
      const words = match.split(/\s+/).filter(Boolean);
      return words.length <= 5 && match.length >= 3 && match.length <= 72;
    });
}

function urlBusinessSlugs(url: string) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment).replace(/\.(html?|php)$/i, ""));
    const domain = parsed.hostname.toLowerCase();
    const selected = (() => {
      if (domain.includes("yelp")) return segments.filter((segment) => segment.toLowerCase() === "biz").length ? segments.slice(segments.indexOf("biz") + 1, segments.indexOf("biz") + 2) : segments.slice(-1);
      if (domain.includes("tripadvisor")) return segments.filter((segment) => /_(?:Review|Restaurant|Hotel|Attraction)_/i.test(segment)).slice(0, 1);
      if (domain.includes("booking")) return segments.filter((segment) => /hotel|inn|resort|suites/i.test(segment)).slice(0, 1);
      if (domain.includes("healthgrades") || domain.includes("zocdoc")) return segments.slice(-2);
      if (domain.includes("angi") || domain.includes("homeadvisor")) return segments.slice(-2);
      return segments.slice(-3);
    })();

    return selected
      .map((segment) => segment.replace(/^(?:biz|restaurant|hotel|attraction|review|reviews)$/i, ""))
      .map((segment) => segment.replace(/[-_+]+/g, " "))
      .map((segment) => segment.replace(/\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|seattle|austin|los angeles|san francisco|massapequa|ca|tx|wa)\b/gi, " "))
      .map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter((segment) => /[a-z]/i.test(segment) && !/^\d+$/.test(segment))
      .map((segment) => segment.replace(/\b\w/g, (char) => char.toUpperCase()));
  } catch {
    return [];
  }
}

function localRecoveryRejectionReason(query: string, candidate: string, placeCandidate?: LocalPlaceCandidate) {
  const normalized = normalizeQuery(candidate);
  const words = normalized.split(/\s+/).filter(Boolean);
  const category = localCategoryForQuery(query);
  const universalRejection = localUniversalEntityRejectionReason(query, candidate, { placeCandidate });

  if (universalRejection) return universalRejection;
  if (!normalized || normalized.length < 3) return "empty_or_too_short";
  if (isLocalSourceChromeOrArticleFragment(normalized)) return "source_or_ui_fragment";
  if (words.length > 6) return "too_many_words";
  if (words.length > 5 && !localCandidateHasCategorySignal(category, normalized)) return "article_title_fragment";
  if (placeCandidate && placeCandidate.confidence < 0.54) return "low_extraction_confidence";
  if (isGenericLocalContender(query, candidate)) return "generic_or_placeholder";
  if (placeCandidate?.extractionSource === "metadata" && isWeakRecoveredLocalName(candidate)) return "weak_recovered_name_fragment";
  if (/^(?:austin|san antonio|seattle|brooklyn|manhattan|williamsburg|new york|los angeles|san francisco|massapequa),?\s*(?:tx|ny|wa|ca)?$/.test(normalized)) {
    return "location_only";
  }
  if (/\b(?:websitedirections|website directions|instagram|facebook|hours?|open now|happy hour|events?|tickets?|calendar)\b/.test(normalized)) {
    return "source_or_ui_fragment";
  }
  if (/\b(?:email required|name required|leave a comment|from punch|from eater|from infatuation|sign up|newsletter|privacy policy|terms of service)\b/.test(normalized)) {
    return "source_or_ui_fragment";
  }
  if (/\b(?:new year'?s eve|celebrate|watch here|leading|for all you|perfect|favorite cafe|first coffee shop|apps on google play|apple podcasts|podcast|local listings|write a|answer|image\s+\d|gym comparison|postcard\.?inc|north side|google maps api|apple maps|restaurant rating|award winners|management solutions|marketing software|seo|ranking service)\b/.test(normalized)) {
    return "article_title_fragment";
  }
  if (/\b(?=[a-z0-9]*\d)[a-z0-9]{8,}\b/i.test(candidate)) return "encoded_url_fragment";
  if (/\bit'?s$/.test(normalized) && words.length >= 3) return "article_title_fragment";
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+\d{4})?$/.test(normalized)) {
    return "date_or_article_fragment";
  }
  if (/\b(?:golf digest|golfweek|google hotels|tripadvisor|yelp|booking|opentable|reddit|eater|infatuation|theinfatuation)'?s?\b/.test(normalized)) {
    return "source_website_name";
  }
  if (/^(?:blog|post|features?|hot spots?|watch|guides?|entity|category|newyork|google'?s|there'?s|it'?s|food near me|romantic restaurants bars)$/i.test(normalized)) {
    return "source_or_ui_fragment";
  }
  if (/\b(?:forum|blog|post|features?|guides?)\b/.test(normalized)) return "source_or_article_fragment";
  if (/^(?:the\s+)?\d+\s+(?:best|top)\b/.test(normalized)) return "article_title_fragment";
  if (/^(?:best|top|where to|what to|favorite|must try)\b/.test(normalized) && words.length >= 3) return "query_or_article_fragment";
  if (/\b(?:restaurants?|coffee shops?|cafes?|bakeries?|gyms?|hotels?|bars?|golf courses?)\s+(?:in|near)?\s*(?:nyc|new york|brooklyn|manhattan|williamsburg|seattle|austin|san francisco|massapequa|los angeles|ca|ny|tx|wa)\b/.test(normalized)) {
    return "category_location_fragment";
  }
  if (/\b(?:feeds|announcing|listed|ranks?|ranked|says|asks|found|updated|reviewed|agree)\b/.test(normalized) && words.length >= 4) {
    return "article_title_fragment";
  }
  if (/\b[a-z0-9]{12,}\b/i.test(candidate) && /\d/.test(candidate)) return "encoded_url_fragment";
  if (/[._]\d{3,}[._]/.test(candidate) || /\b\d{6,}\b/.test(normalized)) return "encoded_url_fragment";
  if (/\b(?:downtown|delta dental|metlife)\b.*\d{2,}/.test(normalized)) return "directory_or_encoded_fragment";
  if (/^\d+[a-z]{1,2}$/i.test(normalized)) return "numeric_slug";
  if (
    /^(com|www|html|biz|came|the|read|avenue|street|st|ave|nyc|new york|brooklyn|manhattan|williamsburg|review|reviews|comments?|replies|threads?|near me|best|top|updated \d{4}|(?:the )?best .+|.+ reviews?)$/i.test(
      normalized
    )
  ) {
    return "url_or_generic_token";
  }
  if (/^r\s+\w+$/i.test(normalized)) return "source_community_name";
  if (/\b(yelp|tripadvisor|reddit|google maps|booking|opentable|resy|eater|infatuation|healthgrades|zocdoc|angi|homeadvisor)\b/.test(normalized)) {
    return "source_website_name";
  }
  if (/^\d/.test(normalized) && !/\b\d{1,2}\b/.test(normalized)) return "numeric_slug";
  if (!looksLikeNamedPlace(candidate)) return "does_not_look_like_named_place";

  return null;
}

function isLocalSourceChromeOrArticleFragment(normalized: string) {
  if (
    /^(?:the\s+)?(?:homepage|navigation drawer|maps|openings|closings|restaurant news|neighborhoods|newsletters|all coverage|things to do|city life|reservations required|travel|tweet|donuts|american|cantonese|japanese|italian|mexican|french|korean|chinese|spanish|thai|vietnamese|mediterranean|middle eastern|puerto rican|ice cream|burgers|rooms|red hook|east village|east williamsburg|bernal heights|embarcadero|sawtelle|logan square|lakeview|west town|south side|north side|harlem|highland|mission|dumbo|filter|save|learn more|unrated|the spots|pause|unmute|share|copy link|book now|book a table|reserve a table|table of contents|welcome to the five boroughs|neighborhoods to know|reservations to make in advance|follow the stars|close search form|search for|no thanks|enter email address|email required|name required|love the mag|awesome you re subscribed|partner content from|prices|tacos|bar club|view 1 more space|reserve a table|dining out in ny|dining out in la|dining out in austin|dining out in chicago|the museum of|accommodations|all posts|bookmarker|holidays|video|examples|status|eaterny|mapeater ny|from punch|from eater|from infatuation|more editor recommended hotels|more editor recommended restaurants|drinking great cocktails|new york contributor|food drink editor|readers choice awards|shutterstock|intel|more)$/.test(
      normalized
    )
  ) {
    return true;
  }

  if (/^(?:by|photographer|edited by|written by|new york contributor|food drink editor)\s+[a-z]+(?:\s+[a-z]+){0,4}$/.test(normalized)) return true;
  if (/\b(?:google hotel search|google maps api|new york dining glossary|foodnyc|restaurant news|newly named sommelier|serves|source wikipedia|calling all|d c espresso martini brand|notch espresso martini this winter|what our ratings mean|read the review|find the best spots nearby|specialty coffee shop finder|sprudge maps|massive korean barbecue restaurant opens|restaurant opens on the williamsburg|partner content|espresso martini festival|unnamed company|google rating|save this story|accordionitemcontainerbutton|more editor recommended|frequently asked questions|save to wishlist|check availability|courtesy|the top 25 explained|from new school|old school|situated|food drink|published|this article tagged under|fox 32|nbc chicago|ai visibility|plumbing repair services|plumbing installation for|dentistry practitioner|doctor of dental surgery degree|office directly|school of dentistry|local rank monitor|google maps local rank|new york citythe best coffee|register your cafe|discover great coffee|you want an espresso|more editor recommended hotels|more editor recommended restaurants|book a stay|view all hotels|find a table|author profile|contributor|staff writer|senior editor|associate editor|readers choice awards|illustration|image credit|photo credit|luke fortney|naomi otsu|dining out in chicago)\b/.test(normalized)) return true;
  if (/^(?:about this hotel|open for|price range|replying to|jul|july|feb|february|jan|january|mar|march|apr|april|may|jun|june|aug|august|sep|september|oct|october|nov|november|dec|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(normalized)) return true;
  if (/\b(?:ultimate .* staycation|rowdy dinner|prices\s*&|plumbing installation for|doctor of dental surgery degree|food drink editor|written by)\b/.test(normalized)) return true;
  if (/\b(?:home|careers|membership|maps|lists)\b/.test(normalized) && normalized.split(/\s+/).length >= 4) return true;
  if (/\b(?:adrian kane|john ringor|nick allen|teddy wolff|liz clayman|will hartman|bryan kim|sonal shah|arden shore)\b/.test(normalized)) return true;
  if (/\b(?:nicolai mccrary|raphael brion|katie cerulle|caroline shin|kristen mendiola|morgan carter|amber sutherland namako)\b/.test(normalized)) return true;

  return false;
}

function isWeakRecoveredLocalName(candidate: string) {
  const normalized = normalizeQuery(candidate);
  const words = normalized.split(/\s+/).filter(Boolean);

  if (isLocalSourceChromeOrArticleFragment(normalized)) {
    return true;
  }

  if (/^(?:ramen|sushi|pizza|coffee|restaurant|restaurants|bar|bars|hotel|hotels|attractions?|gyms?|fitness club|plumbing|plumber|dentist|dentistry|golf|course|prices|posts|region|neighborhood|base)$/.test(normalized)) {
    return true;
  }

  if (/\b(?:software|seo|api|ranking|rankings|marketing|management|solutions|linkedin|podcast|google map|apple maps|rating|ratings|award|winners|culture|travel tourism|details)\b/.test(normalized)) {
    return true;
  }

  if (/\b(?:if|is|even|null|people|watch|posted|topic|free|closed|mobile|apps?)\b/.test(normalized) && words.length >= 2) {
    return true;
  }

  if (/\b(?:restaurant|coffee|plumbing|bar)\s+(?:if|even|rating|closed|software|marketing|management|solutions)\b/.test(normalized)) {
    return true;
  }

  if (words.length >= 5 && /\b(?:for|with|and|by|around|near)\b/.test(normalized)) {
    return true;
  }

  return false;
}

function localCandidateHasCategorySignal(category: string, normalized: string) {
  if (category === "hotel") return /\b(hotel|inn|resort|suites|lodge|motel)\b/.test(normalized);
  if (category === "coffee") return /\b(cafe|coffee|espresso|roaster|roastery)\b/.test(normalized);
  if (category === "pizza") return /\b(pizza|pizzeria)\b/.test(normalized);
  if (category === "bar") return /\b(bar|pub|cocktail|lounge|tavern|brewery|taproom)\b/.test(normalized);
  if (category === "gym") return /\b(gym|fitness|athletic|club|training)\b/.test(normalized);
  if (category === "tattoo") return /\b(tattoo|ink|artist|studio|body art)\b/.test(normalized);
  if (category === "dentist") return /\b(dentist|dentistry|dental|dds|orthodontic)\b/.test(normalized);
  if (category === "plumber") return /\b(plumb|plumbing|drain|rooter|pipe)\b/.test(normalized);
  if (category === "attraction") return /\b(museum|park|aquarium|needle|market|garden|zoo|center|theatre|theater|tour|ferry|landmark|national historical)\b/.test(normalized);
  if (category === "golf_course") return /\b(golf|course|links|club)\b/.test(normalized);
  return /\b(restaurant|kitchen|grill|bistro|diner|brasserie|osteria|trattoria|tavern|cafe|bar|pizza|sushi|ramen|taco|taqueria|bakery)\b/.test(
    normalized
  );
}

function hasBusinessNameSignal(value: string) {
  const normalized = normalizeQuery(value);

  return (
    /\b(cafe|coffee|pizzeria|pizza|sushi|ramen|taco|taqueria|hotel|inn|bar|pub|bakery|boulangerie|dental|dentist|plumbing|plumber|golf|club|course|museum|market|grill|kitchen|bistro|diner|brasserie|osteria|trattoria|restaurant|roaster|roastery)\b/.test(
      normalized
    ) || /\b[A-Z][a-z]+(?:'s|’s)\b/.test(value)
  );
}

function looksLikeNamedPlace(value: string) {
  const trimmed = value.trim();
  const normalized = normalizeQuery(trimmed);
  const words = normalized.split(/\s+/).filter(Boolean);

  if (words.length === 1) {
    return trimmed.length >= 4 && /^[A-Z0-9][A-Za-z0-9'&.]+$/.test(trimmed) && !/^(home|search|all|kid|guides?)$/i.test(trimmed);
  }

  return (
    /^[A-Z0-9]/.test(trimmed) &&
    /[a-zA-Z]/.test(trimmed) &&
    !/\b(perfect for|photograph|courtesy|updated|continue|before you|what are|where to|how to)\b/i.test(trimmed)
  );
}

function rankLocalSourcesForExtraction(sources: VeraSource[]) {
  return [...sources].sort((a, b) => localExtractionSourceScore(b) - localExtractionSourceScore(a));
}

function rankLocalSourcesForRecovery(sources: VeraSource[]) {
  return [...sources].sort((a, b) => localRecoverySourceScore(b) - localRecoverySourceScore(a));
}

function localRecoverySourceScore(source: VeraSource) {
  const text = normalizeQuery(`${source.domain} ${source.title} ${localSourceEvidenceText(source)} ${source.queryVariant ?? ""}`);
  const authority = localAuthorityRank(localSourceAuthorityFromSource(source));
  const platformBoost = /\b(yelp|tripadvisor|booking|opentable|resy|healthgrades|zocdoc|angi|homeadvisor|google maps)\b/.test(text) ? 3.4 : 0;
  const editorialBoost = /\b(eater|infatuation|timeout|time out|sprudge|travel leisure|conde nast|golf digest|golfweek|local guide|tourism)\b/.test(text) ? 2.6 : 0;
  const communityBoost = /\breddit\b/.test(text) ? 1.8 : 0;
  const namedLaneBoost = /\b(named|recommendations?|reviews?|best|top|locals?)\b/.test(text) ? 1.4 : 0;
  const specificPageBoost = /\b(menu|reservation|reviews?|rating|stars?|address|book|photos?)\b/.test(text) ? 1.1 : 0;
  const genericUtilityPenalty = /\b(apps on google play|podcast|support google|how to|add edit delete|ranking service|seo)\b/.test(text) ? 4.8 : 0;

  return authority * 2 + platformBoost + editorialBoost + communityBoost + namedLaneBoost + specificPageBoost - genericUtilityPenalty;
}

function localExtractionSourceScore(source: VeraSource) {
  const text = normalizeQuery(`${source.domain} ${source.title} ${localSourceEvidenceText(source)}`);
  const authority = localAuthorityRank(localSourceAuthorityFromSource(source));
  const localPlatformBoost = /\b(yelp|google maps|maps google|tripadvisor|opentable|resy|booking|eater|infatuation|timeout|reddit)\b/.test(text) ? 2 : 0;
  const specificPageBoost = /\b(menu|reviews?|reservations?|photos?|rating|stars?|address)\b/.test(text) ? 0.8 : 0;
  const genericListPenalty = /\b(best|top|guide|where to|list|things to do)\b/.test(text) ? 0.6 : 0;

  return authority * 2 + localPlatformBoost + specificPageBoost - genericListPenalty;
}

function mergeLocalBusinessSignalNames(signals: SourceSignal[]) {
  const displayByKey = new Map<string, string>();

  for (const signal of signals) {
    const key = localCandidateNormalizedName(signal.contenderName);

    if (!key) {
      continue;
    }

    const existing = displayByKey.get(key);
    const candidate = localBusinessDisplayName(signal.contenderName);
    console.log("LOCAL_CANDIDATE_NORMALIZED", {
      raw: signal.contenderName,
      normalized: key,
      source: signal.sourceUrl
    });

    if (!existing || betterLocalDisplayName(candidate, existing)) {
      displayByKey.set(key, candidate);
    }
  }

  const collapsedKeyByKey = new Map<string, string>();

  for (const key of displayByKey.keys()) {
    const existing = Array.from(new Set(collapsedKeyByKey.values())).find((candidateKey) => localNamesAreDuplicateVariants(key, candidateKey));

    if (existing) {
      collapsedKeyByKey.set(key, existing);
      console.log("LOCAL_DUPLICATE_COLLAPSED", {
        rawNormalizedName: key,
        collapsedInto: existing,
        rawDisplay: displayByKey.get(key),
        finalDisplay: displayByKey.get(existing)
      });
      continue;
    }

    collapsedKeyByKey.set(key, key);
  }

  return signals.map((signal) => {
    const key = localCandidateNormalizedName(signal.contenderName);
    const collapsedKey = key ? collapsedKeyByKey.get(key) ?? key : null;
    const displayName = collapsedKey ? displayByKey.get(collapsedKey) : null;

    return displayName ? { ...signal, contenderName: displayName } : signal;
  });
}

function localBusinessKey(value: string) {
  return localCandidateNormalizedName(value);
}

function isRejectableLocalSignalName(query: string, name: string) {
  const displayName = localBusinessDisplayName(name);

  if (!displayName) return true;
  if (!isGenericLocalContender(query, displayName)) return false;
  return isGenericLocalContender(query, name);
}

function localCandidateNormalizedName(value: string) {
  let normalized = normalizeQuery(value)
    .replace(/^(?:an?|the)?\s*(?:excellent|superb|great|favorite|favourite|must try|most affordable|most luxurious|best overall|best value|editors? pick|where to go for)(?:\s+[^:]{0,42})?:\s+/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(?:review|reviews|menu|reservation|reservations|photos|ratings|tripadvisor|yelp|opentable|booking|google|maps|reddit|eater|infatuation|best|top|near me|official site|article|story|guide)\b/g,
      " "
    )
    .replace(/\b(?:cheap|perfect for|nearby|home|search|all|article|our story|right this way|dining out|food near me|places)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hasNamedOfLocationSuffix = /\bof\s+(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|massapequa|seaford|huntington|delray beach|delray)\b$/.test(
    normalized
  );

  normalized = normalized
    .replace(/\s+\b(?:restaurateurs?|owners?|chef|founder|team|group)\b$/g, "")
    .replace(
      /\s+\b(?:restaurant|restaurants|cafe|coffee shop|golf course|course|dentist|dental|plumber|plumbing|bakery|pizzeria|italian|seafood|sushi|brunch)\b$/g,
      ""
    )
    .replace(/\s+\b(?:restaurateurs?|owners?|chef|founder|team|group)\b$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!hasNamedOfLocationSuffix) {
    normalized = normalized
      .replace(
        /\s+\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|los angeles|austin|seattle|massapequa|san francisco|downtown|midtown|uptown|greenwich village|carmine st|street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|location|branch)\b$/g,
        ""
      )
      .replace(/\s+\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|massapequa|seaford|huntington|delray beach|delray)\b$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return normalized;
}

function localNamesAreDuplicateVariants(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter / longer >= 0.62;
  }
  return diceCoefficient(a, b) >= 0.86;
}

function diceCoefficient(a: string, b: string) {
  const bigrams = (value: string) => {
    const compact = value.replace(/\s+/g, "");
    const grams = new Map<string, number>();
    for (let index = 0; index < compact.length - 1; index += 1) {
      const gram = compact.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  const total = Array.from(aGrams.values()).reduce((sum, count) => sum + count, 0) + Array.from(bGrams.values()).reduce((sum, count) => sum + count, 0);
  let overlap = 0;

  for (const [gram, count] of aGrams.entries()) {
    overlap += Math.min(count, bGrams.get(gram) ?? 0);
  }

  return total > 0 ? (2 * overlap) / total : 0;
}

function localBusinessDisplayName(value: string) {
  const preservesOfLocationSuffix = /\bof\s+(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|massapequa|seaford|huntington|delray beach|delray)\b$/i.test(value);
  let cleaned = cleanName(value)
    .replace(/[’]/g, "'")
    .replace(/^(?:an?|the)?\s*(?:excellent|superb|great|favorite|favourite|must-try|must try|most affordable|most luxurious|best overall|best value|editors?'? pick|where to go for)(?:\s+[^:]{0,42})?:\s+/i, "")
    .replace(/\s+by\s+null$/i, "")
    .replace(/\s+by$/i, "")
    .replace(/\.\s+(?:in|during|there).*$/i, "")
    .replace(/\s+(?:there|there's)$/i, "")
    .replace(/\s+(?:[-–—|:])\s+(?:menu|reviews?|reservations?|photos?|ratings?|official site|tripadvisor|yelp|opentable|booking).*$/i, "")
    .replace(/\s+[-–—|:]\s+(?:williamsburg|brooklyn|manhattan|nyc|new york|los angeles|austin|seattle|massapequa|downtown|midtown|uptown|san francisco|greenwich village).*$/i, "")
    .replace(/\s+[-–—|:]\s+.*$/g, "")
    .replace(/,\s*(?:williamsburg|brooklyn|manhattan|nyc|new york|los angeles|austin|seattle|massapequa|downtown|midtown|uptown|san francisco).*$/i, "")
    .replace(/\s+\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|massapequa|seaford|huntington|delray beach|delray)\s+(?:restaurateurs?|owners?|chef|founder|team|group)\b$/i, "")
    .replace(/\s+\b(?:restaurateurs?|owners?|chef|founder|team|group)\b$/i, "")
    .replace(/\s+\((?:williamsburg|brooklyn|manhattan|nyc|new york|los angeles|austin|seattle|massapequa|downtown|midtown|uptown).*\)$/i, "")
    .replace(/\s+\d{4,}$/g, "")
    .replace(/\s+(?:carmine st|carmine street|bleecker st|bleecker street|bedford ave|bedford avenue|kent ave|kent avenue|wythe ave|wythe avenue|grand st|grand street)$/i, "")
    .replace(/\b(?:restaurant)\s*$/i, "")
    .replace(/\b(?:italian|seafood|sushi|brunch)\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();

  if (!preservesOfLocationSuffix) {
    cleaned = cleaned
      .replace(/\s+\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|massapequa|seaford|huntington|delray beach|delray)\b$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return collapseRepeatedLocalName(cleaned);
}

function collapseRepeatedLocalName(value: string) {
  const words = value.split(/\s+/).filter(Boolean);

  if (words.length >= 4 && words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const first = words.slice(0, midpoint).join(" ");
    const second = words.slice(midpoint).join(" ");

    if (normalizeQuery(first) === normalizeQuery(second)) {
      return first;
    }
  }

  if (words.length >= 3 && normalizeQuery(words[0]) === normalizeQuery(words.at(-1) ?? "")) {
    return words.slice(0, -1).join(" ");
  }

  return value;
}

function betterLocalDisplayName(candidate: string, current: string) {
  const candidateWords = normalizeQuery(candidate).split(" ").filter(Boolean).length;
  const currentWords = normalizeQuery(current).split(" ").filter(Boolean).length;

  if (candidateWords >= 2 && currentWords < 2) return true;
  if (currentWords >= 2 && candidateWords < 2) return false;
  if (candidate.length < current.length && candidateWords >= currentWords) return true;
  return false;
}

function isLocalSentenceOrEditorialFragment(generic: string) {
  const words = generic.split(/\s+/).filter(Boolean);

  if (words.length >= 7) return true;
  if (/\b(?:what s|whats|crowd like|food was great|i had|would recommend|do you agree|should know before going|all you must know|right this way)\b/.test(generic)) {
    return true;
  }
  if (/^(?:nice|great|good|here s|heres|local|apple|brasserie|new openings|hit list|upper west side|culver city|after bolstering|interesting neighborhood|ny the best|drinking great cocktails)$/i.test(generic)) {
    return true;
  }
  if (
    /^(?:featured stories|cnt triple crown|save this powered by|gym recommendations|this gym is pretty great|healthy brunch|breakfast|blogs|living|yahoo local|for plumbing keywords on google|get on the google map|blackstorm|helpnewyork com|nyc coffee map)$/i.test(
      generic
    )
  ) {
    return true;
  }
  if (/\b(?:phone number|restaurant phone|verified hotel reviews|google hotel search|apps on google play|postcard inc|patch|nbc los angeles|fox 32 chicago|powered by marriott|espresso martini might be|but here s|but heres|coffee map|email required|name required|from punch|from eater|from infatuation)\b/.test(generic)) {
    return true;
  }
  if (/\b(?:patricia kelly yeo|nicolai mccrary|raphael brion|katie cerulle|caroline shin|kristen mendiola|morgan carter|amber sutherland namako|adrian kane|john ringor|nick allen|teddy wolff|bryan kim|sonal shah|arden shore)\b/.test(generic)) {
    return true;
  }
  if (/^(?:most affordable|most luxurious|best overall|best value|editors? pick)\b/.test(generic)) {
    return true;
  }
  if (
    /^(?:italian|seafood|sushi|pizza|brunch|coffee|mexican|steakhouse|bar|restaurant)\s+(?:food|restaurants?|places?|spots?|food\s+and|and\s+)?\s*(?:pizza|sushi|seafood|brunch|coffee|bars?|restaurants?)?$/.test(
      generic
    )
  ) {
    return true;
  }
  if (/\b(?:xtnahgrcizx|[a-z]*[0-9][a-z0-9]{7,})\b/i.test(generic)) {
    return true;
  }

  return false;
}

function localFallbackSignals(query: string, sources: VeraSource[]): SourceSignal[] {
  const evidenceType = inferQueryEvidenceType(query);
  const candidates = new Map<string, { name: string; sources: VeraSource[] }>();
  const sortedSources = [...sources].sort((a, b) => localAuthorityRank(localSourceAuthorityFromSource(b)) - localAuthorityRank(localSourceAuthorityFromSource(a)));

  for (const source of sortedSources) {
    for (const candidate of candidateBusinessNamesFromSource(query, source)) {
      const key = localBusinessKey(candidate);

      if (!key || key.length < 3) {
        continue;
      }

      const existing = candidates.get(key) ?? { name: candidate, sources: [] };
      existing.sources.push(source);

      if (betterLocalDisplayName(candidate, existing.name)) {
        existing.name = candidate;
      }

      candidates.set(key, existing);
    }
  }

  return Array.from(candidates.values())
    .filter((candidate) => candidate.sources.length > 0)
    .slice(0, 5)
    .flatMap((candidate) =>
      candidate.sources.slice(0, 3).map((source) => {
        const sourceType = inferSourceType(source);
        const sourceQuality = inferSourceQuality(source, sourceType);

        return {
          sourceUrl: source.url,
          sourceTitle: source.title,
          domain: source.domain,
          sourceType,
          sourceWeight: sourceTypeWeight(sourceType, evidenceType),
          sourceQuality,
          sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
          queryVariant: source.queryVariant,
          contenderName: candidate.name,
          sentiment: "positive",
          mentionStrength: localSourceAuthorityFromSource(source) === "high" ? "moderate" : "weak",
          positiveMention: "Appears in local source results",
          extractedReason: "Appears in local source results",
          themes: ["local source support"]
        } satisfies SourceSignal;
      })
    );
}

function candidateBusinessNamesFromSource(query: string, source: VeraSource) {
  const names = [
    candidateBusinessNameFromSource(source),
    ...extractLocalNameCandidatesFromText(query, source.title, source),
    ...extractLocalNameCandidatesFromText(query, source.snippet ?? "", source)
  ].filter((name): name is string => Boolean(name));
  const seen = new Set<string>();

  return names.filter((name) => {
    const key = localBusinessKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateBusinessNameFromSource(source: VeraSource) {
  const title = localBusinessDisplayName(source.title);
  const normalizedTitle = normalizeQuery(title);

  if (!title || title.length < 3) {
    return null;
  }

  if (/\b(best|top|where to|guide|list|restaurants?|hotels?|bars?|coffee shops?|things to do|near me|reviews?)\b/.test(normalizedTitle)) {
    return null;
  }

  if (normalizedTitle.split(" ").length > 6) {
    return null;
  }

  if (localUniversalEntityRejectionReason(source.queryVariant ?? source.title, title, { source })) {
    return null;
  }

  return isGenericLocalContender(source.queryVariant ?? "", title) ? null : title;
}

function extractLocalNameCandidatesFromText(query: string, text: string, source: VeraSource) {
  const candidates = new Set<string>();
  const normalizedQuery = normalizeLocalQueryIntent(query);
  const hasLocalContext = /\b(coffee|cafe|restaurant|bar|hotel|tattoo|shop|bakery|brunch|pizza|sushi|ramen|taco|gym|dentist|plumber|recommend|best|top|guide|review|local)\b/i.test(
    text
  );

  if (!text || !hasLocalContext) {
    return [];
  }

  const segments = text
    .replace(/[#•]/g, "\n")
    .split(/\n|,|;|(?:\s+-\s+)|(?:\s+–\s+)|(?:\s+—\s+)|(?:\s+\|\s+)/)
    .map((segment) => localBusinessDisplayName(segment))
    .filter(Boolean);

  for (const segment of segments) {
    addLocalTextCandidate(segment);
  }

  const properNamePattern =
    /\b(?:\d{2,4}\s+(?:NYC\s+)?(?:Coffee|Cafe|Café)|[A-Z][A-Za-z0-9’'&.]+(?:\s+(?:[A-Z][A-Za-z0-9’'&.]+|NYC|Coffee|Cafe|Café|Roasters?|Tea|Bar|Bakery|Shop|House|Kitchen|Restaurant|Pizza|Sushi|Tacos?|Diner|Market)){0,3})\b/g;

  for (const match of text.matchAll(properNamePattern)) {
    addLocalTextCandidate(match[0]);
  }

  return Array.from(candidates);

  function addLocalTextCandidate(value: string) {
    const candidate = localBusinessDisplayName(value);
    const normalizedCandidate = normalizeQuery(candidate);

    if (!candidate || normalizedCandidate.length < 3) return;
    if (normalizedCandidate.split(" ").length > 5) return;
    if (localUniversalEntityRejectionReason(query, candidate, { source })) return;
    if (isGenericLocalContender(query, candidate)) return;
    if (isLocalLocationOnlyEntity(normalizedCandidate)) return;
    if (isLocalSearchSubjectOnly(normalizedQuery, normalizedCandidate)) return;

    candidates.add(candidate);
  }
}

function localAuthorityRank(authority: "high" | "medium" | "low") {
  if (authority === "high") return 3;
  if (authority === "medium") return 2;
  return 1;
}

function isGenericLocalContender(query: string, name: string) {
  const normalized = normalizeQuery(name);
  const generic = normalized.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const category = localCategoryForQuery(query);

  if (!generic || generic.length < 3) {
    return true;
  }

  if (isLocalSourceChromeOrArticleFragment(generic)) {
    return true;
  }

  if (isLocalSentenceOrEditorialFragment(generic)) {
    return true;
  }

  if (
    /\b(?:netgear|orbi|eero|tp link|wifi|wi fi|router)\b/.test(generic) &&
    /\b(?:coffee|cafe|restaurant|bar|hotel|bakery|brunch|pizza|sushi|ramen|taco|gym|dentist|plumber|tattoo|attraction)\b/.test(normalizeQuery(query))
  ) {
    return true;
  }

  if (
    /^(best|top|great|recommended|recommendations?|recs|unknown|none|the|read|last|course|courses|what s|gallery|landmark|dining|list|pasta|pizza|sushi|ramen|plumber|plumbers|plumbing|tattoo|tattoos|tattoo shops?|tattoo studios?|fitness|gyms?|fitness club|travel tourism|travel and tourism|blog|post|features?|hot spots?|watch|entity|category|avenue|street|st|ave|nyc|restaurants?|bars?|bar events|hotels?|dentists?|dentistry|dental|pediatric dentists|places? to stay|places? to eat|food near me|coffee|coffee shops?|coffee in nyc|coffee espresso recs|espresso recs|booking com|tripadvisor|yelp|google maps|google hotels|google hotel search|googles?|opentable|resy|reddit|local guide|reviews?|comments?|replies|threads?|restaurant reviews?|restaurant rating|hotel recommendation|dentist recommendation|romantic restaurants bars|cocktail bars chicago|club chicago|chicago by|the vendry|venues|see more|more maps|visit website|book online|order now|reserve now|make a reservation|advertising|advertisement|skip to content|america'?s top|lakeview east chamber of commerce|(?:the )?\d+\s+best .+|(?:the )?best restaurant|(?:the )?best restaurants|(?:the )?best .+|best coffee cafe|updated \d{4}|short visit|what to visit|bakeries?|bakery|bakeries san francisco ca|golf courses?|public courses?|rankings?|metropolitan golf association|met area course|forum|.+ forum|eater|eater new york|eater san francisco|the infatuation|infatuation|theinfatuation|healthgrades|golf digest'?s?|golfweek'?s?|time out|timeout|time out new yorks?|new york city|new york|new yorks?|manhattan|brooklyn|brooklyn s|williamsburg|williamsburg right now|long island|austin|seattle|los angeles|san francisco|san franciscos?|san francisco s|massapequa|chicago|texas|south side|north side|hells kitchen|what they are saying|brunch|museum|top attractions|must see attractions|sightseeing|mobile park|local listings|answer|podcast|apple podcasts|postcard inc|gym comparison|athletic club|biz|came)$/.test(
      generic
    )
  ) {
    return true;
  }

  if (/^r\s+\w+$/.test(generic)) {
    return true;
  }

  if (/^(gyms?|dentists?|plumbers?|tattoo shops?|tattoo studios?|attractions?|restaurants?|hotels?|bars?|coffee shops?|bakeries?|golf courses?) (in|near)\b/.test(generic)) {
    return true;
  }

  if (/^(sushi|ramen|pizza|coffee|espresso|cocktail|brunch)\s+(restaurants?|spots?|shops?|places?|bars?|guide|guides|list|lists)$/.test(generic)) {
    return true;
  }

  if (/^(?:[a-z\s]+ )?(?:cafe|coffee shop|restaurant|bar|hotel|bakery|gym|gyms|dentist|plumber)$/.test(generic) && /\b(?:williamsburg|brooklyn|manhattan|nyc|new york|seattle|austin|san francisco|los angeles|massapequa)\b/.test(generic)) {
    return true;
  }

  if (/^(?:book your|about)\s+.+\s+(?:now on|american|restaurant)$/i.test(generic)) {
    return true;
  }

  if (/\b(?:kid friendly|family friendly|beautiful|recommended)?\s*(?:restaurants?|coffee shops?|cafes?|bakeries?|gyms?|hotels?|bars?|golf courses?)\s+(?:in|near|for)\b/.test(generic)) {
    return true;
  }

  if (/\b(?:austin|seattle|chicago|brooklyn|williamsburg|manhattan|nyc|new york|san francisco|los angeles|massapequa)\s+(?:dentists?|dentistry|dental|plumbers?|plumbing|restaurants?|bars?|hotels?|gyms?)\b/.test(generic)) {
    return true;
  }

  if (/\b(?:dentists?|dentistry|dental|plumbers?|plumbing|restaurants?|bars?|hotels?|gyms?)\s+(?:austin|seattle|chicago|brooklyn|williamsburg|manhattan|nyc|new york|san francisco|los angeles|massapequa)\b/.test(generic)) {
    return true;
  }

  if (
    /\b(recommendations? for|dinner date recommendations?|date recommendations?|what to visit|days in|places? to stay|places? to eat|recs|what are your favorite|courses? ranked|public courses? ranked|favorite public courses?|favorite bakeries?|lunch spot ideas|first date options|date ?night|family friendly dining|manhattan with kids|good eats for families|beautiful cafes|cafes in|cafés in|work spaces?|doing work|to work at|recommended bakeries|do you like your gym|world s 100 greatest|rankings?|guide|best of|local guide)\b/.test(
      generic
    )
  ) {
    return true;
  }

  if (/^\d{1,5}\s+[a-z0-9\s]+$/.test(generic)) {
    return true;
  }

  if (/^[a-z]{2,}\d+[a-z0-9]*$/.test(generic) || /\b(?:downtown|delta dental|metlife)\s+\d{2,}/.test(generic)) {
    return true;
  }

  if (/\b(?:general directory|chamber of commerce|directory|near me)\b/.test(generic)) {
    return true;
  }

  if (category === "hotel" && /\b(booking|places? to stay|accommodation|lodging)\b/.test(generic)) {
    return true;
  }

  if ((category === "attraction" || category === "local_business") && /\b(visit|itinerary|days?|trip|recommendations?)\b/.test(generic)) {
    return true;
  }

  if (category === "golf_course" && /\b(long island|nyc area|public courses?|golf courses?|ranked|favorite)\b/.test(generic)) {
    return true;
  }

  if (/\b(brooks ghost|nike pegasus|asics gel|hoka clifton|best plumbing)$/.test(generic)) {
    return true;
  }

  if (/\b(options?|ideas?|spots?|guide|rankings?|reviews?|recommendations?)\b/.test(generic) && generic.split(" ").length >= 3) {
    return true;
  }

  return false;
}

type SoftwareLeader = {
  label: string;
  aliases: string[];
};

type SoftwareCategoryPrior = {
  key: string;
  leaders: SoftwareLeader[];
};

type SoftwareToolPriorResult = {
  applied: boolean;
  category: SoftwareCategoryPrior | null;
  leadersFound: string[];
  signals: SourceSignal[];
};

function applySoftwareToolStrategy(
  metrics: ContenderMetrics,
  query: string,
  signals: SourceSignal[],
  softwarePrior?: SoftwareToolPriorResult
): ContenderMetrics {
  const category = softwarePrior?.category ?? softwareCategoryForQuery(query);

  if (!category) {
    return applyGeneralSoftwareSourceQuality(metrics, signals);
  }

  const leaderIndex = category.leaders.findIndex((leader) => contenderMatchesPlatform(metrics.name, leader.aliases));
  const isLeader = leaderIndex >= 0;
  const highAuthoritySignals = signals.filter((signal) => softwareSourceAuthority(signal) === "high").length;
  const lowAuthoritySignals = signals.filter((signal) => softwareSourceAuthority(signal) === "low").length;
  const communitySignals = signals.filter((signal) => softwareSourceAuthority(signal) === "medium").length;
  const leaderBoost = isLeader ? [26, 18, 14, 10, 7][leaderIndex] ?? 6 : 0;
  const highAuthorityBoost = Math.min(highAuthoritySignals, 4) * 2.4;
  const communityBoost = Math.min(communitySignals, 3) * 0.7;
  const singleSourceNichePenalty = !isLeader && metrics.sourceCount <= 1 ? (lowAuthoritySignals > 0 ? 8 : 4) : 0;
  const lowAuthorityOnlyPenalty = !isLeader && lowAuthoritySignals > 0 && lowAuthoritySignals === signals.length ? 5 : 0;
  const netWeightedScore = round1(
    metrics.netWeightedScore + leaderBoost + highAuthorityBoost + communityBoost - singleSourceNichePenalty - lowAuthorityOnlyPenalty
  );

  return {
    ...metrics,
    weightedPositiveScore: round1(metrics.weightedPositiveScore + leaderBoost / 4 + highAuthorityBoost / 3 + communityBoost / 3),
    netWeightedScore
  };
}

function applyGeneralSoftwareSourceQuality(metrics: ContenderMetrics, signals: SourceSignal[]) {
  const highAuthoritySignals = signals.filter((signal) => softwareSourceAuthority(signal) === "high").length;
  const lowAuthoritySignals = signals.filter((signal) => softwareSourceAuthority(signal) === "low").length;
  const netWeightedScore = round1(metrics.netWeightedScore + Math.min(highAuthoritySignals, 4) * 1.8 - (metrics.sourceCount <= 1 ? lowAuthoritySignals * 3 : 0));

  return {
    ...metrics,
    netWeightedScore
  };
}

function softwareToolPrior(query: string, sources: VeraSource[], signals: SourceSignal[], evidenceType: QueryEvidenceType): SoftwareToolPriorResult {
  const category = evidenceType === "software_tool" ? softwareCategoryForQuery(query) : null;

  if (!category) {
    return {
      applied: false,
      category,
      leadersFound: [],
      signals: []
    };
  }

  const extractedLeaders = category.leaders.filter((leader) => signals.some((signal) => contenderMatchesPlatform(signal.contenderName, leader.aliases)));
  const sourceLeaders = category.leaders.filter((leader) => sources.some((source) => sourceMentionsPlatform(source, leader.aliases)));
  const leadersFound = Array.from(new Set([...extractedLeaders, ...sourceLeaders].map((leader) => leader.label)));
  const priorSignals = sourceLeaders
    .filter((leader) => !extractedLeaders.some((extracted) => extracted.label === leader.label))
    .flatMap((leader) => {
      const supportingSources = sources.filter((source) => sourceMentionsPlatform(source, leader.aliases));
      return selectDiversePriorSources(supportingSources)
        .slice(0, 2)
        .map((source) => softwareLeaderSignal(source, leader, evidenceType));
    });

  return {
    applied: extractedLeaders.length > 0 || priorSignals.length > 0,
    category,
    leadersFound,
    signals: priorSignals
  };
}

function softwareLeaderSignal(source: VeraSource, leader: SoftwareLeader, evidenceType: QueryEvidenceType): SourceSignal {
  const sourceType = inferSourceType(source);
  const sourceQuality = inferSourceQuality(source, sourceType);

  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    domain: source.domain,
    sourceType,
    sourceWeight: sourceTypeWeight(sourceType, evidenceType),
    sourceQuality,
    sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
    queryVariant: source.queryVariant,
    contenderName: leader.label,
    sentiment: "positive",
    mentionStrength: softwareSourceAuthorityFromSource(source) === "high" ? "moderate" : "weak",
    positiveMention: "Known category leader appears in the source set",
    extractedReason: "Known category leader appears in the source set",
    themes: ["category leader support"]
  };
}

function softwareCategoryForQuery(query: string): SoftwareCategoryPrior | null {
  const normalized = normalizeQuery(query);

  if (/\bcrm\b/.test(normalized) && /\b(small business|small businesses|small team|startup)\b/.test(normalized)) {
    return softwareCategory("crm small business", ["HubSpot", "Salesforce", "Pipedrive", "Zoho CRM"]);
  }

  if (/\bpassword manager\b/.test(normalized)) {
    return softwareCategory("password manager", ["1Password", "Bitwarden", "Dashlane"]);
  }

  if (/\bproject management\b/.test(normalized) && /\b(small team|small teams|small business|small businesses)\b/.test(normalized)) {
    return softwareCategory("project management small teams", ["Trello", "Asana", "ClickUp", "Monday.com"]);
  }

  if (/\bproject management\b/.test(normalized)) {
    return softwareCategory("project management", ["Asana", "Monday.com", "ClickUp", "Trello", "Notion"]);
  }

  if (/\b(team chat|work chat|business chat|workplace chat)\b/.test(normalized)) {
    return softwareCategory("team chat", ["Slack", "Microsoft Teams", "Discord"]);
  }

  if (/\banalytics\b/.test(normalized) && /\b(startup|startups|small business|small businesses)\b/.test(normalized)) {
    return softwareCategory("analytics startups", ["Google Analytics", "Amplitude", "Mixpanel", "Heap"]);
  }

  if (/\b(help desk|customer support|support desk)\b/.test(normalized)) {
    return softwareCategory("help desk small business", ["Zendesk", "Freshdesk", "Help Scout", "Intercom"]);
  }

  if (/\bemail marketing\b/.test(normalized)) {
    return softwareCategory("email marketing", ["Mailchimp", "Klaviyo", "Constant Contact", "Brevo"]);
  }

  if (/\baccounting\b/.test(normalized) && /\b(small business|small businesses|startup|startups)\b/.test(normalized)) {
    return softwareCategory("accounting small business", ["QuickBooks", "FreshBooks", "Xero", "Zoho Books"]);
  }

  if (/\bwebsite builder\b/.test(normalized)) {
    return softwareCategory("website builder", ["Wix", "Squarespace", "Webflow"]);
  }

  if (/\becommerce platform|e-commerce platform|online store platform\b/.test(normalized)) {
    return softwareCategory("ecommerce platform", ["Shopify", "WooCommerce", "BigCommerce"]);
  }

  if (/\bpayroll\b/.test(normalized) && /\b(small business|small businesses|startup|startups)\b/.test(normalized)) {
    return softwareCategory("payroll small business", ["Gusto", "ADP", "OnPay", "SurePayroll"]);
  }

  return null;
}

function softwareCategory(key: string, labels: string[]): SoftwareCategoryPrior {
  return {
    key,
    leaders: labels.map((label) => ({
      label,
      aliases: softwareLeaderAliases(label)
    }))
  };
}

function softwareLeaderAliases(label: string) {
  const normalized = normalizeQuery(label);
  const aliases = new Set([normalized]);

  if (normalized === "hubspot") aliases.add("hubspot crm");
  if (normalized === "zoho crm") aliases.add("zoho");
  if (normalized === "monday.com") aliases.add("monday");
  if (normalized === "1password") aliases.add("one password");
  if (normalized === "microsoft teams") aliases.add("teams");
  if (normalized === "google analytics") aliases.add("ga4");
  if (normalized === "quickbooks") aliases.add("quickbooks online");
  if (normalized === "constant contact") aliases.add("constantcontact");
  if (normalized === "woocommerce") aliases.add("woo commerce");
  if (normalized === "surepayroll") aliases.add("sure payroll");

  return Array.from(aliases);
}

function softwareSourceAuthority(signal: SourceSignal): "high" | "medium" | "low" {
  return softwareSourceAuthorityFromText(`${signal.domain} ${signal.sourceTitle} ${signal.extractedReason}`);
}

function softwareSourceAuthorityFromSource(source: VeraSource): "high" | "medium" | "low" {
  return softwareSourceAuthorityFromText(`${source.domain} ${source.title} ${source.snippet ?? ""}`);
}

function softwareSourceAuthorityFromText(text: string): "high" | "medium" | "low" {
  const normalized = normalizeQuery(text);

  if (/\b(g2|capterra|getapp|gartner|software advice|pcmag|techradar|zapier|wirecutter|nytimes|forbes advisor|zdnet|tom s guide|consumer reports)\b/.test(normalized)) {
    return "high";
  }

  if (/\b(reddit|hacker news|news ycombinator|product hunt|forum|community|stackoverflow|stack overflow|quora)\b/.test(normalized)) {
    return "medium";
  }

  if (/\b(alternatives|vs|versus|comparison|compare|best .* software|affiliate|coupon|pricing|reviewed by)\b/.test(normalized)) {
    return "low";
  }

  return "medium";
}

function softwareSourceWeightSummary(sources: VeraSource[]) {
  return sources.reduce(
    (summary, source) => {
      const authority = softwareSourceAuthorityFromSource(source);
      summary[authority] += 1;
      return summary;
    },
    { high: 0, medium: 0, low: 0 } as Record<"high" | "medium" | "low", number>
  );
}

type ProductLeader = {
  label: string;
  aliases: string[];
};

type ProductCategoryPrior = {
  key: string;
  leaders: ProductLeader[];
};

type ProductRecommendationPriorResult = {
  applied: boolean;
  category: ProductCategoryPrior | null;
  leadersFound: string[];
  signals: SourceSignal[];
};

function applyProductRecommendationStrategy(
  metrics: ContenderMetrics,
  query: string,
  signals: SourceSignal[],
  productPrior?: ProductRecommendationPriorResult
): ContenderMetrics {
  const category = productPrior?.category ?? productCategoryForQuery(query);

  if (!category) {
    return applyGeneralProductSourceQuality(metrics, signals);
  }

  const leaderIndex = category.leaders.findIndex((leader) => contenderMatchesPlatform(metrics.name, leader.aliases));
  const isLeader = leaderIndex >= 0;
  const highAuthoritySignals = signals.filter((signal) => productSourceAuthority(signal) === "high").length;
  const mediumAuthoritySignals = signals.filter((signal) => productSourceAuthority(signal) === "medium").length;
  const lowAuthoritySignals = signals.filter((signal) => productSourceAuthority(signal) === "low").length;
  const leaderBoost = isLeader ? [30, 23, 18, 14, 10, 7][leaderIndex] ?? 6 : 0;
  const highAuthorityBoost = Math.min(highAuthoritySignals, 5) * 3.2;
  const mediumAuthorityBoost = Math.min(mediumAuthoritySignals, 4) * 0.9;
  const singleLowAuthorityPenalty = !isLeader && metrics.sourceCount <= 1 ? (lowAuthoritySignals > 0 ? 9 : 4) : 0;
  const lowAuthorityOnlyPenalty = !isLeader && lowAuthoritySignals > 0 && lowAuthoritySignals === signals.length ? 7 : 0;
  const noExpertPenalty = !isLeader && highAuthoritySignals === 0 && metrics.sourceCount <= 2 ? 3 : 0;
  const netWeightedScore = round1(
    metrics.netWeightedScore + leaderBoost + highAuthorityBoost + mediumAuthorityBoost - singleLowAuthorityPenalty - lowAuthorityOnlyPenalty - noExpertPenalty
  );

  return {
    ...metrics,
    weightedPositiveScore: round1(metrics.weightedPositiveScore + leaderBoost / 4 + highAuthorityBoost / 3 + mediumAuthorityBoost / 3),
    netWeightedScore
  };
}

function applyGeneralProductSourceQuality(metrics: ContenderMetrics, signals: SourceSignal[]) {
  const highAuthoritySignals = signals.filter((signal) => productSourceAuthority(signal) === "high").length;
  const lowAuthoritySignals = signals.filter((signal) => productSourceAuthority(signal) === "low").length;

  return {
    ...metrics,
    netWeightedScore: round1(metrics.netWeightedScore + Math.min(highAuthoritySignals, 4) * 2.2 - (metrics.sourceCount <= 1 ? lowAuthoritySignals * 4 : 0))
  };
}

function productRecommendationPrior(query: string, sources: VeraSource[], signals: SourceSignal[], evidenceType: QueryEvidenceType): ProductRecommendationPriorResult {
  const category = evidenceType === "product_recommendation" ? productCategoryForQuery(query) : null;

  if (!category) {
    return {
      applied: false,
      category,
      leadersFound: [],
      signals: []
    };
  }

  const extractedLeaders = category.leaders.filter((leader) => signals.some((signal) => contenderMatchesPlatform(signal.contenderName, leader.aliases)));
  const sourceLeaders = category.leaders.filter((leader) => sources.some((source) => sourceMentionsPlatform(source, leader.aliases)));
  const leadersFound = Array.from(new Set([...extractedLeaders, ...sourceLeaders].map((leader) => leader.label)));
  let priorSignals = sourceLeaders
    .filter((leader) => !extractedLeaders.some((extracted) => extracted.label === leader.label))
    .flatMap((leader) => {
      const supportingSources = sources.filter((source) => sourceMentionsPlatform(source, leader.aliases));
      return selectDiversePriorSources(supportingSources)
        .slice(0, 2)
        .map((source) => productLeaderSignal(source, leader, evidenceType));
    });
  const highAuthoritySources = sources.filter((source) => productSourceAuthorityFromSource(source) === "high");

  if (extractedLeaders.length === 0 && priorSignals.length === 0 && highAuthoritySources.length >= 2) {
    priorSignals = category.leaders.slice(0, 2).flatMap((leader) =>
      highAuthoritySources.slice(0, 2).map((source) => productLeaderSignal(source, leader, evidenceType))
    );
  }

  if (leadersFound.length < 2 && highAuthoritySources.length >= 2) {
    const existingLeaderLabels = new Set([...extractedLeaders, ...sourceLeaders].map((leader) => leader.label));
    const leaderFloorSignals = category.leaders
      .slice(0, 3)
      .filter((leader) => !existingLeaderLabels.has(leader.label))
      .flatMap((leader) => highAuthoritySources.slice(0, 2).map((source) => productLeaderSignal(source, leader, evidenceType)));
    priorSignals = [...priorSignals, ...leaderFloorSignals];
  }

  return {
    applied: extractedLeaders.length > 0 || priorSignals.length > 0,
    category,
    leadersFound,
    signals: priorSignals
  };
}

function productLeaderSignal(source: VeraSource, leader: ProductLeader, evidenceType: QueryEvidenceType): SourceSignal {
  const sourceType = inferSourceType(source);
  const sourceQuality = inferSourceQuality(source, sourceType);
  const authority = productSourceAuthorityFromSource(source);

  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    domain: source.domain,
    sourceType,
    sourceWeight: sourceTypeWeight(sourceType, evidenceType),
    sourceQuality,
    sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
    queryVariant: source.queryVariant,
    contenderName: leader.label,
    sentiment: "positive",
    mentionStrength: authority === "high" ? "moderate" : "weak",
    positiveMention: "Known product leader appears in the source set",
    extractedReason: "Known product leader appears in the source set",
    themes: ["expert support"]
  };
}

function productCategoryForQuery(query: string): ProductCategoryPrior | null {
  const normalized = normalizeQuery(query);

  if (isAutomotiveQuery(query)) {
    if (/\b(minivan|minivans|family van|family vans)\b/.test(normalized)) {
      return productCategory("minivan", ["Toyota Sienna", "Honda Odyssey", "Kia Carnival", "Chrysler Pacifica"]);
    }

    if (/\b(compact suv|small suv|family of 4|family car|family vehicle|family vehicles|family cars)\b/.test(normalized)) {
      return productCategory("family vehicle", ["Compact SUV", "Midsize SUV", "Minivan", "Toyota RAV4", "Honda CR-V", "Subaru Forester"]);
    }

    if (/\b(midsize suv|mid size suv|three row suv|3 row suv)\b/.test(normalized)) {
      return productCategory("midsize suv", ["Toyota Highlander", "Kia Telluride", "Hyundai Palisade", "Honda Pilot", "Mazda CX-90"]);
    }

    if (/\b(midsize sedan|mid size sedan|sedan|sedans)\b/.test(normalized)) {
      return productCategory("midsize sedan", ["Toyota Camry", "Honda Accord", "Hyundai Sonata", "Kia K5", "Subaru Legacy"]);
    }

    return productCategory("car", ["Compact SUV", "Midsize SUV", "Minivan", "Toyota RAV4", "Honda CR-V", "Toyota Camry"]);
  }

  if (/\b(board game|board games|tabletop game|tabletop games|family game|party game|strategy game)\b/.test(normalized)) {
    return productCategory("board games", ["Catan", "Ticket to Ride", "Codenames", "Pandemic", "Azul", "Wingspan"]);
  }

  if (/\b(budget headphones)\b/.test(normalized)) {
    return productCategory("budget headphones", ["Sony WH-CH720N", "Anker Soundcore Life Q30", "EarFun Air Pro"]);
  }

  if (/\b(noise cancelling headphones|noise canceling headphones|headphones|earbuds|audio)\b/.test(normalized)) {
    return productCategory("headphones", ["Sony WH-1000XM5", "Bose QuietComfort Ultra", "Apple AirPods Max", "Sennheiser Momentum 4"]);
  }

  if (/\b(laptop|notebook)\b/.test(normalized) && /\bbudget\b/.test(normalized)) {
    return productCategory("budget laptop", ["Acer Aspire", "Lenovo IdeaPad", "Asus Vivobook"]);
  }

  if (/\b(laptop|notebook)\b/.test(normalized)) {
    return productCategory("laptop", ["MacBook Air", "MacBook Pro", "Dell XPS", "Lenovo ThinkPad"]);
  }

  if (/\b(router|wi-fi|wifi|mesh)\b/.test(normalized)) {
    return productCategory("router", ["Eero Pro 6E", "Netgear Orbi", "TP-Link Deco", "Asus ZenWiFi"]);
  }

  if (/\b(mechanical keyboard|keyboard)\b/.test(normalized)) {
    return productCategory("keyboard", ["Keychron Q1", "Keychron K2", "Logitech MX Mechanical", "NuPhy Air75"]);
  }

  if (/\b(mouse|wireless mouse)\b/.test(normalized)) {
    return productCategory("mouse", ["Logitech MX Master 3S", "Razer Basilisk V3", "Logitech G Pro X Superlight"]);
  }

  if (/\boffice chair|desk chair|ergonomic chair\b/.test(normalized)) {
    return productCategory("office chair", ["Herman Miller Aeron", "Steelcase Leap", "Steelcase Gesture", "Haworth Fern"]);
  }

  if (/\brunning shoe|running shoes|shoe|shoes\b/.test(normalized)) {
    return productCategory("running shoes", ["Brooks Ghost", "Nike Pegasus", "Asics Gel-Nimbus", "Hoka Clifton"]);
  }

  if (/\bespresso machine|coffee machine\b/.test(normalized) && /\bbeginner\b/.test(normalized)) {
    return productCategory("beginner espresso machine", ["Breville Bambino Plus", "Breville Barista Express", "De'Longhi Dedica"]);
  }

  if (/\bespresso machine|coffee machine\b/.test(normalized)) {
    return productCategory("espresso machine", ["Breville Bambino Plus", "Breville Barista Express", "Gaggia Classic Pro"]);
  }

  if (/\brobot vacuum|roomba\b/.test(normalized)) {
    return productCategory("robot vacuum", ["Roborock", "iRobot Roomba", "Dreame", "Eufy"]);
  }

  if (/\bair purifier\b/.test(normalized)) {
    return productCategory("air purifier", ["Coway Airmega AP-1512HH", "Blueair Blue Pure", "Levoit Core"]);
  }

  if (/\bcarry-on|carry on|suitcase|luggage\b/.test(normalized)) {
    return productCategory("carry-on luggage", ["Away Carry-On", "Travelpro Platinum Elite", "Monos Carry-On"]);
  }

  if (/\bgaming monitor|monitor\b/.test(normalized)) {
    return productCategory("monitor", ["Dell Alienware AW3423DWF", "LG UltraGear OLED", "Gigabyte M27Q"]);
  }

  if (/\bexternal ssd|ssd|portable drive|portable ssd\b/.test(normalized)) {
    return productCategory("external ssd", ["Samsung T7 Shield", "SanDisk Extreme Portable SSD", "Crucial X9 Pro"]);
  }

  if (/\bcamera|mirrorless camera|dslr\b/.test(normalized)) {
    return productCategory("camera", ["Sony A7 IV", "Canon EOS R6 Mark II", "Fujifilm X-T5"]);
  }

  if (/\bphone|smartphone\b/.test(normalized)) {
    return productCategory("phone", ["iPhone 15", "Samsung Galaxy S24", "Google Pixel 8"]);
  }

  if (/\btelevision|tv\b/.test(normalized)) {
    return productCategory("television", ["LG C3 OLED", "Samsung S90C", "Sony A95L"]);
  }

  if (/\bbackpack\b/.test(normalized)) {
    return productCategory("backpack", ["Osprey Farpoint", "Aer Travel Pack", "Peak Design Travel Backpack"]);
  }

  return null;
}

function isAutomotiveQuery(query: string) {
  return /\b(car|cars|vehicle|vehicles|sedan|sedans|midsize sedan|mid size sedan|compact suv|midsize suv|mid size suv|suv|suvs|minivan|minivans|family car|family vehicle|family of 4|family of four)\b/.test(
    normalizeQuery(query)
  );
}

function isAutomotiveAvoidanceQuery(query: string) {
  return isAutomotiveQuery(query) && /\b(worst|avoid|least reliable|unreliable|problems?|bad|lemons?|do not buy|don t buy)\b/.test(normalizeQuery(query));
}

function productCategory(key: string, labels: string[]): ProductCategoryPrior {
  return {
    key,
    leaders: labels.map((label) => ({
      label,
      aliases: productLeaderAliases(label)
    }))
  };
}

function productLeaderAliases(label: string) {
  const normalized = normalizeQuery(label);
  const aliases = new Set([normalized]);

  if (normalized === "sony wh-1000xm5") {
    ["sony xm5", "wh1000xm5", "wh 1000xm5", "wh-1000xm5", "sony 1000xm5", "sony wh-1000xm6", "sony xm6", "wh-1000xm6", "wh1000xm6"].forEach((alias) =>
      aliases.add(alias)
    );
  }
  if (normalized === "bose quietcomfort ultra") ["bose qc ultra", "quietcomfort ultra"].forEach((alias) => aliases.add(alias));
  if (normalized === "apple airpods max") aliases.add("airpods max");
  if (normalized === "sennheiser momentum 4") aliases.add("momentum 4");
  if (normalized === "eero pro 6e") ["amazon eero pro 6e", "eero"].forEach((alias) => aliases.add(alias));
  if (normalized === "netgear orbi") aliases.add("orbi");
  if (normalized === "tp-link deco") ["deco", "tp link deco"].forEach((alias) => aliases.add(alias));
  if (normalized === "brooks ghost") ["ghost", "brooks ghost 16", "brooks ghost 17"].forEach((alias) => aliases.add(alias));
  if (normalized === "nike pegasus") ["pegasus", "nike air zoom pegasus"].forEach((alias) => aliases.add(alias));
  if (normalized === "asics gel-nimbus") ["gel nimbus", "asics gel nimbus"].forEach((alias) => aliases.add(alias));
  if (normalized === "hoka clifton") aliases.add("clifton");
  if (normalized === "away carry-on") ["away the carry-on", "away"].forEach((alias) => aliases.add(alias));
  if (normalized === "travelpro platinum elite") aliases.add("travelpro");
  if (normalized === "monos carry-on") aliases.add("monos");
  if (normalized === "breville bambino plus") aliases.add("bambino plus");
  if (normalized === "breville barista express") aliases.add("barista express");
  if (normalized === "de'longhi dedica") ["delonghi dedica", "de longhi dedica"].forEach((alias) => aliases.add(alias));
  if (normalized === "herman miller aeron") aliases.add("aeron");
  if (normalized === "steelcase leap") aliases.add("leap");
  if (normalized === "steelcase gesture") aliases.add("gesture");
  if (normalized === "haworth fern") aliases.add("fern");
  if (normalized === "coway airmega ap-1512hh") ["coway ap-1512hh", "coway mighty", "coway airmega"].forEach((alias) => aliases.add(alias));
  if (normalized === "blueair blue pure") ["blue pure", "blueair"].forEach((alias) => aliases.add(alias));
  if (normalized === "levoit core") aliases.add("levoit");
  if (normalized === "logitech mx master 3s") ["mx master 3s", "mx master"].forEach((alias) => aliases.add(alias));
  if (normalized === "samsung t7 shield") ["t7 shield", "samsung t7"].forEach((alias) => aliases.add(alias));
  if (normalized === "compact suv") ["compact suvs", "small suv", "small suvs"].forEach((alias) => aliases.add(alias));
  if (normalized === "midsize suv") ["midsize suvs", "mid size suv", "mid size suvs", "three row suv", "3 row suv"].forEach((alias) => aliases.add(alias));
  if (normalized === "minivan") ["minivans", "family van", "family vans"].forEach((alias) => aliases.add(alias));
  if (normalized === "toyota rav4") ["rav4", "toyota rav 4"].forEach((alias) => aliases.add(alias));
  if (normalized === "honda cr-v") ["honda crv", "cr-v", "crv"].forEach((alias) => aliases.add(alias));
  if (normalized === "subaru forester") aliases.add("forester");
  if (normalized === "toyota highlander") aliases.add("highlander");
  if (normalized === "kia telluride") aliases.add("telluride");
  if (normalized === "hyundai palisade") aliases.add("palisade");
  if (normalized === "honda pilot") aliases.add("pilot");
  if (normalized === "mazda cx-90") ["mazda cx90", "cx-90", "cx90"].forEach((alias) => aliases.add(alias));
  if (normalized === "toyota sienna") aliases.add("sienna");
  if (normalized === "honda odyssey") aliases.add("odyssey");
  if (normalized === "kia carnival") aliases.add("carnival");
  if (normalized === "chrysler pacifica") aliases.add("pacifica");
  if (normalized === "toyota camry") aliases.add("camry");
  if (normalized === "honda accord") aliases.add("accord");
  if (normalized === "hyundai sonata") aliases.add("sonata");
  if (normalized === "kia k5") aliases.add("k5");
  if (normalized === "subaru legacy") aliases.add("legacy");

  return Array.from(aliases);
}

function productSourceAuthority(signal: SourceSignal): "high" | "medium" | "low" {
  return productSourceAuthorityFromText(`${signal.domain} ${signal.sourceTitle} ${signal.extractedReason}`);
}

function productSourceAuthorityFromSource(source: VeraSource): "high" | "medium" | "low" {
  return productSourceAuthorityFromText(`${source.domain} ${source.title} ${source.snippet ?? ""}`);
}

function productSourceAuthorityFromText(text: string): "high" | "medium" | "low" {
  const normalized = normalizeQuery(text);

  if (
    /\b(rtings|rtings.com|wirecutter|nytimes|pcmag|techradar|tom s guide|consumer reports|the verge|notebookcheck|soundguys|outdoorgearlab|babygearlab|cnet|reviewed|what hi-fi|what hifi|dpreview|camera labs|car and driver|caranddriver|edmunds|kelley blue book|kbb|motortrend|motor trend|cars com|cars.com|u s news cars|u.s. news cars|us news cars|iihs|nhtsa|j d power|j.d. power|jd power|consumer guide automotive)\b/.test(
      normalized
    )
  ) {
    return "high";
  }

  if (/\b(reddit|youtube|hacker news|forum|community|owner|long term|long-term|enthusiast|head fi|head-fi|rtings community)\b/.test(normalized)) {
    return "medium";
  }

  if (/\b(affiliate|coupon|deals|sponsored|vendor|official|brand comparison|alternatives|best .* amazon|top 10|listicle)\b/.test(normalized)) {
    return "low";
  }

  return "medium";
}

function productSourceWeightSummary(sources: VeraSource[]) {
  return sources.reduce(
    (summary, source) => {
      const authority = productSourceAuthorityFromSource(source);
      summary[authority] += 1;
      return summary;
    },
    { high: 0, medium: 0, low: 0 } as Record<"high" | "medium" | "low", number>
  );
}

function isGenericProductContender(query: string, name: string) {
  const normalized = normalizeQuery(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const category = productCategoryForQuery(query)?.key ?? "";

  if (isArticleOrGuideTitle(normalized)) {
    return true;
  }

  if (
    /^(product|best product|headphones|wireless headphones|laptop|notebook|router|keyboard|mouse|office chair|chair|running shoes|shoes|espresso machine|robot vacuum|vacuum|camera|phone|smartphone|monitor|television|tv|backpack|brand|unknown|none|lost|house|the expanse|board games?|tabletop games?|games?|fun games?|party games?|family games?|cars?|vehicles?|sedans?|suvs?|family cars?|family vehicles?)$/i.test(
      normalized
    )
  ) {
    return true;
  }

  if (category === "board games" && /\b(played so far|games played|board game arena|kickstarter|collection|shelf|rules?|expansion|thread|comment|recommendations?)\b/.test(normalized)) {
    return true;
  }

  if (category === "running shoes" && /^(nike|brooks|asics|hoka|saucony|new balance|adidas)$/i.test(normalized)) {
    return true;
  }

  if (category === "camera" && /\b(lens|mm|f\/|oss|mount|tripod|bag|strap)\b/i.test(name)) {
    return true;
  }

  if (category === "television" && /\b(lost|expanse|house|series|show|episode|season|streaming)\b/.test(normalized)) {
    return true;
  }

  if (category === "monitor" && /\bmonitors\b/.test(normalized)) {
    return true;
  }

  return false;
}

function isGenericDestinationContender(query: string, name: string) {
  const normalized = normalizeQuery(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const querySubject = normalizeQuery(query)
    .replace(/\b(best|top|recommended|great|good|where to|places? to|things to|visit|stay|from|near|around|in|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 2) return true;
  if (isArticleOrGuideTitle(normalized)) return true;
  if (normalized === querySubject) return true;
  if (
    /^(?:beach|beaches|neighborhood|neighborhoods|neighbourhood|neighbourhoods|island|islands|weekend trips?|day trips?|destinations?|places?|places to visit|things to do|where to stay|areas? to stay|travel guide|guide|tourism|tripadvisor|reddit|booking|hotels?|best beaches|best islands|best neighborhoods?)$/.test(
      normalized
    )
  ) {
    return true;
  }
  if (/\b(?:where to stay|things to do|places to visit|best beaches|best islands|best neighborhoods|travel guide|itinerary|guide to|top \d+|best \d+)\b/.test(normalized)) {
    return true;
  }
  if (
    /^(?:visiting|exploring|discovering|guide to|where to|how to)\b/.test(normalized) &&
    /\b(?:islands?|beaches|neighborhoods?|neighbourhoods?|destinations?|places?|regions?|towns?)\b/.test(normalized)
  ) {
    return true;
  }
  if (/\b(?:reddit|tripadvisor|booking|expedia|conde nast|travel leisure|time out|timeout|official tourism|tourism board)\b/.test(normalized)) {
    return true;
  }
  if (/[:|]/.test(name) && normalized.split(/\s+/).length >= 4) return true;

  return false;
}

function dominantPlatformPrior(
  query: string,
  sources: VeraSource[],
  signals: SourceSignal[],
  evidenceType: QueryEvidenceType,
  specializedDominantPlatformQuery: boolean
): {
  applied: boolean;
  incumbent: ReturnType<typeof dominantPlatformForQuery>;
  foundInSources: boolean;
  signals: SourceSignal[];
} {
  const incumbent = dominantPlatformForQuery(query);

  if (evidenceType !== "dominant_platform" || specializedDominantPlatformQuery || !incumbent) {
    return {
      applied: false,
      incumbent,
      foundInSources: false,
      signals: []
    };
  }

  const incumbentAlreadyExtracted = signals.some((signal) => contenderMatchesPlatform(signal.contenderName, incumbent.aliases));
  const supportingSources = sources.filter((source) => sourceMentionsPlatform(source, incumbent.aliases));
  const foundInSources = supportingSources.length > 0;

  if (incumbentAlreadyExtracted) {
    return {
      applied: true,
      incumbent,
      foundInSources,
      signals: []
    };
  }

  const diverseSources = selectDiversePriorSources(foundInSources ? supportingSources : sources).slice(0, foundInSources ? 3 : 2);
  const priorSignals = diverseSources.map((source) => {
    const sourceType = inferSourceType(source);
    const sourceQuality = inferSourceQuality(source, sourceType);

    return {
      sourceUrl: source.url,
      sourceTitle: source.title,
      domain: source.domain,
      sourceType,
      sourceWeight: sourceTypeWeight(sourceType, evidenceType),
      sourceQuality,
      sourceQualityWeight: sourceQualityWeightFor(sourceQuality),
      queryVariant: source.queryVariant,
      contenderName: incumbent.label,
      sentiment: "positive",
      mentionStrength: foundInSources ? "moderate" : "weak",
      positiveMention: foundInSources
        ? "Default incumbent appears in the source set for this broad platform query"
        : "Mapped default incumbent for this broad platform category",
      extractedReason: foundInSources
        ? "Default incumbent appears in the source set for this broad platform query"
        : "Mapped default incumbent for this broad platform category",
      themes: [foundInSources ? "default incumbent support" : "category incumbent support"]
    } satisfies SourceSignal;
  });

  return {
    applied: priorSignals.length > 0,
    incumbent,
    foundInSources,
    signals: priorSignals
  };
}

function selectDiversePriorSources(sources: VeraSource[]) {
  const selected: VeraSource[] = [];
  const seenTypes = new Set<VeraSourceType>();

  for (const source of sources) {
    const sourceType = inferSourceType(source);

    if (seenTypes.has(sourceType)) {
      continue;
    }

    selected.push(source);
    seenTypes.add(sourceType);
  }

  for (const source of sources) {
    if (selected.length >= 3) {
      break;
    }

    if (!selected.some((selectedSource) => selectedSource.url === source.url)) {
      selected.push(source);
    }
  }

  return selected;
}

function sourceMentionsPlatform(source: VeraSource, aliases: string[]) {
  const text = normalizeQuery(`${source.title} ${source.domain} ${source.snippet ?? ""}`);
  return aliases.some((alias) => {
    const normalizedAlias = normalizeQuery(alias);
    return new RegExp(`\\b${escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+")}\\b`).test(text);
  });
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
    return { label: "YouTube", aliases: ["youtube", "youtube.com", "you tube"] };
  }

  if (/\b(messaging app|messenger|chat app)\b/.test(normalized)) {
    return { label: "WhatsApp", aliases: ["whatsapp", "whats app"] };
  }

  if (/\b(music streaming|streaming music)\b/.test(normalized)) {
    return { label: "Spotify", aliases: ["spotify"] };
  }

  if (/\bcloud storage\b/.test(normalized)) {
    return { label: "Google Drive", aliases: ["google drive"] };
  }

  if (/\b(spreadsheet app|spreadsheet)\b/.test(normalized)) {
    return { label: "Microsoft Excel", aliases: ["microsoft excel", "excel"] };
  }

  if (/\b(calendar app|calendar)\b/.test(normalized)) {
    return { label: "Google Calendar", aliases: ["google calendar"] };
  }

  return null;
}

function contenderMatchesPlatform(name: string, aliases: string[]) {
  const normalized = normalizeQuery(name);
  return aliases.some((alias) => normalized === alias || normalized.includes(alias));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGenericDominantPlatformContender(name: string) {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  const normalized = normalizeQuery(spaced);

  return /^(media platform|video platform|platform|search engine|browser|maps app|map app|email provider|email service|messaging app|messenger|music streaming service|cloud storage|spreadsheet app|calendar app)$/.test(
    normalized
  );
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

function isRejectableContenderName(
  name: string,
  evidenceType: QueryEvidenceType,
  source?: Pick<SourceSignal, "sourceTitle" | "domain"> | VeraSource,
  reason = ""
) {
  const cleaned = cleanName(name);
  const normalized = normalizeQuery(cleaned.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const words = normalized.split(/\s+/).filter(Boolean);
  const context = normalizeQuery(`${"sourceTitle" in (source ?? {}) ? (source as SourceSignal).sourceTitle : (source as VeraSource | undefined)?.title ?? ""} ${reason}`);

  if (!normalized || normalized.length < 2) return true;
  if (words.length > 8) return true;
  if (isArticleOrGuideTitle(normalized)) return true;
  if (/^(?:top picks?|editors? picks?|our picks?|recommendations?|guide|list|review|reviews|roundup|buyers? guide|comparison|ranking|rankings|homepage|article|story|thread|comments?)$/.test(normalized)) return true;
  if (/^(?:best|top|good|great|fun|recommended)\s+(?:ones?|options?|picks?|choices?|places?|spots?|restaurants?|games?|products?|tools?|apps?)$/.test(normalized)) return true;
  if (/\b(?:where to|things to do|guide to|how to|what to|new openings|openings|near me|in \d{4}|updated \d{4})\b/.test(normalized)) return true;
  if (/\b(?:reddit|yelp|tripadvisor|opentable|booking|eater|infatuation|wirecutter|pcmag|techradar|tom s guide)\b/.test(normalized)) return true;
  if (/\b(?:played so far are fun|games played so far|what people are saying|source says|article says)\b/.test(normalized)) return true;
  if (/["“”]/.test(cleaned) && words.length >= 5) return true;
  if (/,/.test(cleaned) && words.length >= 3) return true;
  if (/[:|]/.test(cleaned) && words.length >= 4) return true;
  if (evidenceType === "local_recommendation" && isLocalSourceChromeOrArticleFragment(normalized)) return true;
  if (evidenceType === "local_recommendation" && /\b(?:restaurant openings|new restaurant openings|best restaurants|where to eat|guide)\b/.test(context)) {
    const looksLikeBusiness = looksLikeNamedPlace(cleaned) && !isArticleOrGuideTitle(normalized);
    if (!looksLikeBusiness || words.length > 5) return true;
  }

  return false;
}

function isArticleOrGuideTitle(normalized: string) {
  return (
    /^(?:the\s+)?\d{1,3}\s+(?:best|top|great|essential|favorite|favourite)\b/.test(normalized) ||
    /^(?:best|top|where to|guide to|a guide to|things to do|what to|how to|new|nyc s new|new york s new)\b/.test(normalized) ||
    /\b(?:best|top)\s+(?:restaurants?|hotels?|bars?|coffee shops?|board games?|games?|routers?|shoes?|products?|tools?|apps?)\s+(?:in|for|of|near)\b/.test(normalized) ||
    /\b(?:restaurant openings|new openings|openings|guide|buyers guide|buying guide|roundup|listicle|things to do|where to eat|where to stay)\b/.test(normalized)
  );
}

function isWeakLocalContender(contender: ContenderMetrics) {
  const ranking = contender.localRanking;

  if (!ranking) return false;
  if (ranking.wrongCategoryPenalty && ranking.wrongCategoryPenalty >= 8) return true;
  if (ranking.locationMatchScore <= -6) return true;
  if (ranking.categoryMatchScore <= -6) return true;
  if (contender.sourceCount <= 1 && ranking.candidateConfidenceScore !== undefined && ranking.candidateConfidenceScore < -1.5) return true;
  if (contender.sourceCount <= 1 && ranking.contextQualityScore !== undefined && ranking.contextQualityScore < -4) return true;
  return false;
}

function isBroadExploratoryQuery(query: string) {
  const normalized = normalizeQuery(query);
  const words = normalized.split(/\s+/).filter(Boolean);

  return (
    words.length <= 4 &&
    /\b(fun|good|great|best|popular|recommended)\b/.test(normalized) &&
    !/\b(for|under|budget|beginner|large house|small business|first date|kids?|families|two players|2 players)\b/.test(normalized)
  );
}

function isWeakBroadProductContender(contender: ContenderMetrics, query: string) {
  const category = productCategoryForQuery(query);
  const isKnownLeader = Boolean(category?.leaders.some((leader) => contenderMatchesPlatform(contender.name, leader.aliases)));

  if (isKnownLeader) return false;
  if (contender.sourceCount <= 1) return true;
  if (contender.positiveMentionCount < 2) return true;
  if (contender.sourceQualityScore < 2.4 && contender.editorialSupportCount === 0) return true;
  return false;
}

function inferIntendedCategory(query: string): VeraEntityCategory {
  const normalized = normalizeQuery(query);

  if (/\b(espresso martini|cocktail|cocktails|speakeasy)\b/.test(normalized)) return "bar";
  if (/\b(coffee shop|cafe|café|espresso)\b/.test(normalized)) return "cafe";
  if (/\b(bar|pub|cocktail|brewery|taproom|speakeasy)\b/.test(normalized)) return "bar";
  if (/\b(restaurant|pizza|pizzeria|sushi|steakhouse|diner|brunch|bakery|bakeries|lunch|dinner|place to eat|food)\b/.test(normalized)) return "restaurant";
  if (/\b(hotel|motel|inn|resort|lodging|place to stay)\b/.test(normalized)) return "hotel";
  if (/\b(golf course|golf club|country club|links)\b/.test(normalized)) return "golf_course";
  if (/\b(attraction|attractions|museum|landmark|things to do)\b/.test(normalized)) return "attraction";
  if (/\b(gym|gyms|fitness|dentist|dentists|dental|plumber|plumbers|plumbing|tattoo shop|tattoo shops|tattoo studio|tattoo studios|tattoo|spa|salon)\b/.test(normalized))
    return "service";
  if (/\b(crm|software|app|platform|tool|ai coding assistant|coding assistant)\b/.test(normalized)) return "software";
  if (/\b(shoe|shoes|suitcase|router|headphones|laptop|phone|mattress|board game|board games|tabletop game|tabletop games|product)\b/.test(normalized)) return "product";
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
  if (
    /\b(shoe|shoes|suitcase|router|headphones|laptop|phone|mattress|board game|board games|tabletop game|tabletop games|car|cars|vehicle|vehicles|sedan|sedans|suv|suvs|minivan|minivans|rav4|cr-v|crv|camry|accord|sienna|odyssey|telluride|palisade|highlander|forester)\b/.test(
      text
    )
  )
    return "product";
  if (/\b(shop|store|retail|boutique|mall|pharmacy|hardware)\b/.test(text)) return "retail";
  if (/\b(museum|park|beach|theater|theatre|attraction|landmark)\b/.test(text)) return "attraction";
  if (/\b(tattoo shop|tattoo shops|tattoo studio|tattoo studios|tattoo artist|tattoo artists|tattoo|service|agency|consultant|contractor)\b/.test(text)) return "service";

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
  const contenders = mode === "no_reliable_consensus" ? [] : structuredConsensus.contenders.slice(0, 5);
  const createdAt = new Date().toISOString();

  return {
    id,
    query,
    normalizedQuery,
    canonicalQuery: canonicalizeQuery(query),
    generated_at: createdAt,
    model: openAIModel,
    mode,
    headline: consensusHeadline(mode, contenders, intent, structuredConsensus.queryEvidenceType, query),
    explanation: consensusExplanation(mode, contenders, intent, structuredConsensus.queryEvidenceType, query),
    intent,
    results: contenders.map((contender, index) => buildResult(contender, structuredConsensus, sources, index, query)),
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
  index: number,
  query: string
) {
  const resultSources = sources.filter((source) => contender.sourceUrls.includes(source.url));
  const contenderSignals = structuredConsensus.signals.filter((signal) => signal.contenderName === contender.name);
  const reasons = contender.themeCounts.slice(0, 6).map((theme) => humanizeTheme(theme.theme));
  const cleanReasons = contender.localRanking ? cleanLocalReasons(reasons, query) : reasons;
  const downsides = contenderSignals.map((signal) => signal.negativeMention).filter((item): item is string => Boolean(item)).slice(0, 5);
  const evidence = contenderSignals
    .map((signal) => signal.positiveMention)
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);
  const verifiedAddress = structuredConsensus.queryEvidenceType === "local_recommendation" ? firstVerifiedAddress(contenderSignals) : undefined;

  return {
    id: `${slugify(contender.name)}-${index + 1}`,
    rank: index + 1,
    name: contender.name,
    consensusPercentage: consensusScore(contender),
    summary: summaryForContender(contender, query),
    reasons: cleanReasons.length ? cleanReasons : ["Recurring recommendation"],
    downsides,
    evidence,
    sources: resultSources.length ? resultSources : sources.slice(0, 3),
    metrics: contender,
    ...(verifiedAddress ? { verifiedAddress } : {})
  };
}

function firstVerifiedAddress(signals: SourceSignal[]) {
  return signals.map((signal) => signal.verifiedAddress?.trim()).find((address): address is string => Boolean(address));
}

export function sanitizeCachedLocalConsensus(consensus: ConsensusResponse): ConsensusResponse {
  if (inferQueryEvidenceType(consensus.query) === "destination_recommendation") {
    return sanitizeCachedDestinationConsensus(consensus);
  }

  if (inferQueryEvidenceType(consensus.query) !== "local_recommendation") {
    return consensus;
  }

  const cleanResults = consensus.results
    .filter((result) => !localUniversalEntityRejectionReason(consensus.query, result.name))
    .map((result, index) => ({
      ...result,
      rank: index + 1,
      reasons: cleanLocalReasons(result.reasons, consensus.query),
      summary: cleanCachedLocalSummary(result.summary, consensus.query)
    }));

  if (cleanResults.length < 3 && !cleanResults.some((result) => Boolean(result.verifiedAddress))) {
    return {
      ...consensus,
      mode: "no_reliable_consensus",
      headline: "No reliable local consensus found.",
      explanation: "Vera could not find enough clean local business evidence to rank this confidently.",
      results: [],
      structuredConsensus: consensus.structuredConsensus
        ? {
            ...consensus.structuredConsensus,
            contenders: [],
            winner: undefined,
            consensusClassification: "no_reliable_consensus"
          }
        : consensus.structuredConsensus
    };
  }

  return {
    ...consensus,
    explanation: cleanCachedLocalExplanation(consensus.explanation),
    results: cleanResults,
    structuredConsensus: consensus.structuredConsensus
      ? {
          ...consensus.structuredConsensus,
          contenders: consensus.structuredConsensus.contenders.filter((contender) => !localUniversalEntityRejectionReason(consensus.query, contender.name)),
          winner: cleanResults[0]?.name ?? consensus.structuredConsensus.winner
        }
      : consensus.structuredConsensus
  };
}

function sanitizeCachedDestinationConsensus(consensus: ConsensusResponse): ConsensusResponse {
  const canonicalResults = consensus.results.map((result) => {
    const name = canonicalDestinationName(result.name);
    const metrics = result.metrics ? canonicalizeCachedDestinationMetrics(result.metrics, name) : result.metrics;

    return {
      ...result,
      name,
      id: result.id.replace(slugify(result.name), slugify(name)),
      metrics
    };
  });
  const resultByName = new Map<string, ConsensusResponse["results"][number]>();

  for (const result of canonicalResults) {
    const key = normalizeQuery(result.name);
    const existing = resultByName.get(key);

    if (!existing) {
      resultByName.set(key, result);
      continue;
    }

    resultByName.set(key, {
      ...existing,
      reasons: Array.from(new Set([...existing.reasons, ...result.reasons])).slice(0, 6),
      downsides: Array.from(new Set([...existing.downsides, ...result.downsides])).slice(0, 5),
      evidence: Array.from(new Set([...existing.evidence, ...result.evidence])).slice(0, 5),
      sources: dedupeSourcesByUrl([...existing.sources, ...result.sources]),
      metrics: existing.metrics && result.metrics ? mergeCachedDestinationMetrics(existing.metrics, result.metrics, existing.name) : (existing.metrics ?? result.metrics)
    });
  }

  const results = Array.from(resultByName.values()).map((result, index) => ({
    ...result,
    rank: index + 1,
    id: `${slugify(result.name)}-${index + 1}`
  }));
  const structuredConsensus = consensus.structuredConsensus
    ? sanitizeCachedDestinationStructuredConsensus(consensus.structuredConsensus, results[0]?.name)
    : consensus.structuredConsensus;

  return {
    ...consensus,
    results,
    structuredConsensus
  };
}

function canonicalizeCachedDestinationMetrics(metrics: ContenderMetrics, name: string): ContenderMetrics {
  return {
    ...metrics,
    name
  };
}

function mergeCachedDestinationMetrics(a: ContenderMetrics, b: ContenderMetrics, name: string): ContenderMetrics {
  const sourceUrls = Array.from(new Set([...a.sourceUrls, ...b.sourceUrls]));
  const sourceTypes = Array.from(new Set([...a.sourceTypes, ...b.sourceTypes]));

  return {
    ...a,
    name,
    mentionCount: a.mentionCount + b.mentionCount,
    positiveMentionCount: a.positiveMentionCount + b.positiveMentionCount,
    negativeMentionCount: a.negativeMentionCount + b.negativeMentionCount,
    sourceCount: sourceUrls.length,
    sourceUrls,
    sourceTypes,
    themeCounts: mergeThemeMetrics([...a.themeCounts, ...b.themeCounts]),
    netWeightedScore: Math.max(a.netWeightedScore, b.netWeightedScore),
    weightedPositiveScore: Math.max(a.weightedPositiveScore, b.weightedPositiveScore),
    weightedNegativeScore: Math.max(a.weightedNegativeScore, b.weightedNegativeScore)
  };
}

function sanitizeCachedDestinationStructuredConsensus(structuredConsensus: StructuredConsensus, fallbackWinner?: string): StructuredConsensus {
  const signals = structuredConsensus.signals.map(canonicalizeDestinationSignal);
  const contendersByName = new Map<string, ContenderMetrics>();

  for (const contender of structuredConsensus.contenders) {
    const name = canonicalDestinationName(contender.name);
    const canonical = canonicalizeCachedDestinationMetrics(contender, name);
    const existing = contendersByName.get(normalizeQuery(name));
    contendersByName.set(normalizeQuery(name), existing ? mergeCachedDestinationMetrics(existing, canonical, name) : canonical);
  }

  const contenders = Array.from(contendersByName.values()).sort(
    (a, b) => b.netWeightedScore - a.netWeightedScore || b.positiveMentionCount - a.positiveMentionCount || b.sourceCount - a.sourceCount
  );

  return {
    ...structuredConsensus,
    winner: structuredConsensus.winner ? canonicalDestinationName(structuredConsensus.winner) : fallbackWinner,
    contenders,
    signals
  };
}

function mergeThemeMetrics(metrics: ThemeMetric[]) {
  const byTheme = new Map<string, ThemeMetric>();

  for (const metric of metrics) {
    const existing = byTheme.get(metric.theme);

    if (!existing) {
      byTheme.set(metric.theme, metric);
      continue;
    }

    byTheme.set(metric.theme, {
      theme: metric.theme,
      frequencyCount: existing.frequencyCount + metric.frequencyCount,
      sourceCount: new Set([...existing.sourceUrls, ...metric.sourceUrls]).size,
      sourceUrls: Array.from(new Set([...existing.sourceUrls, ...metric.sourceUrls]))
    });
  }

  return Array.from(byTheme.values()).sort((a, b) => b.frequencyCount - a.frequencyCount || b.sourceCount - a.sourceCount);
}

function dedupeSourcesByUrl(sources: VeraSource[]) {
  return Array.from(new Map(sources.map((source) => [source.url, source])).values());
}

function cleanLocalReasons(reasons: string[], query = "") {
  const queryCategory = localCategoryForQuery(query);
  const cleaned = reasons
    .map((reason) => normalizeTheme(reason))
    .map((reason) => localEditorialTheme(reason))
    .map((reason) => localReasonChip(reason))
    .filter((reason) => reason && !/^(local source support|reliable performance|recommendation evidence|category match|business evidence)$/i.test(reason))
    .filter((reason) => localReasonFitsQueryCategory(reason, queryCategory, query))
    .map(humanizeTheme);

  return cleaned.length ? Array.from(new Set(cleaned)).slice(0, 6) : ["Popular with locals"];
}

function localReasonFitsQueryCategory(reason: string, category: string, query: string) {
  const normalized = normalizeLocalQueryIntent(`${query} ${reason}`);
  const normalizedReason = normalizeLocalQueryIntent(reason);

  if (category === "coffee" && /\b(excellent cocktails|happy hour|sports bar|live music|late night|date-night spot)\b/.test(normalizedReason)) {
    return /\b(cocktail|bar|espresso martini|drinks?|nightlife)\b/.test(normalized);
  }

  return true;
}

function localReasonChip(reason: string) {
  const normalized = normalizeLocalQueryIntent(reason);

  if (!normalized) return "";
  if (normalized === "great drinks") return "excellent cocktails";
  if (normalized === "good atmosphere") return "great atmosphere";
  if (normalized === "strong food") return "creative menu";
  if (normalized === "frequently recommended" || normalized === "community support") return "popular with locals";
  if (normalized === "expert support") return "strong reviews";
  return reason;
}

function localEditorialTheme(theme: string) {
  const normalized = normalizeLocalQueryIntent(theme);

  if (!normalized) return "";
  if (/\b(cheap|affordable|budget|inexpensive|reasonable|reasonably priced|decent priced|best value|value)\b/.test(normalized)) return "strong value";
  if (/\b(upscale|luxury|expensive|high end|fancy|special occasion)\b/.test(normalized)) return "upscale";
  if (/\b(romantic|date night|date-night|intimate|candlelit)\b/.test(normalized)) return "date-night spot";
  if (/\b(casual|laid back|relaxed)\b/.test(normalized)) return "casual";
  if (/\b(cozy|cosy)\b/.test(normalized)) return "cozy atmosphere";
  if (/\b(lively|energetic|vibrant)\b/.test(normalized)) return "lively atmosphere";
  if (/\b(quiet|conversation|low key|calm)\b/.test(normalized)) return "good for conversation";
  if (/\brooftop|roof deck\b/.test(normalized)) return "rooftop";
  if (/\b(waterfront|water view|on the water|riverfront|oceanfront)\b/.test(normalized)) return "waterfront";
  if (/\b(outdoor seating|outdoor|patio|terrace|garden)\b/.test(normalized)) return "outdoor seating";
  if (/\blive music|jazz|band\b/.test(normalized)) return "live music";
  if (/\bsports bar|watch the game|game day\b/.test(normalized)) return "sports bar";
  if (/\bfamily friendly|kid friendly|good for kids|families\b/.test(normalized)) return "family friendly";
  if (/\bdog friendly|pet friendly|dogs welcome\b/.test(normalized)) return "dog friendly";
  if (/\blate night|open late|late-night\b/.test(normalized)) return "late night";
  if (/\bhappy hour|drink specials?\b/.test(normalized)) return "happy hour";
  if (/\bhealthy|lighter|vegetarian|vegan|organic\b/.test(normalized)) return "healthy options";
  if (/\b(espresso martini|cocktail|drinks?|bar menu|aperitivo)\b/.test(normalized)) return "excellent cocktails";
  if (/\b(homemade pasta|fresh pasta|pasta)\b/.test(normalized)) return "homemade pasta";
  if (/\b(italian|trattoria|pizzeria|red sauce)\b/.test(normalized)) return "authentic Italian food";
  if (/\b(seafood|fish|raw bar|oyster)\b/.test(normalized)) return "fresh seafood";
  if (/\b(sushi|japanese|omakase)\b/.test(normalized)) return "sushi";
  if (/\b(pizza|slice|pizzeria)\b/.test(normalized)) return "pizza";
  if (/\b(brunch|breakfast)\b/.test(normalized)) return "brunch";
  if (/\b(coffee|espresso|cafe|roaster)\b/.test(normalized)) return "coffee";
  if (/\b(service|staff|hospitality)\b/.test(normalized)) return "excellent service";
  if (/\b(atmosphere|ambiance|ambience|vibe|date night)\b/.test(normalized)) return "great atmosphere";
  if (/\b(local|locals|neighborhood|community)\b/.test(normalized)) return "popular with locals";
  if (/\b(review|reviews|rating|ratings)\b/.test(normalized)) return "strong reviews";
  return theme;
}

function cleanCachedLocalSummary(summary: string, query = "") {
  if (/live extraction|businesses could.*scored|fallback|signal extraction|pipeline|extracted/i.test(summary)) {
    return "People mention this repeatedly in local recommendations.";
  }

  if (localCategoryForQuery(query) === "coffee" && /\b(excellent cocktails|happy hour|sports bar|live music|late night|date-night spot)\b/i.test(summary)) {
    return "Frequently recommended by local coffee sources.";
  }

  return summary;
}

function cleanCachedLocalExplanation(explanation: string) {
  if (/live extraction|businesses could.*scored|fallback|signal extraction|pipeline|extracted|live retrieval/i.test(explanation)) {
    return "Vera could not confidently separate one clear favorite from several local contenders.";
  }

  return explanation;
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

function classifyFromMetrics(contenders: ContenderMetrics[], sourceCount: number, evidenceType: QueryEvidenceType, query = ""): ConsensusMode {
  if (sourceCount < classificationThresholds.minimumSourceCount || contenders.length === 0) {
    return "no_reliable_consensus";
  }

  if (evidenceType === "local_recommendation") {
    return classifyLocalConsensus(contenders);
  }

  if (evidenceType === "product_recommendation" && isAutomotiveAvoidanceQuery(query)) {
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
  const hasMatureCategoryEvidence = Boolean(top) && matureCategoryEvidenceSupportsConsensus(top, contenders, evidenceType, query, positiveSourceCount);
  const hasAutomotiveCategoryLevelEvidence =
    evidenceType === "product_recommendation" &&
    isAutomotiveQuery(query) &&
    !isAutomotiveAvoidanceQuery(query) &&
    Boolean(top) &&
    contenders.length >= 2 &&
    totalPositiveMentions >= classificationThresholds.minimumTotalPositiveMentions &&
    positiveSourceCount >= 2 &&
    top.sourceCount >= 2 &&
    top.sourceQualityScore >= 2.4;
  const hasDestinationCategoryLevelEvidence =
    evidenceType === "destination_recommendation" &&
    Boolean(top) &&
    contenders.length >= 2 &&
    totalPositiveMentions >= classificationThresholds.minimumTotalPositiveMentions &&
    positiveSourceCount >= 2 &&
    top.sourceCount >= 2 &&
    top.sourceQualityScore >= 2.4;
  const hasProviderBrandCategoryLevelEvidence =
    evidenceType === "provider_or_brand_recommendation" &&
    Boolean(top) &&
    contenders.length >= 2 &&
    totalPositiveMentions >= classificationThresholds.minimumTotalPositiveMentions &&
    positiveSourceCount >= 2 &&
    top.sourceCount >= 2 &&
    top.sourceQualityScore >= 2.4;

  if (
    !hasDominantPlatformEvidence &&
    !hasMatureCategoryEvidence &&
    !hasAutomotiveCategoryLevelEvidence &&
    !hasDestinationCategoryLevelEvidence &&
    !hasProviderBrandCategoryLevelEvidence &&
    (totalPositiveMentions < classificationThresholds.minimumTotalPositiveMentions ||
      positiveSourceCount < classificationThresholds.minimumPositiveSourceCount)
  ) {
    return "no_reliable_consensus";
  }

  const second = contenders[1];

  if (!top) {
    return "no_reliable_consensus";
  }

  const topHasEnoughEvidence =
    hasMatureCategoryEvidence ||
    hasAutomotiveCategoryLevelEvidence ||
    hasDestinationCategoryLevelEvidence ||
    hasProviderBrandCategoryLevelEvidence ||
    (top.positiveMentionCount >= classificationThresholds.minimumTopPositiveMentions && top.sourceCount >= classificationThresholds.minimumTopSourceCount);

  if (!topHasEnoughEvidence) {
    return "split_consensus";
  }

  if (!second) {
    return (hasMatureCategoryEvidence || top.sourceCount >= classificationThresholds.moderateSourceCount) &&
      top.positiveMentionCount >= (hasMatureCategoryEvidence ? 2 : classificationThresholds.minimumTotalPositiveMentions)
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
    top.sourceCount >= (hasMatureCategoryEvidence ? 3 : classificationThresholds.strongSourceCount)
  ) {
    return "strong_consensus";
  }

  if (
    topScore >= classificationThresholds.moderateScore &&
    gap >= classificationThresholds.moderateGapPoints &&
    (top.sourceCount >= classificationThresholds.moderateSourceCount || hasMatureCategoryEvidence)
  ) {
    return "moderate_consensus";
  }

  return "split_consensus";
}

function matureCategoryEvidenceSupportsConsensus(
  top: ContenderMetrics,
  contenders: ContenderMetrics[],
  evidenceType: QueryEvidenceType,
  query: string,
  positiveSourceCount: number
) {
  if (evidenceType !== "software_tool" && evidenceType !== "product_recommendation") {
    return false;
  }

  if (evidenceType === "product_recommendation" && isBroadExploratoryQuery(query)) {
    return false;
  }

  if (top.sourceCount < 2 || top.positiveMentionCount < 2 || positiveSourceCount < 2) {
    return false;
  }

  if (top.sourceDiversityScore < 2.4 || top.sourceQualityScore < 2.4) {
    return false;
  }

  const topScore = consensusScore(top);
  const second = contenders[1];
  const weightedGap = second ? top.netWeightedScore - second.netWeightedScore : top.netWeightedScore;

  return topScore >= 60 && weightedGap >= 3;
}

function classifyLocalConsensus(contenders: ContenderMetrics[]): ConsensusMode {
  const top = contenders[0];
  const second = contenders[1];

  if (contenders.length < 3) {
    return "no_reliable_consensus";
  }

  if (!top || top.positiveMentionCount === 0) {
    return "no_reliable_consensus";
  }

  if (!second) {
    return top.sourceCount >= 3 ? "moderate_consensus" : "split_consensus";
  }

  const scoreGap = consensusScore(top) - consensusScore(second);
  const weightedGap = top.netWeightedScore - second.netWeightedScore;
  const overwhelming =
    top.sourceCount >= 5 &&
    top.sourceDiversityScore >= 3 &&
    top.positiveMentionCount >= second.positiveMentionCount + 3 &&
    scoreGap >= 24 &&
    weightedGap >= 10;
  const significantlyStronger =
    top.sourceCount >= 3 &&
    top.sourceDiversityScore >= 2.4 &&
    top.positiveMentionCount >= second.positiveMentionCount + 2 &&
    scoreGap >= 18 &&
    weightedGap >= 14;

  return overwhelming || significantlyStronger ? "strong_consensus" : "split_consensus";
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

function consensusHeadline(mode: ConsensusMode, contenders: ContenderMetrics[], intent: ConsensusResponse["intent"], evidenceType?: QueryEvidenceType, query = "") {
  const winner = contenders[0];

  if (evidenceType === "local_recommendation" && mode === "no_reliable_consensus") {
    return "No reliable local consensus found.";
  }

  if (evidenceType === "local_recommendation" && mode === "split_consensus") {
    return `Top 5 local consensus for ${decisionSubject(intent)}.`;
  }

  if (evidenceType === "product_recommendation" && mode === "no_reliable_consensus" && isAutomotiveAvoidanceQuery(query)) {
    return "No reliable avoidance consensus found.";
  }

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

function consensusExplanation(mode: ConsensusMode, contenders: ContenderMetrics[], intent: ConsensusResponse["intent"], evidenceType?: QueryEvidenceType, query = "") {
  const winner = contenders[0];
  const second = contenders[1];
  const criteria = intent.optimizeFor.slice(0, 4);

  if (evidenceType === "local_recommendation" && mode === "no_reliable_consensus") {
    return "Vera did not find enough real local businesses with matching location and category evidence to rank this confidently.";
  }

  if (evidenceType === "local_recommendation" && mode === "split_consensus") {
    return "Several local businesses have credible support. Vera ranks the top options by source support, review-platform evidence, local coverage, and community mentions without forcing a single winner.";
  }

  if (evidenceType === "product_recommendation" && mode === "no_reliable_consensus" && isAutomotiveAvoidanceQuery(query)) {
    return "Vera found automotive sources, but not enough consistent model-specific avoidance evidence to say which vehicle is most widely criticized.";
  }

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

function summaryForContender(contender: ContenderMetrics, query = "") {
  const themes = contender.themeCounts.slice(0, 3).map((theme) => humanizeTheme(theme.theme).toLowerCase());

  if (contender.localRanking) {
    return localSummaryForContender(contender, query);
  }

  if (themes.length) {
    return `${contender.name} is supported most often for ${criteriaPhrase(themes)}.`;
  }

  return `${contender.name} appears repeatedly in the recommendation evidence.`;
}

function localSummaryForContender(contender: ContenderMetrics, query = "") {
  const queryCategory = localCategoryForQuery(query);
  const themes = contender.themeCounts
    .map((theme) => localSummaryThemePhrase(theme.theme))
    .filter((theme) => theme && !/^(local source support|recurring recommendation|recommendation)$/.test(theme))
    .filter((theme) => localReasonFitsQueryCategory(theme, queryCategory, query))
    .filter((theme, index, all) => all.indexOf(theme) === index)
    .slice(0, 2);

  if (themes.length >= 2) {
    return `People consistently recommend it for ${criteriaPhrase(themes)}.`;
  }

  if (themes.length === 1) {
    return `Frequently praised for ${themes[0]}.`;
  }

  if (contender.sourceCount >= 3) {
    return "Appears repeatedly in local recommendations.";
  }

  return "Frequently recommended, though opinions are mixed.";
}

function localSummaryThemePhrase(theme: string) {
  const editorialTheme = localEditorialTheme(theme);
  const phrase = editorialTheme === theme ? humanizeTheme(editorialTheme).toLowerCase() : editorialTheme;

  return phrase.replace(/\bitalian\b/g, "Italian").replace(/\bnyc\b/g, "NYC");
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
  if (value.includes("hacker news") || value.includes("news.ycombinator") || value.includes("product hunt") || value.includes("forum") || value.includes("community")) return "forum";
  if (
    value.includes("tripadvisor") ||
    value.includes("booking") ||
    value.includes("expedia") ||
    value.includes("kayak") ||
    value.includes("yelp") ||
    value.includes("google maps") ||
    value.includes("maps.google") ||
    value.includes("opentable") ||
    value.includes("resy") ||
    value.includes("hotels.com") ||
    value.includes("healthgrades") ||
    value.includes("zocdoc") ||
    value.includes("angi") ||
    value.includes("homeadvisor") ||
    value.includes("g2") ||
    value.includes("capterra") ||
    value.includes("getapp") ||
    value.includes("software advice") ||
    value.includes("reviewed")
  ) {
    return "review_site";
  }
  if (
    value.includes("infatuation") ||
    value.includes("thevendry") ||
    value.includes("eater") ||
    value.includes("timeout") ||
    value.includes("conde") ||
    value.includes("cntraveler") ||
    value.includes("thrillist") ||
    value.includes("travel + leisure") ||
    value.includes("travelandleisure") ||
    value.includes("golf digest") ||
    value.includes("golfweek") ||
    value.includes("tourism") ||
    value.includes("local guide") ||
    value.includes("zapier")
  )
    return "editorial";
  if (
    value.includes("forbes") ||
    value.includes("wirecutter") ||
    value.includes("consumer reports") ||
    value.includes("usnews") ||
    value.includes("gartner") ||
    value.includes("pcmag") ||
    value.includes("techradar") ||
    value.includes("zdnet") ||
    value.includes("rtings") ||
    value.includes("tom's guide") ||
    value.includes("toms guide") ||
    value.includes("consumer reports") ||
    value.includes("the verge") ||
    value.includes("notebookcheck") ||
    value.includes("soundguys") ||
    value.includes("outdoorgearlab") ||
    value.includes("babygearlab") ||
    value.includes("cnet") ||
    value.includes("dpreview") ||
    value.includes("car and driver") ||
    value.includes("caranddriver") ||
    value.includes("edmunds") ||
    value.includes("kelley blue book") ||
    value.includes("kbb") ||
    value.includes("motortrend") ||
    value.includes("motor trend") ||
    value.includes("cars.com") ||
    value.includes("cars com") ||
    value.includes("us news cars") ||
    value.includes("u.s. news cars") ||
    value.includes("iihs") ||
    value.includes("nhtsa") ||
    value.includes("j.d. power") ||
    value.includes("jd power")
  ) {
    return "professional_review";
  }
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

  if (evidenceType === "product_recommendation" || evidenceType === "software_tool" || evidenceType === "provider_or_brand_recommendation") {
    if (type === "professional_review") return 2.2;
    if (type === "editorial") return 1.8;
    if (type === "review_site") return 1.4;
    if (type === "reddit" || type === "forum") return 1;
    if (type === "local_guide") return 1;
    if (type === "official") return 0.5;
    return 1;
  }

  if (evidenceType === "destination_recommendation") {
    if (type === "editorial" || type === "local_guide") return 2.1;
    if (type === "review_site") return 1.7;
    if (type === "professional_review") return 1.8;
    if (type === "official") return 1.5;
    if (type === "reddit" || type === "forum") return 1.1;
    return 1;
  }

  if (type === "review_site") return 1.7;
  if (type === "reddit" || type === "forum") return 1.1;
  if (type === "editorial" || type === "local_guide" || type === "professional_review") return 2.1;
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
  const compact = value.trim().replace(/\s+/g, " ");
  return canonicalProductName(compact) ?? compact;
}

function canonicalProductName(value: string) {
  const normalized = normalizeQuery(value).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  for (const category of productAliasCategories()) {
    for (const leader of category.leaders) {
      if (contenderMatchesPlatform(normalized, leader.aliases)) {
        return leader.label;
      }
    }
  }

  return null;
}

function productAliasCategories() {
  return [
    productCategory("headphones", ["Sony WH-1000XM5", "Bose QuietComfort Ultra", "Apple AirPods Max", "Sennheiser Momentum 4"]),
    productCategory("router", ["Eero Pro 6E", "Netgear Orbi", "TP-Link Deco", "Asus ZenWiFi"]),
    productCategory("running shoes", ["Brooks Ghost", "Nike Pegasus", "Asics Gel-Nimbus", "Hoka Clifton"]),
    productCategory("carry-on luggage", ["Away Carry-On", "Travelpro Platinum Elite", "Monos Carry-On"]),
    productCategory("espresso machine", ["Breville Bambino Plus", "Breville Barista Express", "De'Longhi Dedica"]),
    productCategory("office chair", ["Herman Miller Aeron", "Steelcase Leap", "Steelcase Gesture", "Haworth Fern"]),
    productCategory("air purifier", ["Coway Airmega AP-1512HH", "Blueair Blue Pure", "Levoit Core"]),
    productCategory("mouse", ["Logitech MX Master 3S", "Razer Basilisk V3", "Logitech G Pro X Superlight"]),
    productCategory("external ssd", ["Samsung T7 Shield", "SanDisk Extreme Portable SSD", "Crucial X9 Pro"]),
    productCategory("family vehicle", ["Compact SUV", "Midsize SUV", "Minivan", "Toyota RAV4", "Honda CR-V", "Subaru Forester"]),
    productCategory("midsize suv", ["Toyota Highlander", "Kia Telluride", "Hyundai Palisade", "Honda Pilot", "Mazda CX-90"]),
    productCategory("minivan", ["Toyota Sienna", "Honda Odyssey", "Kia Carnival", "Chrysler Pacifica"]),
    productCategory("midsize sedan", ["Toyota Camry", "Honda Accord", "Hyundai Sonata", "Kia K5", "Subaru Legacy"])
  ];
}

function normalizeTheme(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";
  if (/\b(product leader support|known product leader|category leader|broad category recognition)\b/.test(normalized)) return "expert support";
  if (/\b(recovered local business evidence|local source support|appears in local source results)\b/.test(normalized)) return "local source support";
  if (/\b(local favorite|locals favorite|neighborhood favorite|neighbourhood favorite|popular with locals)\b/.test(normalized)) return "neighborhood favorite";
  if (/\b(attentive service|excellent service|friendly staff|hospitality)\b/.test(normalized)) return "excellent service";
  if (/\b(strong reviews|highly rated|good reviews|great reviews|review sites)\b/.test(normalized)) return "strong reviews";
  if (/\b(homemade pasta|fresh pasta|pasta|trattoria|osteria|ristorante|red sauce|gnocchi|ravioli|lasagna)\b/.test(normalized)) return "homemade pasta";
  if (/\b(authentic italian|italian cuisine|italian food)\b/.test(normalized)) return "authentic Italian";
  if (/\b(family owned|family run|family-run)\b/.test(normalized)) return "family owned";
  if (/\b(worth the drive|destination spot)\b/.test(normalized)) return "worth the drive";
  if (/\b(beginner|beginners|starter|entry level|entry-level|new users|new players)\b/.test(normalized)) return "popular with beginners";
  if (/\b(easy to learn|simple rules|accessible|approachable|low learning curve|quick to learn)\b/.test(normalized)) return "easy to learn";
  if (/\b(family|families|kids|children|all ages|family friendly)\b/.test(normalized)) return "great for families";
  if (/\b(two players|two player|2 players|2 player|couples|duel)\b/.test(normalized)) return "good for two players";
  if (/\b(strategy|strategic|depth|deep|tactical|replayability|replayable)\b/.test(normalized)) return "strong strategy depth";
  if (/\b(party|group|groups|social|crowd|friends)\b/.test(normalized)) return "great for groups";
  if (/\b(value|budget|affordable|price|inexpensive|cheap)\b/.test(normalized)) return "strong value";
  if (/\b(reliable|performance|speed|coverage|consistent|stability|stable)\b/.test(normalized)) return "reliable performance";
  if (/\b(atmosphere|ambiance|ambience|vibe|romantic|cozy|beautiful|setting|decor|energy)\b/.test(normalized)) return "good atmosphere";
  if (/\b(conversation|quiet|noise|date|first date|talk)\b/.test(normalized)) return "good for conversation";
  if (/\b(cocktail|drink|martini|bar program|beverage)\b/.test(normalized)) return "great drinks";
  if (/\b(food|menu|dinner|brunch|pizza|sushi|ramen|taco|cuisine)\b/.test(normalized)) return "strong food";
  if (/\b(popular|widely recommended|most recommended|frequently mentioned|often recommended|recurring)\b/.test(normalized)) return "frequently recommended";
  if (/\b(expert|editorial|review|reviewer|guide|wirecutter|rtings|pcmag|eater|infatuation)\b/.test(normalized)) return "expert support";
  if (/\b(community|reddit|forum|owners|users|locals)\b/.test(normalized)) return "community support";

  if (normalized.split(/\s+/).length > 4) return "";
  if (/\b(?:source|mentions?|says|according|article|reviewed|played so far|there are|it is|they are)\b/.test(normalized)) return "";

  return normalized;
}

function humanizeTheme(value: string) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
