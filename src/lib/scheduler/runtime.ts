import type { SupabaseClient } from "@supabase/supabase-js";

import { createDuoPlusClient } from "@/lib/duoplus/client";
import { ensureDuoPlusCapacityPool } from "@/lib/duoplus/capacity";
import { decryptDuoPlusApiKey } from "@/lib/duoplus/credentials";
import { isDuoPlusApiError } from "@/lib/duoplus/errors";
import { SupabaseRateSlotAllocator } from "@/lib/duoplus/rate-limit";

import {
  SupabaseDuoPlusOutboundLogger,
  SupabaseSchedulerRepository,
} from "./repository";
import type { DuoPlusClientFactory } from "./worker";
import type { DuoConnectionRow } from "./types";

const CONNECTION_RUNTIME_FIELDS =
  "id, organization_id, name, base_url, issue_timezone, api_key_ciphertext, api_key_iv, api_key_auth_tag, credential_generation, status, min_gap_ms, last_error, subscription_capacity, subscription_in_use, subscription_available, subscription_synced_at, capacity_pool_id";

export function createSupabaseSchedulerRuntime(supabase: SupabaseClient): {
  repository: SupabaseSchedulerRepository;
  clientFactory: DuoPlusClientFactory;
} {
  const repository = new SupabaseSchedulerRepository(supabase);
  const rateSlotAllocator = new SupabaseRateSlotAllocator(supabase);
  const clientFactory: DuoPlusClientFactory = (connection) =>
    createDuoPlusClient({
      apiKey: decryptDuoPlusApiKey({
        ciphertext: connection.api_key_ciphertext,
        iv: connection.api_key_iv,
        authTag: connection.api_key_auth_tag,
      }),
      connectionId: connection.id,
      baseUrl:
        connection.base_url ??
        process.env.DUOPLUS_BASE_URL ??
        "https://openapi.duoplus.net",
      minGapMs:
        connection.min_gap_ms ??
        Number(process.env.DUOPLUS_MIN_GAP_MS ?? "1200"),
      rateSlotAllocator,
      logger: new SupabaseDuoPlusOutboundLogger(
        supabase,
        connection.organization_id,
      ),
    });
  return { repository, clientFactory };
}

/**
 * Keeps the exact DuoPlus Subscription Startup ceiling fresh without relying
 * on someone opening the setup dialog every day. The database still enforces
 * the ceiling atomically and fails closed when this snapshot becomes stale.
 */
export async function refreshStaleSubscriptionCapacities(
  supabase: SupabaseClient,
  options: { now?: Date; maxAgeMs?: number; limit?: number } = {},
): Promise<{ checked: number; refreshed: number; failed: number }> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(
    now.getTime() - (options.maxAgeMs ?? 30 * 60_000),
  ).toISOString();
  const { data, error } = await supabase
    .from("duo_connections")
    .select(CONNECTION_RUNTIME_FIELDS)
    .eq("status", "active")
    .or(`capacity_pool_id.is.null,subscription_synced_at.is.null,subscription_synced_at.lt.${staleBefore}`)
    .limit(options.limit ?? 50);
  if (error) throw new Error("Load stale DuoPlus subscription snapshots failed");

  const connections = (data ?? []) as DuoConnectionRow[];
  const runtime = createSupabaseSchedulerRuntime(supabase);
  let refreshed = 0;
  let failed = 0;
  await Promise.all(
    connections.map(async (connection) => {
      const refreshStartedAt = new Date();
      const syncedAt = refreshStartedAt.toISOString();
      try {
        const apiKey = decryptDuoPlusApiKey({
          ciphertext: connection.api_key_ciphertext,
          iv: connection.api_key_iv,
          authTag: connection.api_key_auth_tag,
        });
        await ensureDuoPlusCapacityPool(supabase, {
          connectionId: connection.id,
          organizationId: connection.organization_id,
          apiKey,
          defaultLimit: 3,
        });
        const capacity = await runtime.clientFactory(
          connection,
        ).getSubscriptionStartupCapacity(refreshStartedAt);
        const { error: updateError } = await supabase
          .from("duo_connections")
          .update({
            subscription_capacity: capacity.total,
            subscription_in_use: capacity.inUse,
            subscription_available: capacity.available,
            subscription_synced_at: syncedAt,
            last_error: null,
            updated_at: syncedAt,
          })
          .eq("id", connection.id)
          .eq("organization_id", connection.organization_id)
          .eq("credential_generation", connection.credential_generation)
          // Two cron invocations may read DuoPlus concurrently. Only the read
          // that started latest may replace the all-or-none capacity snapshot.
          .or(
            `subscription_synced_at.is.null,subscription_synced_at.lte.${syncedAt}`,
          );
        if (updateError) throw new Error("Save DuoPlus subscription snapshot failed");
        refreshed += 1;
      } catch (syncError) {
        failed += 1;
        const unauthorized =
          isDuoPlusApiError(syncError) && syncError.unauthorized;
        await supabase
          .from("duo_connections")
          .update({
            ...(unauthorized ? { status: "invalid" } : {}),
            last_error: unauthorized
              ? "DuoPlus rejected the stored credential."
              : "Subscription Startup capacity refresh failed; new power-ons will fail closed if the snapshot expires.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id)
          .eq("organization_id", connection.organization_id)
          .eq("credential_generation", connection.credential_generation);
      }
    }),
  );
  return { checked: connections.length, refreshed, failed };
}
