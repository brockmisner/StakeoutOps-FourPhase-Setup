import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  MissingProxySellerApiKeyError,
  prepareDeviceCycleProxy,
  ProxySellerAutomationDisabledError,
  resolveDeviceCycleProxyMode,
} from "@/lib/device-cycles/proxy-mode";

describe("device-cycle proxy mode", () => {
  it("defaults to preconfigured without provider automation", () => {
    expect(resolveDeviceCycleProxyMode(undefined, {})).toBe("preconfigured");
    expect(
      resolveDeviceCycleProxyMode(undefined, {
        PROXY_SELLER_API_KEY: "provider-key",
      }),
    ).toBe("preconfigured");
    expect(
      resolveDeviceCycleProxyMode(undefined, {
        PROXY_SELLER_AUTOMATION_ENABLED: "true",
      }),
    ).toBe("preconfigured");
  });

  it("defaults to managed only when both the server key and opt-in are present", () => {
    expect(
      resolveDeviceCycleProxyMode(undefined, {
        PROXY_SELLER_API_KEY: "provider-key",
        PROXY_SELLER_AUTOMATION_ENABLED: " TRUE ",
      }),
    ).toBe("managed");
  });

  it("honors an explicit preconfigured mode even when managed automation is available", () => {
    expect(
      resolveDeviceCycleProxyMode("preconfigured", {
        PROXY_SELLER_API_KEY: "provider-key",
        PROXY_SELLER_AUTOMATION_ENABLED: "true",
      }),
    ).toBe("preconfigured");
  });

  it("rejects explicit managed mode while automation is disabled", () => {
    expect(() =>
      resolveDeviceCycleProxyMode("managed", {
        PROXY_SELLER_API_KEY: "provider-key",
      }),
    ).toThrow(ProxySellerAutomationDisabledError);
  });

  it("rejects explicit managed mode when its server key is absent", () => {
    expect(() =>
      resolveDeviceCycleProxyMode("managed", {
        PROXY_SELLER_AUTOMATION_ENABLED: "true",
      }),
    ).toThrow(MissingProxySellerApiKeyError);
  });

  it("never invokes managed provisioning in preconfigured mode", async () => {
    const provisionManaged = vi.fn(async () => ({
      city: "Lakeland",
      isp: "Example ISP",
      diversityStatus: "unique" as const,
    }));

    const result = await prepareDeviceCycleProxy({
      mode: "preconfigured",
      provisionManaged,
    });

    expect(provisionManaged).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "preconfigured",
      health: null,
      verificationStatus: "not_performed",
      city: null,
      isp: null,
      diversityStatus: "unknown",
    });
  });

  it("returns managed metadata only after its provisioner succeeds", async () => {
    const provisionManaged = vi.fn(async () => ({
      city: "Lakeland",
      isp: "Example ISP",
      diversityStatus: "reused" as const,
    }));

    await expect(
      prepareDeviceCycleProxy({ mode: "managed", provisionManaged }),
    ).resolves.toEqual({
      mode: "managed",
      health: "unverified",
      verificationStatus: "not_performed",
      city: "Lakeland",
      isp: "Example ISP",
      diversityStatus: "reused",
    });
    expect(provisionManaged).toHaveBeenCalledTimes(1);
  });

  it("keeps the public cycle route disconnected from provider provisioning", () => {
    const route = readFileSync(
      new URL("../src/app/api/device-cycles/route.ts", import.meta.url),
      "utf8",
    );

    expect(route).toContain('const proxyMode = "preconfigured" as const;');
    expect(route).not.toContain("provisionCycleProxy");
    expect(route).not.toContain("@/lib/proxy-seller");
    expect(route).not.toContain("proxyMode: z.enum");
  });

  it("compiles preconfigured cycles without phone proxy, GPS, or locale mutation", () => {
    const migration = readFileSync(
      new URL(
        "../supabase/migrations/20260905190000_preconfigured_device_cycle_proxy_mode.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("alter column proxy_mode set default 'preconfigured'");
    expect(migration).toContain("when v_cycle.proxy_mode = 'preconfigured' then 0");
    expect(migration).toContain(
      "case when v_cycle.proxy_mode = 'managed' then v_cycle.timezone else null end",
    );
    expect(migration).toContain(
      "if v_cycle.proxy_mode = 'managed' and not exists",
    );
    expect(migration).toContain("cycle.proxy_mode = 'preconfigured'");
    expect(migration).toContain("phone.client_id = cycle.client_id");
    expect(migration).toContain(
      "v_phone.client_id is distinct from v_run.client_id",
    );
  });
});
