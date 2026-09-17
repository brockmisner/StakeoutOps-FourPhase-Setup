import { NextResponse } from "next/server";

import { safeAuthNext } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = safeAuthNext(url.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url.origin));
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL("/login?error=invalid_callback", url.origin),
      );
    }
  } catch {
    return NextResponse.redirect(
      new URL("/login?error=auth_unavailable", url.origin),
    );
  }

  return NextResponse.redirect(new URL(destination, url.origin));
}
