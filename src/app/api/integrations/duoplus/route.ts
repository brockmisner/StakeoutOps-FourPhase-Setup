import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createDuoPlusClient,
  decryptDuoPlusApiKey,
  DuoPlusCapacityRpcError,
  encryptDuoPlusApiKey,
  ensureDuoPlusCapacityPool,
  getDuoPlusCapacityPool,
  isDuoPlusApiError,
  saveVerifiedDuoPlusConnection,
  setDuoPlusCapacityLimit,
  SupabaseRateSlotAllocator,
} from "@/lib/duoplus";
import { requireWorkspaceAdmin } from "@/lib/auth/context";
import { getDefaultDuoConnection } from "@/lib/auth/duoplus";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import { SupabaseDuoPlusOutboundLogger } from "@/lib/scheduler/repository";

const connectSchema = z.object({
  apiKey: z.string().trim().min(8).max(1_024),
});

const capacitySchema = z.object({
  workerCapacityLimit: z.number().int().min(1).max(100),
}).strict();

type ConnectLogLevel = "info" | "warn" | "error";

interface ConnectLogFields {
  stage: string;
  outcome: "started" | "succeeded" | "failed";
  duration_ms: number;
  error_category?:
    | "validation"
    | "configuration"
    | "authentication"
    | "upstream"
    | "storage"
    | "unexpected";
  error_code?: string | number;
  provider_http_status?: number;
  provider_code?: number;
  phone_probe_count?: number;
  subscription_capacity?: number;
  subscription_in_use?: number;
  subscription_available?: number;
  existing_connection_count?: number;
}

function emitConnectLog(level: ConnectLogLevel, fields: ConnectLogFields): void {
  const entry = { event: "duoplus_connect", ...fields };
  try {
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.info(entry);
  } catch {
    // Route diagnostics are best effort and must not change connection behavior.
  }
}

function safeConnectProviderError(error: unknown): Pick<
  ConnectLogFields,
  "error_category" | "error_code" | "provider_http_status" | "provider_code"
> {
  if (!isDuoPlusApiError(error)) {
    return {
      error_category: "unexpected",
      error_code: "DUOPLUS_UNAVAILABLE",
    };
  }
  return {
    error_category: error.unauthorized ? "authentication" : "upstream",
    error_code: error.unauthorized ? "INVALID_DUOPLUS_KEY" : "DUOPLUS_API_ERROR",
    ...(error.httpStatus === null
      ? {}
      : { provider_http_status: error.httpStatus }),
    ...(error.duoCode === null ? {} : { provider_code: error.duoCode }),
  };
}

function keyHint(apiKey: string): string {
  return `•••• ${apiKey.slice(-4)}`;
}

function minimumGap(): number {
  const configured = Number(process.env.DUOPLUS_MIN_GAP_MS ?? 1_200);
  return Number.isFinite(configured) && configured >= 1_200 && configured <= 60_000
    ? configured
    : 1_200;
}

function issueTimezone(): string {
  const configured = (process.env.DUOPLUS_ISSUE_TIMEZONE ?? "UTC").trim();
  if (!configured || configured.length > 80) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
    return configured;
  } catch {
    return "UTC";
  }
}

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      return dataResponse({
        connected: false,
        keyHint: null,
        verifiedAt: null,
        subscriptionCapacity: 24,
        subscriptionInUse: 18,
        subscriptionAvailable: 6,
        subscriptionSyncedAt: new Date().toISOString(),
      });
    }

    const connection = await getDefaultDuoConnection(context);
    let workerCapacity = connection
      ? await getDuoPlusCapacityPool(context.admin, {
          connectionId: connection.id,
          organizationId: context.organizationId,
        })
      : null;
    if (
      connection?.status === "active" &&
      !workerCapacity &&
      connection.api_key_ciphertext &&
      connection.api_key_iv &&
      connection.api_key_auth_tag
    ) {
      const apiKey = decryptDuoPlusApiKey({
        ciphertext: connection.api_key_ciphertext,
        iv: connection.api_key_iv,
        authTag: connection.api_key_auth_tag,
      });
      workerCapacity = await ensureDuoPlusCapacityPool(context.admin, {
        connectionId: connection.id,
        organizationId: context.organizationId,
        apiKey,
      });
    }
    return dataResponse({
      connected: connection?.status === "active",
      keyHint: connection?.key_hint ?? null,
      verifiedAt: connection?.verified_at ?? null,
      inventorySyncedAt: connection?.inventory_synced_at ?? null,
      issueTimezone: connection?.issue_timezone ?? null,
      subscriptionCapacity: workerCapacity?.workerCapacityLimit ?? null,
      subscriptionInUse: workerCapacity?.activeWorkerCount ?? null,
      subscriptionAvailable: workerCapacity?.availableWorkerSlots ?? null,
      workerCapacityLimit: workerCapacity?.workerCapacityLimit ?? null,
      activeWorkerCount: workerCapacity?.activeWorkerCount ?? null,
      availableWorkerSlots: workerCapacity?.availableWorkerSlots ?? null,
      providerSubscriptionCapacity: connection?.subscription_capacity ?? null,
      providerSubscriptionInUse: connection?.subscription_in_use ?? null,
      providerSubscriptionAvailable: connection?.subscription_available ?? null,
      subscriptionSyncedAt: connection?.subscription_synced_at ?? null,
    });
  });
}

