import { readFileSync } from "node:fs";
import { join } from "node:path";

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

import { PATCH } from "@/app/api/inventory/phones/[id]/route";
import { ApiError } from "@/lib/auth/errors";

const ORGANIZATION_A = "00000000-0000-4000-8000-000000000901";
const PHONE_A = "00000000-0000-4000-8000-000000000101";
const CLIENT_A = "00000000-0000-4000-8000-000000000001";

type RpcResult = {
  data: unknown;
  error: { code: string; message?: string } | null;
};

function phoneFixture(clientId: string | null = null) {
  return {
    id: PHONE_A,
    connection_id: "connection-a",
    client_id: clientId,
    duoplus_image_id: "AIZ3k",
    name: "Lakeland phone",
    status: 1,
    enabled: true,
    busy_until: null,
    gps_latitude: 28.0395,
    gps_longitude: -81.9498,
    locale_timezone: "America/New_York",
    last_seen_at: "2026-09-05T15:00:00.000Z",
    expired_at: null,
  };
}

function serviceRoleAdmin(result?: RpcResult) {
  return {
    rpc: vi.fn().mockResolvedValue(
      result ?? { data: [phoneFixture(CLIENT_A)], error: null },
    ),
  };
}

function liveContext(admin: ReturnType<typeof serviceRoleAdmin>) {
  return {
    demo: false as const,
    user: { id: "user-a", email: "owner@example.test" },
    organizationId: ORGANIZATION_A,
    role: "owner",
    admin,
  };
}

