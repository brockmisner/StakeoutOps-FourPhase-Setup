import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "@/app/api/health/route";

describe("health route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the explicit sample as read-only, not operationally ready", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("INTEGRATION_ENCRYPTION_KEY", "");
    vi.stubEnv("CRON_SECRET", "");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, ready: false, mode: "demo" });
  });

  it("reports live readiness only when every server requirement exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value_over_twenty_chars");
    vi.stubEnv(
      "INTEGRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 7).toString("base64"),
    );
    vi.stubEnv("CRON_SECRET", "cron-test-secret-with-at-least-20-chars");

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      ready: true,
      mode: "live",
      checks: {
        supabaseBrowser: true,
        supabaseServer: true,
        credentialEncryption: true,
        cronAuthentication: true,
      },
    });
  });
});
