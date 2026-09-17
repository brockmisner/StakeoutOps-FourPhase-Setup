import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireOrganization: vi.fn(),
  requireWorkspaceAdmin: vi.fn(),
  getDefaultDuoConnection: vi.fn(),
  createDuoPlusClient: vi.fn(),
  encryptDuoPlusApiKey: vi.fn(),
  ensureDuoPlusCapacityPool: vi.fn(),
  saveVerifiedDuoPlusConnection: vi.fn(),
  setDuoPlusCapacityLimit: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  requireOrganization: mocks.requireOrganization,
  requireWorkspaceAdmin: mocks.requireWorkspaceAdmin,
}));

vi.mock("@/lib/auth/duoplus", () => ({
  getDefaultDuoConnection: mocks.getDefaultDuoConnection,
}));

vi.mock("@/lib/duoplus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/duoplus")>();
  return {
    ...actual,
    createDuoPlusClient: mocks.createDuoPlusClient,
    encryptDuoPlusApiKey: mocks.encryptDuoPlusApiKey,
    ensureDuoPlusCapacityPool: mocks.ensureDuoPlusCapacityPool,
    saveVerifiedDuoPlusConnection: mocks.saveVerifiedDuoPlusConnection,
    setDuoPlusCapacityLimit: mocks.setDuoPlusCapacityLimit,
  };
});

import {
  PATCH as updateDuoPlusCapacity,
  POST as connectDuoPlus,
} from "@/app/api/integrations/duoplus/route";
import { DuoPlusApiError, DuoPlusCapacityRpcError } from "@/lib/duoplus";

function connectAdmin() {
  const savedValues: unknown[] = [];
  const insert = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn((value: unknown) => {
    savedValues.push(value);
    const query = {
      eq: vi.fn(() => query),
      then: <TResult1 = { error: null }>(
        onfulfilled?:
          | ((value: { error: null }) => TResult1 | PromiseLike<TResult1>)
          | null,
      ) => Promise.resolve({ error: null as null }).then(onfulfilled),
    };
    return query;
  });
  const from = vi.fn((table: string) => {
    expect(table).toBe("duo_connections");
    return { insert, update };
  });
  return { from, rpc: vi.fn(), insert, update, savedValues };
}

function liveContext(admin: ReturnType<typeof connectAdmin>) {
  return {
    demo: false as const,
    user: { id: "user-sensitive", email: "owner-sensitive@example.test" },
    organizationId: "organization-sensitive",
    role: "owner" as const,
    admin,
  };
}

