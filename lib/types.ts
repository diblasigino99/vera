import type { QueryEvidenceType } from "@/lib/utils";

export const NO_RELIABLE_CONSENSUS_TITLE = "No Clear Consensus";
export const NO_RELIABLE_CONSENSUS_BODY =
  "We searched available editorial, community, and review sources but could not identify recurring recommendations.\n\nRather than manufacture an answer, Vera cannot confidently recommend a contender.";

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
  | "school"
  | "school_district"
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
  placesPlaceId?: string;
  placesBusinessStatus?: string;
};

export type ContenderActionType = "official_product" | "amazon" | "visit_website" | "website" | "view_website" | "maps";

export type ContenderAction = {
  type: ContenderActionType;
  label: "View Product" | "Amazon" | "Visit Website" | "Website" | "View Website" | "View on Maps";
  url: string;
  domain: string;
  source:
    | "official_source"
    | "verified_local_source"
    | "trusted_retailer_source"
    | "official_destination_resolution"
    | "amazon_destination_resolution"
    | "google_places";
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
  placesPlaceId?: string;
  action?: ContenderAction;
  actions?: ContenderAction[];
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

export type FactualAnswerResponse = {
  type: "factual_answer";
  id: string;
  query: string;
  normalizedQuery: string;
  canonicalQuery?: string;
  isSensitive: boolean;
  personalityLine?: string;
  boundaryMessage: string;
  heading?: string;
  summary?: string;
  items?: string[];
  urgentGuidance?: string;
  urgency?: "none" | "prompt_care" | "emergency";
  presentation?: "short_fact" | "explanatory_fact" | "sensitive_fact";
  answer: string;
  sources: VeraSource[];
  createdAt: string;
  generated_at?: string;
  cached: false;
  factualAnswerVerified: boolean;
  unsupportedReason?: string;
};

export type SearchResponse = ConsensusResponse | FactualAnswerResponse;

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
