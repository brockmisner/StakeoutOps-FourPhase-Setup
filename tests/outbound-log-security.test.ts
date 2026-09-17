import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SupabaseDuoPlusOutboundLogger,
  SupabaseSchedulerRepository,
} from "@/lib/scheduler/repository";

describe("DuoPlus outbound log persistence", () => {
  it("recursively redacts sensitive request and response fields at the database boundary", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    const logger = new SupabaseDuoPlusOutboundLogger(
      { from } as never,
      "organization-1",
    );
    const requestBody = {
      image: {
        adb_password: "phone-secret",
        proxy_login: "proxy-user",
        safe_label: "Pilot phone",
      },
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: "duoplus_session=session-secret",
      },
    };
    const responseBody = {
      data: [
        {
          access_token: "response-secret",
          credential: { private_key: "key-secret" },
          session_id: "session-secret",
          status: "ok",
        },
      ],
    };

    await logger.log({
      connectionId: "connection-1",
      endpoint: "/api/v1/cloudPhone/list",
      startedAt: new Date("2026-09-06T22:00:00.000Z"),
      finishedAt: new Date("2026-09-06T22:00:01.000Z"),
      httpStatus: 200,
      duoCode: 200,
      ok: true,
      requestBody,
      responseBody,
    });

    expect(from).toHaveBeenCalledWith("duo_outbound_logs");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        request_body: {
          image: {
            adb_password: "[REDACTED]",
            proxy_login: "[REDACTED]",
            safe_label: "Pilot phone",
          },
          headers: {
            Authorization: "[REDACTED]",
            Cookie: "[REDACTED]",
          },
        },
        response_body: {
          data: [
            {
              access_token: "[REDACTED]",
              credential: "[REDACTED]",
              session_id: "[REDACTED]",
              status: "ok",
            },
          ],
        },
      }),
    );
    expect(requestBody.image.adb_password).toBe("phone-secret");
    expect(requestBody.headers.Cookie).toContain("session-secret");
    expect(responseBody.data[0].access_token).toBe("response-secret");
  });
});

describe("submission validation repository contract", () => {
  it("atomically authorizes and begins a submission with the exact claim generation", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = new SupabaseSchedulerRepository({ rpc } as never);
    const startedAt = new Date("2026-09-06T22:00:00.000Z");

    await expect(
      repository.beginRunSubmission(
        { id: "run-1", lease_token: "lease-1" },
        "worker-1",
        startedAt,
      ),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("authorize_run_submission", {
      p_run_id: "run-1",
      p_worker_id: "worker-1",
      p_run_lease_token: "lease-1",
      p_submission_started_at: startedAt.toISOString(),
    });
  });

  it("keeps post-submit validation separate from the pre-submit authorizer", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = new SupabaseSchedulerRepository({ rpc } as never);
    const runLease = { id: "run-1", lease_token: "lease-1" };

    await expect(
      repository.isRunSubmissionValid(runLease, "worker-1"),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("validate_run_after_submission", {
      p_run_id: "run-1",
      p_worker_id: "worker-1",
      p_run_lease_token: "lease-1",
    });
  });

  it("passes the exact claim generation to phone acquisition and cleanup RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const repository = new SupabaseSchedulerRepository({ rpc } as never);
    const runLease = { id: "run-1", lease_token: "lease-1" };

    await expect(
      repository.acquirePhoneLease(
        "phone-1",
        runLease,
        "worker-1",
        900,
      ),
    ).resolves.toBe(true);
    await repository.releasePhoneLease("phone-1", runLease, "worker-1");
    await repository.releaseRunLease(runLease, "worker-1");

    expect(rpc).toHaveBeenNthCalledWith(1, "acquire_phone_lease", {
      p_phone_id: "phone-1",
      p_run_id: "run-1",
      p_worker_id: "worker-1",
      p_run_lease_token: "lease-1",
      p_lease_seconds: 900,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "release_phone_lease", {
      p_phone_id: "phone-1",
      p_run_id: "run-1",
      p_worker_id: "worker-1",
      p_run_lease_token: "lease-1",
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "release_run_lease", {
      p_run_id: "run-1",
      p_worker_id: "worker-1",
      p_run_lease_token: "lease-1",
    });
  });

  it("includes the lease token in direct run updates", async () => {
    const maybeSingle = vi.fn(async () => ({ data: { id: "run-1" }, error: null }));
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ eq, select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    const repository = new SupabaseSchedulerRepository({ from } as never);

    await repository.updateRun(
      { id: "run-1", lease_token: "lease-1" },
      "worker-1",
      { stage: "resolve_task" },
    );

    expect(eq).toHaveBeenCalledWith("lease_owner", "worker-1");
    expect(eq).toHaveBeenCalledWith("lease_token", "lease-1");
  });

  it("rejects a claim result that has no generation token", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ id: "run-1", lease_owner: "worker-1", lease_token: null }],
      error: null,
    }));
    const repository = new SupabaseSchedulerRepository({ rpc } as never);

    await expect(
      repository.claimDueRuns({
        workerId: "worker-1",
        limit: 1,
        leaseSeconds: 180,
        horizonEnd: new Date("2026-09-06T23:00:00.000Z"),
      }),
    ).rejects.toThrow("unfenced lease");
  });
});
