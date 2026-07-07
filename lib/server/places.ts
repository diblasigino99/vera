import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceSignal } from "@/lib/types";
import { normalizeLocalQueryIntent, normalizeQuery, parseLocalIntent } from "@/lib/utils";
import { getSupabaseAdmin } from "@/lib/server/supabase";
import type { ExternalCallCounts } from "@/lib/server/external-call-counts";

type PlacesValidationStatus = "verified" | "downgraded" | "rejected";

type PlacesValidation = {
  cacheKey: string;
  inputName: string;
  normalizedInputName: string;
  status: PlacesValidationStatus;
  canonicalName?: string;
  placeId?: string;
  formattedAddress?: string;
  latitude?: number;
  longitude?: number;
  types?: string[];
  businessStatus?: string;
  locationConfidence: number;
  categoryConfidence: number;
  nameConfidence: number;
  overallConfidence: number;
  rejectionReason?: string;
  expiresAt: string;
};

export type PlacesValidationSnapshot = Pick<
  PlacesValidation,
  | "status"
  | "canonicalName"
  | "formattedAddress"
  | "latitude"
  | "longitude"
  | "types"
  | "businessStatus"
  | "locationConfidence"
  | "categoryConfidence"
  | "nameConfidence"
  | "overallConfidence"
  | "rejectionReason"
>;

type PlacesApiPlace = {
  id?: string;
  displayName?: {
    text?: string;
    languageCode?: string;
  };
  formattedAddress?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
};

type PlacesCacheRow = {
  cache_key: string;
  input_name: string;
  normalized_input_name: string;
  status: PlacesValidationStatus;
  canonical_name?: string | null;
  place_id?: string | null;
  formatted_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  types?: string[] | null;
  business_status?: string | null;
  location_confidence?: number | null;
  category_confidence?: number | null;
  name_confidence?: number | null;
  overall_confidence?: number | null;
  rejection_reason?: string | null;
  expires_at?: string | null;
};

const targetVerifiedPlacesContenders = 3;
const maxPlacesValidationAttempts = 10;
const placesValidationConcurrency = 3;
const placesTimeoutMs = 1800;
const verifiedCacheTtlMs = 90 * 24 * 60 * 60 * 1000;
const rejectedCacheTtlMs = 30 * 24 * 60 * 60 * 1000;
const downgradedCacheTtlMs = 14 * 24 * 60 * 60 * 1000;
const memoryPlacesCache = new Map<string, PlacesValidation>();
const localPlacesCachePath = join(process.cwd(), ".vera-cache", "places-validation.json");

