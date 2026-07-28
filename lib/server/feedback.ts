import { getSupabaseAdmin } from "@/lib/server/supabase";

export type FeedbackType = "yes" | "no" | "report_issue";
export type FeedbackReason =
  | "wrong_recommendations"
  | "missing_obvious"
  | "unconvincing_sources"
  | "misunderstood_search"
  | "other";

export type FeedbackSentimentFilter = "all" | "positive" | "negative";

export type FeedbackEventInput = {
  searchId?: string | null;
  actorId?: string | null;
  searchQuery?: string | null;
  resultSlug?: string | null;
  feedbackType: FeedbackType;
  helpful?: boolean | null;
  feedbackReason?: FeedbackReason | null;
  feedbackText?: string | null;
  evidenceType?: string | null;
  consensusClassification?: string | null;
  displayedContenders?: string[] | null;
  cacheVersion?: number | null;
  engineVersion?: string | null;
};

export type AdminFeedbackEvent = {
  id: string;
  created_at: string;
  search_id: string | null;
  actor_id: string | null;
  search_query: string | null;
  result_slug: string | null;
  feedback_type: FeedbackType;
  helpful: boolean | null;
  feedback_reason: FeedbackReason | null;
  feedback_text: string | null;
  evidence_type: string | null;
  consensus_classification: string | null;
  displayed_contenders: string[] | null;
  cache_version: number | null;
  engine_version: string | null;
};

export type FeedbackEventFilters = {
  sentiment?: FeedbackSentimentFilter;
  reason?: FeedbackReason | "all";
};

const feedbackSelect =
  "id, created_at, search_id, actor_id, search_query, result_slug, feedback_type, helpful, feedback_reason, feedback_text, evidence_type, consensus_classification, displayed_contenders, cache_version, engine_version";

type FeedbackQuery = {
  eq: (column: string, value: unknown) => FeedbackQuery;
  order: (column: string, options: { ascending: boolean }) => FeedbackQuery;
  limit: (limit: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};

type FeedbackSingleQuery = {
  eq: (column: string, value: unknown) => FeedbackSingleQuery;
  maybeSingle: () => PromiseLike<{ data: unknown | null; error: { message: string } | null }>;
};

type FeedbackCountQuery = {
  eq: (column: string, value: unknown) => FeedbackCountQuery;
} & PromiseLike<{ count: number | null; error: { message: string } | null }>;

export async function recordFeedbackEvent(input: FeedbackEventInput) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    throw new Error("Feedback storage is not configured.");
  }

  const { error } = await supabase.from("feedback_events").insert({
    search_id: input.searchId ?? null,
    actor_id: input.actorId ?? null,
    search_query: input.searchQuery ?? null,
    result_slug: input.resultSlug ?? null,
    feedback_type: input.feedbackType,
    helpful: input.helpful ?? feedbackTypeToHelpful(input.feedbackType),
    feedback_reason: input.feedbackReason ?? null,
    feedback_text: input.feedbackText?.trim() || null,
    evidence_type: input.evidenceType ?? null,
    consensus_classification: input.consensusClassification ?? null,
    displayed_contenders: input.displayedContenders?.length ? input.displayedContenders : null,
    cache_version: input.cacheVersion ?? null,
    engine_version: input.engineVersion ?? null
  });

  if (error) {
    throw new Error(`Feedback insert failed: ${error.message}`);
  }
}

export async function getRecentFeedbackEvents(limit = 25, filters: FeedbackEventFilters = {}) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return [];
  }

  const query = applyFeedbackFilters(
    supabase.from("feedback_events").select(feedbackSelect) as unknown as FeedbackQuery,
    filters
  )
    .order("created_at", { ascending: false })
    .limit(limit);

  const { data, error } = await query;

  if (error) {
    console.warn("[vera:feedback] recent lookup failed", { error: error.message });
    return [];
  }

  return (data ?? []) as unknown as AdminFeedbackEvent[];
}

export async function getFeedbackEvent(id: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  const { data, error } = await (supabase
    .from("feedback_events")
    .select(feedbackSelect)
    .eq("id", id) as unknown as FeedbackSingleQuery)
    .maybeSingle();

  if (error) {
    console.warn("[vera:feedback] detail lookup failed", { id, error: error.message });
    return null;
  }

  return data as unknown as AdminFeedbackEvent | null;
}

export async function countFeedbackEvents(filters: FeedbackEventFilters = {}) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return 0;
  }

  const { count, error } = await applyFeedbackFilters(
    supabase.from("feedback_events").select("id", { count: "exact", head: true }) as unknown as FeedbackCountQuery,
    filters
  );

  if (error) {
    console.warn("[vera:feedback] count failed", { error: error.message });
    return 0;
  }

  return count ?? 0;
}

function feedbackTypeToHelpful(type: FeedbackType) {
  if (type === "yes") return true;
  if (type === "no" || type === "report_issue") return false;
  return null;
}

function applyFeedbackFilters<TQuery extends { eq: (column: string, value: unknown) => TQuery }>(query: TQuery, filters: FeedbackEventFilters) {
  let next = query;

  if (filters.sentiment === "positive") {
    next = next.eq("helpful", true);
  } else if (filters.sentiment === "negative") {
    next = next.eq("helpful", false);
  }

  if (filters.reason && filters.reason !== "all") {
    next = next.eq("feedback_reason", filters.reason);
  }

  return next;
}
