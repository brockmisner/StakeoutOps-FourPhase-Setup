import { describe, expect, it } from "vitest";

import { arePublicSignupsAllowed } from "@/lib/auth/signup-policy";

describe("public signup policy", () => {
  it("is disabled when the environment variable is absent", () => {
    expect(arePublicSignupsAllowed(undefined)).toBe(false);
  });

  it("is enabled only by the exact literal true", () => {
    expect(arePublicSignupsAllowed("true")).toBe(true);
    expect(arePublicSignupsAllowed("TRUE")).toBe(false);
    expect(arePublicSignupsAllowed(" true ")).toBe(false);
    expect(arePublicSignupsAllowed("1")).toBe(false);
    expect(arePublicSignupsAllowed("false")).toBe(false);
  });
});
