import "server-only";

import {
  createDuoPlusClient,
  decryptDuoPlusApiKey,
  ensureDuoPlusCapacityPool,
  SupabaseRateSlotAllocator,
} from "@/lib/duoplus";
import { SupabaseDuoPlusOutboundLogger } from "@/lib/scheduler/repository";

import type { AuthContext } from "./context";
import { ApiError } from "./errors";

export type DuoConnection = {
  id: string;
  organization_id: string;
  name: string;
  is_default: boolean;
  base_url: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_auth_tag: string | null;
  credential_generation: number;
  key_hint: string | null;
  status: string;
  min_gap_ms: number;
  issue_timezone: string;
  verified_at: string | null;
  inventory_synced_at: string | null;
  subscription_capacity: number | null;
  subscription_in_use: number | null;
  subscription_available: number | null;
  subscription_synced_at: string | null;
  capacity_pool_id: string | null;
  last_error: string | null;
};

export async function getDefaultDuoConnection(
  context: Exclude<AuthContext, { demo: true }>,
  options: { requireKey?: boolean } = {},
): Promise<DuoConnection | null> {
  const { data, error } = await context.admin
    .from("duo_connections")
    .select(
      "id, organization_id, name, is_default, base_url, api_key_ciphertext, api_key_iv, api_key_auth_tag, credential_generation, key_hint, status, min_gap_ms, issue_timezone, verified_at, inventory_synced_at, subscription_capacity, subscription_in_use, subscription_available, subscription_synced_at, capacity_pool_id, last_error",
    )
    .eq("organization_id", context.organizationId)
    .eq("is_default", true)
    .maybeSingle();

  if (error) {
    throw new ApiError(
      503,
      "INTEGRATION_LOOKUP_FAILED",
      "The DuoPlus connection could not be loaded.",
    );
  }

  const connection = data as DuoConnection | null;
  if (
    connection &&
    options.requireKey &&
    (!connection.api_key_ciphertext ||
      !connection.api_key_iv ||
      !connection.api_key_auth_tag ||
      connection.status !== "active")
  ) {
    throw new ApiError(
      409,
      "DUOPLUS_NOT_CONNECTED",
      "Connect a valid DuoPlus API key first.",
    );
  }

  return connection;
}

export async function createOrganizationDuoClient(
  context: Exclude<AuthContext, { demo: true }>,
) {
  const connection = await getDefaultDuoConnection(context, {
    requireKey: true,
  });
  if (!connection) {
    throw new ApiError(
      409,
      "DUOPLUS_NOT_CONNECTED",
      "Connect a valid DuoPlus API key first.",
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptDuoPlusApiKey({
      ciphertext: connection.api_key_ciphertext!,
      iv: connection.api_key_iv!,
      authTag: connection.api_key_auth_tag!,
    });
  } catch {
    throw new ApiError(
      500,
      "INTEGRATION_DECRYPT_FAILED",
      "The DuoPlus credential could not be decrypted. Reconnect the account.",
    );
  }

  const rateSlotAllocator = new SupabaseRateSlotAllocator(context.admin);
  const capacity = await ensureDuoPlusCapacityPool(context.admin, {
    connectionId: connection.id,
    organizationId: context.organizationId,
    apiKey,
  });
  connection.capacity_pool_id = capacity.poolId;
  const client = createDuoPlusClient({
    apiKey,
    connectionId: connection.id,
    baseUrl: connection.base_url,
    minGapMs: connection.min_gap_ms,
    rateSlotAllocator,
    logger: new SupabaseDuoPlusOutboundLogger(
      context.admin,
      context.organizationId,
    ),
  });

  return { client, connection };
}
