import { getSupabaseAdmin } from "@/lib/server/supabase";

export type FeedbackType = "yes" | "no" | "report_issue";

export type FeedbackEventInput = {
  searchQuery?: string | null;
  resultSlug?: string | null;
  feedbackType: FeedbackType;
  feedbackText?: string | null;
  evidenceType?: string | null;
  consensusClassification?: string | null;
};

export type AdminFeedbackEvent = {
  id: string;
  created_at: string;
  search_query: string | null;
  result_slug: string | null;
  feedback_type: FeedbackType;
  feedback_text: string | null;
  evidence_type: string | null;
  consensus_classification: string | null;
};

export async function recordFeedbackEvent(input: FeedbackEventInput) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    throw new Error("Feedback storage is not configured.");
  }

  const { error } = await supabase.from("feedback_events").insert({
    search_query: input.searchQuery ?? null,
    result_slug: input.resultSlug ?? null,
    feedback_type: input.feedbackType,
    feedback_text: input.feedbackText?.trim() || null,
    evidence_type: input.evidenceType ?? null,
    consensus_classification: input.consensusClassification ?? null
  });

  if (error) {
    throw new Error(`Feedback insert failed: ${error.message}`);
  }
}

export async function getRecentFeedbackEvents(limit = 25) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from("feedback_events")
    .select("id, created_at, search_query, result_slug, feedback_type, feedback_text, evidence_type, consensus_classification")
    .order("created_at", { ascending: false })
    .limit(limit);

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

  const { data, error } = await supabase
    .from("feedback_events")
    .select("id, created_at, search_query, result_slug, feedback_type, feedback_text, evidence_type, consensus_classification")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.warn("[vera:feedback] detail lookup failed", { id, error: error.message });
    return null;
  }

  return data as unknown as AdminFeedbackEvent | null;
}

export async function countFeedbackEvents() {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return 0;
  }

  const { count, error } = await supabase.from("feedback_events").select("id", { count: "exact", head: true });

  if (error) {
    console.warn("[vera:feedback] count failed", { error: error.message });
    return 0;
  }

  return count ?? 0;
}
