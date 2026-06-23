import { createClient } from "@supabase/supabase-js";

export function getSupabaseAdmin() {
  const url = getFinalSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function getSupabaseConfigSnapshot() {
  const rawUrl = getRawSupabaseUrl();
  const finalUrl = getFinalSupabaseUrl();

  return {
    hasUrl: Boolean(finalUrl),
    hasAnonKey: Boolean(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    rawSupabaseUrl: rawUrl,
    finalSupabaseUrl: finalUrl,
    searchCacheUrl: finalUrl ? `${finalUrl}/rest/v1/search_cache` : null
  };
}

function getRawSupabaseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
}

function getFinalSupabaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const validCandidate = candidates.find(isValidSupabaseProjectUrl);

  if (validCandidate) {
    return validCandidate.replace(/\/+$/, "");
  }

  const rawUrl = candidates[0];

  if (!rawUrl) {
    return "";
  }

  return completeSupabaseProjectUrl(rawUrl);
}

function isValidSupabaseProjectUrl(value: string) {
  try {
    return new URL(value).hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

function completeSupabaseProjectUrl(value: string) {
  try {
    const parsed = new URL(value);

    if (!parsed.hostname.includes(".") && /^[a-z0-9]{20}$/i.test(parsed.hostname)) {
      parsed.hostname = `${parsed.hostname}.supabase.co`;
      return parsed.origin;
    }

    return value.replace(/\/+$/, "");
  } catch {
    if (/^[a-z0-9]{20}$/i.test(value)) {
      return `https://${value}.supabase.co`;
    }

    return value;
  }
}
