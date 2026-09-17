const FALLBACK_ORIGIN = "https://stakeout.invalid";

export function safeAuthNext(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /%5c/i.test(value)
  ) {
    return "/";
  }

  try {
    const candidate = new URL(value, FALLBACK_ORIGIN);
    return candidate.origin === FALLBACK_ORIGIN
      ? `${candidate.pathname}${candidate.search}${candidate.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function createAuthCallbackUrl(origin: string, next: string | null): string {
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", safeAuthNext(next));
  return callback.toString();
}

export function legacyRootCodeCallback(url: URL): URL | null {
  if (url.pathname !== "/" || !url.searchParams.get("code")) return null;

  const callback = new URL(url);
  callback.pathname = "/auth/callback";
  return callback;
}