export async function validateLocalSignalsWithPlaces(query: string, signals: SourceSignal[], rankedCandidateNames: string[] = [], callCounts?: ExternalCallCounts) {
  const key = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

  if (!signals.length) return signals;

  const groups = groupSignalsForPlacesValidation(query, signals, rankedCandidateNames);

  if (!groups.length) return signals;

  console.log("PLACES_VALIDATION_STARTED", {
    query,
    candidateGroups: groups.length,
    signalCount: signals.length,
    hasGooglePlacesKey: Boolean(key)
  });

  if (!key) {
    console.log("PLACES_VALIDATION_SKIPPED", {
      query,
      reason: "missing_google_places_api_key"
    });
    console.log("PLACES_VALIDATIONS_ATTEMPTED", 0);
    console.log("PLACES_VALIDATIONS_SUCCEEDED", 0);
    console.log("PLACES_VALIDATIONS_REJECTED", 0);
    console.log("FINAL_VERIFIED_CONTENDERS", []);
    recordPlacesSummary(callCounts, 0, 0, 0, []);
    return signals;
  }

  const validations = new Map<string, PlacesValidation>();
  const verifiedNames = new Set<string>();
  let attempted = 0;
  let rejected = 0;
  const paidCallsBeforeBatch = callCounts?.placesApiCalls ?? 0;

  for (let index = 0; index < groups.length; ) {
    if (verifiedNames.size >= targetVerifiedPlacesContenders || attempted >= maxPlacesValidationAttempts) {
      break;
    }

    const remainingAttempts = maxPlacesValidationAttempts - attempted;
    const remainingVerifiedSlots = targetVerifiedPlacesContenders - verifiedNames.size;
    const batchSize = Math.min(placesValidationConcurrency, remainingAttempts, remainingVerifiedSlots);
    const batch = groups.slice(index, index + batchSize);
    index += batchSize;

    const settled = await Promise.allSettled(batch.map((group) => validateCandidateWithPlaces(query, group.displayName, key, callCounts)));

    for (const [batchIndex, response] of settled.entries()) {
      const group = batch[batchIndex];
      attempted += 1;

      if (!group) {
        rejected += 1;
        continue;
      }

      if (response.status === "fulfilled") {
        const validation = response.value;
        validations.set(group.normalizedName, validation);
        for (const alias of group.aliases) {
          validations.set(alias, validation);
        }
        if (validation.status === "verified") {
          verifiedNames.add(group.normalizedName);
        } else {
          rejected += 1;
        }
      } else {
        rejected += 1;
        console.warn("PLACES_VALIDATION_FAILED_SOFT", {
          query,
          candidate: group.displayName,
          error: response.reason instanceof Error ? response.reason.message : String(response.reason)
        });
      }
    }
  }

  const paidCallsDuringValidation = (callCounts?.placesApiCalls ?? paidCallsBeforeBatch) - paidCallsBeforeBatch;

  if (!validations.size) {
    console.log("PLACES_COST_AUDIT", {
      query,
      candidateGroups: groups.length,
      attempted,
      validationsReturned: 0,
      verifiedContenders: 0,
      rejectedSignals: 0,
      canonicalizedSignals: 0,
      estimatedPlacesCalls: paidCallsDuringValidation
    });
    console.log("PLACES_API_CALL_COUNT", callCounts?.placesApiCalls ?? 0);
    console.log("PLACES_CACHE_HITS", callCounts?.placesCacheHits ?? 0);
    console.log("PLACES_VALIDATIONS_ATTEMPTED", attempted);
    console.log("PLACES_VALIDATIONS_SUCCEEDED", 0);
    console.log("PLACES_VALIDATIONS_REJECTED", rejected);
    console.log("FINAL_VERIFIED_CONTENDERS", []);
    recordPlacesSummary(callCounts, attempted, 0, rejected, []);
    return signals;
  }

  let rejectedSignals = 0;
  let canonicalizedSignals = 0;

  const validatedSignals = signals.flatMap((signal) => {
    const normalizedName = placesCandidateKey(signal.contenderName);
    const validation = validations.get(normalizedName);

    if (!validation) return [];

    if (validation.status !== "verified") {
      rejectedSignals += 1;
      console.log("PLACES_REJECTED", {
        candidate: signal.contenderName,
        reason: validation.rejectionReason ?? "places_not_verified",
        overallConfidence: validation.overallConfidence
      });
      return [];
    }

    const canonicalName = validation.canonicalName;
    const shouldCanonicalize =
      canonicalName && canonicalName !== signal.contenderName && (validation.status === "verified" || validation.nameConfidence >= 0.65);

    const verifiedSignal = validation.formattedAddress
      ? {
          ...signal,
          verifiedAddress: validation.formattedAddress
        }
      : signal;

    if (!shouldCanonicalize) {
      return [verifiedSignal];
    }

    canonicalizedSignals += 1;
    console.log("PLACES_CANONICALIZED", {
      input: signal.contenderName,
      canonicalName,
      status: validation.status,
      overallConfidence: validation.overallConfidence
    });

    return [
      {
        ...verifiedSignal,
        contenderName: canonicalName,
        extractedReason: `${signal.extractedReason}; Places verified canonical business name`,
        themes: Array.from(new Set([...signal.themes, "verified business"]))
      }
    ];
  });

  console.log("PLACES_COST_AUDIT", {
    query,
    candidateGroups: groups.length,
    attempted,
    validationsReturned: validations.size,
    verifiedContenders: verifiedNames.size,
    rejectedSignals,
      canonicalizedSignals,
      estimatedPlacesCalls: paidCallsDuringValidation
  });
  console.log("PLACES_VALIDATIONS_ATTEMPTED", attempted);
  console.log("PLACES_API_CALL_COUNT", callCounts?.placesApiCalls ?? 0);
  console.log("PLACES_CACHE_HITS", callCounts?.placesCacheHits ?? 0);
  console.log("PLACES_VALIDATIONS_SUCCEEDED", verifiedNames.size);
  console.log("PLACES_VALIDATIONS_REJECTED", rejected);
  const finalVerifiedContenders = Array.from(validations.values())
    .filter((validation) => validation.status === "verified")
    .map((validation) => validation.canonicalName ?? validation.inputName);
  console.log(
    "FINAL_VERIFIED_CONTENDERS",
    finalVerifiedContenders
  );
  recordPlacesSummary(callCounts, attempted, verifiedNames.size, rejected, finalVerifiedContenders);

  return validatedSignals;
}

