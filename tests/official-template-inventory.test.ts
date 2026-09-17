import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
  requireSchedulerManager: vi.fn(),
  createOrganizationDuoClient: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: auth.requireOrganization,
  requireSchedulerManager: auth.requireSchedulerManager,
}));

vi.mock("@/lib/auth/duoplus", () => ({
  createOrganizationDuoClient: auth.createOrganizationDuoClient,
}));

import { POST as syncInventory } from "@/app/api/inventory/sync/route";
import {
  DUOPLUS_ENDPOINTS,
  DuoPlusClient,
  DuoPlusPaginationError,
} from "@/lib/duoplus";

function pagedRows(prefix: string, start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${start + index}`,
    name: `${prefix} template ${start + index}`,
  }));
}

function createAdmin() {
  const phoneUpsert = vi.fn().mockResolvedValue({ error: null });
  const connectionUpdate = vi.fn();
  const from = vi.fn((table: string) => {
    if (table === "duo_phones") return { upsert: phoneUpsert };
    if (table === "duo_templates") {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        then: <TResult1 = { data: never[]; error: null }>(
          onfulfilled?: ((value: { data: never[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        ) => Promise.resolve({ data: [] as never[], error: null as null }).then(onfulfilled),
      };
      return query;
    }
    if (table === "duo_connections") {
      const query = {
        eq: vi.fn(() => query),
        lte: vi.fn(() => query),
        or: vi.fn(() => query),
        then: <TResult1 = { error: null }>(
          onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        ) => Promise.resolve({ error: null as null }).then(onfulfilled),
      };
      return {
        update: vi.fn((value: unknown) => {
          connectionUpdate(value);
          return query;
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
  const rpc = vi.fn().mockResolvedValue({
    data: [{ saved_count: 2, disabled_count: 0 }],
    error: null,
  });
  return { from, rpc, phoneUpsert, connectionUpdate };
}

describe("DuoPlus complete inventory pagination", () => {
  it("accepts a documented empty list as complete inventory", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: { list: [], page: 1, total: 0, total_page: 0 },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).resolves.toEqual([]);
  });

  it("rejects a code-200 payload without a list instead of replacing inventory with empty", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 200, data: { message: "success" } }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusApiError",
      retryable: true,
      message: expect.stringContaining("invalid list payload"),
    });
  });

  it("rejects a non-success HTTP response even when its body says code 200", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 200, data: { list: [] } }),
        { status: 503 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusApiError",
      httpStatus: 503,
      retryable: true,
    });
  });

  it("loads every official-template page at 100 rows and deduplicates by remote id", async () => {
    const firstPage = pagedRows("official", 1, 100);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain(DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST);
      const body = JSON.parse(String(init?.body)) as { page: number; pagesize: number };
      const list = body.page === 1
        ? firstPage
        : [firstPage[99], { id: "official-101", name: "Last official" }];
      return new Response(
        JSON.stringify({
          code: 200,
          data: { list, page: body.page, pagesize: 100, total: 101, total_page: 2 },
        }),
        { status: 200 },
      );
    });
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl: fetchMock as typeof fetch,
      minGapMs: 0,
    });

    const templates = await client.listOfficialTemplates();

    expect(templates).toHaveLength(101);
    expect(templates.at(-1)).toMatchObject({ id: "official-101" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([
        { page: 1, pagesize: 100 },
        { page: 2, pagesize: 100 },
      ]);
  });

  it("fails closed when DuoPlus repeats a page before its reported total", async () => {
    const firstPage = pagedRows("custom", 1, 100);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      return new Response(
        JSON.stringify({
          code: 200,
          data: { list: firstPage, page: body.page, total: 200, total_page: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listUserTemplates()).rejects.toMatchObject({
      name: "DuoPlusPaginationError",
      retryable: true,
      message: expect.stringContaining("repeated rows before completion"),
    });
  });

  it.each([
    ["missing", { name: "Missing id" }],
    ["empty", { id: "", name: "Empty id" }],
    ["blank", { id: "   ", name: "Blank id" }],
    ["non-string", { id: 42, name: "Numeric id" }],
  ])("fails closed when an inventory row has a %s remote id", async (_label, badRow) => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            list: [{ id: "official-1", name: "Valid" }, badRow],
            page: 1,
            total: 2,
            total_page: 1,
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusPaginationError",
      retryable: true,
      message: expect.stringContaining("nonblank string id"),
    });
  });

  it("fails closed when reported row and page totals disagree", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            list: pagedRows("official", 1, 100),
            page: 1,
            pagesize: 100,
            total: 100,
            total_page: 2,
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusPaginationError",
      message: expect.stringContaining("before reported page 2"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when zero reported pages contain rows", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            list: [{ id: "unexpected", name: "Unexpected template" }],
            page: 1,
            total_page: 0,
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusPaginationError",
      message: expect.stringContaining("zero pages"),
    });
  });

  it("fails closed at the request safety cap instead of returning a partial catalog", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      return new Response(
        JSON.stringify({
          code: 200,
          data: { list: pagedRows(`page-${body.page}`, 1, 100) },
        }),
        { status: 200 },
      );
    });
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl: fetchMock as typeof fetch,
      minGapMs: 0,
    });

    await expect(client.listOfficialTemplates()).rejects.toMatchObject({
      name: "DuoPlusPaginationError",
      message: expect.stringContaining("more than 4000 rows"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it("paginates cloud phones instead of requesting an unsupported 1000-row page", async () => {
    const firstPage = pagedRows("phone", 1, 100).map((phone) => ({
      ...phone,
      status: 1,
    }));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number; pagesize: number };
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            list: body.page === 1 ? firstPage : [{ id: "phone-101", status: 2 }],
            page: body.page,
            total: 101,
            total_page: 2,
          },
        }),
        { status: 200 },
      );
    });
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-a",
      fetchImpl: fetchMock as typeof fetch,
      minGapMs: 0,
    });

    await expect(client.listAllPhones()).resolves.toHaveLength(101);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([
        { page: 1, pagesize: 100 },
        { page: 2, pagesize: 100 },
      ]);
  });
});

describe("official and custom template inventory replacement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves both sources without colliding ids and maps official desc", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const admin = createAdmin();
    auth.requireOrganization.mockResolvedValue({
      demo: false,
      user: { id: "user-a", email: "friend@example.test" },
      organizationId: "org-a",
      role: "owner",
      admin,
    });
    auth.createOrganizationDuoClient.mockResolvedValue({
      connection: { id: "connection-a" },
      client: {
        listAllPhones: vi.fn().mockResolvedValue([
          {
            id: "phone-a",
            name: "Phone A",
            status: 1,
            ip: "",
            expired_at: "1791132379",
          },
        ]),
        listUserTemplates: vi.fn().mockResolvedValue([
          {
            id: "shared-id",
            name: "Warming",
            config: { password: "must-not-be-stored" },
          },
        ]),
        listOfficialTemplates: vi.fn().mockResolvedValue([
          { id: "shared-id", name: "Warming", desc: "Official description" },
        ]),
        getSubscriptionStartupCapacity: vi.fn().mockResolvedValue({
          total: 2,
          inUse: 1,
          available: 1,
        }),
      },
    });

    const response = await syncInventory(
      new Request("https://app.test/api/inventory/sync", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        phoneCount: 1,
        templateCount: 2,
        customTemplateCount: 1,
        officialTemplateCount: 1,
      },
    });

    expect(admin.rpc).toHaveBeenCalledTimes(3);
    expect(admin.rpc).toHaveBeenCalledWith(
      "replace_duoplus_phone_inventory",
      expect.objectContaining({
        p_organization_id: "org-a",
        p_connection_id: "connection-a",
        p_phones: [
          expect.objectContaining({
            duoplus_image_id: "phone-a",
            name: "Phone A",
            ip_address: null,
            expired_at: new Date(1_791_132_379_000).toISOString(),
          }),
        ],
      }),
    );
    expect(admin.rpc).toHaveBeenCalledWith(
      "replace_duoplus_template_inventory",
      expect.objectContaining({
        p_organization_id: "org-a",
        p_connection_id: "connection-a",
        p_template_types: [1, 2],
        p_templates: expect.arrayContaining([
          expect.objectContaining({
            duoplus_template_id: "shared-id",
            template_type: 2,
            enabled: true,
          }),
          expect.objectContaining({
            duoplus_template_id: "shared-id",
            template_type: 1,
            description: "Official description",
            enabled: true,
          }),
        ]),
      }),
    );
    expect(admin.rpc).toHaveBeenCalledWith(
      "get_duoplus_capacity_snapshot",
      {
        p_connection_id: "connection-a",
        p_organization_id: "org-a",
      },
    );
    const templateReplacementCall = admin.rpc.mock.calls.find(
      ([name]) => name === "replace_duoplus_template_inventory",
    );
    expect(JSON.stringify(templateReplacementCall?.[1])).not.toContain(
      "must-not-be-stored",
    );

    const entries = infoLog.mock.calls.map(([entry]) => entry);
    expect(entries).toContainEqual({
      event: "duoplus_inventory_sync",
      stage: "complete",
      outcome: "succeeded",
      duration_ms: expect.any(Number),
      phone_count: 1,
      custom_template_count: 1,
      official_template_count: 1,
      template_count: 2,
      subscription_capacity: 2,
      subscription_in_use: 1,
      subscription_available: 1,
    });
    const serializedEntries = JSON.stringify(entries);
    for (const forbidden of [
      "friend@example.test",
      "phone-a",
      "Phone A",
      "shared-id",
      "Warming",
      "must-not-be-stored",
      "https://app.test/api/inventory/sync",
    ]) {
      expect(serializedEntries).not.toContain(forbidden);
    }
    infoLog.mockRestore();
  });

  it("does not touch database inventory after an incomplete upstream page set", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = createAdmin();
    auth.requireOrganization.mockResolvedValue({
      demo: false,
      user: { id: "user-a", email: "friend@example.test" },
      organizationId: "org-a",
      role: "owner",
      admin,
    });
    auth.createOrganizationDuoClient.mockResolvedValue({
      connection: { id: "connection-a" },
      client: {
        listAllPhones: vi.fn().mockResolvedValue([]),
        listUserTemplates: vi.fn().mockResolvedValue([]),
        listOfficialTemplates: vi.fn().mockRejectedValue(
          new DuoPlusPaginationError({
            endpoint: DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST,
            resource: "Official template",
            reason: "page 2 repeated rows before completion",
          }),
        ),
        getSubscriptionStartupCapacity: vi.fn(),
      },
    });

    const response = await syncInventory(
      new Request("https://app.test/api/inventory/sync", { method: "POST" }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVENTORY_SYNC_INCOMPLETE",
        message: expect.stringContaining("Previously synced inventory was preserved"),
      },
    });
    expect(admin.from).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith({
      event: "duoplus_inventory_sync",
      stage: "fetch_official_templates",
      outcome: "failed",
      duration_ms: expect.any(Number),
      error_category: "pagination",
      error_code: "INVENTORY_SYNC_INCOMPLETE",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      DUOPLUS_ENDPOINTS.OFFICIAL_TEMPLATE_LIST,
    );
    infoLog.mockRestore();
    errorLog.mockRestore();
  });

  it("keeps stale disabling organization, connection, and template-source scoped", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260905205500_duoplus_official_template_inventory.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("template.organization_id = p_organization_id");
    expect(migration).toContain("template.connection_id = p_connection_id");
    expect(migration).toContain("template.template_type = any(p_template_types)");
    expect(migration).toContain("template.last_synced_at is distinct from p_synced_at");
    expect(migration).toContain("on conflict (connection_id, duoplus_template_id, template_type)");
  });

  it("reconciles phones as a complete tenant-scoped provider snapshot", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260905214500_atomic_inventory_and_run_now.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("replace_duoplus_phone_inventory");
    expect(migration).toContain("phone.organization_id = p_organization_id");
    expect(migration).toContain("phone.connection_id = p_connection_id");
    expect(migration).toContain("'provider_present', false");
    expect(migration).toContain("enabled = false");
  });
});
