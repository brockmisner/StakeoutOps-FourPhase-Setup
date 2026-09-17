import "server-only";

import { redirect } from "next/navigation";

import { isDemoMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Defense-in-depth for protected Server Component pages. proxy.ts refreshes the
 * session cookie; this helper performs the authorization check at render time.
 */
export async function requirePageUser() {
  if (isDemoMode()) return null;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) return user;
  } catch {
    // A deployment without working auth must fail closed.
  }

  redirect("/login");
}