function groupSignalsForPlacesValidation(query: string, signals: SourceSignal[], rankedCandidateNames: string[]) {
  const byName = new Map<string, { normalizedName: string; displayName: string; signalCount: number; sourceCount: number; aliases: Set<string> }>();

  for (const signal of signals) {
    const normalizedName = placesCandidateKey(signal.contenderName);

    if (!normalizedName) continue;

    const existingKey = Array.from(byName.keys()).find((candidateKey) => placesCandidateKeysAreDuplicate(candidateKey, normalizedName));
    const existing = existingKey ? byName.get(existingKey) : undefined;
    if (!existing) {
      byName.set(normalizedName, {
        normalizedName,
        displayName: cleanPlacesInputName(signal.contenderName),
        signalCount: 1,
        sourceCount: 1,
        aliases: new Set([normalizedName])
      });
      continue;
    }

    existing.signalCount += 1;
    existing.sourceCount += 1;
    existing.aliases.add(normalizedName);
    if (cleanPlacesInputName(signal.contenderName).length < existing.displayName.length) {
      existing.displayName = cleanPlacesInputName(signal.contenderName);
    }
  }

  const queryTokens = new Set(normalizeQuery(query).split(/\s+/).filter(Boolean));

  const rankedIndex = new Map(rankedCandidateNames.map((name, index) => [placesCandidateKey(name), index]));

  return Array.from(byName.values())
    .filter((group) => {
      const candidateTokens = group.normalizedName.split(/\s+/).filter(Boolean);
      return candidateTokens.some((token) => !queryTokens.has(token));
    })
    .map((group) => ({ ...group, aliases: Array.from(group.aliases) }))
    .sort((a, b) => {
      const aRank = rankedIndex.get(a.normalizedName) ?? Number.POSITIVE_INFINITY;
      const bRank = rankedIndex.get(b.normalizedName) ?? Number.POSITIVE_INFINITY;

      return aRank - bRank || b.signalCount - a.signalCount || b.sourceCount - a.sourceCount;
    });
}

function recordPlacesSummary(
  callCounts: ExternalCallCounts | undefined,
  attempted: number,
  succeeded: number,
  rejected: number,
  finalVerifiedContenders: string[]
) {
  if (!callCounts) return;

  callCounts.placesValidationAttempts += attempted;
  callCounts.placesValidationsSucceeded += succeeded;
  callCounts.placesValidationsRejected += rejected;
  callCounts.finalVerifiedPlacesContenders = Array.from(new Set([...callCounts.finalVerifiedPlacesContenders, ...finalVerifiedContenders]));
}

