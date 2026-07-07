import type { QueryEvidenceType } from "@/lib/utils";

export type IntentProfile = {
  category: string;
  location?: string;
  constraints: string[];
  optimizeFor: string[];
  avoid: string[];
};

export type VeraSource = {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  enrichedText?: string;
  enrichedBodyText?: string;
  enriched?: boolean;
  enrichmentFailed?: boolean;
  queryVariant?: string;
  canonicalUrl?: string;
  supportingContender?: string;
  relevanceScore?: number;
};

export type VeraSourceType =
  | "reddit"
  | "forum"
  | "review_site"
  | "editorial"
  | "local_guide"
  | "professional_review"
  | "official"
  | "other";

export type VeraEntityCategory =
  | "restaurant"
  | "bar"
  | "cafe"
  | "hotel"
  | "liquor_store"
  | "grocery_store"
  | "retail"
  | "attraction"
  | "golf_course"
  | "software"
  | "product"
  | "service"
  | "other";

export type SourceSignal = {
  sourceUrl: string;
  sourceTitle: string;
  domain: string;
  sourceType: VeraSourceType;
  sourceWeight: number;
  sourceQuality: "low" | "medium" | "high";
  sourceQualityWeight: number;
  queryVariant?: string;
  contenderName: string;
  sentiment: "positive" | "neutral" | "negative";
  mentionStrength: "weak" | "moderate" | "strong";
  positiveMention?: string;
  negativeMention?: string;
  extractedReason: string;
  themes: string[];
  verifiedAddress?: string;
  placesTypes?: string[];
  placesCategoryConfidence?: number;
  placesLocationConfidence?: number;
  placesVerified?: boolean;
};

export type ThemeMetric = {
  theme: string;
  frequencyCount: number;
  sourceCount: number;
  sourceUrls: string[];
};

export type ContenderMetrics = {
  name: string;
  contenderCategory: VeraEntityCategory;
  categoryConfidence: "low" | "medium" | "high";
  mentionCount: number;
  positiveMentionCount: number;
  negativeMentionCount: number;
  sourceCount: number;
  sourceDiversityScore: number;
  sourceQualityScore: number;
  strongMentionCount: number;
  editorialSupportCount: number;
  communitySupportCount: number;
  weightedPositiveScore: number;
  weightedNegativeScore: number;
  netWeightedScore: number;
  averageRating?: number;
  confidence?: "low" | "medium" | "high";
  localRanking?: {
    baseScore: number;
    finalScore: number;
    locationMatchScore: number;
    geographicPrecision?: {
      tier: string;
      score: number;
    };
    categoryMatchScore: number;
    sourceAuthorityScore: number;
    sourceAgreementScore: number;
    crossSourceAgreementCount: number;
    mentionFrequencyScore: number;
    extractionConfidence: number;
    extractionConfidenceScore: number;
    sourceSpecificConfidence: number;
    reviewSourceSignal: number;
    editorialMentionBoost?: number;
    editorialContextScore?: number;
    positionScore?: number;
    bodyMatchScore?: number;
    candidateConfidenceScore?: number;
    contextQualityScore?: number;
    wrongCategoryPenalty?: number;
    weakSingleSourcePenalty: number;
    urlOnlyPenalty: number;
    sourceDomains: string[];
  };
  sourceTypes: VeraSourceType[];
  themeCounts: ThemeMetric[];
  sourceUrls: string[];
};

export type StructuredConsensus = {
  winner?: string;
  intendedCategory: VeraEntityCategory;
  queryEvidenceType?: QueryEvidenceType;
  evidenceStrategy?: string;
  contenders: ContenderMetrics[];
  mentionCounts: Record<
    string,
    {
      mentionCount: number;
      positiveMentionCount: number;
      negativeMentionCount: number;
      sourceCount: number;
      sourceDiversityScore: number;
      sourceQualityScore: number;
      strongMentionCount: number;
      editorialSupportCount: number;
      communitySupportCount: number;
      weightedPositiveScore: number;
      weightedNegativeScore: number;
      netWeightedScore: number;
      averageRating?: number;
      confidence?: "low" | "medium" | "high";
    }
  >;
  themeCounts: Record<string, ThemeMetric>;
  sourceBreakdown: Record<VeraSourceType, number>;
  confidenceReasoning: string;
  consensusClassification: ConsensusMode;
  signals: SourceSignal[];
  localPlaceExtraction?: {
    candidates: Array<{
      name: string;
      evidenceText: string;
      sourceUrl: string;
      sourceTitle: string;
      extractionSource: "title" | "snippet" | "url" | "metadata";
      confidence: number;
      accepted: boolean;
      rejectionReason?: string;
    }>;
  };
};

export type ConsensusResult = {
  id: string;
  rank: number;
  name: string;
  consensusPercentage?: number;
  summary: string;
  reasons: string[];
  downsides: string[];
  evidence: string[];
  sources: VeraSource[];
  metrics?: ContenderMetrics;
  verifiedAddress?: string;
};

export type ConsensusMode =
  | "clear_consensus"
  | "strong_consensus"
  | "moderate_consensus"
  | "split_consensus"
  | "no_reliable_consensus";

export type ConsensusResponse = {
  id: string;
  query: string;
  normalizedQuery: string;
  canonicalQuery?: string;
  cacheVersion?: number;
  generated_at?: string;
  model?: string;
  mode: ConsensusMode;
  headline: string;
  explanation: string;
  intent: IntentProfile;
  results: ConsensusResult[];
  sources: VeraSource[];
  structuredConsensus?: StructuredConsensus;
  createdAt: string;
  cached: boolean;
};

export type ProfileSnapshot = {
  recentSearches: Array<Pick<ConsensusResponse, "id" | "query" | "headline" | "createdAt">>;
  savedSearches: Array<Pick<ConsensusResponse, "id" | "query" | "headline" | "createdAt">>;
  savedResults: Array<{
    searchId: string;
    resultId: string;
    name: string;
    query: string;
    summary: string;
  }>;
};