function assignmentRequest(clientId: string | null | undefined, extra?: object) {
  return new Request(`https://app.test/api/inventory/phones/${PHONE_A}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(clientId !== undefined ? { clientId } : {}),
      ...extra,
    }),
  });
}

function patchPhone(request: Request, id = PHONE_A) {
  return PATCH(request, { params: Promise.resolve({ id }) });
}

describe("phone client assignment API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.requireSchedulerManager.mockImplementation(() => undefined);
  });

  it("rejects an invalid phone ID before database access", async () => {
    const admin = serviceRoleAdmin();
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await patchPhone(assignmentRequest(CLIENT_A), "not-a-uuid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_PHONE_ID",
        message: "Supply a valid phone ID.",
      },
    });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed, and extra assignment fields before database access", async () => {
    const admin = serviceRoleAdmin();
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    for (const request of [
      assignmentRequest(undefined),
      assignmentRequest("not-a-uuid"),
      assignmentRequest(CLIENT_A, { unexpected: true }),
    ]) {
      const response = await patchPhone(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_PHONE_ASSIGNMENT",
          message: "Supply a valid client ID, or null to remove the phone assignment.",
        },
      });
    }

    expect(auth.requireSchedulerManager).toHaveBeenCalledTimes(3);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("requires schedule-management permission", async () => {
    const admin = serviceRoleAdmin();
    auth.requireOrganization.mockResolvedValue(liveContext(admin));
    auth.requireSchedulerManager.mockImplementationOnce(() => {
      throw new ApiError(
        403,
        "INSUFFICIENT_ROLE",
        "Schedule management access is required.",
      );
    });

    const response = await patchPhone(assignmentRequest(CLIENT_A));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INSUFFICIENT_ROLE" },
    });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("passes the authenticated tenant to the atomic assignment function", async () => {
    const admin = serviceRoleAdmin();
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await patchPhone(assignmentRequest(CLIENT_A));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledOnce();
    expect(admin.rpc).toHaveBeenCalledWith("assign_duoplus_phone_client", {
      p_organization_id: ORGANIZATION_A,
      p_phone_id: PHONE_A,
      p_client_id: CLIENT_A,
    });
    await expect(response.json()).resolves.toEqual({
      data: {
        phone: {
          id: PHONE_A,
          connectionId: "connection-a",
          clientId: CLIENT_A,
          imageId: "AIZ3k",
          name: "Lakeland phone",
          status: 1,
          enabled: true,
          busyUntil: null,
          gpsLatitude: 28.0395,
          gpsLongitude: -81.9498,
          timezone: "America/New_York",
          lastSeenAt: "2026-09-05T15:00:00.000Z",
          expiredAt: null,
        },
      },
    });
  });

  it("passes null to the function when unassigning a phone", async () => {
    const admin = serviceRoleAdmin({ data: phoneFixture(null), error: null });
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await patchPhone(assignmentRequest(null));

    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith("assign_duoplus_phone_client", {
      p_organization_id: ORGANIZATION_A,
      p_phone_id: PHONE_A,
      p_client_id: null,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { phone: { id: PHONE_A, clientId: null } },
    });
  });

  it.each([
    ["P4101", 404, "PHONE_NOT_FOUND"],
    ["P4102", 404, "CLIENT_NOT_FOUND"],
    ["P4103", 409, "CLIENT_UNAVAILABLE"],
    ["P4104", 409, "PHONE_HAS_OPEN_CYCLE"],
    ["P4105", 409, "PHONE_UNAVAILABLE"],
    ["P4106", 409, "PHONE_HAS_SCHEDULED_WORK"],
  ])(
    "maps database outcome %s to a safe API response",
    async (databaseCode, status, apiCode) => {
      const admin = serviceRoleAdmin({
        data: null,
        error: { code: databaseCode, message: "internal database detail" },
      });
      auth.requireOrganization.mockResolvedValue(liveContext(admin));

      const response = await patchPhone(assignmentRequest(CLIENT_A));

      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error.code).toBe(apiCode);
      expect(body.error.message).not.toContain("internal database detail");
    },
  );

  it("does not expose unexpected database errors", async () => {
    const admin = serviceRoleAdmin({
      data: null,
      error: { code: "XX000", message: "private SQL diagnostics" },
    });
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await patchPhone(assignmentRequest(CLIENT_A));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PHONE_ASSIGNMENT_FAILED",
        message: "The phone client assignment could not be saved.",
      },
    });
  });

  it("rejects an empty successful RPC result", async () => {
    const admin = serviceRoleAdmin({ data: [], error: null });
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await patchPhone(assignmentRequest(CLIENT_A));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PHONE_ASSIGNMENT_FAILED" },
    });
  });
});

describe("atomic phone assignment migration", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260905221500_atomic_phone_assignment.sql",
    ),
    "utf8",
  );

  it("locks and tenant-scopes the phone before validation and update", () => {
    expect(migration).toMatch(
      /from public\.duo_phones as phone[\s\S]*phone\.id = p_phone_id[\s\S]*phone\.organization_id = p_organization_id[\s\S]*for update/,
    );
    expect(migration).toMatch(
      /update public\.duo_phones as phone[\s\S]*phone\.id = p_phone_id[\s\S]*phone\.organization_id = p_organization_id[\s\S]*returning phone\.\*/,
    );
  });

  it("tenant-scopes and share-locks the active client validation", () => {
    expect(migration).toMatch(
      /from public\.clients as client[\s\S]*client\.id = p_client_id[\s\S]*client\.organization_id = p_organization_id[\s\S]*for share/,
    );
    expect(migration).toContain("v_client_status <> 'active'");
    expect(migration).toContain("errcode = 'P4102'");
    expect(migration).toContain("errcode = 'P4103'");
  });

  it("rejects every open cycle state in the same transaction", () => {
    expect(migration).toMatch(
      /from public\.device_cycles as cycle[\s\S]*cycle\.organization_id = p_organization_id[\s\S]*cycle\.phone_id = p_phone_id/,
    );
    expect(migration).toContain(
      "cycle.status in ('provisioning', 'active', 'paused', 'blocked')",
    );
    expect(migration).toContain("errcode = 'P4104'");
  });

  it("is callable only by the service role with a fixed search path", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = pg_catalog, public");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });

  it("serializes against the existing device-cycle phone share lock", () => {
    const cycleValidation = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260905190000_preconfigured_device_cycle_proxy_mode.sql",
      ),
      "utf8",
    );
    expect(cycleValidation).toMatch(
      /from public\.duo_phones as phone[\s\S]*phone\.id = new\.phone_id[\s\S]*phone\.organization_id = new\.organization_id[\s\S]*for share/,
    );
  });
});
