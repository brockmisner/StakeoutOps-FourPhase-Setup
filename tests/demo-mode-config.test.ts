import { afterEach, describe, expect, it, vi } from "vitest";

import { isDemoMode } from "@/lib/supabase/config";

describe("demo-mode configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never enables demo mode implicitly when configuration is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    expect(isDemoMode()).toBe(false);
  });

  it("enables the sample only through an explicit true opt-in", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    expect(isDemoMode()).toBe(true);
  });

  it("fails closed instead of mixing a live browser with a demo server", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    expect(isDemoMode()).toBe(false);
  });
});
