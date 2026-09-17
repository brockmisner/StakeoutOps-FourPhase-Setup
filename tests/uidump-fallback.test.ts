import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DUOPLUS_ENDPOINTS,
  DUOPLUS_UI_HIERARCHY_DUMP_COMMAND,
  DuoPlusClient,
} from "@/lib/duoplus";
import type { SchedulerRepository } from "@/lib/scheduler/repository";
import type { SchedulerRunRow } from "@/lib/scheduler/types";
import { summarizeUiDumpEvidence } from "@/lib/scheduler/ui-dump";
import { captureFailedRpaUiDump } from "@/lib/scheduler/worker";

describe("DuoPlus UI hierarchy capture", () => {
  it("uses the fixed cloud-phone command without an adb shell prefix", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({ code: 200, data: { output: "<hierarchy />" } }),
        { status: 200 },
      );
    });
    const client = new DuoPlusClient({
      apiKey: "test-key",
      connectionId: "connection-1",
      fetchImpl: fetchImpl as typeof fetch,
      minGapMs: 0,
    });

    await expect(client.dumpUiHierarchy(" image-1 ")).resolves.toEqual({
      output: "<hierarchy />",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://openapi.duoplus.net${DUOPLUS_ENDPOINTS.PHONE_COMMAND}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          image_id: "image-1",
          command: DUOPLUS_UI_HIERARCHY_DUMP_COMMAND,
        }),
      }),
    );
    expect(DUOPLUS_UI_HIERARCHY_DUMP_COMMAND).not.toContain("adb shell");
  });

  it("bounds XML and redacts profile, phone, credential, and editable text", () => {
    const evidence = summarizeUiDumpEvidence({
      output: `<hierarchy><node text="person@example.com" content-desc="api_key=live-secret" /><node class="android.widget.TextView" text="Call (407) 555-0198" /><node class="android.widget.EditText" text="private search" content-desc="private field" password="false" resource-id="search_box" />${"x".repeat(60_000)}</hierarchy>`,
      password: "must-not-survive",
    });
    const stored = JSON.stringify(evidence);

    expect(stored).toContain("[REDACTED_EMAIL]");
    expect(stored).toContain("[REDACTED_PHONE]");
    expect(stored).toContain("[REDACTED_INPUT]");
    expect(stored).toContain("[REDACTED]");
    expect(evidence).toMatchObject({ truncated: true });
    expect(stored.length).toBeLessThan(22_000);
    expect(stored).not.toContain("person@example.com");
    expect(stored).not.toContain("407) 555-0198");
    expect(stored).not.toContain("private search");
    expect(stored).not.toContain("live-secret");
    expect(stored).not.toContain("must-not-survive");
    expect(stored).toContain('resource-id=\\"search_box');
  });

  it("does not retain arbitrary command responses when no hierarchy is present", () => {
    const evidence = summarizeUiDumpEvidence({
      output: "person@example.com",
      debug: "sensitive user-visible response",
    });

    expect(evidence).toMatchObject({
      xml: null,
      detail: "DuoPlus command returned no XML hierarchy",
    });
    expect(JSON.stringify(evidence)).not.toContain("person@example.com");
    expect(JSON.stringify(evidence)).not.toContain("sensitive user-visible response");
  });

  it("records zero-point evidence and keeps command failures non-fatal", async () => {
    const recordEvent = vi.fn(async () => undefined);
    const repository = { recordEvent } as unknown as SchedulerRepository;
    const run = { id: "run-1" } as SchedulerRunRow;
    const successClient = {
      dumpUiHierarchy: vi.fn(async () => ({ output: "<hierarchy />" })),
    } as unknown as DuoPlusClient;

    await captureFailedRpaUiDump({
      repository,
      client: successClient,
      run,
      imageId: "image-1",
    });
    expect(recordEvent).toHaveBeenCalledWith(
      "run-1",
      "ui_dump_captured",
      expect.any(String),
      expect.objectContaining({ scorePoints: 0 }),
    );

    const failureClient = {
      dumpUiHierarchy: vi.fn(async () => {
        throw new Error("command endpoint unavailable");
      }),
    } as unknown as DuoPlusClient;
    await expect(
      captureFailedRpaUiDump({
        repository,
        client: failureClient,
        run,
        imageId: "image-1",
      }),
    ).resolves.toBeUndefined();
    expect(recordEvent).toHaveBeenLastCalledWith(
      "run-1",
      "ui_dump_unavailable",
      expect.any(String),
      expect.objectContaining({ scorePoints: 0 }),
    );
  });
});
