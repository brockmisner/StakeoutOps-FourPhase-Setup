import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabaseServerConfig } from "./config";

export function createSupabaseAdminClient() {
  const { url, secretKey } = getSupabaseServerConfig();

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