async function validateCandidateWithPlaces(query: string, inputName: string, apiKey: string, callCounts?: ExternalCallCounts) {
  const cacheKey = placesCacheKey(query, inputName);
  const memoryHit = memoryPlacesCache.get(cacheKey);

  if (memoryHit && new Date(memoryHit.expiresAt).getTime() > Date.now()) {
    console.log("PLACES_CACHE_HIT", {
      candidate: inputName,
      cache: "memory",
      status: memoryHit.status
    });
    if (callCounts) callCounts.placesCacheHits += 1;
    return memoryHit;
  }

  const cached = await readPlacesCache(cacheKey);
  if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
    memoryPlacesCache.set(cacheKey, cached);
    console.log("PLACES_CACHE_HIT", {
      candidate: inputName,
      cache: "persistent",
      status: cached.status
    });
    if (callCounts) callCounts.placesCacheHits += 1;
    return cached;
  }

  const validation = await fetchPlacesValidation(query, inputName, apiKey, cacheKey, callCounts);
  await writePlacesCache(validation);
  memoryPlacesCache.set(cacheKey, validation);

  return validation;
}

export function getCachedPlacesValidationSnapshot(query: string, inputName: string): PlacesValidationSnapshot | null {
  const cacheKey = placesCacheKey(query, inputName);
  const validation = memoryPlacesCache.get(cacheKey);

  if (!validation || new Date(validation.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return {
    status: validation.status,
    canonicalName: validation.canonicalName,
    formattedAddress: validation.formattedAddress,
    latitude: validation.latitude,
    longitude: validation.longitude,
    types: validation.types,
    businessStatus: validation.businessStatus,
    locationConfidence: validation.locationConfidence,
    categoryConfidence: validation.categoryConfidence,
    nameConfidence: validation.nameConfidence,
    overallConfidence: validation.overallConfidence,
    rejectionReason: validation.rejectionReason
  };
}

async function fetchPlacesValidation(query: string, inputName: string, apiKey: string, cacheKey: string, callCounts?: ExternalCallCounts): Promise<PlacesValidation> {
  const textQuery = placesTextQuery(query, inputName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), placesTimeoutMs);
  const startedAt = Date.now();

  console.log("PLACES_API_CALL", {
    candidate: inputName,
    textQuery
  });
  if (callCounts) callCounts.placesApiCalls += 1;

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.businessStatus"
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 3,
        languageCode: "en"
      })
    });

    if (!response.ok) {
      throw new Error(`Google Places returned ${response.status}`);
    }

    const payload = (await response.json()) as { places?: PlacesApiPlace[] };
    const validation = scorePlacesResults(query, inputName, cacheKey, payload.places ?? []);

    console.log("PLACES_VALIDATED", {
      candidate: inputName,
      status: validation.status,
      canonicalName: validation.canonicalName,
      overallConfidence: validation.overallConfidence,
      durationMs: Date.now() - startedAt
    });

    return validation;
  } finally {
    clearTimeout(timeout);
  }
}

