import type { ConsensusResponse, ProfileSnapshot } from "@/lib/types";
import { canonicalizeQuery, normalizeQuery } from "@/lib/utils";
import { getSupabaseAdmin, getSupabaseConfigSnapshot } from "@/lib/server/supabase";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExternalCallCounts } from "@/lib/server/external-call-counts";

const memorySearches = new Map<string, ConsensusResponse>();
const localCachePath = join(process.cwd(), ".vera-cache", "searches.json");
const localSavesPath = join(process.cwd(), ".vera-cache", "saves.json");
const localCacheVersion = 8;
const canUseLocalJsonFallback = !process.env.VERCEL && process.env.NODE_ENV !== "production";

type LocalCacheEntry = {
  original_query: string;
  normalized_query: string;
  canonical_query?: string;
  result: ConsensusResponse;
  sources_used: ConsensusResponse["sources"];
  created_at: string;
  updated_at: string;
  cache_version?: number;
};

type LocalCacheFile = Record<string, LocalCacheEntry>;

type SupabaseSearchCacheRow = {
  id?: string;
  original_query?: string | null;
  query?: string | null;
  normalized_query?: string | null;
  canonical_query?: string | null;
  result_json?: ConsensusResponse | null;
  result?: ConsensusResponse | null;
  sources_json?: ConsensusResponse["sources"] | null;
  cache_version?: number | null;
  updated_at?: string | null;
};

type LocalSavesFile = Record<
  string,
  {
    saved_searches: string[];
    saved_results: Array<{
      searchId: string;
      resultId: string;
    }>;
    updated_at: string;
  }
>;

const memorySaves = new Map<string, LocalSavesFile[string]>();

export function getCacheVersion() {
  console.log("CACHE_VERSION", { cacheVersion: localCacheVersion });
  return localCacheVersion;
}

export async function getCachedConsensus(query: string, callCounts?: ExternalCallCounts) {
  const normalizedQuery = normalizeQuery(query);
  const canonicalQuery = canonicalizeQuery(query);
  const supabase = getSupabaseAdmin();
  console.log("ORIGINAL_QUERY", query);
  console.log("NORMALIZED_QUERY", normalizedQuery);
  console.log("CANONICAL_QUERY", canonicalQuery);

  if (supabase) {
    console.log("[vera:cache] cache lookup started", {
      normalizedQuery,
      canonicalQuery,
      cacheVersion: localCacheVersion,
      store: "supabase"
    });

    const supabaseHit = await getSupabaseCachedConsensus(canonicalQuery, normalizedQuery, callCounts);

    if (supabaseHit) {
      memorySearches.set(normalizedQuery, supabaseHit);
      memorySearches.set(canonicalQuery, supabaseHit);
      console.log("[vera:cache] cache hit", {
        normalizedQuery,
        canonicalQuery,
        cacheVersion: localCacheVersion,
        store: "supabase",
        searchId: supabaseHit.id
      });
      return { ...supabaseHit, cached: true };
    }

    console.log("[vera:cache] cache miss", {
      normalizedQuery,
      canonicalQuery,
      cacheVersion: localCacheVersion,
      store: "supabase"
    });
  } else {
    const config = getSupabaseConfigSnapshot();
    console.log("SUPABASE_CONFIG", {
      hasUrl: config.hasUrl,
      hasAnonKey: config.hasAnonKey,
      hasServiceRole: config.hasServiceRole,
      runtime: config.runtime,
      searchCacheUrl: config.searchCacheUrl
    });
    console.log("RAW_SUPABASE_URL", config.rawSupabaseUrl);
    console.log("FINAL_SUPABASE_URL", config.finalSupabaseUrl);
  }

  const local = memorySearches.get(canonicalQuery) ?? memorySearches.get(normalizedQuery);

  if (local) {
    console.log("CACHE_HIT_TYPE", memorySearches.has(canonicalQuery) ? "canonical" : "normalized");
    console.log("[vera:cache] cache hit", {
      normalizedQuery,
      canonicalQuery,
      cacheVersion: localCacheVersion,
      store: "memory",
      searchId: local.id
    });
    return { ...local, cached: true };
  }

  const localFileCache = await readLocalCache();
  const localFileHit = localFileCache[canonicalQuery] ?? localFileCache[normalizedQuery];

  if (localFileHit?.result && localFileHit.cache_version === localCacheVersion) {
    memorySearches.set(normalizedQuery, localFileHit.result);
    memorySearches.set(canonicalQuery, localFileHit.result);
    console.log("CACHE_HIT_TYPE", localFileCache[canonicalQuery] ? "canonical" : "normalized");
    console.log("[vera:cache] cache hit", {
      normalizedQuery,
      canonicalQuery,
      cacheVersion: localCacheVersion,
      store: "local-json",
      searchId: localFileHit.result.id
    });
    return { ...localFileHit.result, cached: true };
  }

  console.log("[vera:cache] cache miss", {
    normalizedQuery,
    canonicalQuery,
    cacheVersion: localCacheVersion,
    store: supabase ? "memory/local-json-after-supabase" : "memory/local-json"
  });
  console.log("CACHE_HIT_TYPE", "miss");
  return null;
}

