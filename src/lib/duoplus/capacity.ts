import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { duoPlusCapacityPoolFingerprint } from "./credentials";

export type DuoPlusWorkerCapacity = {
  poolId: string;
  workerCapacityLimit: number;
  activeWorkerCount: number;
  availableWorkerSlots: number;
};

export class DuoPlusCapacityRpcError extends Error {
  constructor(
    message: string,
    readonly databaseCode: string | null = null,
  ) {
    super(message);
    this.name = "DuoPlusCapacityRpcError";
  }
}

type CapacityRpcRow = {
  pool_id: string;
  worker_capacity_limit: number;
  active_worker_count: number;
  available_worker_slots: number;
};

function firstRow(value: unknown): CapacityRpcRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as CapacityRpcRow;
}

function present(row: CapacityRpcRow): DuoPlusWorkerCapacity {
  return {
    poolId: row.pool_id,
    workerCapacityLimit: row.worker_capacity_limit,
    activeWorkerCount: row.active_worker_count,
    availableWorkerSlots: row.available_worker_slots,
  };
}

export async function ensureDuoPlusCapacityPool(
  supabase: SupabaseClient,
  input: {
    connectionId: string;
    organizationId: string;
    apiKey: string;
    defaultLimit?: number;
  },
): Promise<DuoPlusWorkerCapacity> {
  const { data, error } = await supabase.rpc("link_duoplus_capacity_pool", {
    p_connection_id: input.connectionId,
    p_organization_id: input.organizationId,
    p_key_fingerprint: duoPlusCapacityPoolFingerprint(input.apiKey),
    p_default_limit: input.defaultLimit ?? 3,
  });
  const row = firstRow(data);
  if (error || !row) throw new Error("Link DuoPlus Startup worker pool failed");
  return present(row);
}

export async function saveVerifiedDuoPlusConnection(
  supabase: SupabaseClient,
  input: {
    connectionId: string;
    organizationId: string;
    expectedCredentialGeneration: number;
    apiKey: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    keyHint: string;
    minGapMs: number;
    verifiedAt: string;
    subscriptionCapacity: number;
    subscriptionInUse: number;
    subscriptionAvailable: number;
    subscriptionSyncedAt: string;
    defaultLimit?: number;
  },
): Promise<DuoPlusWorkerCapacity> {
  const { data, error } = await supabase.rpc(
    "save_verified_duoplus_connection",
    {
      p_connection_id: input.connectionId,
      p_organization_id: input.organizationId,
      p_expected_credential_generation: input.expectedCredentialGeneration,
      p_key_fingerprint: duoPlusCapacityPoolFingerprint(input.apiKey),
      p_api_key_ciphertext: input.ciphertext,
      p_api_key_iv: input.iv,
      p_api_key_auth_tag: input.authTag,
      p_key_hint: input.keyHint,
      p_min_gap_ms: input.minGapMs,
      p_verified_at: input.verifiedAt,
      p_subscription_capacity: input.subscriptionCapacity,
      p_subscription_in_use: input.subscriptionInUse,
      p_subscription_available: input.subscriptionAvailable,
      p_subscription_synced_at: input.subscriptionSyncedAt,
      p_default_limit: input.defaultLimit ?? 3,
    },
  );
  const row = firstRow(data);
  if (error || !row) {
    throw new DuoPlusCapacityRpcError(
      "Save verified DuoPlus connection and Startup worker pool failed",
      error?.code ?? null,
    );
  }
  return present(row);
}

export async function getDuoPlusCapacityPool(
  supabase: SupabaseClient,
  input: { connectionId: string; organizationId: string },
): Promise<DuoPlusWorkerCapacity | null> {
  const { data, error } = await supabase.rpc("get_duoplus_capacity_snapshot", {
    p_connection_id: input.connectionId,
    p_organization_id: input.organizationId,
  });
  if (error) throw new Error("Load DuoPlus Startup worker capacity failed");
  const row = firstRow(data);
  return row ? present(row) : null;
}

export async function setDuoPlusCapacityLimit(
  supabase: SupabaseClient,
  input: {
    connectionId: string;
    organizationId: string;
    workerCapacityLimit: number;
  },
): Promise<DuoPlusWorkerCapacity> {
  const { data, error } = await supabase.rpc("set_duoplus_worker_capacity", {
    p_connection_id: input.connectionId,
    p_organization_id: input.organizationId,
    p_worker_capacity_limit: input.workerCapacityLimit,
  });
  const row = firstRow(data);
  if (error) throw new Error(error.message || "Save DuoPlus Startup worker capacity failed");
  if (!row) throw new Error("Save DuoPlus Startup worker capacity failed");
  return present(row);
}
