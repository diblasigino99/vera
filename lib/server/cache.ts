import type { ConsensusResponse, ProfileSnapshot } from "@/lib/types";
import { normalizeQuery } from "@/lib/utils";
import { getSupabaseAdmin } from "@/lib/server/supabase";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const memorySearches = new Map<string, ConsensusResponse>();
const localCachePath = join(process.cwd(), ".vera-cache", "searches.json");
const localSavesPath = join(process.cwd(), ".vera-cache", "saves.json");
const localCacheVersion = 6;
const canUseLocalJsonFallback = !process.env.VERCEL && process.env.NODE_ENV !== "production";

type LocalCacheEntry = {
  original_query: string;
  normalized_query: string;
  result: ConsensusResponse;
  sources_used: ConsensusResponse["sources"];
  created_at: string;
  updated_at: string;
  cache_version?: number;
};

type LocalCacheFile = Record<string, LocalCacheEntry>;

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

export async function getCachedConsensus(query: string) {
  const normalizedQuery = normalizeQuery(query);
  const local = memorySearches.get(normalizedQuery);

  if (local) {
    return { ...local, cached: true };
  }

  const localFileCache = await readLocalCache();
  const localFileHit = localFileCache[normalizedQuery];

  if (localFileHit?.result && localFileHit.cache_version === localCacheVersion) {
    memorySearches.set(normalizedQuery, localFileHit.result);
    return { ...localFileHit.result, cached: true };
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("search_cache")
    .select("result")
    .eq("normalized_query", normalizedQuery)
    .maybeSingle();

  if (error || !data?.result) {
    return null;
  }

  const result = data.result as ConsensusResponse;

  if (result.cacheVersion !== localCacheVersion) {
    console.log("[vera:cache] Ignoring stale Supabase cache entry", {
      query,
      normalizedQuery,
      cachedVersion: result.cacheVersion ?? "missing",
      expectedVersion: localCacheVersion,
      cachedMode: result.mode
    });
    return null;
  }

  return { ...result, cached: true };
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
    .select("result")
    .eq("id", searchId)
    .maybeSingle();

  if (error || !data?.result) {
    return null;
  }

  return data.result as ConsensusResponse;
}

export async function cacheConsensus(consensus: ConsensusResponse) {
  const versionedConsensus = { ...consensus, cacheVersion: localCacheVersion };

  memorySearches.set(versionedConsensus.normalizedQuery, versionedConsensus);
  await writeLocalCacheEntry(versionedConsensus);

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return;
  }

  await supabase.from("search_cache").upsert(
    {
      id: consensus.id,
      query: consensus.query,
      normalized_query: consensus.normalizedQuery,
      result: versionedConsensus,
      created_at: consensus.createdAt,
      updated_at: new Date().toISOString()
    },
    {
      onConflict: "normalized_query"
    }
  );
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
  const existing = cache[consensus.normalizedQuery];
  const now = new Date().toISOString();

  cache[consensus.normalizedQuery] = {
    original_query: consensus.query,
    normalized_query: consensus.normalizedQuery,
    result: consensus,
    sources_used: consensus.sources,
    created_at: existing?.created_at ?? consensus.createdAt,
    updated_at: now,
    cache_version: localCacheVersion
  };

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

  const { error } = await supabase.from("search_cache").upsert(
    {
      id: consensus.id,
      query: consensus.query,
      normalized_query: consensus.normalizedQuery,
      result: consensus,
      created_at: consensus.createdAt,
      updated_at: new Date().toISOString()
    },
    {
      onConflict: "normalized_query"
    }
  );

  if (error) {
    throw new Error(error.message);
  }
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
      supabase.from("search_cache").select("id, query, result, created_at").order("created_at", { ascending: false }).limit(8),
      supabase.from("saved_searches").select("search_id").eq("profile_id", actorId).order("created_at", { ascending: false }),
      supabase.from("saved_results").select("search_id, result_id").eq("profile_id", actorId).order("created_at", { ascending: false })
    ]);

    const recentSearches = (remoteRecent ?? []).map((row) => row.result as ConsensusResponse);
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
