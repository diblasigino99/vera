import { getSupabaseAdmin } from "@/lib/server/supabase";

const searchEventInsertTimeoutMs = 300;

export type SearchEventInput = {
  searchId?: string | null;
  originalQuery?: string | null;
  normalizedQuery?: string | null;
  canonicalQuery?: string | null;
  evidenceType?: string | null;
  consensusMode?: string | null;
  cacheHit?: boolean | null;
  cacheHitType?: string | null;
  cacheVersion?: number | null;
  totalMs?: number | null;
  cacheMs?: number | null;
  tavilyMs?: number | null;
  openAiMs?: number | null;
  cacheWriteMs?: number | null;
  tavilyCalls?: number | null;
  openAiCalls?: number | null;
  placesApiCalls?: number | null;
  placesCacheHits?: number | null;
  placesValidationAttempts?: number | null;
  error?: string | null;
};

export async function recordSearchEvent(event: SearchEventInput) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  try {
    const { error } = await withSearchEventTimeout(
      supabase.from("search_events").insert({
        search_id: event.searchId ?? null,
        original_query: event.originalQuery ?? null,
        normalized_query: event.normalizedQuery ?? null,
        canonical_query: event.canonicalQuery ?? null,
        evidence_type: event.evidenceType ?? null,
        consensus_mode: event.consensusMode ?? null,
        cache_hit: event.cacheHit ?? null,
        cache_hit_type: event.cacheHitType ?? null,
        cache_version: event.cacheVersion ?? null,
        total_ms: event.totalMs ?? null,
        cache_ms: event.cacheMs ?? null,
        tavily_ms: event.tavilyMs ?? null,
        openai_ms: event.openAiMs ?? null,
        cache_write_ms: event.cacheWriteMs ?? null,
        tavily_calls: event.tavilyCalls ?? 0,
        openai_calls: event.openAiCalls ?? 0,
        places_api_calls: event.placesApiCalls ?? 0,
        places_cache_hits: event.placesCacheHits ?? 0,
        places_validation_attempts: event.placesValidationAttempts ?? 0,
        error: event.error ?? null
      })
    );

    if (error) {
      console.warn("[vera:search-events] insert failed", {
        normalizedQuery: event.normalizedQuery,
        error: error.message,
        code: error.code ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null
      });
    }
  } catch (error) {
    console.warn("[vera:search-events] insert exception", {
      normalizedQuery: event.normalizedQuery,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
  }
}

async function withSearchEventTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Search event insert timed out.")), searchEventInsertTimeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