function scorePlacesResults(query: string, inputName: string, cacheKey: string, places: PlacesApiPlace[]): PlacesValidation {
  const scored = places.map((place) => {
    const displayName = place.displayName?.text?.trim() ?? "";
    const types = Array.from(new Set([place.primaryType, ...(place.types ?? [])].filter((type): type is string => Boolean(type))));
    const nameConfidence = scoreNameMatch(inputName, displayName);
    const locationConfidence = scoreLocationMatch(query, place.formattedAddress ?? "");
    const categoryConfidence = scoreCategoryMatch(query, types, displayName);
    const nonBusinessPenalty = isNonBusinessPlace(types) ? 0.45 : 0;
    const closedPenalty = place.businessStatus === "CLOSED_PERMANENTLY" ? 0.45 : 0;
    const overallConfidence = clamp01(nameConfidence * 0.45 + locationConfidence * 0.3 + categoryConfidence * 0.25 - nonBusinessPenalty - closedPenalty);

    return {
      place,
      displayName,
      types,
      nameConfidence,
      locationConfidence,
      categoryConfidence,
      overallConfidence
    };
  });

  const best = scored.sort((a, b) => b.overallConfidence - a.overallConfidence)[0];
  const normalizedInputName = placesCandidateKey(inputName);
  const expiresAt = new Date(Date.now() + rejectedCacheTtlMs).toISOString();

  if (!best || !best.displayName) {
    return {
      cacheKey,
      inputName,
      normalizedInputName,
      status: "rejected",
      locationConfidence: 0,
      categoryConfidence: 0,
      nameConfidence: 0,
      overallConfidence: 0,
      rejectionReason: "no_places_match",
      expiresAt
    };
  }

  if (isNonBusinessPlace(best.types)) {
    return rejectedValidation(cacheKey, inputName, normalizedInputName, best, "resolved_to_non_business_place");
  }

  if (best.nameConfidence < 0.45) {
    return rejectedValidation(cacheKey, inputName, normalizedInputName, best, "weak_name_match");
  }

  if (best.locationConfidence < 0.25 && localLocationTokensForPlaces(query).length > 0) {
    return rejectedValidation(cacheKey, inputName, normalizedInputName, best, "weak_location_match");
  }

  if (best.categoryConfidence < 0.2 && localCategoryForPlaces(query) !== "place") {
    return rejectedValidation(cacheKey, inputName, normalizedInputName, best, "wrong_category_match");
  }

  const status: PlacesValidationStatus = best.overallConfidence >= 0.78 ? "verified" : best.overallConfidence >= 0.55 ? "downgraded" : "rejected";

  if (status === "rejected") {
    return rejectedValidation(cacheKey, inputName, normalizedInputName, best, "low_overall_confidence");
  }

  return {
    cacheKey,
    inputName,
    normalizedInputName,
    status,
    canonicalName: cleanPlacesCanonicalName(best.displayName),
    placeId: best.place.id,
    formattedAddress: best.place.formattedAddress,
    latitude: best.place.location?.latitude,
    longitude: best.place.location?.longitude,
    types: best.types,
    businessStatus: best.place.businessStatus,
    locationConfidence: round2(best.locationConfidence),
    categoryConfidence: round2(best.categoryConfidence),
    nameConfidence: round2(best.nameConfidence),
    overallConfidence: round2(best.overallConfidence),
    expiresAt: new Date(Date.now() + (status === "verified" ? verifiedCacheTtlMs : downgradedCacheTtlMs)).toISOString()
  };
}

function rejectedValidation(
  cacheKey: string,
  inputName: string,
  normalizedInputName: string,
  best: {
    place: PlacesApiPlace;
    displayName: string;
    types: string[];
    locationConfidence: number;
    categoryConfidence: number;
    nameConfidence: number;
    overallConfidence: number;
  },
  rejectionReason: string
): PlacesValidation {
  return {
    cacheKey,
    inputName,
    normalizedInputName,
    status: "rejected",
    canonicalName: cleanPlacesCanonicalName(best.displayName),
    placeId: best.place.id,
    formattedAddress: best.place.formattedAddress,
    latitude: best.place.location?.latitude,
    longitude: best.place.location?.longitude,
    types: best.types,
    businessStatus: best.place.businessStatus,
    locationConfidence: round2(best.locationConfidence),
    categoryConfidence: round2(best.categoryConfidence),
    nameConfidence: round2(best.nameConfidence),
    overallConfidence: round2(best.overallConfidence),
    rejectionReason,
    expiresAt: new Date(Date.now() + rejectedCacheTtlMs).toISOString()
  };
}

async function readPlacesCache(cacheKey: string) {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    const { data, error } = await supabase.from("places_validation_cache").select("*").eq("cache_key", cacheKey).maybeSingle();

    if (!error && data) {
      return validationFromCacheRow(data as PlacesCacheRow);
    }

    if (error) {
      console.warn("PLACES_CACHE_READ_FAILED_SOFT", {
        cacheKey,
        errorCode: error.code,
        errorMessage: error.message
      });
    }
  }

  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return null;
  }

  const localCache = await readLocalPlacesCache();
  const cached = localCache[cacheKey];
  return cached ?? null;
}

