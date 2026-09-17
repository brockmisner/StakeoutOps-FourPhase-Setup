import type { ProxySellerBusinessError, ProxySellerEnvelope } from "./types";

export class ProxySellerApiError extends Error {
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly businessCode: number | null;
  readonly retryable: boolean;

  constructor(options: {
    endpoint: string;
    message: string;
    httpStatus?: number | null;
    businessCode?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProxySellerApiError";
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus ?? null;
    this.businessCode = options.businessCode ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function errorMessage(errors: ProxySellerBusinessError[] | undefined): string {
  const first = errors?.find((error) => typeof error.message === "string");
  return first?.message?.slice(0, 500) || "Proxy-Seller rejected the request";
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function parseProxySellerResponse<T>(
  value: unknown,
  endpoint: string,
  httpStatus: number,
): T {
  if (!value || typeof value !== "object") {
    throw new ProxySellerApiError({
      endpoint,
      httpStatus,
      message: `${endpoint} returned an invalid response`,
      retryable: retryableHttpStatus(httpStatus),
    });
  }

  const envelope = value as ProxySellerEnvelope<T>;
  if (envelope.status === "error" || (envelope.errors?.length ?? 0) > 0) {
    const businessCode = envelope.errors
      ?.map((error) => Number(error.code))
      .find(Number.isFinite);
    const message = errorMessage(envelope.errors);
    throw new ProxySellerApiError({
      endpoint,
      httpStatus,
      businessCode: businessCode ?? null,
      message: `${endpoint}: ${message}`,
      retryable:
        retryableHttpStatus(httpStatus) ||
        /request limit|rate limit|temporar|timeout|try again/i.test(message),
    });
  }

  if (!responseOk(httpStatus)) {
    throw new ProxySellerApiError({
      endpoint,
      httpStatus,
      message: `${endpoint} failed with HTTP ${httpStatus}`,
      retryable: retryableHttpStatus(httpStatus),
    });
  }

  if (
    typeof envelope.status === "string" &&
    envelope.status !== "success"
  ) {
    throw new ProxySellerApiError({
      endpoint,
      httpStatus,
      message: `${endpoint} returned an invalid status`,
      retryable: false,
    });
  }

  if ("data" in envelope) return envelope.data as T;
  // /resident/geo is documented as a bare array on success.
  return value as T;
}

function responseOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export function safeProxyEndpoint(path: string): string {
  if (!/^\/(?!\/)[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(path)) {
    throw new Error("Invalid Proxy-Seller endpoint");
  }
  return path;
}

export function rotationValue(value: number | string): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -1 &&
    value <= 3_600
  ) {
    return value;
  }

  const text = String(value).trim();
  const parsed = /^-?\d+/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= -1 && parsed <= 3_600) {
    return parsed;
  }
  if (/sticky|no rotation/i.test(text)) return -1;
  if (/per request|each request/i.test(text)) return 0;
  throw new Error("Invalid Proxy-Seller rotation value");
}

/** Redacts both literal and URL-encoded forms of path-based credentials. */
export function redactProxySellerSecrets(
  value: string,
  secrets: Array<string | undefined>,
): string {
  return secrets.reduce<string>((text, candidate) => {
    const secret = candidate?.trim();
    if (!secret) return text;
    const encoded = encodeURIComponent(secret);
    return text
      .split(secret)
      .join("[REDACTED]")
      .split(encoded)
      .join("[REDACTED]");
  }, value);
}

export function normalizeProxySellerDate(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    const [, dayText, monthText, yearText] = match;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }
    return `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
  }

  // Avoid implementation-dependent parsing of ambiguous dotted/slashed dates.
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!isoMatch) return null;
  const direct = new Date(trimmed);
  if (Number.isNaN(direct.getTime())) return null;
  const normalized = direct.toISOString().slice(0, 10);
  return normalized === `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    ? normalized
    : null;
}

export function normalizeProxySellerInteger(
  value: string | undefined,
): string | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return value.trim();
}
