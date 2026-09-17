import { describe, expect, it } from "vitest";

import {
  createAuthCallbackUrl,
  legacyRootCodeCallback,
  safeAuthNext,
} from "@/lib/auth/redirect";

describe("Supabase Auth redirects", () => {
  it("builds the callback from the deployment that initiated authentication", () => {
    expect(
      createAuthCallbackUrl(
        "https://stakeout-preview-team.vercel.app",
        "/runs?state=waiting",
      ),
    ).toBe(
      "https://stakeout-preview-team.vercel.app/auth/callback?next=%2Fruns%3Fstate%3Dwaiting",
    );
  });

  it("rejects external and backslash-based next destinations", () => {
    expect(safeAuthNext("https://attacker.example/path")).toBe("/");
    expect(safeAuthNext("//attacker.example/path")).toBe("/");
    expect(safeAuthNext("/%5cattacker.example/path")).toBe("/");
    expect(safeAuthNext("/safe/path?tab=1#proof")).toBe(
      "/safe/path?tab=1#proof",
    );
  });

  it("recovers a code returned to the configured Site URL root", () => {
    const source = new URL("https://stakeout-ops.vercel.app/?code=test-code");
    expect(legacyRootCodeCallback(source)?.toString()).toBe(
      "https://stakeout-ops.vercel.app/auth/callback?code=test-code",
    );
    expect(
      legacyRootCodeCallback(
        new URL("https://stakeout-ops.vercel.app/login?code=test-code"),
      ),
    ).toBeNull();
  });
});
