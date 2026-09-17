import "server-only";

import {
  hasSupabaseBrowserConfig,
  hasSupabaseServerConfig,
} from "@/lib/supabase/config";

function validHttpsUrl(value: string | undefined): boolean {
  try {
    const parsed = new URL(value?.trim() ?? "");
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validEncryptionKey(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.byteLength === 32 && decoded.toString("base64") === trimmed;
  } catch {
    return false;
  }
}

function plausibleServerSecret(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) >= 20;
}

export function deploymentReadinessChecks() {
  return {
    supabaseBrowser:
      hasSupabaseBrowserConfig() &&
      validHttpsUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseServer:
      hasSupabaseServerConfig() &&
      plausibleServerSecret(process.env.SUPABASE_SECRET_KEY),
    credentialEncryption: validEncryptionKey(
      process.env.INTEGRATION_ENCRYPTION_KEY,
    ),
    cronAuthentication: plausibleServerSecret(process.env.CRON_SECRET),
  };
}

export function isDeploymentReady(): boolean {
  return Object.values(deploymentReadinessChecks()).every(Boolean);
}
