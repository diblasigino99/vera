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

export type AdminDateRangeKey = "today" | "7d" | "30d" | "all" | "custom";
export type AdminCacheFilter = "all" | "hit" | "miss";
export type AdminLatencySort = "newest" | "slowest" | "fastest";

export type AdminDashboardFilters = {
  dateRange?: AdminDateRangeKey;
  startDate?: string;
  endDate?: string;
  searchText?: string;
  category?: string;
  consensus?: string;
  cache?: AdminCacheFilter;
  sort?: AdminLatencySort;
};

export type AdminDashboardData = {
  unavailableReason?: string;
  filters: Required<AdminDashboardFilters>;
  rangeLabel: string;
  overview: {
    totalSearches: number;
    searchesToday: number;
    searchesLast7Days: number;
    cacheHitRate: number;
    noConsensusRate: number;
    averageResponseMs: number | null;
    averageConfidenceScore: number | null;
    errorCount: number;
  };
  categoryBreakdown: Array<{
    label: string;
    count: number;
  }>;
  decisionBreakdown: Array<{
    label: string;
    count: number;
  }>;
  categoryAnalysis: Array<{
    label: string;
    count: number;
    strong: number;
    moderate: number;
    split: number;
    noConsensus: number;
    noConsensusRate: number;
    averageResponseMs: number | null;
  }>;
  topSearches: Array<{
    query: string;
    count: number;
    category: string;
    lastSearchedAt: string | null;
  }>;
  recentSearches: AdminEventWithCache[];
  latencySearches: {
    slowest: AdminEventWithCache[];
    fastest: AdminEventWithCache[];
  };
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

const recentLimit = 100;
const breakdownLimit = 1000;

type AdminSupabase = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function getAdminDashboardData(filters: AdminDashboardFilters = {}): Promise<AdminDashboardData> {
  const supabase = getSupabaseAdmin();
  const normalizedFilters = normalizeDashboardFilters(filters);

  if (!supabase) {
    return emptyDashboardData("Supabase service-role access is not configured for this runtime.", normalizedFilters);
  }

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateBounds = dateBoundsForFilters(normalizedFilters, now);

  const [today, last7, filteredResult, totalFeedback, recentFeedback] = await Promise.all([
    countSearchEvents(supabase, { createdAfter: todayStart.toISOString() }),
    countSearchEvents(supabase, { createdAfter: sevenDaysAgo.toISOString() }),
    buildSearchEventsQuery(supabase, normalizedFilters, dateBounds)
      .order("created_at", { ascending: false })
      .limit(breakdownLimit),
    countFeedbackEvents(),
    getRecentFeedbackEvents(25)
  ]);

  if (filteredResult.error) {
    return emptyDashboardData(`Search events could not be loaded: ${filteredResult.error.message}`, normalizedFilters);
  }

  const filteredEvents = filterEventsInMemory((filteredResult.data ?? []) as unknown as AdminSearchEvent[], normalizedFilters);
  const sortedEvents = sortEvents(filteredEvents, normalizedFilters.sort);
  const visibleEvents = sortedEvents.slice(0, recentLimit);
  const recentSearches = visibleEvents;
  const successfulTimedEvents = filteredEvents.filter((event) => !event.error && typeof event.total_ms === "number");
  const cacheKnownEvents = filteredEvents.filter((event) => typeof event.cache_hit === "boolean");
  const noConsensusEvents = filteredEvents.filter((event) => event.consensus_mode === "no_reliable_consensus");

  return {
    filters: normalizedFilters,
    rangeLabel: rangeLabelForFilters(normalizedFilters, dateBounds),
    overview: {
      totalSearches: filteredEvents.length,
      searchesToday: today,
      searchesLast7Days: last7,
      cacheHitRate: ratio(
        cacheKnownEvents.filter((event) => event.cache_hit).length,
        cacheKnownEvents.length
      ),
      noConsensusRate: ratio(noConsensusEvents.length, filteredEvents.length),
      averageResponseMs: average(successfulTimedEvents.map((event) => event.total_ms ?? 0)),
      averageConfidenceScore: null,
      errorCount: filteredEvents.filter((event) => event.error).length
    },
    categoryBreakdown: buildCategoryBreakdown(filteredEvents),
    decisionBreakdown: buildDecisionBreakdown(filteredEvents),
    categoryAnalysis: buildCategoryAnalysis(filteredEvents),
    topSearches: buildTopSearches(filteredEvents).slice(0, 12),
    recentSearches,
    latencySearches: {
      slowest: sortEvents(filteredEvents, "slowest").slice(0, 10),
      fastest: sortEvents(filteredEvents.filter((event) => typeof event.total_ms === "number"), "fastest").slice(0, 10)
    },
    problemSearches: {
      noConsensus: filteredEvents.filter((event) => event.consensus_mode === "no_reliable_consensus").slice(0, 25),
      slow: sortEvents(filteredEvents.filter((event) => (event.total_ms ?? 0) > 15000), "slowest").slice(0, 25),
      errors: filteredEvents.filter((event) => event.error).slice(0, 25),
      zeroContenders: []
    },
    feedback: {
      total: totalFeedback,
      recent: recentFeedback
    },
    sampleSize: filteredEvents.length
  };

}

type SearchEventCountOptions = {
  createdAfter?: string;
  hasError?: boolean;
};

async function countSearchEvents(supabase: AdminSupabase, options: SearchEventCountOptions = {}) {
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

function buildCategoryAnalysis(events: AdminSearchEvent[]) {
  return buildCategoryBreakdown(events).map((item) => {
    const categoryEvents = events.filter((event) => categoryLabelForEvent(event) === item.label);
    const timedEvents = categoryEvents.filter((event) => typeof event.total_ms === "number" && !event.error);

    return {
      label: item.label,
      count: categoryEvents.length,
      strong: categoryEvents.filter((event) => event.consensus_mode === "clear_consensus" || event.consensus_mode === "strong_consensus").length,
      moderate: categoryEvents.filter((event) => event.consensus_mode === "moderate_consensus").length,
      split: categoryEvents.filter((event) => event.consensus_mode === "split_consensus").length,
      noConsensus: categoryEvents.filter((event) => event.consensus_mode === "no_reliable_consensus").length,
      noConsensusRate: ratio(categoryEvents.filter((event) => event.consensus_mode === "no_reliable_consensus").length, categoryEvents.length),
      averageResponseMs: average(timedEvents.map((event) => event.total_ms ?? 0))
    };
  });
}

function buildDecisionBreakdown(events: AdminSearchEvent[]) {
  const labels = ["Purchasing Decisions", "Travel Decisions", "Business Decisions", "Local Decisions", "Curiosity / General Knowledge", "Other"];
  const counts = new Map(labels.map((label) => [label, 0]));

  events.forEach((event) => {
    const label = decisionBucketForEvent(event);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });

  return labels.map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

function buildTopSearches(events: AdminSearchEvent[]) {
  const grouped = new Map<string, { query: string; count: number; category: string; lastSearchedAt: string | null }>();

  events.forEach((event) => {
    const query = (event.normalized_query ?? event.original_query ?? "").trim();
    if (!query) return;
    const key = query.toLowerCase();
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        query: event.original_query ?? query,
        count: 1,
        category: categoryLabelForEvent(event),
        lastSearchedAt: event.created_at
      });
      return;
    }

    existing.count += 1;
    if (event.created_at && (!existing.lastSearchedAt || new Date(event.created_at).getTime() > new Date(existing.lastSearchedAt).getTime())) {
      existing.lastSearchedAt = event.created_at;
    }
  });

  return Array.from(grouped.values()).sort((a, b) => b.count - a.count || new Date(b.lastSearchedAt ?? 0).getTime() - new Date(a.lastSearchedAt ?? 0).getTime());
}