async function writePlacesCache(validation: PlacesValidation) {
  const supabase = getSupabaseAdmin();

  if (supabase) {
    const { error } = await supabase.from("places_validation_cache").upsert(cacheRowFromValidation(validation), { onConflict: "cache_key" });

    if (error) {
      console.warn("PLACES_CACHE_WRITE_FAILED_SOFT", {
        cacheKey: validation.cacheKey,
        errorCode: error.code,
        errorMessage: error.message
      });
    }
  }

  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return;
  }

  const localCache = await readLocalPlacesCache();
  localCache[validation.cacheKey] = validation;
  await mkdir(dirname(localPlacesCachePath), { recursive: true });
  await writeFile(localPlacesCachePath, JSON.stringify(localCache, null, 2));
}

async function readLocalPlacesCache(): Promise<Record<string, PlacesValidation>> {
  try {
    return JSON.parse(await readFile(localPlacesCachePath, "utf8")) as Record<string, PlacesValidation>;
  } catch {
    return {};
  }
}

function validationFromCacheRow(row: PlacesCacheRow): PlacesValidation {
  return {
    cacheKey: row.cache_key,
    inputName: row.input_name,
    normalizedInputName: row.normalized_input_name,
    status: row.status,
    canonicalName: row.canonical_name ?? undefined,
    placeId: row.place_id ?? undefined,
    formattedAddress: row.formatted_address ?? undefined,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    types: row.types ?? undefined,
    businessStatus: row.business_status ?? undefined,
    locationConfidence: row.location_confidence ?? 0,
    categoryConfidence: row.category_confidence ?? 0,
    nameConfidence: row.name_confidence ?? 0,
    overallConfidence: row.overall_confidence ?? 0,
    rejectionReason: row.rejection_reason ?? undefined,
    expiresAt: row.expires_at ?? new Date(Date.now() + rejectedCacheTtlMs).toISOString()
  };
}

function cacheRowFromValidation(validation: PlacesValidation): PlacesCacheRow {
  return {
    cache_key: validation.cacheKey,
    input_name: validation.inputName,
    normalized_input_name: validation.normalizedInputName,
    status: validation.status,
    canonical_name: validation.canonicalName,
    place_id: validation.placeId,
    formatted_address: validation.formattedAddress,
    latitude: validation.latitude,
    longitude: validation.longitude,
    types: validation.types,
    business_status: validation.businessStatus,
    location_confidence: validation.locationConfidence,
    category_confidence: validation.categoryConfidence,
    name_confidence: validation.nameConfidence,
    overall_confidence: validation.overallConfidence,
    rejection_reason: validation.rejectionReason,
    expires_at: validation.expiresAt
  };
}

function placesTextQuery(query: string, inputName: string) {
  return [cleanPlacesInputName(inputName), localCategoryLabelForPlaces(query), localLocationLabelForPlaces(query)].filter(Boolean).join(" ");
}

function placesCacheKey(query: string, inputName: string) {
  return ["places", "v1", placesCandidateKey(inputName), localLocationLabelForPlaces(query), localCategoryLabelForPlaces(query)].map(normalizeQuery).join(":");
}

function placesCandidateKey(value: string) {
  return cleanPlacesInputName(value)
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\b([a-z]{3,})\s+s\b/gi, "$1s")
    .replace(/\bof\s+(?:wantagh|seaford|massapequa|huntington|delray beach|nyc|ny|new york|brooklyn|manhattan|williamsburg)\b/gi, " ")
    .replace(/\b(?:restaurant|restaurants|bar|cafe|coffee shop|hotel|inn|pizzeria|pizza|italian|seafood|sushi|brunch|nyc|ny|new york|brooklyn|manhattan|williamsburg|wantagh|seaford|massapequa|huntington|delray beach|restaurateurs?|owners?|chef|founder)\b$/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function placesCandidateKeysAreDuplicate(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter / longer >= 0.62;
  }

  return placesDiceCoefficient(a, b) >= 0.88;
}