export async function getConsensusById(searchId: string) {
  for (const consensus of memorySearches.values()) {
    if (consensus.id === searchId) {
      return consensus;
    }
  }

  const localFileCache = await readLocalCache();
  const localFileHit = Object.values(localFileCache).find((entry) => entry.result?.id === searchId);

  if (localFileHit?.result) {
    memorySearches.set(localFileHit.result.normalizedQuery, localFileHit.result);
    return localFileHit.result;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("search_cache")
    .select("result_json, result, sources_json, cache_version")
    .eq("id", searchId)
    .maybeSingle();

  if (error) {
    const legacy = await supabase.from("search_cache").select("result").eq("id", searchId).maybeSingle();
    const legacyResult = legacy.data?.result as ConsensusResponse | undefined;

    if (!legacy.error && legacyResult) {
      return legacyResult;
    }

    return null;
  }

  const result = consensusFromSupabaseRow(data as SupabaseSearchCacheRow);

  if (!result) {
    return null;
  }

  return result;
}

export async function cacheConsensus(consensus: ConsensusResponse, callCounts?: ExternalCallCounts) {
  const versionedConsensus = {
    ...consensus,
    canonicalQuery: consensus.canonicalQuery ?? canonicalizeQuery(consensus.query),
    cacheVersion: localCacheVersion,
    sources: annotateSources(consensus)
  };

  memorySearches.set(versionedConsensus.normalizedQuery, versionedConsensus);
  memorySearches.set(versionedConsensus.canonicalQuery, versionedConsensus);

  const supabase = getSupabaseAdmin();
  if (supabase) {
    await writeSupabaseCacheEntry(versionedConsensus, callCounts);
    return;
  }

  await writeLocalCacheEntry(versionedConsensus);
}

function annotateSources(consensus: ConsensusResponse) {
  return consensus.sources.map((source) => {
    const supportingResult = consensus.results.find((result) => result.sources.some((resultSource) => resultSource.url === source.url));

    return {
      ...source,
      supportingContender: supportingResult?.name,
      relevanceScore: source.snippet && source.snippet.length >= 160 ? 1 : 0.6
    };
  });
}

async function getSupabaseCachedConsensus(canonicalQuery: string, normalizedQuery: string, callCounts?: ExternalCallCounts) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return null;
  }

  if (callCounts) {
    callCounts.supabaseReads += 1;
  }

  const lookupStartedAt = Date.now();
  const config = getSupabaseConfigSnapshot();
  console.log("SUPABASE_CONFIG", {
    hasUrl: config.hasUrl,
    hasAnonKey: config.hasAnonKey,
    hasServiceRole: config.hasServiceRole,
    runtime: config.runtime,
    searchCacheUrl: config.searchCacheUrl
  });
  console.log("RAW_SUPABASE_URL", config.rawSupabaseUrl);
  console.log("FINAL_SUPABASE_URL", config.finalSupabaseUrl);

  let lookup;

  try {
    lookup = await supabase
      .from("search_cache")
      .select("id, original_query, normalized_query, canonical_query, result_json, sources_json, cache_version, updated_at")
      .or(`canonical_query.eq.${escapePostgrestValue(canonicalQuery)},normalized_query.eq.${escapePostgrestValue(normalizedQuery)}`)
      .eq("cache_version", localCacheVersion)
      .limit(2);
  } catch (error) {
    console.log("CACHE_LOOKUP_EXCEPTION", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });

    console.log("CACHE_LOOKUP_RESULT", {
      hit: false,
      rowId: null,
      errorCode: error instanceof Error ? error.name : null,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - lookupStartedAt
    });

    throw error;
  }

  const { data, error } = lookup;

  const rows = (data ?? []) as SupabaseSearchCacheRow[];
  const row =
    rows.find((candidate) => candidate.canonical_query === canonicalQuery) ??
    rows.find((candidate) => candidate.normalized_query === normalizedQuery) ??
    null;

  if (!error) {
    const hit = consensusFromSupabaseRow(row);

    console.log("CACHE_LOOKUP_RESULT", {
      hit: Boolean(hit),
      rowId: row?.id ?? null,
      hitType: hit ? (row?.canonical_query === canonicalQuery ? "canonical" : "normalized") : "miss",
      errorCode: null,
      errorMessage: null,
      durationMs: Date.now() - lookupStartedAt
    });

    if (hit) {
      console.log("CACHE_HIT_TYPE", row?.canonical_query === canonicalQuery ? "canonical" : "normalized");
      return hit;
    }

    return null;
  }

  if (error.code === "PGRST116") {
    console.log("CACHE_LOOKUP_RESULT", {
      hit: false,
      rowId: null,
      hitType: "miss",
      errorCode: error.code,
      errorMessage: error.message,
      durationMs: Date.now() - lookupStartedAt
    });
    return null;
  }

  console.log("[vera:cache] cache lookup failed", {
    normalizedQuery,
    cacheVersion: localCacheVersion,
    store: "supabase",
    error
  });

  console.log("CACHE_LOOKUP_RESULT", {
    hit: false,
    rowId: null,
    hitType: "miss",
    errorCode: error.code ?? null,
    errorMessage: error.message,
    errorDetails: error.details ?? null,
    errorHint: error.hint ?? null,
    durationMs: Date.now() - lookupStartedAt
  });

  throw new Error(`Supabase cache lookup failed: ${error.message}`);
}