describe("DuoPlus route observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDefaultDuoConnection.mockResolvedValue(null);
    mocks.encryptDuoPlusApiKey.mockReturnValue({
      ciphertext: "ciphertext-sensitive",
      iv: "iv-sensitive",
      authTag: "auth-tag-sensitive",
    });
    mocks.ensureDuoPlusCapacityPool.mockResolvedValue({
      poolId: "pool-sensitive",
      workerCapacityLimit: 3,
      activeWorkerCount: 0,
      availableWorkerSlots: 3,
    });
    mocks.saveVerifiedDuoPlusConnection.mockResolvedValue({
      poolId: "pool-sensitive",
      workerCapacityLimit: 3,
      activeWorkerCount: 0,
      availableWorkerSlots: 3,
    });
  });

  it("logs successful connection stages and counts without secret or inventory data", async () => {
    const apiKey = "api-key-sensitive-1234";
    const admin = connectAdmin();
    mocks.requireOrganization.mockResolvedValue(liveContext(admin));
    mocks.createDuoPlusClient.mockReturnValue({
      listPhones: vi.fn().mockResolvedValue([
        {
          id: "phone-id-sensitive",
          name: "Phone Name Sensitive",
          ip: "203.0.113.42",
        },
      ]),
      getSubscriptionStartupCapacity: vi.fn().mockResolvedValue({
        total: 8,
        inUse: 3,
        available: 5,
      }),
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await connectDuoPlus(
      new Request("https://app.test/api/integrations/duoplus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.saveVerifiedDuoPlusConnection).toHaveBeenCalledWith(admin, {
      connectionId: expect.any(String),
      organizationId: "organization-sensitive",
      expectedCredentialGeneration: 0,
      apiKey,
      ciphertext: "ciphertext-sensitive",
      iv: "iv-sensitive",
      authTag: "auth-tag-sensitive",
      keyHint: "•••• 1234",
      minGapMs: 1_200,
      verifiedAt: expect.any(String),
      subscriptionCapacity: 8,
      subscriptionInUse: 3,
      subscriptionAvailable: 5,
      subscriptionSyncedAt: expect.any(String),
      defaultLimit: 3,
    });
    expect(admin.update).not.toHaveBeenCalled();
    const entries = infoLog.mock.calls.map(([entry]) => entry);
    expect(entries).toContainEqual({
      event: "duoplus_connect",
      stage: "verify_phone_access",
      outcome: "succeeded",
      duration_ms: expect.any(Number),
      phone_probe_count: 1,
    });
    expect(entries).toContainEqual({
      event: "duoplus_connect",
      stage: "complete",
      outcome: "succeeded",
      duration_ms: expect.any(Number),
      subscription_capacity: 8,
      subscription_in_use: 3,
      subscription_available: 5,
    });
    const serializedEntries = JSON.stringify(entries);
    for (const forbidden of [
      apiKey,
      "ciphertext-sensitive",
      "iv-sensitive",
      "auth-tag-sensitive",
      "owner-sensitive@example.test",
      "phone-id-sensitive",
      "Phone Name Sensitive",
      "203.0.113.42",
      "https://app.test/api/integrations/duoplus",
    ]) {
      expect(serializedEntries).not.toContain(forbidden);
    }
    infoLog.mockRestore();
  });

  it("logs only a safe category and numeric provider codes for rejected keys", async () => {
    const apiKey = "rejected-key-sensitive";
    const admin = connectAdmin();
    mocks.requireOrganization.mockResolvedValue(liveContext(admin));
    mocks.createDuoPlusClient.mockReturnValue({
      listPhones: vi.fn().mockRejectedValue(
        new DuoPlusApiError({
          endpoint: "/api/v1/cloudPhone/list",
          httpStatus: 401,
          duoCode: 401,
          message: `provider reflected ${apiKey}`,
        }),
      ),
      getSubscriptionStartupCapacity: vi.fn(),
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await connectDuoPlus(
      new Request("https://app.test/api/integrations/duoplus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );

    expect(response.status).toBe(400);
    expect(errorLog).toHaveBeenCalledWith({
      event: "duoplus_connect",
      stage: "verify_phone_access",
      outcome: "failed",
      duration_ms: expect.any(Number),
      error_category: "authentication",
      error_code: "INVALID_DUOPLUS_KEY",
      provider_http_status: 401,
      provider_code: 401,
    });
    const serializedEntries = JSON.stringify(errorLog.mock.calls);
    expect(serializedEntries).not.toContain(apiKey);
    expect(serializedEntries).not.toContain("/api/v1/cloudPhone/list");
    infoLog.mockRestore();
    errorLog.mockRestore();
  });

  it("lets a workspace admin adjust the shared worker limit", async () => {
    const admin = connectAdmin();
    mocks.requireOrganization.mockResolvedValue(liveContext(admin));
    mocks.getDefaultDuoConnection.mockResolvedValue({
      id: "connection-1",
      organization_id: "organization-sensitive",
      status: "active",
      capacity_pool_id: "pool-1",
      api_key_ciphertext: "ciphertext",
      api_key_iv: "iv",
      api_key_auth_tag: "tag",
      credential_generation: 2,
    });
    mocks.setDuoPlusCapacityLimit.mockResolvedValue({
      poolId: "pool-1",
      workerCapacityLimit: 3,
      activeWorkerCount: 2,
      availableWorkerSlots: 1,
    });

    const response = await updateDuoPlusCapacity(
      new Request("https://app.test/api/integrations/duoplus", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerCapacityLimit: 3 }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        subscriptionCapacity: 3,
        subscriptionInUse: 2,
        subscriptionAvailable: 1,
      },
    });
    expect(mocks.requireWorkspaceAdmin).toHaveBeenCalled();
    expect(mocks.setDuoPlusCapacityLimit).toHaveBeenCalledWith(admin, {
      connectionId: "connection-1",
      organizationId: "organization-sensitive",
      workerCapacityLimit: 3,
    });
  });

  it.each([
    ["P4112", "DUOPLUS_POOL_LINK_FAILED"],
    ["P4113", "DUOPLUS_CONNECTION_CHANGED"],
  ])(
    "relies on the atomic RPC when a rotated key save fails with %s",
    async (databaseCode, responseCode) => {
    const admin = connectAdmin();
    mocks.requireOrganization.mockResolvedValue(liveContext(admin));
    mocks.getDefaultDuoConnection.mockResolvedValue({
      id: "connection-1",
      organization_id: "organization-sensitive",
      name: "DuoPlus",
      is_default: true,
      base_url: "https://openapi.duoplus.net",
      api_key_ciphertext: "old-ciphertext",
      api_key_iv: "old-iv",
      api_key_auth_tag: "old-auth-tag",
      credential_generation: 4,
      key_hint: "•••• old1",
      status: "active",
      min_gap_ms: 1_200,
      issue_timezone: "UTC",
      verified_at: "2026-09-01T00:00:00.000Z",
      inventory_synced_at: null,
      subscription_capacity: 3,
      subscription_in_use: 3,
      subscription_available: 0,
      subscription_synced_at: "2026-09-01T00:00:00.000Z",
      capacity_pool_id: "pool-1",
    });
    mocks.createDuoPlusClient.mockReturnValue({
      listPhones: vi.fn().mockResolvedValue([]),
      getSubscriptionStartupCapacity: vi.fn().mockResolvedValue({
        total: 3,
        inUse: 3,
        available: 0,
      }),
    });
    mocks.saveVerifiedDuoPlusConnection.mockRejectedValueOnce(
      new DuoPlusCapacityRpcError("atomic save rejected", databaseCode),
    );
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await connectDuoPlus(
      new Request("https://app.test/api/integrations/duoplus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "rotated-key-sensitive" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: responseCode },
    });
    expect(mocks.saveVerifiedDuoPlusConnection).toHaveBeenCalledTimes(1);
    expect(mocks.saveVerifiedDuoPlusConnection).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ expectedCredentialGeneration: 4 }),
    );
    expect(admin.update).not.toHaveBeenCalled();
    infoLog.mockRestore();
    errorLog.mockRestore();
    },
  );
});
