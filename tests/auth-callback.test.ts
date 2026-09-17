import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession: dependencies.exchangeCodeForSession },
  }),
}));

import { GET } from "@/app/auth/callback/route";

describe("authentication callbacks behind Railway's proxy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dependencies.exchangeCodeForSession.mockResolvedValue({ error: null });
  });

  it("returns missing-code errors to the browser's public origin", async () => {
    const response = await GET(new Request("https://0.0.0.0:8080/auth/callback"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?error=missing_code");
    expect(dependencies.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges a code and returns to the requested same-site page", async () => {
    const response = await GET(new Request(
      "https://0.0.0.0:8080/auth/callback?code=test-code&next=%2Fruns%3Fstate%3Dwaiting",
    ));
    expect(dependencies.exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/runs?state=waiting");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps an invalid-code error on the public site", async () => {
    dependencies.exchangeCodeForSession.mockResolvedValue({ error: new Error("Invalid code") });
    const response = await GET(new Request("https://0.0.0.0:8080/auth/callback?code=expired"));
    expect(response.headers.get("location")).toBe("/login?error=invalid_callback");
  });

  it("keeps a provider failure on the public site", async () => {
    dependencies.exchangeCodeForSession.mockRejectedValue(new Error("Unavailable"));
    const response = await GET(new Request("https://0.0.0.0:8080/auth/callback?code=test-code"));
    expect(response.headers.get("location")).toBe("/login?error=auth_unavailable");
  });

  it("does not follow an external next destination", async () => {
    const response = await GET(new Request(
      "https://0.0.0.0:8080/auth/callback?code=test-code&next=https%3A%2F%2Fattacker.example",
    ));
    expect(response.headers.get("location")).toBe("/");
  });
});