async function writeSupabaseCacheEntry(consensus: ConsensusResponse, callCounts?: ExternalCallCounts) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const payload = {
    id: consensus.id,
    query: consensus.query,
    original_query: consensus.query,
    normalized_query: consensus.normalizedQuery,
    canonical_query: consensus.canonicalQuery ?? canonicalizeQuery(consensus.query),
    result: consensus,
    result_json: consensus,
    sources_json: consensus.sources,
    cache_version: localCacheVersion,
    created_at: consensus.createdAt,
    updated_at: new Date().toISOString()
  };

  if (callCounts) {
    callCounts.supabaseWrites += 1;
  }

  const writeStartedAt = Date.now();
  const { error } = await supabase.from("search_cache").upsert(payload, {
    onConflict: "normalized_query"
  });

  if (!error) {
    console.log("CACHE_WRITE_RESULT", {
      success: true,
      rowId: consensus.id,
      error: null,
      durationMs: Date.now() - writeStartedAt
    });
    console.log("[vera:cache] cache write success", {
      normalizedQuery: consensus.normalizedQuery,
      cacheVersion: localCacheVersion,
      store: "supabase",
      searchId: consensus.id
    });
    return;
  }

  console.log("[vera:cache] cache write failed", {
    normalizedQuery: consensus.normalizedQuery,
    cacheVersion: localCacheVersion,
    store: "supabase",
    error: error.message
  });

  console.log("CACHE_WRITE_RESULT", {
    success: false,
    rowId: consensus.id,
    error: error.message,
    durationMs: Date.now() - writeStartedAt
  });

  throw new Error(`Supabase cache write failed: ${error.message}`);
}

function consensusFromSupabaseRow(row?: SupabaseSearchCacheRow | null): ConsensusResponse | null {
  if (!row) {
    return null;
  }

  const result = row.result_json ?? row.result;

  if (!result) {
    return null;
  }

  return {
    ...result,
    canonicalQuery: row.canonical_query ?? result.canonicalQuery,
    cacheVersion: row.cache_version ?? result.cacheVersion,
    sources: row.sources_json ?? result.sources
  } satisfies ConsensusResponse;
}

function escapePostgrestValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/\./g, "\\.");
}

export async function getSavedState(actorId: string, searchId: string, resultId?: string) {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    const [savedSearch, savedResult] = await Promise.all([
      supabase
        .from("saved_searches")
        .select("id")
        .eq("profile_id", actorId)
        .eq("search_id", searchId)
        .maybeSingle(),
      resultId
        ? supabase
            .from("saved_results")
            .select("id")
            .eq("profile_id", actorId)
            .eq("search_id", searchId)
            .eq("result_id", resultId)
            .maybeSingle()
        : Promise.resolve({ data: null })
    ]);

    return {
      savedSearch: Boolean(savedSearch.data),
      savedResult: Boolean(savedResult.data)
    };
  }

  const localSaves = await readLocalSaves();
  const actor = localSaves[actorId];

  return {
    savedSearch: Boolean(actor?.saved_searches.includes(searchId)),
    savedResult: Boolean(resultId && actor?.saved_results.some((item) => item.searchId === searchId && item.resultId === resultId))
  };
}

