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

vi.mock("@/lib/auth/duoplus", () => ({
  createOrganizationDuoClient: vi.fn(),
  getDefaultDuoConnection: vi.fn(),
}));

vi.mock("@/lib/proxy-seller/provision", () => ({
  provisionCycleProxy: vi.fn(),
}));

import {
  GET as getCyclePrograms,
  POST as createCycleProgram,
} from "@/app/api/cycle-programs/route";
import { GET as getDeviceCycles } from "@/app/api/device-cycles/route";
import { ApiError } from "@/lib/auth/errors";
import { getDefaultDuoConnection } from "@/lib/auth/duoplus";

type FixtureRow = Record<string, unknown>;
type QueryResult = { data: FixtureRow[]; error: null };

type QueryTrace = {
  table: string;
  eq: ReturnType<typeof vi.fn>;
};

function serviceRoleAdmin(
  fixtures: Record<string, FixtureRow[]>,
  rpcResult: unknown = [],
) {
  const traces: QueryTrace[] = [];

  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;

    const materialize = (): QueryResult => {
      let rows = [...(fixtures[table] ?? [])].filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );
      if (limit !== null) rows = rows.slice(0, limit);
      if (range !== null) rows = rows.slice(range[0], range[1] + 1);
      return { data: rows, error: null };
    };

    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn((value: number) => {
        limit = value;
        return query;
      }),
      range: vi.fn((from: number, to: number) => {
        range = [from, to];
        return query;
      }),
      maybeSingle: vi.fn(async () => {
        const result = materialize();
        return { data: result.data[0] ?? null, error: null };
      }),
      then: <TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?:
          | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ): Promise<TResult1 | TResult2> =>
        Promise.resolve(materialize()).then(onfulfilled, onrejected),
    };

    traces.push({ table, eq: query.eq });
    return query;
  });

  const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
  return { from, rpc, traces };
}

function liveContext(admin: ReturnType<typeof serviceRoleAdmin>) {
  return {
    demo: false as const,
    user: { id: "user-1", email: "owner@example.test" },
    organizationId: "org-a",
    role: "owner",
    admin,
  };
}

async function expectUnauthorized(
  handler: (request: Request) => Promise<Response>,
  path: string,
) {
  auth.requireOrganization.mockRejectedValueOnce(
    new ApiError(401, "UNAUTHORIZED", "Sign in to continue."),
  );

  const response = await handler(new Request(`https://app.test${path}`));
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    error: { code: "UNAUTHORIZED", message: "Sign in to continue." },
  });
}

