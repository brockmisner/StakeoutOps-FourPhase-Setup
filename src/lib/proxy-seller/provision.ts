import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DuoPlusClient, DuoPlusProxy } from "@/lib/duoplus";

import { createProxySellerClient } from "./client";
import {
  normalizeProxySellerDate,
  normalizeProxySellerInteger,
  redactProxySellerSecrets,
  rotationValue,
} from "./protocol";
import {
  proxyGatewayForCountry,
  proxyTargetInventory,
  recommendProxyTarget,
} from "./selection";
import type { ProxySellerList, ProxySellerPackage } from "./types";

type CycleForProvisioning = {
  id: string;
  organization_id: string;
  client_id: string;
  connection_id: string;
  phone_id: string;
  target_country: string;
  target_region: string;
  target_city: string;
  target_latitude: number | null;
  target_longitude: number | null;
  timezone: string;
  ends_on: string;
};

type PhoneForProvisioning = {
  id: string;
  duoplus_image_id: string;
  name: string;
};

function assertProvisioningTarget(cycle: CycleForProvisioning): void {
  const hasLatitude = cycle.target_latitude !== null;
  const hasLongitude = cycle.target_longitude !== null;
  if (hasLatitude !== hasLongitude) {
    throw new Error("Proxy target requires both latitude and longitude");
  }
  if (
    hasLatitude &&
    (!Number.isFinite(cycle.target_latitude) ||
      !Number.isFinite(cycle.target_longitude) ||
      cycle.target_latitude! < -90 ||
      cycle.target_latitude! > 90 ||
      cycle.target_longitude! < -180 ||
      cycle.target_longitude! > 180)
  ) {
    throw new Error("Proxy target coordinates are outside valid bounds");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cycle.timezone }).format();
  } catch {
    throw new Error("Proxy target timezone is invalid");
  }
}

function tenantCode(organizationId: string): string {
  return createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
}

export function proxyListTitle(organizationId: string, cycleId: string): string {
  return `stk-${tenantCode(organizationId)}-${cycleId.replaceAll("-", "").slice(0, 10)}`;
}

export async function saveProxyPackageSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  value: ProxySellerPackage,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("proxy_package_snapshots").upsert(
    {
      organization_id: organizationId,
      is_active: value.is_active === true,
      auto_renew: typeof value.auto_renew === "boolean" ? value.auto_renew : null,
      expired_on: normalizeProxySellerDate(value.expired_at),
      traffic_limit_bytes: normalizeProxySellerInteger(value.traffic_limit),
      traffic_used_bytes: normalizeProxySellerInteger(value.traffic_usage),
      traffic_left_bytes: normalizeProxySellerInteger(value.traffic_left),
      synced_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: "organization_id" },
  );
  if (error) throw new Error(`Save proxy package snapshot: ${error.message}`);
}

function loginHint(login: string): string {
  return login.length <= 4 ? "••••" : `•••• ${login.slice(-4)}`;
}