export async function getSavedStateBatch(actorId: string, searchId: string, resultIds: string[]) {
  const uniqueResultIds = Array.from(new Set(resultIds.filter(Boolean)));
  const supabase = getSupabaseAdmin();

  if (supabase) {
    const [savedSearch, savedResults] = await Promise.all([
      supabase
        .from("saved_searches")
        .select("id")
        .eq("profile_id", actorId)
        .eq("search_id", searchId)
        .maybeSingle(),
      uniqueResultIds.length
        ? supabase
            .from("saved_results")
            .select("result_id")
            .eq("profile_id", actorId)
            .eq("search_id", searchId)
            .in("result_id", uniqueResultIds)
        : Promise.resolve({ data: [] })
    ]);

    const savedResultIds = new Set((savedResults.data ?? []).map((row) => row.result_id));

    return {
      savedSearch: Boolean(savedSearch.data),
      savedResults: Object.fromEntries(uniqueResultIds.map((resultId) => [resultId, savedResultIds.has(resultId)]))
    };
  }

  const localSaves = await readLocalSaves();
  const actor = localSaves[actorId];
  const savedResultIds = new Set(
    actor?.saved_results.filter((item) => item.searchId === searchId).map((item) => item.resultId) ?? []
  );

  return {
    savedSearch: Boolean(actor?.saved_searches.includes(searchId)),
    savedResults: Object.fromEntries(uniqueResultIds.map((resultId) => [resultId, savedResultIds.has(resultId)]))
  };
}

async function readLocalCache(): Promise<LocalCacheFile> {
  if (!canUseLocalJsonFallback) {
    return {};
  }

  try {
    return JSON.parse(await readFile(localCachePath, "utf8")) as LocalCacheFile;
  } catch {
    return {};
  }
}

async function writeLocalCacheEntry(consensus: ConsensusResponse) {
  if (!canUseLocalJsonFallback) {
    return;
  }

  const cache = await readLocalCache();
  const canonicalQuery = consensus.canonicalQuery ?? canonicalizeQuery(consensus.query);
  const existing = cache[canonicalQuery] ?? cache[consensus.normalizedQuery];
  const now = new Date().toISOString();

  const entry = {
    original_query: consensus.query,
    normalized_query: consensus.normalizedQuery,
    canonical_query: canonicalQuery,
    result: consensus,
    sources_used: consensus.sources,
    created_at: existing?.created_at ?? consensus.createdAt,
    updated_at: now,
    cache_version: localCacheVersion
  };
  cache[canonicalQuery] = entry;
  cache[consensus.normalizedQuery] = entry;

  await mkdir(dirname(localCachePath), { recursive: true });
  await writeFile(localCachePath, JSON.stringify(cache, null, 2));
}

async function readLocalSaves(): Promise<LocalSavesFile> {
  if (!canUseLocalJsonFallback) {
    return Object.fromEntries(memorySaves);
  }

  try {
    return JSON.parse(await readFile(localSavesPath, "utf8")) as LocalSavesFile;
  } catch {
    return {};
  }
}

async function writeLocalSaves(saves: LocalSavesFile) {
  if (!canUseLocalJsonFallback) {
    memorySaves.clear();
    Object.entries(saves).forEach(([actorId, actorSaves]) => {
      memorySaves.set(actorId, actorSaves);
    });
    return;
  }

  await mkdir(dirname(localSavesPath), { recursive: true });
  await writeFile(localSavesPath, JSON.stringify(saves, null, 2));
}

async function ensureSupabaseProfile(actorId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.from("profiles").upsert({ id: actorId });

  if (error) {
    throw new Error(error.message);
  }
}

async function ensureSupabaseSearch(searchId: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  const { data } = await supabase.from("search_cache").select("id").eq("id", searchId).maybeSingle();

  if (data?.id) {
    return;
  }

  const consensus = await getConsensusById(searchId);

  if (!consensus) {
    throw new Error("Saved search could not be found.");
  }

  await writeSupabaseCacheEntry(consensus);
}

export async function saveSearch(searchId: string, actorId: string) {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    await ensureSupabaseProfile(actorId);
    await ensureSupabaseSearch(searchId);
    const { error } = await supabase
      .from("saved_searches")
      .upsert({ profile_id: actorId, search_id: searchId }, { onConflict: "profile_id,search_id" });

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  const saves = await readLocalSaves();
  const actor = saves[actorId] ?? { saved_searches: [], saved_results: [], updated_at: new Date().toISOString() };

  if (!actor.saved_searches.includes(searchId)) {
    actor.saved_searches.push(searchId);
  }

  actor.updated_at = new Date().toISOString();
  saves[actorId] = actor;
  await writeLocalSaves(saves);
}