describe("cycle route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for unauthenticated reads of both cycle APIs", async () => {
    await expectUnauthorized(getCyclePrograms, "/api/cycle-programs");
    await expectUnauthorized(getDeviceCycles, "/api/device-cycles");
  });

  it("scopes every cycle-program service-role query to the authorized tenant", async () => {
    const admin = serviceRoleAdmin({
      cycle_programs: [
        {
          id: "program-a",
          organization_id: "org-a",
          connection_id: "connection-a",
          name: "Program A",
          duration_days: 30,
          timezone: "America/New_York",
          version: 1,
          status: "published",
          published_at: "2026-09-05T00:00:00.000Z",
          created_at: "2026-09-05T00:00:00.000Z",
        },
        {
          id: "program-b",
          organization_id: "org-b",
          connection_id: "connection-b",
          name: "Program B",
          duration_days: 15,
          timezone: "America/Chicago",
          version: 1,
          status: "published",
          published_at: "2026-09-05T00:00:00.000Z",
          created_at: "2026-09-05T00:00:00.000Z",
        },
      ],
      cycle_program_rules: [
        {
          id: "rule-a",
          organization_id: "org-a",
          program_id: "program-a",
          template_id: "template-a",
          name: "Daily warming",
          rule_kind: "daily_range",
          app_kind: "chrome",
          points: 5,
          start_day: 1,
          end_day: 30,
          local_time: "09:00:00",
          sequence: 1,
          config: {},
          expected_duration_seconds: 600,
          max_attempts: 3,
          required: true,
        },
      ],
      duo_templates: [
        {
          id: "template-a",
          organization_id: "org-a",
          duoplus_template_id: "remote-template-a",
          template_type: 1,
          name: "Account warming",
        },
      ],
    });
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getCyclePrograms(
      new Request("https://app.test/api/cycle-programs"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.programs).toHaveLength(1);
    expect(payload.data.programs[0].id).toBe("program-a");
    expect(payload.data.programs[0].rules[0]).toMatchObject({
      templateId: "template-a",
      duoplusTemplateId: "remote-template-a",
      templateType: 1,
      templateSource: "official",
      templateName: "Account warming",
    });

    expect(admin.traces.map((trace) => trace.table)).toEqual([
      "cycle_programs",
      "cycle_program_rules",
      "duo_templates",
    ]);
    for (const trace of admin.traces) {
      expect(trace.eq).toHaveBeenCalledWith("organization_id", "org-a");
    }
  });

  it("loads cycle rule template metadata beyond the first Supabase page", async () => {
    const templates = Array.from({ length: 1_001 }, (_, index) => ({
      id: `template-${String(index + 1).padStart(4, "0")}`,
      organization_id: "org-a",
      duoplus_template_id: `remote-${index + 1}`,
      template_type: index === 1_000 ? 1 : 2,
      name: `Template ${index + 1}`,
    }));
    const admin = serviceRoleAdmin({
      cycle_programs: [
        {
          id: "program-a",
          organization_id: "org-a",
          connection_id: "connection-a",
          name: "Program A",
          duration_days: 30,
          timezone: "America/New_York",
          ready_day: 10,
          ready_threshold_percent: 80,
          completion_threshold_percent: 90,
          version: 1,
          status: "published",
          published_at: "2026-09-05T00:00:00.000Z",
          created_at: "2026-09-05T00:00:00.000Z",
        },
      ],
      cycle_program_rules: [
        {
          id: "rule-a",
          organization_id: "org-a",
          program_id: "program-a",
          template_id: "template-1001",
          name: "Official warming",
          rule_kind: "daily_range",
          app_kind: "chrome",
          points: 5,
          start_day: 1,
          end_day: 30,
          local_time: "09:00:00",
          sequence: 1,
          config: {},
          expected_duration_seconds: 600,
          max_attempts: 3,
          required: true,
        },
      ],
      duo_templates: templates,
    });
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getCyclePrograms(
      new Request("https://app.test/api/cycle-programs"),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.programs[0].rules[0]).toMatchObject({
      templateId: "template-1001",
      duoplusTemplateId: "remote-1001",
      templateType: 1,
      templateSource: "official",
      templateName: "Template 1001",
    });
  });

  it("accepts typed whole-value placeholders for reusable program rules", async () => {
    const config = {
      count: { key: "count", type: "number", value: "{{visit_count}}", required: true },
      enabled: { key: "enabled", type: "boolean", value: "{{open_result}}", required: true },
      files: { key: "files", type: "file", value: "{{attachments}}", required: true },
      rows: { key: "rows", type: "excel", value: "{{spreadsheet_rows}}", required: true },
    };
    const admin = serviceRoleAdmin({
      duo_templates: [{
        id: "00000000-0000-4000-8000-000000000301",
        organization_id: "org-a",
        duoplus_template_id: "remote-generic",
        template_type: 1,
        name: "Generic official task",
        config_schema: null,
        enabled: true,
      }],
      cycle_programs: [{
        id: "00000000-0000-4000-8000-000000000302",
        organization_id: "org-a",
        connection_id: "connection-a",
        name: "Reusable program",
        duration_days: 30,
        timezone: "America/New_York",
        ready_day: 10,
        ready_threshold_percent: 80,
        completion_threshold_percent: 90,
        version: 1,
        status: "published",
        published_at: "2026-09-05T00:00:00.000Z",
        created_at: "2026-09-05T00:00:00.000Z",
      }],
      cycle_program_rules: [{
        id: "rule-a",
        organization_id: "org-a",
        program_id: "00000000-0000-4000-8000-000000000302",
        template_id: "00000000-0000-4000-8000-000000000301",
        name: "Daily task",
        rule_kind: "daily_range",
        app_kind: "other",
        points: 1,
        start_day: 1,
        end_day: 30,
        local_time: "09:00:00",
        sequence: 1,
        config,
        expected_duration_seconds: 600,
        max_attempts: 3,
        required: true,
      }],
    }, "00000000-0000-4000-8000-000000000302");
    auth.requireOrganization.mockResolvedValue(liveContext(admin));
    vi.mocked(getDefaultDuoConnection).mockResolvedValue({
      id: "connection-a",
      status: "active",
    } as never);

    const response = await createCycleProgram(new Request(
      "https://app.test/api/cycle-programs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Reusable program",
          durationDays: 30,
          timezone: "America/New_York",
          readyDay: 10,
          readyThresholdPercent: 80,
          completionThresholdPercent: 90,
          rules: [{
            name: "Daily task",
            templateId: "00000000-0000-4000-8000-000000000301",
            ruleKind: "daily_range",
            startDay: 1,
            endDay: 30,
            localTime: "09:00",
            sequence: 1,
            config,
            expectedDurationSeconds: 600,
            maxAttempts: 3,
            required: true,
            appKind: "other",
            points: 1,
          }],
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(admin.rpc).toHaveBeenCalledWith("create_cycle_program", expect.objectContaining({
      p_rules: [expect.objectContaining({ config })],
    }));
  });

  it("scopes all device-cycle reads and aggregate RPC input to the tenant", async () => {
    const cycleBase = {
      connection_id: "connection-a",
      program_id: "program-a",
      phone_id: "phone-a",
      keyword: "local service",
      profile_label: null,
      starts_on: "2026-09-05",
      ends_on: "2026-10-04",
      duration_days: 30,
      timezone: "America/New_York",
      status: "active",
      target_country: "US",
      target_region: "Florida",
      target_city: "Lakeland",
      target_latitude: 28.0395,
      target_longitude: -81.9498,
      activated_at: "2026-09-05T00:00:00.000Z",
      completed_at: null,
      last_error: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };
    const admin = serviceRoleAdmin(
      {
        device_cycles: [
          {
            ...cycleBase,
            id: "cycle-a",
            organization_id: "org-a",
            client_id: "client-a",
            name: "Cycle A",
          },
          {
            ...cycleBase,
            id: "cycle-b",
            organization_id: "org-b",
            client_id: "client-b",
            name: "Cycle B",
          },
        ],
        clients: [
          { id: "client-a", organization_id: "org-a", name: "Client A" },
          { id: "client-b", organization_id: "org-b", name: "Client B" },
        ],
        duo_phones: [
          { id: "phone-a", organization_id: "org-a", name: "Phone A" },
        ],
        cycle_programs: [
          { id: "program-a", organization_id: "org-a", name: "Program A" },
        ],
        phone_proxy_bindings: [],
        proxy_package_snapshots: [],
      },
      [
        {
          device_cycle_id: "cycle-a",
          total: 159,
          done: 0,
          running: 0,
          failed: 0,
          pending: 159,
        },
      ],
    );
    auth.requireOrganization.mockResolvedValue(liveContext(admin));

    const response = await getDeviceCycles(
      new Request("https://app.test/api/device-cycles"),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.cycles).toHaveLength(1);
    expect(payload.data.cycles[0]).toMatchObject({
      id: "cycle-a",
      clientName: "Client A",
      phoneName: "Phone A",
      programName: "Program A",
    });

    for (const trace of admin.traces) {
      expect(trace.eq).toHaveBeenCalledWith("organization_id", "org-a");
    }
    expect(admin.rpc).toHaveBeenCalledWith("get_device_cycle_run_counts", {
      p_organization_id: "org-a",
    });
  });
});
