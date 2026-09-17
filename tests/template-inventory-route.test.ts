import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
}));

import { GET as getTemplates } from "@/app/api/inventory/templates/route";

type TemplateFixture = {
  id: string;
  organization_id: string;
  connection_id: string;
  duoplus_template_id: string;
  template_type: 1 | 2;
  name: string;
  description: string | null;
  enabled: boolean;
  last_synced_at: string;
};

function makeTemplate(index: number): TemplateFixture {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organization_id: "org-a",
    connection_id: "connection-a",
    duoplus_template_id: `remote-${index}`,
    template_type: index % 2 === 0 ? 1 : 2,
    name: `Template ${String(index).padStart(4, "0")}`,
    description: null,
    enabled: true,
    last_synced_at: "2026-09-05T00:00:00.000Z",
  };
}

function inventoryAdmin(
  rows: TemplateFixture[],
  errorAtFrom: number | null = null,
) {
  const ranges: Array<[number, number]> = [];
  const tenantFilters: Array<[string, unknown]> = [];
  const from = vi.fn((table: string) => {
    expect(table).toBe("duo_templates");
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        tenantFilters.push([column, value]);
        return query;
      }),
      order: vi.fn(() => query),
      range: vi.fn(async (start: number, end: number) => {
        ranges.push([start, end]);
        if (start === errorAtFrom) {
          return { data: null, error: { message: "database unavailable" } };
        }
        return { data: rows.slice(start, end + 1), error: null };
      }),
    };
    return query;
  });
  return { from, ranges, tenantFilters };
}

function liveContext(admin: unknown) {
  return {
    demo: false as const,
    user: { id: "user-a", email: "owner@example.test" },
    organizationId: "org-a",
    role: "owner",
    admin,
  };
}

describe("template inventory API database pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns templates beyond Supabase's default 1,000-row response cap", async () => {
    const admin = inventoryAdmin(
      Array.from({ length: 1_001 }, (_, index) => makeTemplate(index + 1)),
    );
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getTemplates(
      new Request("https://app.test/api/inventory/templates"),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.templates).toHaveLength(1_001);
    expect(payload.data.templates.at(-1)).toMatchObject({
      id: makeTemplate(1_001).id,
      duoplusTemplateId: "remote-1001",
      templateType: 2,
      templateSource: "custom",
    });
    expect(admin.ranges).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
    expect(admin.tenantFilters).toEqual([
      ["organization_id", "org-a"],
      ["organization_id", "org-a"],
    ]);
  });

  it("fails closed instead of returning a partial catalog after a later-page error", async () => {
    const admin = inventoryAdmin(
      Array.from({ length: 1_001 }, (_, index) => makeTemplate(index + 1)),
      1_000,
    );
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getTemplates(
      new Request("https://app.test/api/inventory/templates"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "TEMPLATE_LIST_FAILED",
        message: "Templates could not be loaded.",
      },
    });
    expect(admin.ranges).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
  });

  it("stops at the 50-page safety bound and never labels a partial result complete", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) =>
      makeTemplate(index + 1),
    );
    const ranges: Array<[number, number]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(async (start: number, end: number) => {
        ranges.push([start, end]);
        return { data: page, error: null };
      }),
    };
    const admin = { from: vi.fn(() => query) };
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getTemplates(
      new Request("https://app.test/api/inventory/templates"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TEMPLATE_LIST_TOO_LARGE" },
    });
    expect(ranges).toHaveLength(50);
    expect(ranges.at(-1)).toEqual([49_000, 49_999]);
  });
});