export async function PATCH(request: Request) {
  return withOrganization(request, async (context) => {
    requireWorkspaceAdmin(context);
    let input: z.infer<typeof capacitySchema>;
    try {
      input = capacitySchema.parse(await request.json());
    } catch {
      throw new ApiError(
        400,
        "INVALID_WORKER_CAPACITY",
        "Concurrent worker slots must be a whole number between 1 and 100.",
      );
    }

    const connection = await getDefaultDuoConnection(context, { requireKey: true });
    if (!connection) {
      throw new ApiError(409, "DUOPLUS_NOT_CONNECTED", "Connect DuoPlus first.");
    }
    if (!connection.capacity_pool_id) {
      const apiKey = decryptDuoPlusApiKey({
        ciphertext: connection.api_key_ciphertext!,
        iv: connection.api_key_iv!,
        authTag: connection.api_key_auth_tag!,
      });
      await ensureDuoPlusCapacityPool(context.admin, {
        connectionId: connection.id,
        organizationId: context.organizationId,
        apiKey,
      });
    }

    try {
      const capacity = await setDuoPlusCapacityLimit(context.admin, {
        connectionId: connection.id,
        organizationId: context.organizationId,
        workerCapacityLimit: input.workerCapacityLimit,
      });
      return dataResponse({
        connected: true,
        subscriptionCapacity: capacity.workerCapacityLimit,
        subscriptionInUse: capacity.activeWorkerCount,
        subscriptionAvailable: capacity.availableWorkerSlots,
        workerCapacityLimit: capacity.workerCapacityLimit,
        activeWorkerCount: capacity.activeWorkerCount,
        availableWorkerSlots: capacity.availableWorkerSlots,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("provider")) {
        throw new ApiError(
          409,
          "WORKER_CAPACITY_EXCEEDS_SUBSCRIPTION",
          "Sync DuoPlus after purchasing more Startup slots, then raise this limit.",
        );
      }
      throw new ApiError(
        503,
        "WORKER_CAPACITY_SAVE_FAILED",
        "Concurrent worker slots could not be saved.",
      );
    }
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireWorkspaceAdmin(context);
    const routeStartedAt = Date.now();
    emitConnectLog("info", {
      stage: "request",
      outcome: "started",
      duration_ms: 0,
    });

    let input: z.infer<typeof connectSchema>;
    try {
      input = connectSchema.parse(await request.json());
    } catch {
      emitConnectLog("warn", {
        stage: "validate_request",
        outcome: "failed",
        duration_ms: Date.now() - routeStartedAt,
        error_category: "validation",
        error_code: "INVALID_REQUEST",
      });
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "Enter a valid DuoPlus API key.",
      );
    }

    let encrypted: ReturnType<typeof encryptDuoPlusApiKey>;
    try {
      encrypted = encryptDuoPlusApiKey(input.apiKey);
    } catch {
      emitConnectLog("error", {
        stage: "encrypt_credential",
        outcome: "failed",
        duration_ms: Date.now() - routeStartedAt,
        error_category: "configuration",
        error_code: "ENCRYPTION_NOT_CONFIGURED",
      });
      throw new ApiError(
        503,
        "ENCRYPTION_NOT_CONFIGURED",
        "Credential encryption is not configured for this deployment.",
      );
    }

    const connectionLookupStartedAt = Date.now();
    let existing: Awaited<ReturnType<typeof getDefaultDuoConnection>>;
    try {
      existing = await getDefaultDuoConnection(context);
      emitConnectLog("info", {
        stage: "load_connection",
        outcome: "succeeded",
        duration_ms: Date.now() - connectionLookupStartedAt,
        existing_connection_count: existing ? 1 : 0,
      });
    } catch (error) {
      emitConnectLog("error", {
        stage: "load_connection",
        outcome: "failed",
        duration_ms: Date.now() - connectionLookupStartedAt,
        error_category: "storage",
        error_code:
          error instanceof ApiError
            ? error.code
            : "INTEGRATION_LOOKUP_FAILED",
      });
      throw error;
    }
    const connectionId = existing?.id ?? randomUUID();
    const expectedCredentialGeneration = existing?.credential_generation ?? 0;
    const baseUrl =
      existing?.base_url ??
      process.env.DUOPLUS_BASE_URL ??
      "https://openapi.duoplus.net";
    const minGapMs = existing?.min_gap_ms ?? minimumGap();
    const createdPending = !existing;
    let startupCapacity: { total: number; inUse: number; available: number } | null = null;
    let subscriptionSnapshotStartedAt = "";

    if (createdPending) {
      const prepareStartedAt = Date.now();
      const { error: pendingError } = await (async () => {
        try {
          return await context.admin.from("duo_connections").insert({
            id: connectionId,
            organization_id: context.organizationId,
            name: "DuoPlus",
            is_default: true,
            base_url: baseUrl,
            status: "pending",
            min_gap_ms: minGapMs,
            issue_timezone: issueTimezone(),
            created_by: context.user.id,
          });
        } catch (error) {
          emitConnectLog("error", {
            stage: "prepare_connection",
            outcome: "failed",
            duration_ms: Date.now() - prepareStartedAt,
            error_category: "storage",
            error_code: "INTEGRATION_SAVE_FAILED",
          });
          throw error;
        }
      })();
      if (pendingError) {
        emitConnectLog("error", {
          stage: "prepare_connection",
          outcome: "failed",
          duration_ms: Date.now() - prepareStartedAt,
          error_category: "storage",
          error_code: "INTEGRATION_SAVE_FAILED",
        });
        throw new ApiError(
          503,
          "INTEGRATION_SAVE_FAILED",
          "The DuoPlus connection could not be prepared.",
        );
      }
      emitConnectLog("info", {
        stage: "prepare_connection",
        outcome: "succeeded",
        duration_ms: Date.now() - prepareStartedAt,
      });
    }

    let verificationStage = "verify_phone_access";
    let verificationStartedAt = Date.now();
    try {
      const probe = createDuoPlusClient({
        apiKey: input.apiKey,
        connectionId,
        baseUrl,
        minGapMs,
        rateSlotAllocator: new SupabaseRateSlotAllocator(context.admin),
        logger: new SupabaseDuoPlusOutboundLogger(
          context.admin,
          context.organizationId,
        ),
      });
      const phoneProbe = await probe.listPhones({ page: 1, pagesize: 1 });
      emitConnectLog("info", {
        stage: verificationStage,
        outcome: "succeeded",
        duration_ms: Date.now() - verificationStartedAt,
        phone_probe_count: phoneProbe.length,
      });
      verificationStage = "fetch_subscription_capacity";
      verificationStartedAt = Date.now();
      subscriptionSnapshotStartedAt = new Date().toISOString();
      startupCapacity = await probe.getSubscriptionStartupCapacity();
      emitConnectLog("info", {
        stage: verificationStage,
        outcome: "succeeded",
        duration_ms: Date.now() - verificationStartedAt,
        subscription_capacity: startupCapacity.total,
        subscription_in_use: startupCapacity.inUse,
        subscription_available: startupCapacity.available,
      });
    } catch (error) {
      emitConnectLog("error", {
        stage: verificationStage,
        outcome: "failed",
        duration_ms: Date.now() - verificationStartedAt,
        ...safeConnectProviderError(error),
      });
      if (createdPending) {
        await context.admin
          .from("duo_connections")
          .update({
            status:
              isDuoPlusApiError(error) && error.unauthorized
                ? "invalid"
                : "error",
            last_error:
              isDuoPlusApiError(error) && error.unauthorized
                ? "DuoPlus rejected the credential."
                : "DuoPlus verification was unavailable.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connectionId)
          .eq("organization_id", context.organizationId)
          .eq("credential_generation", expectedCredentialGeneration);
      }
      if (isDuoPlusApiError(error) && error.unauthorized) {
        throw new ApiError(
          400,
          "INVALID_DUOPLUS_KEY",
          "DuoPlus rejected that API key.",
        );
      }
      throw new ApiError(
        502,
        "DUOPLUS_UNAVAILABLE",
        "DuoPlus could not verify the key. Try again shortly.",
      );
    }

    const now = new Date().toISOString();
    const payload = {
      api_key_ciphertext: encrypted.ciphertext,
      api_key_iv: encrypted.iv,
      api_key_auth_tag: encrypted.authTag,
      key_hint: keyHint(input.apiKey),
      status: "active",
      min_gap_ms: minGapMs,
      verified_at: now,
      subscription_capacity: startupCapacity?.total ?? null,
      subscription_in_use: startupCapacity?.inUse ?? null,
      subscription_available: startupCapacity?.available ?? null,
      subscription_synced_at: subscriptionSnapshotStartedAt,
      last_error: null,
      updated_at: now,
    };

    const saveStartedAt = Date.now();
    let workerCapacity: Awaited<
      ReturnType<typeof saveVerifiedDuoPlusConnection>
    >;
    try {
      workerCapacity = await saveVerifiedDuoPlusConnection(context.admin, {
        connectionId,
        organizationId: context.organizationId,
        expectedCredentialGeneration,
        apiKey: input.apiKey,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyHint: payload.key_hint,
        minGapMs,
        verifiedAt: now,
        subscriptionCapacity: startupCapacity.total,
        subscriptionInUse: startupCapacity.inUse,
        subscriptionAvailable: startupCapacity.available,
        subscriptionSyncedAt: subscriptionSnapshotStartedAt,
        // Start conservatively at the product default even when the provider
        // account owns more slots. An admin can raise this after inventory sync.
        defaultLimit: Math.min(3, Math.max(1, startupCapacity.total)),
      });
    } catch (error) {
      emitConnectLog("error", {
        stage: "save_verified_connection",
        outcome: "failed",
        duration_ms: Date.now() - saveStartedAt,
        error_category: "storage",
        error_code:
          error instanceof DuoPlusCapacityRpcError &&
          error.databaseCode === "P4112"
            ? "DUOPLUS_POOL_LINK_FAILED"
            : error instanceof DuoPlusCapacityRpcError &&
                error.databaseCode === "P4113"
              ? "DUOPLUS_CONNECTION_CHANGED"
              : "INTEGRATION_SAVE_FAILED",
      });
      if (
        error instanceof DuoPlusCapacityRpcError &&
        error.databaseCode === "P4112"
      ) {
        throw new ApiError(
          409,
          "DUOPLUS_POOL_LINK_FAILED",
          "That DuoPlus key is already linked to another provider pool. No verified connection changes were saved.",
        );
      }
      if (
        error instanceof DuoPlusCapacityRpcError &&
        error.databaseCode === "P4113"
      ) {
        throw new ApiError(
          409,
          "DUOPLUS_CONNECTION_CHANGED",
          "The DuoPlus connection changed while this key was being verified. Try again.",
        );
      }
      throw new ApiError(
        503,
        "INTEGRATION_SAVE_FAILED",
        "The verified DuoPlus connection could not be saved safely.",
      );
    }
    emitConnectLog("info", {
      stage: "save_verified_connection",
      outcome: "succeeded",
      duration_ms: Date.now() - saveStartedAt,
    });

    emitConnectLog("info", {
      stage: "complete",
      outcome: "succeeded",
      duration_ms: Date.now() - routeStartedAt,
      subscription_capacity: payload.subscription_capacity ?? undefined,
      subscription_in_use: payload.subscription_in_use ?? undefined,
      subscription_available: payload.subscription_available ?? undefined,
    });

    return dataResponse(
      {
        connected: true,
        keyHint: payload.key_hint,
        verifiedAt: now,
        subscriptionCapacity: workerCapacity.workerCapacityLimit,
        subscriptionInUse: workerCapacity.activeWorkerCount,
        subscriptionAvailable: workerCapacity.availableWorkerSlots,
        workerCapacityLimit: workerCapacity.workerCapacityLimit,
        activeWorkerCount: workerCapacity.activeWorkerCount,
        availableWorkerSlots: workerCapacity.availableWorkerSlots,
        providerSubscriptionCapacity: payload.subscription_capacity,
        providerSubscriptionInUse: payload.subscription_in_use,
        providerSubscriptionAvailable: payload.subscription_available,
        subscriptionSyncedAt: subscriptionSnapshotStartedAt,
      },
      { status: existing ? 200 : 201 },
    );
  });
}

export async function DELETE(request: Request) {
  return withOrganization(request, async (context) => {
    requireWorkspaceAdmin(context);
    const connection = await getDefaultDuoConnection(context);
    if (!connection) {
      return dataResponse({ connected: false, keyHint: null, verifiedAt: null });
    }

    const { data, error } = await context.admin.rpc(
      "disconnect_duoplus_connection",
      {
        p_connection_id: connection.id,
        p_organization_id: context.organizationId,
      },
    );
    if (error) {
      throw new ApiError(
        503,
        "INTEGRATION_DISCONNECT_FAILED",
        "The DuoPlus connection could not be disconnected.",
      );
    }

    const result = (Array.isArray(data) ? data[0] : data) as
      | {
          disconnected?: boolean;
          enabled_schedules?: number;
          open_runs?: number;
        }
      | null;
    if (!result?.disconnected) {
      throw new ApiError(
        409,
        "DUOPLUS_STILL_IN_USE",
        "Pause every schedule and finish or cancel every open run before disconnecting DuoPlus.",
        {
          openRunCount: result?.open_runs ?? 0,
          activeScheduleCount: result?.enabled_schedules ?? 0,
        },
      );
    }

    return dataResponse({ connected: false, keyHint: null, verifiedAt: null });
  });
}
