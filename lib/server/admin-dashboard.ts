import { getSupabaseAdmin } from "@/lib/server/supabase";
import { countFeedbackEvents, getRecentFeedbackEvents, type AdminFeedbackEvent } from "@/lib/server/feedback";
import type { ConsensusResponse } from "@/lib/types";

export type AdminSearchEvent = {
  id: string;
  created_at: string;
  search_id: string | null;
  original_query: string | null;
  normalized_query: string | null;
  canonical_query: string | null;
  evidence_type: string | null;
  consensus_mode: string | null;
  cache_hit: boolean | null;
  cache_hit_type: string | null;
  cache_version: number | null;
  total_ms: number | null;
  cache_ms: number | null;
  tavily_ms: number | null;
  openai_ms: number | null;
  cache_write_ms: number | null;
  tavily_calls: number | null;
  openai_calls: number | null;
  places_api_calls: number | null;
  places_cache_hits: number | null;
  places_validation_attempts: number | null;
  error: string | null;
};

export type AdminSearchCacheRow = {
  id: string;
  original_query: string | null;
  normalized_query: string | null;
  canonical_query: string | null;
  result_json: ConsensusResponse | null;
  result: ConsensusResponse | null;
  sources_json: ConsensusResponse["sources"] | null;
  cache_version: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export type AdminEventWithCache = AdminSearchEvent & {
  cacheResult?: ConsensusResponse | null;
  cachedSources?: ConsensusResponse["sources"] | null;
};

export type AdminDashboardData = {
  unavailableReason?: string;
  overview: {
    totalSearches: number;
    searchesToday: number;
    searchesLast7Days: number;
    cacheHitRate: number;
    noConsensusRate: number;
    averageResponseMs: number | null;
    errorCount: number;
  };
  categoryBreakdown: Array<{
    label: string;
    count: number;
  }>;
  recentSearches: AdminEventWithCache[];
  problemSearches: {
    noConsensus: AdminEventWithCache[];
    slow: AdminEventWithCache[];
    errors: AdminEventWithCache[];
    zeroContenders: AdminEventWithCache[];
  };
  feedback: {
    total: number;
    recent: AdminFeedbackEvent[];
  };
  sampleSize: number;
};

const recentLimit = 300;
const breakdownLimit = 5000;

export async function getAdminDashboardData(): Promise<AdminDashboardData> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return emptyDashboardData("Supabase service-role access is not configured for this runtime.");
  }

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [total, today, last7, errors, recentResult, breakdownResult, totalFeedback, recentFeedback] = await Promise.all([
    countSearchEvents(supabase),
    countSearchEvents(supabase, { createdAfter: todayStart.toISOString() }),
    countSearchEvents(supabase, { createdAfter: sevenDaysAgo.toISOString() }),
    countSearchEvents(supabase, { hasError: true }),
    supabase
      .from("search_events")
      .select(searchEventSelect)
      .order("created_at", { ascending: false })
      .limit(recentLimit),
    supabase
      .from("search_events")
      .select("evidence_type, cache_hit_type")
      .order("created_at", { ascending: false })
      .limit(breakdownLimit),
    countFeedbackEvents(),
    getRecentFeedbackEvents(25)
  ]);

  if (recentResult.error) {
    return emptyDashboardData(`Search events could not be loaded: ${recentResult.error.message}`);
  }

  const recentEvents = (recentResult.data ?? []) as unknown as AdminSearchEvent[];
  const recentSearches = await attachCacheResults(recentEvents);
  const successfulTimedEvents = recentEvents.filter((event) => !event.error && typeof event.total_ms === "number");
  const cacheKnownEvents = recentEvents.filter((event) => typeof event.cache_hit === "boolean");
  const noConsensusEvents = recentEvents.filter((event) => event.consensus_mode === "no_reliable_consensus");

  return {
    overview: {
      totalSearches: total,
      searchesToday: today,
      searchesLast7Days: last7,
      cacheHitRate: ratio(
        cacheKnownEvents.filter((event) => event.cache_hit).length,
        cacheKnownEvents.length
      ),
      noConsensusRate: ratio(noConsensusEvents.length, recentEvents.length),
      averageResponseMs: average(successfulTimedEvents.map((event) => event.total_ms ?? 0)),
      errorCount: errors
    },
    categoryBreakdown: buildCategoryBreakdown((breakdownResult.data ?? []) as unknown as Array<Pick<AdminSearchEvent, "evidence_type" | "cache_hit_type">>),
    recentSearches,
    problemSearches: {
      noConsensus: recentSearches.filter((event) => event.consensus_mode === "no_reliable_consensus").slice(0, 25),
      slow: recentSearches.filter((event) => (event.total_ms ?? 0) > 15000).slice(0, 25),
      errors: recentSearches.filter((event) => event.error).slice(0, 25),
      zeroContenders: recentSearches.filter((event) => contenderNamesFromResult(event.cacheResult).length === 0).slice(0, 25)
    },
    feedback: {
      total: totalFeedback,
      recent: recentFeedback
    },
    sampleSize: recentEvents.length
  };

}

