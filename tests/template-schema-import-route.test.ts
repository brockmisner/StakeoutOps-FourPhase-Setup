import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
  requireSchedulerManager: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
  requireSchedulerManager: auth.requireSchedulerManager,
}));

import { POST } from "@/app/api/inventory/template-schemas/route";
import { extractDuoPlusTemplateConfigSchema } from "@/lib/duoplus/template-schema";

function context() {
  const updates: unknown[] = [];
  const filters: Array<[string, unknown]> = [];
  const selectQuery = {
    select: vi.fn(() => selectQuery),
    eq: vi.fn((key: string, value: unknown) => {
      filters.push([key, value]);
      return selectQuery;
    }),
    then: <TResult1 = { data: unknown[]; error: null }>(
      onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    ) => Promise.resolve({
      data: [{
        id: "00000000-0000-4000-8000-000000000201",
        name: "$ Chrome AIO + Local Pack GBP Click",
        template_type: 2,
      }],
      error: null,
    }).then(onfulfilled),
  };
  const updateQuery = {
    eq: vi.fn((key: string, value: unknown) => {
      filters.push([key, value]);
      return updateQuery;
    }),
    then: <TResult1 = { error: null }>(
      onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    ) => Promise.resolve({ error: null as null }).then(onfulfilled),
  };
  const admin = {
    from: vi.fn(() => ({
      select: selectQuery.select,
      update: vi.fn((value: unknown) => {
        updates.push(value);
        return updateQuery;
      }),
    })),
  };
  return {
    admin,
    updates,
    filters,
    authContext: {
      demo: false as const,
      user: { id: "user-a", email: "owner@example.test" },
      organizationId: "org-a",
      role: "owner",
      admin,
    },
  };
}

describe("template input schema import API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches a downloaded copy filename and stores only the compact input schema", async () => {
    const setup = context();
    auth.requireOrganization.mockResolvedValue(setup.authContext);
    const schema = extractDuoPlusTemplateConfigSchema({
      config: [{ key: "search_term", value: "plumber", type: "string", required: true }],
      nodes: [{ data: { text: "${search_term}" } }],
    }, "$ Chrome AIO + Local Pack GBP Click (1).json");

    const response = await POST(new Request("https://app.test/api/inventory/template-schemas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exports: [{ fileName: schema.sourceName, schema }] }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        updated: [{
          id: "00000000-0000-4000-8000-000000000201",
          inputCount: 1,
        }],
        unmatched: [],
      },
    });
    expect(auth.requireSchedulerManager).toHaveBeenCalledTimes(1);
    expect(setup.updates).toHaveLength(1);
    expect(setup.updates[0]).toMatchObject({
      config_schema: { schemaVersion: 1, inputs: [{ key: "search_term" }] },
    });
    expect(setup.filters).toContainEqual(["organization_id", "org-a"]);
  });
});

