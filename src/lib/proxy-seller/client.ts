import "server-only";

import {
  ProxySellerApiError,
  parseProxySellerResponse,
  redactProxySellerSecrets,
  rotationValue,
  safeProxyEndpoint,
} from "./protocol";
import type {
  ProxySellerCreateListInput,
  ProxySellerGeoCountry,
  ProxySellerList,
  ProxySellerPackage,
} from "./types";

type FetchMethod = "GET" | "POST" | "DELETE" | "PUT";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function validateCreateListInput(input: ProxySellerCreateListInput): void {
  if (!input.title.trim()) throw new Error("Proxy list title is required");
  if (
    !input.geo.country.trim() ||
    !input.geo.region.trim() ||
    !input.geo.city.trim() ||
    !input.geo.isp.trim()
  ) {
    throw new Error("Proxy list requires an exact country, region, city, and ISP");
  }
  if (
    !Number.isInteger(input.export.ports) ||
    input.export.ports < 1 ||
    input.export.ports > 1_000
  ) {
    throw new Error("Proxy list ports must be an integer between 1 and 1000");
  }
  if (!input.export.ext.trim()) throw new Error("Proxy list export type is required");
  rotationValue(input.rotation);
}

function listMatchesTarget(
  list: ProxySellerList,
  input: ProxySellerCreateListInput,
): boolean {
  return (
    normalized(list.geo.country) === normalized(input.geo.country) &&
    normalized(list.geo.region) === normalized(input.geo.region) &&
    normalized(list.geo.city) === normalized(input.geo.city) &&
    normalized(list.geo.isp) === normalized(input.geo.isp)
  );
}

export type ProxySellerClientOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class ProxySellerClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ProxySellerClientOptions = {}) {
    this.apiKey = (
      options.apiKey ??
      process.env.PROXY_SELLER_API_KEY ??
      process.env.proxy_reseller_api_key ??
      ""
    ).trim();
    if (!this.apiKey) throw new Error("PROXY_SELLER_API_KEY is not configured");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(
    method: FetchMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const endpoint = safeProxyEndpoint(path);
    // Never expose this URL to logs or errors. The provider uses path-based auth.
    const url = `https://proxy-seller.com/personal/api/v1/${encodeURIComponent(this.apiKey)}/resident${endpoint}`;
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = {
          status: "error",
          errors: [{ message: "Invalid JSON response" }],
        };
      }
      return parseProxySellerResponse<T>(parsed, endpoint, response.status);
    } catch (error) {
      if (error instanceof ProxySellerApiError) {
        throw new ProxySellerApiError({
          endpoint: error.endpoint,
          httpStatus: error.httpStatus,
          businessCode: error.businessCode,
          retryable: error.retryable,
          message: redactProxySellerSecrets(error.message, [this.apiKey]),
        });
      }

      // Native fetch errors may retain their full request URL, which contains
      // the API key. Never attach the original error as a public `cause`.
      throw new ProxySellerApiError({
        endpoint,
        httpStatus: response?.status ?? null,
        message: `${endpoint} network request failed`,
        retryable: true,
      });
    }
  }

  async getPackage(): Promise<ProxySellerPackage> {
    return this.request<ProxySellerPackage>("GET", "/package");
  }

  async getGeo(): Promise<ProxySellerGeoCountry[]> {
    return this.request<ProxySellerGeoCountry[]>("GET", "/geo");
  }

  async listProxyLists(): Promise<ProxySellerList[]> {
    const data = await this.request<{ items?: ProxySellerList[] }>("GET", "/lists");
    return Array.isArray(data?.items) ? data.items : [];
  }

  async createProxyList(input: ProxySellerCreateListInput): Promise<ProxySellerList> {
    validateCreateListInput(input);
    return this.request<ProxySellerList>("POST", "/list/add", input);
  }

  async updateProxyListRotation(
    id: number,
    rotation: number,
  ): Promise<ProxySellerList> {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("A valid Proxy-Seller list id is required");
    }
    const normalizedRotation = rotationValue(rotation);
    return this.request<ProxySellerList>("POST", "/list/rotation", {
      id,
      rotation: normalizedRotation,
    });
  }

  async ensureProxyList(input: ProxySellerCreateListInput): Promise<ProxySellerList> {
    validateCreateListInput(input);
    const desiredRotation = rotationValue(input.rotation);
    const validateAndAlign = async (list: ProxySellerList) => {
      if (!listMatchesTarget(list, input)) {
        throw new ProxySellerApiError({
          endpoint: "/lists",
          message: "Existing Proxy-Seller list title has different GEO settings",
          retryable: false,
        });
      }
      return rotationValue(list.rotation) === desiredRotation
        ? list
        : this.updateProxyListRotation(list.id, desiredRotation);
    };

    const existing = (await this.listProxyLists()).find(
      (item) => item.title === input.title,
    );
    if (existing) return validateAndAlign(existing);
    try {
      return await validateAndAlign(await this.createProxyList(input));
    } catch (error) {
      // A timeout can happen after the provider accepted the create. Reconcile
      // by deterministic title before allowing an operator to retry.
      let reconciled: ProxySellerList | undefined;
      try {
        reconciled = (await this.listProxyLists()).find(
          (item) => item.title === input.title,
        );
      } catch {
        // Preserve the original, endpoint-only error.
      }
      // Keep the safety checks outside the catch: a title collision discovered
      // during reconciliation must not be hidden behind the original timeout.
      if (reconciled) return validateAndAlign(reconciled);
      throw error;
    }
  }
}

export function createProxySellerClient(
  options: ProxySellerClientOptions = {},
): ProxySellerClient {
  return new ProxySellerClient(options);
}