function normalizeDashboardFilters(filters: AdminDashboardFilters): Required<AdminDashboardFilters> {
  const dateRange = isDateRange(filters.dateRange) ? filters.dateRange : "7d";
  const cache = filters.cache === "hit" || filters.cache === "miss" ? filters.cache : "all";
  const sort = filters.sort === "slowest" || filters.sort === "fastest" ? filters.sort : "newest";

  return {
    dateRange,
    startDate: filters.startDate?.trim() ?? "",
    endDate: filters.endDate?.trim() ?? "",
    searchText: filters.searchText?.trim() ?? "",
    category: filters.category?.trim() ?? "all",
    consensus: filters.consensus?.trim() ?? "all",
    cache,
    sort
  };
}

function isDateRange(value?: string): value is AdminDateRangeKey {
  return value === "today" || value === "7d" || value === "30d" || value === "all" || value === "custom";
}

function dateBoundsForFilters(filters: Required<AdminDashboardFilters>, now: Date) {
  if (filters.dateRange === "all") {
    return { start: null as string | null, end: null as string | null };
  }

  if (filters.dateRange === "custom") {
    return {
      start: dateInputToIso(filters.startDate, "start"),
      end: dateInputToIso(filters.endDate, "end")
    };
  }

  const start =
    filters.dateRange === "today"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : new Date(now.getTime() - (filters.dateRange === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000);

  return { start: start.toISOString(), end: null as string | null };
}

function dateInputToIso(value: string, boundary: "start" | "end") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (boundary === "end") {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return date.toISOString();
}

function rangeLabelForFilters(filters: Required<AdminDashboardFilters>, bounds: { start: string | null; end: string | null }) {
  if (filters.dateRange === "today") return "Today";
  if (filters.dateRange === "7d") return "Last 7 days";
  if (filters.dateRange === "30d") return "Last 30 days";
  if (filters.dateRange === "all") return "All time";
  if (bounds.start || bounds.end) return "Custom range";
  return "Custom range";
}

function buildSearchEventsQuery(supabase: AdminSupabase, filters: Required<AdminDashboardFilters>, bounds: { start: string | null; end: string | null }) {
  let query = supabase.from("search_events").select(searchEventSelect);

  if (bounds.start) {
    query = query.gte("created_at", bounds.start);
  }

  if (bounds.end) {
    query = query.lt("created_at", bounds.end);
  }

  if (filters.consensus !== "all") {
    const modes = consensusModesForFilter(filters.consensus);
    if (modes.length === 1) {
      query = query.eq("consensus_mode", modes[0]);
    } else if (modes.length > 1) {
      query = query.in("consensus_mode", modes);
    }
  }

  if (filters.cache === "hit") {
    query = query.eq("cache_hit", true);
  } else if (filters.cache === "miss") {
    query = query.eq("cache_hit", false);
  }

  return query;
}

function consensusModesForFilter(value: string) {
  if (value === "strong") return ["clear_consensus", "strong_consensus"];
  if (value === "moderate") return ["moderate_consensus"];
  if (value === "split") return ["split_consensus"];
  if (value === "no_reliable_consensus") return ["no_reliable_consensus"];
  return [];
}

function filterEventsInMemory(events: AdminSearchEvent[], filters: Required<AdminDashboardFilters>) {
  const searchText = filters.searchText.toLowerCase();

  return events.filter((event) => {
    if (filters.category !== "all" && categoryLabelForEvent(event) !== filters.category) {
      return false;
    }

    if (searchText) {
      const searchable = `${event.original_query ?? ""} ${event.normalized_query ?? ""} ${event.canonical_query ?? ""}`.toLowerCase();
      if (!searchable.includes(searchText)) {
        return false;
      }
    }

    return true;
  });
}

function sortEvents(events: AdminSearchEvent[], sort: AdminLatencySort) {
  return [...events].sort((a, b) => {
    if (sort === "slowest") return (b.total_ms ?? -1) - (a.total_ms ?? -1);
    if (sort === "fastest") return (a.total_ms ?? Number.MAX_SAFE_INTEGER) - (b.total_ms ?? Number.MAX_SAFE_INTEGER);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function decisionBucketForEvent(event: Pick<AdminSearchEvent, "original_query" | "normalized_query" | "evidence_type" | "cache_hit_type">) {
  const query = `${event.original_query ?? ""} ${event.normalized_query ?? ""}`.toLowerCase();
  const category = categoryLabelForEvent(event);

  if (category === "local") return "Local Decisions";
  if (category === "destination") return "Travel Decisions";
  if (category === "software/tools" || /\b(crm|project management|small team|business|sales|marketing|workflow|productivity)\b/.test(query)) {
    return "Business Decisions";
  }
  if (category === "product" || category === "provider/brand" || /\b(buy|purchase|luggage|headphones|laptop|router|shoe|watch|backpack|carrier|airline|hotel chain|insurance|bank)\b/.test(query)) {
    return "Purchasing Decisions";
  }
  if (/\b(why|what is|who is|history|meaning|explain)\b/.test(query)) return "Curiosity / General Knowledge";

  return "Other";
}

function emptyDashboardData(unavailableReason: string, filters: Required<AdminDashboardFilters> = normalizeDashboardFilters({})): AdminDashboardData {
  return {
    unavailableReason,
    filters,
    rangeLabel: rangeLabelForFilters(filters, { start: null, end: null }),
    overview: {
      totalSearches: 0,
      searchesToday: 0,
      searchesLast7Days: 0,
      cacheHitRate: 0,
      noConsensusRate: 0,
      averageResponseMs: null,
      averageConfidenceScore: null,
      errorCount: 0
    },
    categoryBreakdown: [],
    decisionBreakdown: [],
    categoryAnalysis: [],
    topSearches: [],
    recentSearches: [],
    latencySearches: {
      slowest: [],
      fastest: []
    },
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
