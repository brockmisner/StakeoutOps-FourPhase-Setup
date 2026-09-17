import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProxySellerClient } from "@/lib/proxy-seller/client";
import {
  ProxySellerApiError,
  normalizeProxySellerDate,
  normalizeProxySellerInteger,
  parseProxySellerResponse,
  redactProxySellerSecrets,
  rotationValue,
  safeProxyEndpoint,
} from "@/lib/proxy-seller/protocol";
import {
  proxyGatewayForCountry,
  recommendProxyTarget,
} from "@/lib/proxy-seller/selection";

const catalog = [
  {
    code: "US",
    name: "United States",
    regions: [
      {
        name: "Florida",
        code: 12,
        cities: [
          {
            name: "Lakeland",
            isps: ["Example Fiber", "Example Cable", "Example Fiber"],
          },
        ],
      },
    ],
  },
];

const createListInput = {
  title: "cycle-list",
  whitelist: "",
  geo: {
    country: "US",
    region: "Florida",
    city: "Lakeland",
    isp: "Example Fiber",
  },
  export: { ports: 1, ext: "txt" },
  rotation: -1,
};

describe("Proxy-Seller response parsing", () => {
  it("unwraps normal envelopes and preserves the documented bare GEO array", () => {
    expect(
      parseProxySellerResponse(
        { status: "success", data: { package_key: "package" }, errors: [] },
        "/package",
        200,
      ),
    ).toEqual({ package_key: "package" });
    expect(parseProxySellerResponse(catalog, "/geo", 200)).toEqual(catalog);
  });

  it("treats HTTP-200 business errors as failures and recognizes rate limits", () => {
    let error: unknown;
    try {
      parseProxySellerResponse(
        {
          status: "error",
          data: null,
          errors: [{ message: "Request limit reached", code: 503 }],
        },
        "/lists",
        200,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProxySellerApiError);
    expect(error).toMatchObject({
      endpoint: "/lists",
      httpStatus: 200,
      businessCode: 503,
      retryable: true,
    });
  });

  it("marks an empty 429 response retryable and rejects unknown statuses", () => {
    expect(() => parseProxySellerResponse(null, "/geo", 429)).toThrowError(
      expect.objectContaining({ retryable: true }),
    );
    expect(() =>
      parseProxySellerResponse(
        { status: "unexpected", data: {} },
        "/package",
        200,
      ),
    ).toThrow("invalid status");
  });
});

describe("Proxy-Seller protocol normalization", () => {
  it.each([
    [-1, -1],
    [0, 0],
    [3_600, 3_600],
    ["-1 = sticky", -1],
    ["0 = rotation per request", 0],
    ["rotation per request", 0],
  ])("normalizes rotation %s", (value, expected) => {
    expect(rotationValue(value)).toBe(expected);
  });

  it.each([-2, 3_601, "unknown", ""]) (
    "rejects unsafe rotation %s",
    (value) => {
      expect(() => rotationValue(value)).toThrow("Invalid Proxy-Seller rotation");
    },
  );

  it("accepts symbolic paths but rejects URL/key injection", () => {
    expect(safeProxyEndpoint("/list/rotation")).toBe("/list/rotation");
    for (const unsafe of ["//list", "/../list", "/lists?key=secret", "https://example.test"]) {
      expect(() => safeProxyEndpoint(unsafe)).toThrow("Invalid Proxy-Seller endpoint");
    }
  });

  it("redacts literal and URL-encoded forms of path credentials", () => {
    const credential = "fake/key+value";
    const output = redactProxySellerSecrets(
      `literal=${credential} encoded=${encodeURIComponent(credential)}`,
      [credential],
    );
    expect(output).not.toContain(credential);
    expect(output).not.toContain(encodeURIComponent(credential));
    expect(output).toContain("[REDACTED]");
  });

  it("parses provider dates without locale ambiguity", () => {
    expect(normalizeProxySellerDate("05.09.2026")).toBe("2026-09-05");
    expect(normalizeProxySellerDate("2026-09-05T12:00:00Z")).toBe("2026-09-05");
    expect(normalizeProxySellerDate("31.02.2026")).toBeNull();
    expect(normalizeProxySellerDate("2026-02-31")).toBeNull();
    expect(normalizeProxySellerDate("05/09/2026")).toBeNull();
  });

  it("keeps byte counters as integer strings", () => {
    expect(normalizeProxySellerInteger(" 7516192768 ")).toBe("7516192768");
    expect(normalizeProxySellerInteger("1.5")).toBeNull();
    expect(normalizeProxySellerInteger("-1")).toBeNull();
  });
});

describe("Proxy-Seller target selection", () => {
  it("chooses the least-used ISP for the exact city", () => {
    expect(
      recommendProxyTarget({
        catalog,
        country: "us",
        region: "florida",
        city: "lakeland",
        usedIsps: ["Example Cable"],
      }),
    ).toEqual({
      country: "US",
      region: "Florida",
      city: "Lakeland",
      isp: "Example Fiber",
      diversityStatus: "unique",
      availableIspCount: 2,
    });
  });

  it("fails closed instead of silently selecting a different city", () => {
    expect(() =>
      recommendProxyTarget({
        catalog,
        country: "US",
        region: "Florida",
        city: "Tampa",
      }),
    ).toThrow("No exact Proxy-Seller city match");
  });

  it("selects the nearest gateway region", () => {
    expect(proxyGatewayForCountry("US")).toBe("us.res.proxy-seller.com");
    expect(proxyGatewayForCountry("JP")).toBe("asia.res.proxy-seller.com");
    expect(proxyGatewayForCountry("DE")).toBe("res.proxy-seller.com");
  });
});

describe("Proxy-Seller client safety", () => {
  it("does not retain a secret-bearing fetch URL in the public error or cause", async () => {
    const fakeCredential = "fake-path-credential";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      throw new Error(`Network rejected ${String(url)}`);
    }) as typeof fetch;
    const client = new ProxySellerClient({
      apiKey: fakeCredential,
      fetchImpl,
      timeoutMs: 100,
    });

    const error = await client.getPackage().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProxySellerApiError);
    expect(JSON.stringify(error)).not.toContain(fakeCredential);
    expect((error as Error).message).toBe("/package network request failed");
    expect((error as Error).cause).toBeUndefined();
  });

  it("refuses to reuse a deterministic title with different GEO settings", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            items: [
              {
                id: 10,
                title: createListInput.title,
                login: "fake-user",
                password: "fake-password",
                rotation: -1,
                geo: { ...createListInput.geo, city: "Tampa" },
              },
            ],
          },
          errors: [],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new ProxySellerClient({
      apiKey: "fake-path-credential",
      fetchImpl,
    });

    await expect(client.ensureProxyList(createListInput)).rejects.toThrow(
      "different GEO settings",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a GEO collision found while reconciling a timed-out create", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ status: "success", data: { items: [] }, errors: [] }),
          { status: 200 },
        );
      }
      if (call === 2) throw new Error("simulated timeout");
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            items: [
              {
                id: 10,
                title: createListInput.title,
                login: "fake-user",
                password: "fake-password",
                rotation: -1,
                geo: { ...createListInput.geo, isp: "Different ISP" },
              },
            ],
          },
          errors: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new ProxySellerClient({
      apiKey: "fake-path-credential",
      fetchImpl,
    });

    await expect(client.ensureProxyList(createListInput)).rejects.toThrow(
      "different GEO settings",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("aligns a matching existing list to sticky rotation", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              items: [
                {
                  id: 10,
                  title: createListInput.title,
                  login: "fake-user",
                  password: "fake-password",
                  rotation: "0 = rotation per request",
                  geo: createListInput.geo,
                },
              ],
            },
            errors: [],
          }),
          { status: 200 },
        );
      }
      expect(JSON.parse(String(init?.body))).toEqual({ id: 10, rotation: -1 });
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            id: 10,
            title: createListInput.title,
            login: "fake-user",
            password: "fake-password",
            rotation: -1,
            geo: createListInput.geo,
          },
          errors: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new ProxySellerClient({
      apiKey: "fake-path-credential",
      fetchImpl,
    });

    await expect(client.ensureProxyList(createListInput)).resolves.toMatchObject({
      id: 10,
      rotation: -1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
