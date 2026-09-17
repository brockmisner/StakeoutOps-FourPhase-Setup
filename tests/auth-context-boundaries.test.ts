import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dependencies = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createServerClient: vi.fn(),
  demoMode: vi.fn(() => false),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: dependencies.createAdminClient,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: dependencies.createServerClient,
}));

vi.mock("@/lib/supabase/config", () => ({
  isDemoMode: dependencies.demoMode,
}));

import {
  requireOrganization,
  requireSchedulerManager,
  requireWorkspaceAdmin,
} from "@/lib/auth/context";

function membershipAdmin(
  memberships: Array<{ organization_id: string; role: string }>,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockResolvedValue({ data: memberships, error: null });

  return {
    from: vi.fn((table: string) => {
      expect(table).toBe("organization_members");
      return query;
    }),
    query,
  };
}

describe("organization authorization boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.demoMode.mockReturnValue(false);
  });

  it("rejects an unauthenticated request before any service-role query", async () => {
    const admin = membershipAdmin([]);
    dependencies.createAdminClient.mockReturnValue(admin);
    dependencies.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new Error("No session"),
        }),
      },
      rpc: vi.fn(),
    });

    await expect(
      requireOrganization(new Request("https://app.test/api/device-cycles")),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });

    expect(admin.from).not.toHaveBeenCalled();
  });

  it("rejects a requested workspace that is not in the user's memberships", async () => {
    const admin = membershipAdmin([
      { organization_id: "org-owned", role: "owner" },
    ]);
    dependencies.createAdminClient.mockReturnValue(admin);
    dependencies.createServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: "user-1",
              email: "owner@example.test",
              user_metadata: {},
            },
          },
          error: null,
        }),
      },
      rpc: vi.fn(),
    });

    await expect(
      requireOrganization(
        new Request("https://app.test/api/device-cycles", {
          headers: { "x-organization-id": "org-other" },
        }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_ACCESS_DENIED",
    });

    expect(admin.query.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("rejects fake mutations in a read-only demo workspace", () => {
    const demoContext = {
      demo: true as const,
      user: { id: "demo-user" as const, email: "preview@stakeout.local" as const },
      organizationId: "demo-workspace" as const,
      role: "owner" as const,
      admin: null,
    };

    expect(() => requireWorkspaceAdmin(demoContext)).toThrowError(
      expect.objectContaining({ code: "DEMO_MODE_READ_ONLY", status: 409 }),
    );
    expect(() => requireSchedulerManager(demoContext)).toThrowError(
      expect.objectContaining({ code: "DEMO_MODE_READ_ONLY", status: 409 }),
    );
  });
});
