import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SupabaseSchedulerRepository } from "@/lib/scheduler/repository";

describe("scheduler phone snapshot normalization", () => {
  it("stores blank provider IPs as null and Unix-second expirations as ISO", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    const repository = new SupabaseSchedulerRepository({ from } as never);

    await repository.updatePhoneSnapshot("phone-row-a", {
      id: "duoplus-phone-a",
      name: "Phone A",
      status: 1,
      ip: "",
      expired_at: "1791132379",
    });

    expect(from).toHaveBeenCalledWith("duo_phones");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Phone A",
        status: 1,
        ip_address: null,
        expired_at: new Date(1_791_132_379_000).toISOString(),
      }),
    );
    expect(eq).toHaveBeenCalledWith("id", "phone-row-a");
  });

  it("does not erase optional snapshot fields omitted by DuoPlus", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    const repository = new SupabaseSchedulerRepository({
      from: vi.fn(() => ({ update })),
    } as never);

    await repository.updatePhoneSnapshot("phone-row-a", {
      id: "duoplus-phone-a",
      status: 2,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        ip_address: undefined,
        expired_at: undefined,
      }),
    );
  });
});
