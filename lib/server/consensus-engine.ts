import type { QueryEvidenceType, QueryIntent } from "@/lib/utils";
import type { ConsensusMode, ContenderMetrics, SourceSignal, VeraSource } from "@/lib/types";
import { canonicalizeQuery, inferQueryEvidenceType, inferQueryIntent, normalizeQuery } from "@/lib/utils";

export type DiscardReasonCode =
  | "duplicate_url"
  | "duplicate_domain"
  | "weak_relevance"
  | "blocked_domain"
  | "low_quality_source"
  | "geography_mismatch"
  | "source_balance_removal"
  | "invalid_url"
  | "unsupported_content"
  | "wrong_entity_type"
  | "wrong_geography"
  | "outside_constraint"
  | "insufficient_evidence"
  | "duplicate_entity"
  | "generic_entity"
  | "category_mismatch"
  | "software_subtype_mismatch"
  | "software_missing_category_evidence"
  | "software_opinion_alternative_not_scoped"
  | "software_missing_positive_evidence"
  | "invalid_business"
  | "stale_or_unavailable"
  | "final_cleanup_removal"
  | "exact_duplicate"
  | "normalized_duplicate"
  | "alias_merge"
  | "parent_entity_mismatch"
  | "child_entity_mismatch"
  | "wrong_entity_granularity"
  | "canonicalized_entity"
  | "ambiguous_relationship"
  | "unknown";