type SearchEventCountOptions = {
  createdAfter?: string;
  hasError?: boolean;
};

async function countSearchEvents(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>, options: SearchEventCountOptions = {}) {
  let query = supabase.from("search_events").select("id", { count: "exact", head: true });
  if (options.createdAfter) {
    query = query.gte("created_at", options.createdAfter);
  }
  if (options.hasError) {
    query = query.not("error", "is", null);
  }

  const { count, error } = await query;

  if (error) {
    console.warn("[vera:admin] count failed", { error: error.message });
    return 0;
  }

  return count ?? 0;
}

export async function getAdminSearchDetail(eventId: string): Promise<{
  event: AdminEventWithCache | null;
  unavailableReason?: string;
}> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return { event: null, unavailableReason: "Supabase service-role access is not configured for this runtime." };
  }

  const { data, error } = await supabase.from("search_events").select(searchEventSelect).eq("id", eventId).maybeSingle();

  if (error) {
    return { event: null, unavailableReason: error.message };
  }

  if (!data) {
    return { event: null };
  }

  const [event] = await attachCacheResults([data as unknown as AdminSearchEvent]);
  return { event };
}

export function contenderNamesFromResult(result?: ConsensusResponse | null) {
  if (!result) return [];

  const resultNames = result.results?.map((item) => item.name).filter(Boolean) ?? [];

  if (resultNames.length > 0) {
    return resultNames;
  }

  return result.structuredConsensus?.contenders.map((item) => item.name).filter(Boolean) ?? [];
}

export function sourcesFromResult(result?: ConsensusResponse | null) {
  if (!result) return [];
  return result.sources ?? [];
}

export function categoryLabelForEvent(event: Pick<AdminSearchEvent, "evidence_type" | "cache_hit_type">) {
  const evidenceType = (event.evidence_type ?? "").toLowerCase();
  const cacheHitType = (event.cache_hit_type ?? "").toLowerCase();

  if (cacheHitType.includes("negative") || cacheHitType.includes("unsupported") || cacheHitType.includes("vague")) {
    return "negative/safety";
  }

  if (evidenceType === "local_recommendation") return "local";
  if (evidenceType === "destination_recommendation") return "destination";
  if (evidenceType === "product_recommendation") return "product";
  if (evidenceType === "provider_or_brand_recommendation") return "provider/brand";
  if (evidenceType === "software_tool") return "software/tools";

  return "unclear/other";
}

async function attachCacheResults(events: AdminSearchEvent[]): Promise<AdminEventWithCache[]> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return events;
  }

  const searchIds = Array.from(new Set(events.map((event) => event.search_id).filter((id): id is string => Boolean(id))));

  if (searchIds.length === 0) {
    return events;
  }

  const { data, error } = await supabase
    .from("search_cache")
    .select("id, original_query, normalized_query, canonical_query, result_json, result, sources_json, cache_version, created_at, updated_at")
    .in("id", searchIds);

  if (error) {
    console.warn("[vera:admin] cache result lookup failed", { error: error.message });
    return events;
  }

  const cacheById = new Map((data ?? []).map((row) => [row.id, row as AdminSearchCacheRow]));

  return events.map((event) => {
    const cacheRow = event.search_id ? cacheById.get(event.search_id) : null;
    const result = cacheRow?.result_json ?? cacheRow?.result ?? null;

    return {
      ...event,
      cacheResult: result,
      cachedSources: cacheRow?.sources_json ?? result?.sources ?? null
    };
  });
}

function buildCategoryBreakdown(events: Array<Pick<AdminSearchEvent, "evidence_type" | "cache_hit_type">>) {
  const orderedLabels = ["local", "destination", "product", "provider/brand", "software/tools", "negative/safety", "unclear/other"];
  const counts = new Map(orderedLabels.map((label) => [label, 0]));

  events.forEach((event) => {
    const label = categoryLabelForEvent(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });

  return orderedLabels.map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

function emptyDashboardData(unavailableReason: string): AdminDashboardData {
  return {
    unavailableReason,
    overview: {
      totalSearches: 0,
      searchesToday: 0,
      searchesLast7Days: 0,
      cacheHitRate: 0,
      noConsensusRate: 0,
      averageResponseMs: null,
      errorCount: 0
    },
    categoryBreakdown: [],
    recentSearches: [],
    problemSearches: {
      noConsensus: [],
      slow: [],
      errors: [],
      zeroContenders: []
    },
    feedback: {
      total: 0,
      recent: []
    },
    sampleSize: 0
  };
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

const searchEventSelect = [
  "id",
  "created_at",
  "search_id",
  "original_query",
  "normalized_query",
  "canonical_query",
  "evidence_type",
  "consensus_mode",
  "cache_hit",
  "cache_hit_type",
  "cache_version",
  "total_ms",
  "cache_ms",
  "tavily_ms",
  "openai_ms",
  "cache_write_ms",
  "tavily_calls",
  "openai_calls",
  "places_api_calls",
  "places_cache_hits",
  "places_validation_attempts",
  "error"
].join(", ");