export async function saveResult(searchId: string, resultId: string, actorId: string) {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    await ensureSupabaseProfile(actorId);
    await ensureSupabaseSearch(searchId);
    const { error } = await supabase
      .from("saved_results")
      .upsert({ profile_id: actorId, search_id: searchId, result_id: resultId }, { onConflict: "profile_id,search_id,result_id" });

    if (error) {
      throw new Error(error.message);
    }

    return;
  }

  const saves = await readLocalSaves();
  const actor = saves[actorId] ?? { saved_searches: [], saved_results: [], updated_at: new Date().toISOString() };

  if (!actor.saved_results.some((item) => item.searchId === searchId && item.resultId === resultId)) {
    actor.saved_results.push({ searchId, resultId });
  }

  actor.updated_at = new Date().toISOString();
  saves[actorId] = actor;
  await writeLocalSaves(saves);
}

export async function getProfileSnapshot(actorId?: string): Promise<ProfileSnapshot> {
  const recent = Array.from(memorySearches.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

  const supabase = getSupabaseAdmin();
  if (!actorId) {
    return {
      recentSearches: recent.map(toProfileSearch),
      savedSearches: [],
      savedResults: []
    };
  }

  if (supabase) {
    const [{ data: remoteRecent }, { data: savedSearchRows }, { data: savedResultRows }] = await Promise.all([
      supabase
        .from("search_cache")
        .select("id, original_query, query, result_json, result, sources_json, cache_version, created_at")
        .order("created_at", { ascending: false })
        .limit(8),
      supabase.from("saved_searches").select("search_id").eq("profile_id", actorId).order("created_at", { ascending: false }),
      supabase.from("saved_results").select("search_id, result_id").eq("profile_id", actorId).order("created_at", { ascending: false })
    ]);

    const recentSearches = (remoteRecent ?? [])
      .map((row) => consensusFromSupabaseRow(row as SupabaseSearchCacheRow))
      .filter((item): item is ConsensusResponse => Boolean(item));
    const savedSearches = await Promise.all((savedSearchRows ?? []).map((row) => getConsensusById(row.search_id)));
    const savedResults = await savedResultsSnapshot(savedResultRows ?? []);

    return {
      recentSearches: recentSearches.map(toProfileSearch),
      savedSearches: savedSearches.filter(Boolean).map((search) => toProfileSearch(search as ConsensusResponse)),
      savedResults
    };
  }

  const localCache = await readLocalCache();
  const allSearches = uniqueSearches([
    ...memorySearches.values(),
    ...Object.values(localCache).map((entry) => entry.result)
  ]);
  const localSaves = await readLocalSaves();
  const actor = localSaves[actorId];

  if (!actor) {
    return {
      recentSearches: allSearches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map(toProfileSearch),
      savedSearches: [],
      savedResults: []
    };
  }

  const savedSearches = actor.saved_searches
    .map((searchId) => allSearches.find((search) => search.id === searchId))
    .filter(Boolean) as ConsensusResponse[];
  const savedResults = actor.saved_results
    .map((saved) => {
      const search = allSearches.find((item) => item.id === saved.searchId);
      const result = search?.results.find((item) => item.id === saved.resultId);

      if (!search || !result) {
        return null;
      }

      return {
        searchId: search.id,
        resultId: result.id,
        name: result.name,
        query: search.query,
        summary: result.summary
      };
    })
    .filter(Boolean) as ProfileSnapshot["savedResults"];

  return {
    recentSearches: allSearches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map(toProfileSearch),
    savedSearches: savedSearches.map(toProfileSearch),
    savedResults
  };
}

async function savedResultsSnapshot(rows: Array<{ search_id: string; result_id: string }>) {
  const items = await Promise.all(
    rows.map(async (row) => {
      const search = await getConsensusById(row.search_id);
      const result = search?.results.find((item) => item.id === row.result_id);

      if (!search || !result) {
        return null;
      }

      return {
        searchId: search.id,
        resultId: result.id,
        name: result.name,
        query: search.query,
        summary: result.summary
      };
    })
  );

  return items.filter(Boolean) as ProfileSnapshot["savedResults"];
}

function toProfileSearch(search: ConsensusResponse) {
  return {
    id: search.id,
    query: search.query,
    headline: search.headline,
    createdAt: search.createdAt
  };
}

function uniqueSearches(searches: ConsensusResponse[]) {
  const byId = new Map<string, ConsensusResponse>();

  searches.forEach((search) => {
    byId.set(search.id, search);
  });

  return Array.from(byId.values());
}