export type DiscardReason = {
  stage: string;
  code: DiscardReasonCode;
  message?: string;
  contenderName?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

export type StageResult<TOutput = unknown> = {
  stage: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  output?: TOutput;
  error?: string;
  discards?: DiscardReason[];
};

export type ConsensusTask = {
  id: string;
  query: string;
  normalizedQuery: string;
  canonicalQuery: string;
  evidenceType: QueryEvidenceType;
  queryIntent: QueryIntent;
  actorId?: string;
  createdAt: string;
};

export type TraceSource = Pick<VeraSource, "title" | "url" | "domain" | "queryVariant" | "relevanceScore" | "supportingContender">;

export type SourceFilterDiagnostic = {
  source?: TraceSource;
  url?: string;
  domain?: string;
  queryVariant?: string;
  retained: boolean;
  reasonCode?: DiscardReasonCode;
  stage:
    | "tavily_result_mapping"
    | "url_dedupe"
    | "source_filtering"
    | "domain_balancing"
    | "source_limit"
    | "consensus_source_selection"
    | "local_enrichment";
  message?: string;
  metadata?: Record<string, unknown>;
};

export type TraceEntity = {
  name: string;
  sourceUrl?: string;
  sourceTitle?: string;
  status?: "accepted" | "rejected" | "downgraded" | "verified" | "entered_aggregation" | "finalist";
  discardReason?: DiscardReason;
  metadata?: Record<string, unknown>;
};

export type EntityValidationDiagnostic = {
  status: "accepted" | "rejected" | "downgraded" | "merged";
  reasonCode: DiscardReasonCode;
  canonicalName?: string;
  originalName: string;
  validator: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

export type EntityResolutionDiagnostic = {
  originalName: string;
  canonicalName: string;
  relationshipType:
    | "exact_duplicate"
    | "normalized_duplicate"
    | "alias"
    | "abbreviation"
    | "canonical_variant"
    | "parent_brand_child_product"
    | "company_service"
    | "platform_product"
    | "ambiguous"
    | "none";
  action: "merged" | "accepted" | "rejected" | "downgraded";
  reasonCode: DiscardReasonCode;
  requestedEntityType: string;
  evidenceTransferred: boolean;
  sourceUrls: string[];
  metadata?: Record<string, unknown>;
};

export type FinalCleanupDiagnostic = {
  contenderName: string;
  stage:
    | "generic_contender_cleanup"
    | "entity_type_cleanup"
    | "geography_cleanup"
    | "category_mismatch_cleanup"
    | "insufficient_evidence_cleanup"
    | "negative_evidence_cleanup"
    | "final_result_cleanup";
  reasonCode: DiscardReasonCode;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type TraceRetrievalPlan = {
  query: string;
  normalizedQuery: string;
  canonicalQuery: string;
  evidenceType: QueryEvidenceType;
  queryIntent: QueryIntent;
  cacheVersion: number;
  strategy: string;
  unavailable?: string[];
};

export type TraceCacheState = {
  status: "not_checked" | "hit" | "miss" | "stale_hit" | "write_completed" | "error" | "bypassed";
  cacheVersion?: number | null;
  searchId?: string;
  elapsedMs?: number;
  cacheHitType?: string;
  error?: string;
};

export type TraceLatency = {
  cacheMs?: number;
  tavilyMs?: number;
  filteringMs?: number;
  openAiMs?: number;
  cacheWriteMs?: number;
  totalMs?: number;
};

export type TraceCallCounts = {
  supabaseReads: number;
  tavilyCalls: number;
  openAiCalls: number;
  placesApiCalls: number;
  placesCacheHits: number;
  placesValidationAttempts: number;
  placesValidationsSucceeded: number;
  placesValidationsRejected: number;
  supabaseWrites: number;
  tavilyCallReasons: unknown[];
  openAiCallReasons: unknown[];
  finalVerifiedPlacesContenders: string[];
};

export type TraceClassification = {
  mode: ConsensusMode;
  resultNames: string[];
  resultCount: number;
  rationale?: string;
  source?: string;
  decisionPath?: ClassificationDecisionTrace;
};

export type ClassificationDecisionTrace = {
  classifier: "classifyFromMetrics" | "classifyLocalConsensus" | "consensus-classification-helper" | "fallback" | "unknown";
  selectedPath: string;
  finalReasonCode: string;
  finalClassification: ConsensusMode;
  contenderCount: number;
  sourceCount: number;
  totalPositiveMentions?: number;
  positiveSourceCount?: number;
  sourceDiversity?: number;
  leaderMargin?: {
    scoreGap?: number | null;
    weightedGap?: number | null;
  };
  thresholds?: Record<string, number>;
  evidenceCounts?: Record<string, number | boolean | string | null>;
  diagnostics?: Record<string, unknown>;
};

export type TraceContenderScore = {
  name: string;
  netWeightedScore?: number;
  weightedPositiveScore?: number;
  weightedNegativeScore?: number;
  sourceCount?: number;
  positiveMentionCount?: number;
  negativeMentionCount?: number;
  localFinalScore?: number;
  localBaseScore?: number;
  metrics?: ContenderMetrics;
};

export type ConsensusTrace = {
  id: string;
  taskId: string;
  enabled: boolean;
  task: ConsensusTask;
  startedAt: string;
  completedAt?: string;
  stages: StageResult[];
  retrievalPlan?: TraceRetrievalPlan;
  retrievedSourceCount?: number;
  retainedSources: TraceSource[];
  discardedSources: TraceSource[];
  sourceDiagnostics: SourceFilterDiagnostic[];
  extractedSignals: SourceSignal[];
  candidateEntities: TraceEntity[];
  validationOutcomes: TraceEntity[];
  entityValidationDiagnostics: EntityValidationDiagnostic[];
  entityResolutionDiagnostics: EntityResolutionDiagnostic[];
  acceptedEntities: TraceEntity[];
  rejectedEntities: TraceEntity[];
  downgradedEntities: TraceEntity[];
  discards: DiscardReason[];
  aggregationEntrants: TraceEntity[];
  finalCleanupRemovals: DiscardReason[];
  cleanupDiagnostics: FinalCleanupDiagnostic[];
  contenderScores: TraceContenderScore[];
  classification?: TraceClassification;
  cache: TraceCacheState;
  latency: TraceLatency;
  callCounts?: TraceCallCounts;
  unavailable: string[];
};

export type RunConsensusEngineOptions<TResult> = {
  actorId?: string;
  collectTrace?: boolean;
  onTrace?: (trace: ConsensusTrace) => void | Promise<void>;
  execute: (context: { task: ConsensusTask; trace: ConsensusTrace }) => Promise<TResult>;
};

type TraceCollector = (trace: ConsensusTrace) => void | Promise<void>;

const traceCollectors: TraceCollector[] = [];

export async function runConsensusEngine<TResult>(query: string, options: RunConsensusEngineOptions<TResult>): Promise<TResult> {
  const task = buildConsensusTask(query, options.actorId);
  const trace = buildConsensusTrace(task, Boolean(options.collectTrace || options.onTrace || traceCollectors.length));
  const startedAt = Date.now();
  const routeStage: StageResult = {
    stage: "existing_route_pipeline",
    status: "running",
    startedAt: new Date(startedAt).toISOString()
  };

  trace.stages.push(routeStage);

  try {
    const result = await options.execute({ task, trace });
    const completedAt = Date.now();
    routeStage.status = "completed";
    routeStage.completedAt = new Date(completedAt).toISOString();
    routeStage.durationMs = completedAt - startedAt;
    trace.completedAt = routeStage.completedAt;
    trace.latency.totalMs ??= routeStage.durationMs;
    await publishTrace(trace, options.onTrace);
    return result;
  } catch (error) {
    const completedAt = Date.now();
    routeStage.status = "failed";
    routeStage.completedAt = new Date(completedAt).toISOString();
    routeStage.durationMs = completedAt - startedAt;
    routeStage.error = error instanceof Error ? error.message : String(error);
    trace.completedAt = routeStage.completedAt;
    trace.latency.totalMs ??= routeStage.durationMs;
    await publishTrace(trace, options.onTrace);
    throw error;
  }
}

export async function collectConsensusTraceDuring<TResult>(operation: () => Promise<TResult>): Promise<{ result: TResult; trace?: ConsensusTrace }> {
  let trace: ConsensusTrace | undefined;
  const collector: TraceCollector = (completedTrace) => {
    trace = completedTrace;
  };

  traceCollectors.push(collector);

  try {
    const result = await operation();
    return { result, trace };
  } finally {
    const index = traceCollectors.lastIndexOf(collector);
    if (index >= 0) {
      traceCollectors.splice(index, 1);
    }
  }
}

export function recordConsensusStage<TOutput>(trace: ConsensusTrace | undefined, stage: StageResult<TOutput>) {
  if (!trace?.enabled) return;
  trace.stages.push(stage);
}

export function updateConsensusTrace(trace: ConsensusTrace | undefined, updates: Partial<Omit<ConsensusTrace, "id" | "taskId" | "enabled" | "task" | "startedAt" | "stages">>) {
  if (!trace?.enabled) return;

  if (updates.retrievalPlan) trace.retrievalPlan = updates.retrievalPlan;
  if (updates.retrievedSourceCount !== undefined) trace.retrievedSourceCount = updates.retrievedSourceCount;
  if (updates.retainedSources) trace.retainedSources = updates.retainedSources;
  if (updates.discardedSources) trace.discardedSources = updates.discardedSources;
  if (updates.sourceDiagnostics) trace.sourceDiagnostics = updates.sourceDiagnostics;
  if (updates.extractedSignals) trace.extractedSignals = updates.extractedSignals;
  if (updates.candidateEntities) trace.candidateEntities = updates.candidateEntities;
  if (updates.validationOutcomes) trace.validationOutcomes = updates.validationOutcomes;
  if (updates.entityValidationDiagnostics) trace.entityValidationDiagnostics = updates.entityValidationDiagnostics;
  if (updates.entityResolutionDiagnostics) trace.entityResolutionDiagnostics = updates.entityResolutionDiagnostics;
  if (updates.acceptedEntities) trace.acceptedEntities = updates.acceptedEntities;
  if (updates.rejectedEntities) trace.rejectedEntities = updates.rejectedEntities;
  if (updates.downgradedEntities) trace.downgradedEntities = updates.downgradedEntities;
  if (updates.discards) trace.discards = updates.discards;
  if (updates.aggregationEntrants) trace.aggregationEntrants = updates.aggregationEntrants;
  if (updates.finalCleanupRemovals) trace.finalCleanupRemovals = updates.finalCleanupRemovals;
  if (updates.cleanupDiagnostics) trace.cleanupDiagnostics = updates.cleanupDiagnostics;
  if (updates.contenderScores) trace.contenderScores = updates.contenderScores;
  if (updates.classification) trace.classification = updates.classification;
  if (updates.cache) trace.cache = { ...trace.cache, ...updates.cache };
  if (updates.latency) trace.latency = { ...trace.latency, ...updates.latency };
  if (updates.callCounts) trace.callCounts = updates.callCounts;
  if (updates.unavailable) {
    for (const gap of updates.unavailable) {
      if (!trace.unavailable.includes(gap)) trace.unavailable.push(gap);
    }
  }
}

export function addConsensusDiscard(trace: ConsensusTrace | undefined, discard: DiscardReason) {
  if (!trace?.enabled) return;
  trace.discards.push(discard);
}

export function mapDiscardReasonCode(reason: string | undefined): DiscardReasonCode {
  const normalized = (reason ?? "").toLowerCase();

  if (/duplicate.*url|url.*duplicate|canonical/.test(normalized)) return "duplicate_url";
  if (/duplicate.*domain|domain.*duplicate/.test(normalized)) return "duplicate_domain";
  if (/weak.*relevance|relevance|snippet|too_little|thin/.test(normalized)) return "weak_relevance";
  if (/blocked.*domain|pinterest|facebook|instagram|tiktok/.test(normalized)) return "blocked_domain";
  if (/low.*quality|coupon|promo|sale/.test(normalized)) return "low_quality_source";
  if (/geography_mismatch|geograph|location|outside|long_island|borough|nearby/.test(normalized)) return "geography_mismatch";
  if (/source_balance|domain_balanc|source_limit|limit/.test(normalized)) return "source_balance_removal";
  if (/invalid.*url|missing.*url|url_missing/.test(normalized)) return "invalid_url";
  if (/unsupported.*content|non_html|content_type/.test(normalized)) return "unsupported_content";
  if (/duplicate|dedupe|collapsed/.test(normalized)) return "duplicate_entity";
  if (/generic|location_as_contender|city|borough|neighborhood/.test(normalized)) return "generic_entity";
  if (/geograph|location|outside|long_island|borough|nearby/.test(normalized)) return "wrong_geography";
  if (/constraint|intent/.test(normalized)) return "outside_constraint";
  if (/category|cuisine|subtype|type/.test(normalized)) return "category_mismatch";
  if (/business|place|invalid|non_business/.test(normalized)) return "invalid_business";
  if (/stale|unavailable|timeout|failed/.test(normalized)) return "stale_or_unavailable";
  if (/cleanup|ui|final/.test(normalized)) return "final_cleanup_removal";
  if (/evidence|confidence|weak|low|thin|insufficient/.test(normalized)) return "insufficient_evidence";

  return "unknown";
}

function buildConsensusTask(query: string, actorId?: string): ConsensusTask {
  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    evidenceType: inferQueryEvidenceType(query),
    queryIntent: inferQueryIntent(query),
    actorId,
    createdAt: new Date().toISOString()
  };
}

async function publishTrace(trace: ConsensusTrace, optionCollector?: TraceCollector) {
  if (!trace.enabled) return;

  if (optionCollector) {
    await optionCollector(trace);
  }

  for (const collector of traceCollectors) {
    await collector(trace);
  }
}

function buildConsensusTrace(task: ConsensusTask, enabled: boolean): ConsensusTrace {
  return {
    id: crypto.randomUUID(),
    taskId: task.id,
    enabled,
    task,
    startedAt: task.createdAt,
    stages: [],
    retainedSources: [],
    discardedSources: [],
    sourceDiagnostics: [],
    extractedSignals: [],
    candidateEntities: [],
    validationOutcomes: [],
    entityValidationDiagnostics: [],
    entityResolutionDiagnostics: [],
    acceptedEntities: [],
    rejectedEntities: [],
    downgradedEntities: [],
    discards: [],
    aggregationEntrants: [],
    finalCleanupRemovals: [],
    cleanupDiagnostics: [],
    contenderScores: [],
    cache: {
      status: "not_checked"
    },
    latency: {},
    unavailable: []
  };
}