function placesDiceCoefficient(a: string, b: string) {
  const bigrams = (value: string) => {
    const compact = value.replace(/\s+/g, "");
    const grams = new Map<string, number>();
    for (let index = 0; index < compact.length - 1; index += 1) {
      const gram = compact.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
  };
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  const total = Array.from(aGrams.values()).reduce((sum, count) => sum + count, 0) + Array.from(bGrams.values()).reduce((sum, count) => sum + count, 0);
  let overlap = 0;

  for (const [gram, count] of aGrams.entries()) {
    overlap += Math.min(count, bGrams.get(gram) ?? 0);
  }

  return total > 0 ? (2 * overlap) / total : 0;
}

function cleanPlacesInputName(value: string) {
  return value
    .replace(/[’]/g, "'")
    .replace(/\s+\b(?:ny|nyc|new york|brooklyn|manhattan|williamsburg|wantagh|massapequa|seaford|huntington|delray beach|delray)\s+(?:restaurateurs?|owners?|chef|founder|team|group)\b$/i, "")
    .replace(/\s+\b(?:restaurateurs?|owners?|chef|founder|team|group)\b$/i, "")
    .replace(/\s+[-–—|:]\s+.*$/g, "")
    .replace(/\b(?:restaurant)\s*$/i, "")
    .replace(/\s+\b(?:wantagh|seaford|massapequa|huntington|delray beach|delray|ny|new york)\b$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPlacesCanonicalName(value: string) {
  return value
    .replace(/[’]/g, "'")
    .replace(/\s+\b(?:restaurant)\b$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreNameMatch(inputName: string, displayName: string) {
  const input = placesCandidateKey(inputName);
  const display = placesCandidateKey(displayName);

  if (!input || !display) return 0;
  if (input === display) return 1;
  if (input.includes(display) || display.includes(input)) return 0.9;

  const inputTokens = new Set(input.split(/\s+/).filter(Boolean));
  const displayTokens = new Set(display.split(/\s+/).filter(Boolean));
  const overlap = Array.from(inputTokens).filter((token) => displayTokens.has(token)).length;
  const denominator = Math.max(inputTokens.size, displayTokens.size, 1);

  return overlap / denominator;
}

function scoreLocationMatch(query: string, formattedAddress: string) {
  const tokens = localLocationTokensForPlaces(query);

  if (!tokens.length) return 0.65;

  const address = normalizeQuery(formattedAddress);
  const matched = tokens.filter((token) => address.includes(token)).length;

  if (matched === tokens.length) return 1;
  if (matched > 0) return 0.72;
  if (/\bnew york\b/.test(address) && tokens.some((token) => ["nyc", "manhattan", "brooklyn", "williamsburg"].includes(token))) return 0.78;
  return 0.12;
}

function scoreCategoryMatch(query: string, types: string[], displayName: string) {
  const category = localCategoryForPlaces(query);
  const normalizedTypes = normalizeQuery(types.join(" "));
  const normalizedName = normalizeQuery(displayName);

  if (category === "hotel") return /\b(lodging|hotel|motel|resort|inn)\b/.test(normalizedTypes) ? 1 : 0.05;
  if (category === "coffee") return /\b(cafe|coffee_shop|bakery|restaurant|food|store)\b/.test(normalizedTypes) || /\b(coffee|cafe|espresso|roaster)\b/.test(normalizedName) ? 1 : 0.15;
  if (category === "bar") return /\b(bar|night_club|restaurant|food)\b/.test(normalizedTypes) || /\b(bar|cocktail|pub|lounge|tavern)\b/.test(normalizedName) ? 1 : 0.15;
  if (category === "service")
    return /\b(plumber|electrician|roofing_contractor|general_contractor|laundry|car_repair|health|doctor|dentist|tattoo_shop)\b/.test(normalizedTypes) ||
      /\b(tattoo|ink|body art)\b/.test(normalizedName)
      ? 1
      : 0.15;
  if (category === "restaurant") return /\b(restaurant|food|meal_takeaway|meal_delivery|bar|cafe|bakery)\b/.test(normalizedTypes) ? 1 : 0.15;
  return /\b(point_of_interest|establishment|store|food|restaurant|lodging)\b/.test(normalizedTypes) ? 0.8 : 0.45;
}

function isNonBusinessPlace(types: string[]) {
  const normalizedTypes = normalizeQuery(types.join(" "));
  const hasBusinessType = /\b(point_of_interest|establishment|restaurant|food|bar|cafe|bakery|lodging|store|dentist|doctor|plumber|health|tourist_attraction)\b/.test(
    normalizedTypes
  );
  const hasLocationOnlyType = /\b(neighborhood|locality|political|administrative_area|postal_code|route|street_address|geocode)\b/.test(normalizedTypes);

  return hasLocationOnlyType && !hasBusinessType;
}

function localLocationLabelForPlaces(query: string) {
  const parsedIntent = parseLocalIntent(query);

  if (parsedIntent.locationForSearch) return parsedIntent.locationForSearch;

  const normalized = normalizeLocalQueryIntent(query);
  if (/\bnyc\b/.test(normalized)) return "New York City, NY";
  if (/\bmanhattan\b/.test(normalized)) return "Manhattan, NY";
  if (/\bbrooklyn\b/.test(normalized)) return "Brooklyn, NY";
  if (/\bqueens\b/.test(normalized)) return "Queens, NY";
  return "";
}

function localLocationTokensForPlaces(query: string) {
  const label = normalizeQuery(localLocationLabelForPlaces(query));
  const expanded = label
    .replace(/\bnyc\b/g, "new york")
    .replace(/\bnew york city\b/g, "new york")
    .replace(/\bdelray\b/g, "delray beach");

  return expanded
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !["best", "top", "restaurant", "restaurants", "bar", "coffee", "hotel", "near"].includes(token));
}

function localCategoryLabelForPlaces(query: string) {
  const parsedIntent = parseLocalIntent(query);
  const normalized = normalizeLocalQueryIntent(parsedIntent.category || query);

  if (/\b(italian|sushi|seafood|pizza|brunch|ramen|tacos?|mexican|steakhouse)\b/.test(normalized)) {
    return `${normalized.match(/\b(italian|sushi|seafood|pizza|brunch|ramen|tacos?|mexican|steakhouse)\b/)?.[1]} restaurant`;
  }
  if (/\b(espresso martini|cocktail bar|cocktail)\b/.test(normalized)) return "cocktail bar";
  if (/\b(bar|pub)\b/.test(normalized)) return "bar";
  if (/\b(coffee|cafe)\b/.test(normalized)) return "coffee shop";
  if (/\b(hotel|hotels)\b/.test(normalized)) return "hotel";
  if (/\b(tattoo shop|tattoo studio|tattoo)\b/.test(normalized)) return "tattoo shop";
  if (/\b(dentist|dental|plumber|plumbing|gym|fitness)\b/.test(normalized)) return normalized.match(/\b(dentist|dental|plumber|plumbing|gym|fitness)\b/)?.[1] ?? "local business";
  if (/\b(restaurant|restaurants)\b/.test(normalized)) return "restaurant";
  return "local business";
}

function localCategoryForPlaces(query: string) {
  const label = localCategoryLabelForPlaces(query);

  if (/\bhotel\b/.test(label)) return "hotel";
  if (/\bcoffee|cafe\b/.test(label)) return "coffee";
  if (/\bbar|cocktail|pub\b/.test(label)) return "bar";
  if (/\bdentist|dental|plumber|plumbing|gym|fitness|tattoo\b/.test(label)) return "service";
  if (/\brestaurant|italian|sushi|seafood|pizza|brunch|ramen|taco|mexican|steakhouse\b/.test(label)) return "restaurant";
  return "place";
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
