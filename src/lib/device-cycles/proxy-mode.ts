export type DeviceCycleProxyMode = "managed" | "preconfigured";

type Environment = Record<string, string | undefined>;

export class MissingProxySellerApiKeyError extends Error {
  constructor() {
    super("Managed proxy mode requires PROXY_SELLER_API_KEY");
    this.name = "MissingProxySellerApiKeyError";
  }
}

export class ProxySellerAutomationDisabledError extends Error {
  constructor() {
    super("Managed proxy mode requires PROXY_SELLER_AUTOMATION_ENABLED=true");
    this.name = "ProxySellerAutomationDisabledError";
  }
}

export function hasProxySellerApiKey(environment: Environment = process.env): boolean {
  return Boolean(
    environment.PROXY_SELLER_API_KEY?.trim() ||
      environment.proxy_reseller_api_key?.trim(),
  );
}

export function isProxySellerAutomationEnabled(
  environment: Environment = process.env,
): boolean {
  return environment.PROXY_SELLER_AUTOMATION_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Preserve managed provisioning when it is configured, while making the
 * no-secret path safe for phones whose proxies were configured beforehand.
 */
export function resolveDeviceCycleProxyMode(
  requestedMode: DeviceCycleProxyMode | undefined,
  environment: Environment = process.env,
): DeviceCycleProxyMode {
  const sellerConfigured = hasProxySellerApiKey(environment);
  const automationEnabled = isProxySellerAutomationEnabled(environment);
  if (requestedMode === "managed") {
    if (!automationEnabled) throw new ProxySellerAutomationDisabledError();
    if (!sellerConfigured) throw new MissingProxySellerApiKeyError();
    return "managed";
  }
  if (requestedMode) return requestedMode;
  return sellerConfigured && automationEnabled ? "managed" : "preconfigured";
}

export type DeviceCycleProxyState =
  | {
      mode: "managed";
      health: "unverified";
      verificationStatus: "not_performed";
      city: string;
      isp: string;
      diversityStatus: "unique" | "reused";
    }
  | {
      mode: "preconfigured";
      health: null;
      verificationStatus: "not_performed";
      city: null;
      isp: null;
      diversityStatus: "unknown";
    };

/**
 * The callback boundary makes it impossible for preconfigured mode to invoke
 * the provider integration. It also keeps its returned GEO/ISP deliberately
 * empty until a separate egress observation can verify the phone.
 */
export async function prepareDeviceCycleProxy(options: {
  mode: DeviceCycleProxyMode;
  provisionManaged: () => Promise<{
    city: string;
    isp: string;
    diversityStatus: "unique" | "reused";
  }>;
}): Promise<DeviceCycleProxyState> {
  if (options.mode === "preconfigured") {
    return {
      mode: "preconfigured",
      health: null,
      verificationStatus: "not_performed",
      city: null,
      isp: null,
      diversityStatus: "unknown",
    };
  }

  const managed = await options.provisionManaged();
  return {
    mode: "managed",
    health: "unverified",
    verificationStatus: "not_performed",
    city: managed.city,
    isp: managed.isp,
    diversityStatus: managed.diversityStatus,
  };
}
