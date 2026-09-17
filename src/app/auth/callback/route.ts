import { NextResponse } from "next/server";

import { safeAuthNext } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function redirectWithinSite(path: string) {
  // Railway's internal request origin can be 0.0.0.0:8080. A relative
  // Location keeps both successful and failed callbacks on the public site.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = safeAuthNext(url.searchParams.get("next"));

  if (!code) {
    return redirectWithinSite("/login?error=missing_code");
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return redirectWithinSite("/login?error=invalid_callback");
    }
  } catch {
    return redirectWithinSite("/login?error=auth_unavailable");
  }

  return redirectWithinSite(destination);
}
