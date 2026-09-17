export interface WorkerConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  intervalMs: number;
  maxRuntimeMs: number;
  staleAfterMs: number;
  port: number;
  batchSize: number;
  horizonBatchSize: number;
  lookaheadMinutes: number;
}

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!env[name]) return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  if (env.NEXT_PUBLIC_DEMO_MODE === "true") {
    throw new Error("The scheduler worker cannot run in demo mode");
  }
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey?.trim()) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTP(S) origin");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("SUPABASE_URL must be an HTTPS origin (HTTP is allowed for localhost)");
  }
  if (
    env.SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_URL &&
    env.SUPABASE_URL.replace(/\/$/, "") !== env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")
  ) {
    throw new Error("SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL must match");
  }
  const encryptionKey = env.INTEGRATION_ENCRYPTION_KEY;
  if (
    !encryptionKey || encryptionKey.trim() !== encryptionKey ||
    Buffer.from(encryptionKey, "base64").byteLength !== 32 ||
    Buffer.from(encryptionKey, "base64").toString("base64") !== encryptionKey
  ) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key");
  }
  return {
    supabaseUrl: url.origin,
    supabaseSecretKey,
    intervalMs: integer(env, "WORKER_INTERVAL_MS", 30_000, 5_000, 60_000),
    maxRuntimeMs: integer(env, "WORKER_TICK_BUDGET_MS", 90_000, 10_000, 240_000),
    staleAfterMs: integer(env, "WORKER_STALE_AFTER_MS", 600_000, 300_000, 1_800_000),
    port: integer(env, "PORT", 8080, 1, 65535),
    batchSize: integer(env, "DISPATCH_BATCH_SIZE", 20, 1, 1_000),
    horizonBatchSize: integer(env, "HORIZON_DISPATCH_BATCH_SIZE", 100, 1, 1_000),
    lookaheadMinutes: integer(env, "DISPATCH_LOOKAHEAD_MINUTES", 15, 1, 180),
  };
}
