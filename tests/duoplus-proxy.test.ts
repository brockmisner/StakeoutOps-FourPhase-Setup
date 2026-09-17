import { describe, expect, it, vi } from "vitest";

import { DuoPlusClient } from "@/lib/duoplus/client";

function proxyInput() {
  return {
    protocol: "socks5" as const,
    host: "us.res.proxy-seller.com",
    port: 10_000,
    user: "fake-proxy-user",
    password: "fake-proxy-password",
    name: "cycle-proxy",
  };
}

describe("DuoPlus proxy transport", () => {
  it("serializes addProxy and redacts reflected proxy credentials from audit data", async () => {
    const logger = { log: vi.fn().mockResolvedValue(undefined) };
    const input = proxyInput();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        proxy_list: [input],
        ip_scan_channel: "ipapi",
      });
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            success: [],
            fail: [
              {
                index: 0,
                message: `Rejected ${input.user}:${input.password}`,
              },
            ],
          },
          message: "Success",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "fake-duoplus-key",
      connectionId: "connection-a",
      fetchImpl,
      logger,
      minGapMs: 0,
    });

    await client.addProxies({
      proxy_list: [input],
      ip_scan_channel: "ipapi",
    });

    const logged = logger.log.mock.calls[0]?.[0];
    expect(JSON.stringify(logged)).not.toContain(input.user);
    expect(JSON.stringify(logged)).not.toContain(input.password);
    expect(logged.requestBody.proxy_list[0]).toMatchObject({
      user: "[REDACTED]",
      password: "[REDACTED]",
    });
    expect(logged.responseBody.data.fail[0].message).toContain("[REDACTED]");
  });

  it("redacts proxy credentials reflected by a failing envelope", async () => {
    const logger = { log: vi.fn().mockResolvedValue(undefined) };
    const input = proxyInput();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 500,
          data: null,
          message: `Could not authenticate ${input.user}:${input.password}`,
        }),
        { status: 500 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "fake-duoplus-key",
      connectionId: "connection-a",
      fetchImpl,
      logger,
      minGapMs: 0,
    });

    const error = await client
      .addProxies({ proxy_list: [input] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("DuoPlus request failed");
    expect((error as Error).message).not.toContain(input.user);
    expect((error as Error).message).not.toContain(input.password);
    expect(JSON.stringify(logger.log.mock.calls[0]?.[0])).not.toContain(input.password);
  });

  it("redacts proxy-list usernames only in audit output", async () => {
    const logger = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyUser = "listed-proxy-user";
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            list: [
              {
                id: "proxy-a",
                name: "Cycle proxy",
                host: "us.res.proxy-seller.com",
                port: "10000",
                user: proxyUser,
                area: "US",
              },
            ],
          },
          message: "Success",
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "fake-duoplus-key",
      connectionId: "connection-a",
      fetchImpl,
      logger,
      minGapMs: 0,
    });

    await expect(client.listProxies()).resolves.toEqual([
      expect.objectContaining({ id: "proxy-a", user: proxyUser }),
    ]);
    const logged = logger.log.mock.calls[0]?.[0];
    expect(JSON.stringify(logged)).not.toContain(proxyUser);
    expect(logged.responseBody.data.list[0].user).toBe("[REDACTED]");
  });

  it("enforces DuoPlus' 1–20 proxy batch limit before calling upstream", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "fake-duoplus-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    expect(() => client.addProxies({ proxy_list: [] })).toThrow("between 1 and 20");
    expect(() =>
      client.addProxies({ proxy_list: Array.from({ length: 21 }, proxyInput) }),
    ).toThrow("between 1 and 20");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns per-phone update acceptance so provisioning can fail closed", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            success: [],
            fail: ["phone-a"],
            fail_reason: { "phone-a": "Proxy check failed" },
          },
          message: "Success",
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "fake-duoplus-key",
      connectionId: "connection-a",
      fetchImpl,
      minGapMs: 0,
    });

    await expect(
      client.updatePhones({
        images: [{ image_id: "phone-a", proxy: { id: "proxy-a", dns: 1 } }],
      }),
    ).resolves.toEqual({
      success: [],
      fail: ["phone-a"],
      fail_reason: { "phone-a": "Proxy check failed" },
    });
  });
});