async function saveProxyList(
  supabase: SupabaseClient,
  organizationId: string,
  list: ProxySellerList,
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("proxy_lists")
    .upsert(
      {
        organization_id: organizationId,
        provider_list_id: list.id,
        title: list.title,
        login_hint: loginHint(list.login),
        country: list.geo.country.toUpperCase(),
        region: list.geo.region,
        city: list.geo.city,
        isp: list.geo.isp,
        rotation_seconds: rotationValue(list.rotation),
        port_count: 1,
        enabled: true,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "organization_id,provider_list_id" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`Save proxy list: ${error?.message ?? "missing row"}`);
  return data as { id: string };
}

async function ensureDuoPlusProxy(options: {
  duo: DuoPlusClient;
  name: string;
  list: ProxySellerList;
  host: string;
  port: number;
}): Promise<DuoPlusProxy> {
  const find = (rows: DuoPlusProxy[]) => rows.find((proxy) => proxy.name === options.name);
  const validateExisting = (proxy: DuoPlusProxy): DuoPlusProxy => {
    const sameHost =
      typeof proxy.host === "string" &&
      proxy.host.trim().toLocaleLowerCase("en-US") ===
        options.host.toLocaleLowerCase("en-US");
    const samePort = Number(proxy.port) === options.port;
    const sameUser =
      typeof proxy.user === "string" && proxy.user === options.list.login;
    if (!sameHost || !samePort || !sameUser) {
      throw new Error(
        "Existing DuoPlus proxy name has different connection settings",
      );
    }
    return proxy;
  };
  const existing = find(await options.duo.listProxies());
  if (existing) return validateExisting(existing);

  try {
    const result = await options.duo.addProxies({
      proxy_list: [
        {
          protocol: "socks5",
          host: options.host,
          port: options.port,
          user: options.list.login,
          password: options.list.password,
          name: options.name,
        },
      ],
      ip_scan_channel: "ipapi",
    });
    const id = result.success?.find((item) => item.index === 0)?.id;
    if (id) return { id, name: options.name, host: options.host, port: options.port };
    const failure = result.fail?.find((item) => item.index === 0)?.message;
    throw new Error(
      failure
        ? redactProxySellerSecrets(failure, [
            options.list.login,
            options.list.password,
          ])
        : "DuoPlus did not return the new proxy id",
    );
  } catch (error) {
    // As with addTask, a network failure may occur after acceptance. Reconcile
    // by deterministic name, but never issue a second create automatically.
    const reconciled = find(await options.duo.listProxies());
    if (reconciled) return validateExisting(reconciled);
    throw error;
  }
}

export async function provisionCycleProxy(options: {
  supabase: SupabaseClient;
  duo: DuoPlusClient;
  cycle: CycleForProvisioning;
  phone: PhoneForProvisioning;
}): Promise<{
  bindingId: string;
  isp: string;
  city: string;
  diversityStatus: "unique" | "reused";
}> {
  assertProvisioningTarget(options.cycle);
  const seller = createProxySellerClient();
  const [proxyPackage, catalog] = await Promise.all([
    seller.getPackage(),
    seller.getGeo(),
  ]);
  await saveProxyPackageSnapshot(
    options.supabase,
    options.cycle.organization_id,
    proxyPackage,
  );
  if (!proxyPackage.is_active) throw new Error("Proxy-Seller residential package is inactive");
  const expiredOn = normalizeProxySellerDate(proxyPackage.expired_at);
  if (!expiredOn) {
    throw new Error("Proxy-Seller package expiration could not be verified");
  }
  const cycleEndsOn = normalizeProxySellerDate(options.cycle.ends_on);
  if (!cycleEndsOn) throw new Error("Device cycle end date is invalid");
  if (expiredOn < new Date().toISOString().slice(0, 10)) {
    throw new Error("Proxy-Seller residential package is expired");
  }
  if (expiredOn < cycleEndsOn) {
    throw new Error("Proxy-Seller package expires before the device cycle ends");
  }
  const trafficLeft = normalizeProxySellerInteger(proxyPackage.traffic_left);
  if (trafficLeft === null) {
    throw new Error("Proxy-Seller remaining traffic could not be verified");
  }
  if (trafficLeft === "0") {
    throw new Error("Proxy-Seller residential package has no traffic remaining");
  }
  const target = proxyTargetInventory({
    catalog,
    country: options.cycle.target_country,
    region: options.cycle.target_region,
    city: options.cycle.target_city,
  });
  const { data: reservationData, error: reservationError } =
    await options.supabase.rpc("reserve_cycle_proxy_isp", {
      p_organization_id: options.cycle.organization_id,
      p_cycle_id: options.cycle.id,
      p_candidate_isps: target.isps,
    });
  if (reservationError) throw new Error("Reserve cycle proxy ISP failed");
  const reservation = Array.isArray(reservationData)
    ? reservationData[0]
    : reservationData;
  const selectedIsp =
    reservation && typeof reservation.selected_isp === "string"
      ? reservation.selected_isp
      : null;
  if (!selectedIsp) throw new Error("Proxy ISP reservation returned no ISP");
  if (
    !target.isps.some(
      (isp) =>
        isp.trim().toLocaleLowerCase("en-US") ===
        selectedIsp.trim().toLocaleLowerCase("en-US"),
    )
  ) {
    throw new Error("Reserved proxy ISP is no longer available for the exact city");
  }
  const recommendation = recommendProxyTarget({
    catalog,
    country: target.country,
    region: target.region,
    city: target.city,
    preferredIsp: selectedIsp,
  });
  const diversityStatus =
    reservation.diversity_status === "reused" ? "reused" : "unique";
  const title = proxyListTitle(options.cycle.organization_id, options.cycle.id);
  const list = await seller.ensureProxyList({
    title,
    whitelist: "",
    geo: {
      country: recommendation.country,
      region: recommendation.region,
      city: recommendation.city,
      isp: recommendation.isp,
    },
    export: { ports: 1, ext: "txt" },
    rotation: -1,
  });
  const localList = await saveProxyList(
    options.supabase,
    options.cycle.organization_id,
    list,
  );
  const gatewayHost = proxyGatewayForCountry(recommendation.country);
  const gatewayPort = 10_000;
  const duoProxy = await ensureDuoPlusProxy({
    duo: options.duo,
    name: title,
    list,
    host: gatewayHost,
    port: gatewayPort,
  });

  const phoneUpdate = await options.duo.updatePhones({
    images: [
      {
        image_id: options.phone.duoplus_image_id,
        proxy: { id: duoProxy.id, dns: 1 },
        gps:
          options.cycle.target_latitude !== null && options.cycle.target_longitude !== null
            ? {
                type: 2,
                latitude: options.cycle.target_latitude,
                longitude: options.cycle.target_longitude,
              }
            : { type: 1 },
        locale: { type: 2, timezone: options.cycle.timezone, language: "en-US" },
      },
    ],
  });
  if (!phoneUpdate.success?.includes(options.phone.duoplus_image_id)) {
    const reason =
      typeof phoneUpdate.fail_reason === "string"
        ? phoneUpdate.fail_reason
        : phoneUpdate.fail_reason?.[options.phone.duoplus_image_id];
    throw new Error(
      reason
        ? redactProxySellerSecrets(reason, [list.login, list.password])
        : "DuoPlus rejected the phone proxy update",
    );
  }

  const now = new Date().toISOString();
  const existingBinding = await options.supabase
    .from("phone_proxy_bindings")
    .select("id")
    .eq("organization_id", options.cycle.organization_id)
    .eq("device_cycle_id", options.cycle.id)
    .is("released_at", null)
    .maybeSingle();
  if (existingBinding.error) {
    throw new Error(`Load proxy binding: ${existingBinding.error.message}`);
  }
  const bindingPayload = {
    organization_id: options.cycle.organization_id,
    client_id: options.cycle.client_id,
    connection_id: options.cycle.connection_id,
    phone_id: options.phone.id,
    device_cycle_id: options.cycle.id,
    proxy_list_id: localList.id,
    duoplus_proxy_id: duoProxy.id,
    gateway_host: gatewayHost,
    gateway_port: gatewayPort,
    configured_country: recommendation.country,
    configured_region: recommendation.region,
    configured_city: recommendation.city,
    configured_isp: recommendation.isp,
    target_latitude: options.cycle.target_latitude,
    target_longitude: options.cycle.target_longitude,
    diversity_status: diversityStatus,
    health: "unverified",
    checked_at: null,
    last_error: null,
    updated_at: now,
  };
  const bindingResult = existingBinding.data
    ? await options.supabase
        .from("phone_proxy_bindings")
        .update(bindingPayload)
        .eq("id", existingBinding.data.id)
        .eq("organization_id", options.cycle.organization_id)
        .select("id")
        .single()
    : await options.supabase
        .from("phone_proxy_bindings")
        .insert(bindingPayload)
        .select("id")
        .single();
  if (bindingResult.error || !bindingResult.data) {
    throw new Error(`Save phone proxy binding: ${bindingResult.error?.message ?? "missing row"}`);
  }

  return {
    bindingId: bindingResult.data.id,
    isp: recommendation.isp,
    city: recommendation.city,
    diversityStatus,
  };
}
