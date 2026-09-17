import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DUOPLUS_PHONE_STATUS,
  type DuoPlusClient,
} from "@/lib/duoplus";
import { isSchedulablePhone } from "@/lib/duoplus/phone-eligibility";
import {
  DEFAULT_PHONE_IDLE_SECONDS,
  runSchedulerPowerOffSweep,
} from "@/lib/scheduler/device-power";
import {
  cycleEndExclusiveInstant,
  isPhoneEligibleForNewWork,
  isPhoneEligibleThroughCycle,
} from "@/lib/scheduler/phone-safety";
import {
  SupabaseSchedulerRepository,
  type SchedulerRepository,
} from "@/lib/scheduler/repository";
import type {
  DuoConnectionRow,
  DuoPhoneRow,
  SchedulerRunContext,
  SchedulerPowerOffCandidate,
} from "@/lib/scheduler/types";
import { waitForPhoneOn } from "@/lib/scheduler/worker";

const now = new Date("2026-09-06T18:00:00.000Z");

describe("phone eligibility", () => {
  const eligible = {
    enabled: true,
    provider_present: true,
    status: DUOPLUS_PHONE_STATUS.OFF,
    expired_at: "2026-09-07T18:00:00.000Z",
  };

  it("accepts only present, enabled, current phones for new work", () => {
    expect(isPhoneEligibleForNewWork(eligible, now)).toBe(true);
    expect(
      isPhoneEligibleForNewWork({ ...eligible, enabled: false }, now),
    ).toBe(false);
    expect(
      isPhoneEligibleForNewWork(
        { ...eligible, provider_present: false },
        now,
      ),
    ).toBe(false);
    expect(
      isPhoneEligibleForNewWork(
        { ...eligible, expired_at: now.toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      isPhoneEligibleForNewWork({ ...eligible, expired_at: "invalid" }, now),
    ).toBe(false);
  });

  it.each([
    DUOPLUS_PHONE_STATUS.EXPIRED,
    DUOPLUS_PHONE_STATUS.RENEWAL_OVERDUE,
  ])("rejects DuoPlus status %s", (status) => {
    expect(isPhoneEligibleForNewWork({ ...eligible, status }, now)).toBe(false);
  });

  it("uses the same fail-closed rules in browser-facing phone selectors", () => {
    const browserPhone = {
      enabled: true,
      providerPresent: true,
      status: DUOPLUS_PHONE_STATUS.OFF,
      expiredAt: "2026-09-07T18:00:00.000Z",
    };
    expect(isSchedulablePhone(browserPhone, now.getTime())).toBe(true);
    expect(
      isSchedulablePhone(
        { ...browserPhone, providerPresent: false },
        now.getTime(),
      ),
    ).toBe(false);
    expect(
      isSchedulablePhone(
        { ...browserPhone, expiredAt: "invalid" },
        now.getTime(),
      ),
    ).toBe(false);
  });

  it("requires a dedicated phone subscription through the final local cycle day", () => {
    expect(
      cycleEndExclusiveInstant(
        "2026-03-08",
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-03-09T04:00:00.000Z");

    expect(
      isPhoneEligibleThroughCycle(
        {
          ...eligible,
          expired_at: "2026-03-09T04:00:00.000Z",
        },
        "2026-03-08",
        "America/New_York",
        new Date("2026-03-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isPhoneEligibleThroughCycle(
        {
          ...eligible,
          expired_at: "2026-03-09T04:00:00.001Z",
        },
        "2026-03-08",
        "America/New_York",
        new Date("2026-03-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });
});

describe("repository assignment boundary", () => {
  const phone = {
    id: "phone-1",
    organization_id: "organization-1",
    connection_id: "connection-1",
    client_id: "client-1",
    duoplus_image_id: "image-1",
    name: "Expired phone",
    status: DUOPLUS_PHONE_STATUS.EXPIRED,
    enabled: true,
    provider_present: true,
    expired_at: now.toISOString(),
    busy_until: null,
    lease_run_id: null,
    gps_latitude: null,
    gps_longitude: null,
    gps_mode: 0,
    locale_timezone: null,
    locale_language: null,
  } satisfies DuoPhoneRow;

  function context(options: {
    phone: DuoPhoneRow | null;
    submissionState?: "never" | "accepted";
    runPhoneId?: string | null;
  }) {
    return {
      phone: options.phone,
      run: {
        id: "run-1",
        phone_id: options.runPhoneId === undefined ? options.phone?.id ?? null : options.runPhoneId,
        duoplus_task_id:
          options.submissionState === "accepted" ? "remote-task-1" : null,
        submission_state: options.submissionState ?? "never",
        status: options.submissionState === "accepted" ? "queued" : "pending",
        stage:
          options.submissionState === "accepted" ? "monitor_task" : "pending",
      },
    } as unknown as SchedulerRunContext;
  }

  it("does not return an expired assigned phone for new work", async () => {
    const repository = new SupabaseSchedulerRepository({} as never);

    await expect(
      repository.listCandidatePhones(context({ phone })),
    ).resolves.toEqual([]);
  });

  it("returns the same persisted phone solely to reconcile an existing task", async () => {
    const repository = new SupabaseSchedulerRepository({} as never);

    await expect(
      repository.listCandidatePhones(
        context({ phone, submissionState: "accepted" }),
      ),
    ).resolves.toEqual([phone]);
  });

  it("never substitutes a different phone for an existing remote task", async () => {
    const repository = new SupabaseSchedulerRepository({} as never);

    await expect(
      repository.listCandidatePhones(
        context({
          phone,
          submissionState: "accepted",
          runPhoneId: "different-phone",
        }),
      ),
    ).resolves.toEqual([]);
    await expect(
      repository.listCandidatePhones(
        context({
          phone: null,
          submissionState: "accepted",
          runPhoneId: null,
        }),
      ),
    ).resolves.toEqual([]);
  });
});

describe("scheduler power-on ownership", () => {
  const baseOptions = {
    imageId: "image-1",
    mode: "minute" as const,
    clock: { now: () => now },
    sleeper: { sleep: vi.fn(async () => undefined) },
    pollIntervalMs: 5_000,
    timeoutMs: 60_000,
    deadline: now.getTime() + 270_000,
  };

  it("records ownership intent only after requesting an off phone to power on", async () => {
    const powerOn = vi.fn(async () => ({}));
    const onPowerOnAccepted = vi.fn(async () => undefined);

    await expect(
      waitForPhoneOn({
        ...baseOptions,
        client: { powerOn } as unknown as DuoPlusClient,
        initialPhone: { id: "image-1", status: DUOPLUS_PHONE_STATUS.OFF },
        onPowerOnAccepted,
      }),
    ).resolves.toBeNull();

    expect(powerOn).toHaveBeenCalledWith(["image-1"]);
    expect(onPowerOnAccepted).toHaveBeenCalledTimes(1);
    expect(powerOn.mock.invocationCallOrder[0]).toBeLessThan(
      onPowerOnAccepted.mock.invocationCallOrder[0],
    );
  });

  it("never records power ownership for a phone that was already on", async () => {
    const powerOn = vi.fn(async () => ({}));
    const onPowerOnAccepted = vi.fn(async () => undefined);
    const phone = { id: "image-1", status: DUOPLUS_PHONE_STATUS.ON };

    await expect(
      waitForPhoneOn({
        ...baseOptions,
        client: { powerOn } as unknown as DuoPlusClient,
        initialPhone: phone,
        onPowerOnAccepted,
      }),
    ).resolves.toBe(phone);

    expect(powerOn).not.toHaveBeenCalled();
    expect(onPowerOnAccepted).not.toHaveBeenCalled();
  });

  it("polls without sending a duplicate power-on when a durable attempt already exists", async () => {
    const powerOn = vi.fn(async () => ({}));
    const beforePowerOn = vi.fn(async () => false);
    const onPowerOnAccepted = vi.fn(async () => undefined);

    await expect(
      waitForPhoneOn({
        ...baseOptions,
        client: { powerOn } as unknown as DuoPlusClient,
        initialPhone: { id: "image-1", status: DUOPLUS_PHONE_STATUS.OFF },
        beforePowerOn,
        onPowerOnAccepted,
      }),
    ).resolves.toBeNull();

    expect(beforePowerOn).toHaveBeenCalledTimes(1);
    expect(powerOn).not.toHaveBeenCalled();
    expect(onPowerOnAccepted).not.toHaveBeenCalled();
  });
});

const candidate: SchedulerPowerOffCandidate = {
  id: "phone-1",
  organization_id: "organization-1",
  connection_id: "connection-1",
  duoplus_image_id: "image-1",
  status: DUOPLUS_PHONE_STATUS.ON,
  claim_token: "poweroff-claim-1",
};

const connection: DuoConnectionRow = {
  id: "connection-1",
  organization_id: "organization-1",
  name: "DuoPlus",
  base_url: "https://openapi.duoplus.net",
  issue_timezone: "UTC",
  api_key_ciphertext: "ciphertext",
  api_key_iv: "iv",
  api_key_auth_tag: "tag",
  credential_generation: 4,
  status: "active",
  min_gap_ms: 1_200,
  last_error: null,
  subscription_capacity: 1,
  subscription_in_use: 1,
  subscription_available: 0,
  subscription_synced_at: now.toISOString(),
  capacity_pool_id: null,
};

function powerOffHarness(options: {
  candidates?: SchedulerPowerOffCandidate[];
  remoteStatus?: number;
  getPhoneError?: boolean;
  powerOffError?: boolean;
  completeError?: boolean;
} = {}) {
  const sequence: string[] = [];
  const claimIdleSchedulerPoweredOnPhones = vi.fn(async () =>
    options.candidates ?? [candidate],
  );
  const completeSchedulerPowerOff = vi.fn(async () => {
    sequence.push("complete");
    if (options.completeError) {
      throw new Error("completion response lost");
    }
    return true;
  });
  const consumeSchedulerPowerOffOwnership = vi.fn(async () => {
    sequence.push("consume");
    return true;
  });
  const releaseSchedulerPowerOffClaim = vi.fn(async () => {
    sequence.push("release");
    return true;
  });
  const repository = {
    claimIdleSchedulerPoweredOnPhones,
    loadPowerManagementConnection: vi.fn(async () => connection),
    completeSchedulerPowerOff,
    consumeSchedulerPowerOffOwnership,
    releaseSchedulerPowerOffClaim,
  } as unknown as SchedulerRepository;
  const getPhone = options.getPhoneError
    ? vi.fn(async () => {
        throw new Error("temporary lookup failure");
      })
    : vi.fn(async () => ({
        id: "image-1",
        status: options.remoteStatus ?? DUOPLUS_PHONE_STATUS.ON,
      }));
  const powerOff = options.powerOffError
    ? vi.fn(async () => {
        sequence.push("powerOff");
        throw new Error("uncertain provider result");
      })
    : vi.fn(async () => {
        sequence.push("powerOff");
        return {};
      });
  const client = { getPhone, powerOff } as unknown as DuoPlusClient;
  const sweep = () =>
    runSchedulerPowerOffSweep({
      repository,
      clientFactory: () => client,
      workerId: "worker-1",
      clock: { now: () => now },
    });

  return {
    claimIdleSchedulerPoweredOnPhones,
    completeSchedulerPowerOff,
    consumeSchedulerPowerOffOwnership,
    getPhone,
    powerOff,
    releaseSchedulerPowerOffClaim,
    sequence,
    sweep,
  };
}

describe("idle scheduler-owned phone shutdown", () => {
  it("uses a 15-minute idle default and consumes ownership before powerOff", async () => {
    const harness = powerOffHarness();

    await expect(harness.sweep()).resolves.toEqual({
      claimed: 1,
      poweredOff: 1,
      released: 0,
      failed: 0,
    });

    expect(harness.claimIdleSchedulerPoweredOnPhones).toHaveBeenCalledWith({
      workerId: "worker-1",
      idleSeconds: DEFAULT_PHONE_IDLE_SECONDS,
      limit: 20,
      claimSeconds: 120,
    });
    expect(harness.sequence).toEqual(["consume", "powerOff", "complete"]);
    expect(harness.consumeSchedulerPowerOffOwnership).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
    );
    expect(harness.powerOff).toHaveBeenCalledWith(["image-1"]);
    expect(harness.completeSchedulerPowerOff).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      DUOPLUS_PHONE_STATUS.OFF,
    );
  });

  it("does no work when the database finds no scheduler-owned candidate", async () => {
    const harness = powerOffHarness({ candidates: [] });

    await expect(harness.sweep()).resolves.toEqual({
      claimed: 0,
      poweredOff: 0,
      released: 0,
      failed: 0,
    });
    expect(harness.getPhone).not.toHaveBeenCalled();
    expect(harness.powerOff).not.toHaveBeenCalled();
  });

  it("clears ownership without powerOff when the phone is already off", async () => {
    const harness = powerOffHarness({ remoteStatus: DUOPLUS_PHONE_STATUS.OFF });

    await expect(harness.sweep()).resolves.toMatchObject({
      poweredOff: 0,
      released: 1,
      failed: 0,
    });
    expect(harness.consumeSchedulerPowerOffOwnership).not.toHaveBeenCalled();
    expect(harness.powerOff).not.toHaveBeenCalled();
    expect(harness.completeSchedulerPowerOff).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      DUOPLUS_PHONE_STATUS.OFF,
    );
  });

  it("releases a changing phone without attempting shutdown", async () => {
    const harness = powerOffHarness({
      remoteStatus: DUOPLUS_PHONE_STATUS.POWERING_ON,
    });

    await expect(harness.sweep()).resolves.toMatchObject({
      poweredOff: 0,
      released: 1,
      failed: 0,
    });
    expect(harness.powerOff).not.toHaveBeenCalled();
    expect(harness.releaseSchedulerPowerOffClaim).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      { errorMessage: "Phone is still changing power state" },
    );
  });

  it("relinquishes ownership after an ambiguous powerOff result", async () => {
    const harness = powerOffHarness({ powerOffError: true });

    await expect(harness.sweep()).resolves.toMatchObject({
      poweredOff: 0,
      failed: 1,
    });
    expect(harness.sequence).toEqual(["consume", "powerOff", "release"]);
    expect(harness.releaseSchedulerPowerOffClaim).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      expect.objectContaining({ abandonOwnership: true }),
    );
  });

  it("keeps the quarantine when remote shutdown succeeds but completion is uncertain", async () => {
    const harness = powerOffHarness({ completeError: true });

    await expect(harness.sweep()).resolves.toMatchObject({
      poweredOff: 0,
      failed: 1,
    });
    expect(harness.sequence).toEqual(["consume", "powerOff", "complete", "release"]);
    expect(harness.releaseSchedulerPowerOffClaim).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      expect.objectContaining({ abandonOwnership: true }),
    );
  });

  it("keeps ownership when preflight state verification fails", async () => {
    const harness = powerOffHarness({ getPhoneError: true });

    await expect(harness.sweep()).resolves.toMatchObject({
      poweredOff: 0,
      failed: 1,
    });
    expect(harness.consumeSchedulerPowerOffOwnership).not.toHaveBeenCalled();
    expect(harness.powerOff).not.toHaveBeenCalled();
    expect(harness.releaseSchedulerPowerOffClaim).toHaveBeenCalledWith(
      "phone-1",
      "worker-1",
      "poweroff-claim-1",
      { errorMessage: "Phone power-off preparation failed" },
    );
  });
});

describe("device power safety migration", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260906223756_scheduler_device_power_safety.sql",
    ),
    "utf8",
  );
  const finalLeaseMigration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260906224153_scheduler_security_and_lease_hardening.sql",
    ),
    "utf8",
  );
  const inventorySyncRoute = readFileSync(
    join(process.cwd(), "src/app/api/inventory/sync/route.ts"),
    "utf8",
  );
  const cycleRoute = readFileSync(
    join(process.cwd(), "src/app/api/device-cycles/route.ts"),
    "utf8",
  );
  const schedulerRuntime = readFileSync(
    join(process.cwd(), "src/lib/scheduler/runtime.ts"),
    "utf8",
  );

  it("separates provider presence from the operator enabled switch", () => {
    expect(migration).toContain(
      "provider_present boolean not null default true",
    );
    expect(migration).toMatch(
      /on conflict \(connection_id, duoplus_image_id\) do update[\s\S]*provider_present = true[\s\S]*preserve duo_phones\.enabled/,
    );
    expect(migration).toMatch(
      /update public\.duo_phones as phone[\s\S]*set provider_present = false/,
    );
    expect(migration).toMatch(
      /when provider_present[\s\S]*metadata ->> 'provider_present' = 'false'[\s\S]*then true/,
    );
  });

  it("serializes full inventory snapshots and rejects stale or future reads", () => {
    expect(migration).toContain("p_synced_at is null");
    expect(migration).toContain("p_synced_at > clock_timestamp() + interval '5 minutes'");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toMatch(
      /connection\.inventory_synced_at is null[\s\S]*connection\.inventory_synced_at <= p_synced_at/,
    );
    expect(migration).toContain(
      "get diagnostics v_connection_updated = row_count",
    );
    expect(migration).toContain("errcode = 'P4107'");
    expect(migration).toMatch(
      /update public\.duo_connections as connection[\s\S]*set inventory_synced_at = p_synced_at/,
    );
    expect(inventorySyncRoute).toMatch(
      /const syncedAt = new Date\(upstreamStartedAt\)\.toISOString\(\);[\s\S]*await client\.listAllPhones\(\)/,
    );
    expect(inventorySyncRoute).toContain('.lte("inventory_synced_at", syncedAt)');
  });

  it("atomically blocks expired, overdue, absent, and powering-off phones from new work", () => {
    expect(migration).toMatch(
      /not v_existing_task[\s\S]*not v_phone\.provider_present[\s\S]*v_phone\.status in \(3, 4\)[\s\S]*v_phone\.expired_at/,
    );
    expect(migration).toMatch(
      /v_phone\.scheduler_poweroff_lease_expires_at is not null[\s\S]*v_phone\.scheduler_poweroff_lease_expires_at > clock_timestamp\(\)/,
    );
  });

  it("requires a capacity snapshot no older than 60 minutes at the final lease boundary", () => {
    expect(finalLeaseMigration).toContain("interval '60 minutes'");
    expect(finalLeaseMigration).not.toContain("interval '24 hours'");
    expect(schedulerRuntime).toContain(
      "const syncedAt = refreshStartedAt.toISOString()",
    );
    expect(schedulerRuntime).toContain(
      "subscription_synced_at.is.null,subscription_synced_at.lte.${syncedAt}",
    );
  });

  it("claims only confirmed scheduler-owned phones after idle and run guards", () => {
    expect(migration).toMatch(
      /phone\.scheduler_power_requested_at is not null[\s\S]*phone\.scheduler_powered_on_at is not null[\s\S]*phone\.scheduler_last_activity_at <=/,
    );
    expect(migration).toContain("for update of phone skip locked");
    expect(migration).toContain(
      "run.status in ('preparing', 'queued', 'running', 'paused')",
    );
    expect(migration).toContain(
      "clock_timestamp() + make_interval(secs => p_idle_seconds)",
    );
  });

  it("protects unresolved remote side effects even after a local terminal state", () => {
    expect(migration).toMatch(
      /claim_idle_scheduler_powered_phones[\s\S]*coalesce\(run\.submission_state, 'never'\) in \('attempting', 'unknown'\)[\s\S]*run\.submission_state = 'accepted'[\s\S]*run\.duoplus_status not in \(3, 4, 5\)/,
    );
    expect(migration).toMatch(
      /assign_duoplus_phone_client[\s\S]*coalesce\(run\.submission_state, 'never'\) in \('attempting', 'unknown'\)[\s\S]*run\.submission_state = 'accepted'[\s\S]*run\.duoplus_status not in \(3, 4, 5\)/,
    );
  });

  it("requires cycle phones to remain eligible through the final local day", () => {
    expect(migration).toContain(
      "((new.ends_on + 1)::timestamp at time zone new.timezone)",
    );
    expect(migration).toContain("errcode = 'P4108'");
    expect(migration).toMatch(
      /before insert or update of phone_id, client_id, connection_id, starts_on,[\s\S]*ends_on, timezone, status/,
    );
    expect(cycleRoute).toContain("isPhoneEligibleThroughCycle");
    expect(cycleRoute).toContain('"PHONE_EXPIRES_DURING_CYCLE"');
  });

  it("prevents new manual client assignment for unavailable phones", () => {
    expect(migration).toContain("errcode = 'P4105'");
    expect(migration).toMatch(
      /p_client_id is not null[\s\S]*not v_phone\.enabled[\s\S]*not v_phone\.provider_present[\s\S]*v_phone\.status in \(3, 4\)/,
    );
  });

  it("fences client reassignment while schedules or runs still reference the phone", () => {
    expect(migration).toMatch(
      /from public\.scheduler_schedules as schedule[\s\S]*schedule\.phone_id = p_phone_id[\s\S]*schedule\.enabled/,
    );
    expect(migration).toMatch(
      /from public\.scheduler_runs as run[\s\S]*run\.phone_id = p_phone_id[\s\S]*run\.status in/,
    );
    expect(migration).toContain("errcode = 'P4106'");
  });

  it("keeps privileged power claims private to the service role", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toMatch(
      /revoke all on function public\.claim_idle_scheduler_powered_phones[\s\S]*from public, anon, authenticated;[\s\S]*grant execute[\s\S]*to service_role;/,
    );
  });

  it("generation-fences and revalidates every shutdown side effect", () => {
    expect(migration).toContain(
      "scheduler_poweroff_lease_token uuid",
    );
    expect(migration).toMatch(
      /consume_scheduler_phone_poweroff_ownership[\s\S]*p_claim_token uuid[\s\S]*scheduler_poweroff_lease_token = p_claim_token[\s\S]*scheduler_poweroff_lease_expires_at > clock_timestamp\(\)[\s\S]*not exists/,
    );
    expect(migration).toMatch(
      /release_scheduler_phone_poweroff_claim[\s\S]*p_claim_token uuid[\s\S]*p_abandon_ownership[\s\S]*p_quarantine_seconds/,
    );
    expect(migration).toMatch(
      /complete_scheduler_phone_power_off[\s\S]*p_claim_token uuid[\s\S]*scheduler_poweroff_lease_token = p_claim_token[\s\S]*scheduler_poweroff_lease_expires_at > clock_timestamp\(\)/,
    );
  });
});
