import { createClient } from "@supabase/supabase-js";

export function getSupabaseAdmin() {
  const url = getSupabaseUrl();
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
  const url = getSupabaseUrl();

  return {
    hasUrl: Boolean(url),
    hasAnonKey: Boolean(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    searchCacheUrl: url ? `${url.replace(/\/+$/, "")}/rest/v1/search_cache` : null
  };
}

function getSupabaseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
}
