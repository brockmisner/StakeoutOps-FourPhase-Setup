import type { DuoPlusPhone, DuoPlusTemplate } from "@/lib/duoplus";
import {
  getDuoPlusCapacityPool,
  isDuoPlusApiError,
  isDuoPlusPaginationError,
  normalizeDuoPlusIpAddress,
  normalizeDuoPlusProviderTimestamp,
  redactDuoPlusValue,
} from "@/lib/duoplus";
import { createOrganizationDuoClient } from "@/lib/auth/duoplus";
import { requireSchedulerManager } from "@/lib/auth/context";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import {
  bundledTemplateSchemaForName,
  isDuoPlusTemplateConfigSchema,
} from "@/lib/duoplus/template-schema";

export const maxDuration = 300;

type InventoryLogLevel = "info" | "warn" | "error";

interface InventoryLogFields {
  stage: string;
  outcome: "started" | "succeeded" | "failed";
  duration_ms: number;
  error_category?:
    | "authentication"
    | "pagination"
    | "upstream"
    | "storage"
    | "application"
    | "unexpected";
  error_code?: string | number;
  provider_http_status?: number;
  provider_code?: number;
  phone_count?: number;
  custom_template_count?: number;
  official_template_count?: number;
  template_count?: number;
  subscription_capacity?: number;
  subscription_in_use?: number;
  subscription_available?: number;
}

function emitInventoryLog(
  level: InventoryLogLevel,
  fields: InventoryLogFields,
): void {
  const entry = { event: "duoplus_inventory_sync", ...fields };
  try {
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else console.info(entry);
  } catch {
    // Route diagnostics are best effort and must not change sync behavior.
  }
}

function safeInventoryError(
  error: unknown,
  fallbackCode: string,
): Pick<
  InventoryLogFields,
  "error_category" | "error_code" | "provider_http_status" | "provider_code"
> {
  if (isDuoPlusPaginationError(error)) {
    return {
      error_category: "pagination",
      error_code: "INVENTORY_SYNC_INCOMPLETE",
      ...(error.httpStatus === null
        ? {}
        : { provider_http_status: error.httpStatus }),
      ...(error.duoCode === null ? {} : { provider_code: error.duoCode }),
    };
  }
  if (isDuoPlusApiError(error)) {
    return {
      error_category: error.unauthorized ? "authentication" : "upstream",
      error_code: error.unauthorized ? "INVALID_DUOPLUS_KEY" : fallbackCode,
      ...(error.httpStatus === null
        ? {}
        : { provider_http_status: error.httpStatus }),
      ...(error.duoCode === null ? {} : { provider_code: error.duoCode }),
    };
  }
  if (error instanceof ApiError) {
    return {
      error_category: "application",
      error_code: error.code,
    };
  }
  return {
    error_category: "unexpected",
    error_code: fallbackCode,
  };
}

function safePhoneMetadata(phone: DuoPlusPhone): Record<string, unknown> {
  return redactDuoPlusValue(phone) as Record<string, unknown>;
}

function phoneRows(
  organizationId: string,
  connectionId: string,
  phones: DuoPlusPhone[],
  seenAt: string,
) {
  return phones.map((phone) => ({
    organization_id: organizationId,
    connection_id: connectionId,
    duoplus_image_id: phone.id,
    name: phone.name?.trim() || phone.id,
    status: phone.status,
    adb_endpoint: phone.adb ?? null,
    // DuoPlus uses an empty string when no phone IP is available. PostgreSQL
    // `inet` rejects that value, so persist only a syntactically valid address.
    ip_address: normalizeDuoPlusIpAddress(phone.ip),
    os_version: phone.os ?? null,
    // The provider currently returns Unix seconds as a string even though the
    // database column is timestamptz. Accept documented date strings too.
    expired_at: normalizeDuoPlusProviderTimestamp(phone.expired_at),
    last_seen_at: seenAt,
    metadata: safePhoneMetadata(phone),
    updated_at: seenAt,
  }));
}

function templateRows(
  organizationId: string,
  connectionId: string,
  templates: DuoPlusTemplate[],
  templateType: 1 | 2,
  seenAt: string,
  existingSchemas: Map<string, unknown> = new Map(),
) {
  return templates.map((template) => {
    const name = (template.name?.trim() || template.id).slice(0, 160);
    const description =
      typeof template.description === "string"
        ? template.description.trim() || null
        : typeof template.desc === "string"
          ? template.desc.trim() || null
          : null;
    return {
      organization_id: organizationId,
      connection_id: connectionId,
      duoplus_template_id: template.id,
      template_type: templateType,
      name,
      description,
      // The list endpoints are inventory discovery, not a credential vault.
      // Keep only the documented fields and source discriminator instead of
      // persisting arbitrary upstream objects that could contain input values.
      config_schema: bundledTemplateSchemaForName(name) ??
        (isDuoPlusTemplateConfigSchema(existingSchemas.get(`${templateType}:${template.id}`))
          ? existingSchemas.get(`${templateType}:${template.id}`)
          : null) ?? {
        id: template.id,
        name,
        ...(description ? { desc: description } : {}),
        source: templateType === 1 ? "official" : "custom",
        template_type: templateType,
      },
      enabled: true,
      last_synced_at: seenAt,
      updated_at: seenAt,
    };
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const routeStartedAt = Date.now();
    emitInventoryLog("info", {
      stage: "request",
      outcome: "started",
      duration_ms: 0,
    });
    const connectionStartedAt = Date.now();
    let duoContext: Awaited<ReturnType<typeof createOrganizationDuoClient>>;
    try {
      duoContext = await createOrganizationDuoClient(context);
    } catch (error) {
      emitInventoryLog("error", {
        stage: "load_connection",
        outcome: "failed",
        duration_ms: Date.now() - connectionStartedAt,
        ...safeInventoryError(error, "DUOPLUS_CONNECTION_UNAVAILABLE"),
      });
      throw error;
    }
    const { client, connection } = duoContext;
    emitInventoryLog("info", {
      stage: "load_connection",
      outcome: "succeeded",
      duration_ms: Date.now() - connectionStartedAt,
    });
    let phones: DuoPlusPhone[];
    let userTemplates: DuoPlusTemplate[];
    let officialTemplates: DuoPlusTemplate[];
    let subscriptionCapacity: Awaited<
      ReturnType<typeof client.getSubscriptionStartupCapacity>
    >;
    let upstreamStage = "fetch_phones";
    let upstreamStartedAt = Date.now();
    // Complete-snapshot ordering is based on when the provider read began,
    // not when a slower request happened to finish. The database rejects an
    // older read if a newer snapshot has already won the connection lock.
    const syncedAt = new Date(upstreamStartedAt).toISOString();
    try {
      // DuoPlus applies a one-QPS contract per account. Keep strict serial
      // order in addition to reserving shared database rate slots.
      phones = await client.listAllPhones();
      emitInventoryLog("info", {
        stage: upstreamStage,
        outcome: "succeeded",
        duration_ms: Date.now() - upstreamStartedAt,
        phone_count: phones.length,
      });
      upstreamStage = "fetch_custom_templates";
      upstreamStartedAt = Date.now();
      userTemplates = await client.listUserTemplates();
      emitInventoryLog("info", {
        stage: upstreamStage,
        outcome: "succeeded",
        duration_ms: Date.now() - upstreamStartedAt,
        custom_template_count: userTemplates.length,
      });
      upstreamStage = "fetch_official_templates";
      upstreamStartedAt = Date.now();
      officialTemplates = await client.listOfficialTemplates();
      emitInventoryLog("info", {
        stage: upstreamStage,
        outcome: "succeeded",
        duration_ms: Date.now() - upstreamStartedAt,
        official_template_count: officialTemplates.length,
      });
      upstreamStage = "fetch_subscription_capacity";
      upstreamStartedAt = Date.now();
      subscriptionCapacity = await client.getSubscriptionStartupCapacity();
      emitInventoryLog("info", {
        stage: upstreamStage,
        outcome: "succeeded",
        duration_ms: Date.now() - upstreamStartedAt,
        subscription_capacity: subscriptionCapacity.total,
        subscription_in_use: subscriptionCapacity.inUse,
        subscription_available: subscriptionCapacity.available,
      });
    } catch (error) {
      emitInventoryLog("error", {
        stage: upstreamStage,
        outcome: "failed",
        duration_ms: Date.now() - upstreamStartedAt,
        ...safeInventoryError(error, "INVENTORY_SYNC_FAILED"),
      });
      if (isDuoPlusPaginationError(error)) {
        throw new ApiError(
          502,
          "INVENTORY_SYNC_INCOMPLETE",
          `${error.message}. Previously synced inventory was preserved.`,
        );
      }
      if (isDuoPlusApiError(error) && error.unauthorized) {
        await context.admin
          .from("duo_connections")
          .update({
            status: "invalid",
            last_error: "DuoPlus rejected the stored credential.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id)
          .eq("organization_id", context.organizationId)
          .eq("credential_generation", connection.credential_generation);
        throw new ApiError(
          409,
          "INVALID_DUOPLUS_KEY",
          "DuoPlus rejected the saved API key. Reconnect the account.",
        );
      }
      throw new ApiError(
        502,
        "INVENTORY_SYNC_FAILED",
        "DuoPlus inventory could not be synced.",
      );
    }
    const { data: existingTemplateRows, error: existingTemplateError } = await context.admin
      .from("duo_templates")
      .select("duoplus_template_id, template_type, config_schema")
      .eq("organization_id", context.organizationId)
      .eq("connection_id", connection.id);
    if (existingTemplateError) {
      throw new ApiError(
        503,
        "TEMPLATE_LIST_FAILED",
        "Existing template input definitions could not be loaded.",
      );
    }
    const existingSchemas = new Map<string, unknown>(
      (existingTemplateRows ?? []).map((row) => [
        `${row.template_type}:${row.duoplus_template_id}`,
        row.config_schema,
      ]),
    );
    const phonesToSave = phoneRows(
      context.organizationId,
      connection.id,
      phones,
      syncedAt,
    );
    const customTemplatesToSave = templateRows(
      context.organizationId,
      connection.id,
      userTemplates,
      2,
      syncedAt,
      existingSchemas,
    );
    const officialTemplatesToSave = templateRows(
      context.organizationId,
      connection.id,
      officialTemplates,
      1,
      syncedAt,
      existingSchemas,
    );
    const templatesToSave = [
      ...customTemplatesToSave,
      ...officialTemplatesToSave,
    ];

    const inventorySaveStartedAt = Date.now();
    const [phoneResult, templateResult] = await Promise.all([
      context.admin.rpc("replace_duoplus_phone_inventory", {
        p_organization_id: context.organizationId,
        p_connection_id: connection.id,
        p_synced_at: syncedAt,
        p_phones: phonesToSave,
      }),
      context.admin.rpc("replace_duoplus_template_inventory", {
        p_organization_id: context.organizationId,
        p_connection_id: connection.id,
        p_template_types: [1, 2],
        p_synced_at: syncedAt,
        p_templates: templatesToSave,
      }),
    ]).catch((error: unknown) => {
      emitInventoryLog("error", {
        stage: "save_inventory",
        outcome: "failed",
        duration_ms: Date.now() - inventorySaveStartedAt,
        error_category: "storage",
        error_code: "INVENTORY_SAVE_FAILED",
      });
      throw error;
    });

    if (phoneResult.error || templateResult.error) {
      emitInventoryLog("error", {
        stage: "save_inventory",
        outcome: "failed",
        duration_ms: Date.now() - inventorySaveStartedAt,
        error_category: "storage",
        error_code: "INVENTORY_SAVE_FAILED",
      });
      throw new ApiError(
        503,
        "INVENTORY_SAVE_FAILED",
        "DuoPlus responded, but its inventory could not be saved.",
      );
    }
    emitInventoryLog("info", {
      stage: "save_inventory",
      outcome: "succeeded",
      duration_ms: Date.now() - inventorySaveStartedAt,
      phone_count: phones.length,
      custom_template_count: customTemplatesToSave.length,
      official_template_count: officialTemplatesToSave.length,
      template_count: templatesToSave.length,
    });

    const connectionSaveStartedAt = Date.now();
    const { error: connectionError } = await (async () => {
      try {
        return await context.admin
          .from("duo_connections")
          .update({
            subscription_capacity: subscriptionCapacity.total,
            subscription_in_use: subscriptionCapacity.inUse,
            subscription_available: subscriptionCapacity.available,
            subscription_synced_at: syncedAt,
            status: "active",
            last_error: null,
            updated_at: syncedAt,
          })
          .eq("id", connection.id)
          .eq("organization_id", context.organizationId)
          .eq("credential_generation", connection.credential_generation)
          // The phone snapshot RPC advances this timestamp under a
          // per-connection lock. Do not let a slower, older HTTP request
          // regress capacity or connection metadata after a newer sync wins.
          .lte("inventory_synced_at", syncedAt)
          // A cron capacity refresh can also finish while this full inventory
          // request is in flight. Never replace that newer capacity snapshot.
          .or(
            `subscription_synced_at.is.null,subscription_synced_at.lte.${syncedAt}`,
          );
      } catch (error) {
        emitInventoryLog("error", {
          stage: "save_sync_metadata",
          outcome: "failed",
          duration_ms: Date.now() - connectionSaveStartedAt,
          error_category: "storage",
          error_code: "SYNC_TIMESTAMP_FAILED",
        });
        throw error;
      }
    })();

    if (connectionError) {
      emitInventoryLog("error", {
        stage: "save_sync_metadata",
        outcome: "failed",
        duration_ms: Date.now() - connectionSaveStartedAt,
        error_category: "storage",
        error_code: "SYNC_TIMESTAMP_FAILED",
      });
      throw new ApiError(
        503,
        "SYNC_TIMESTAMP_FAILED",
        "Inventory synced, but its timestamp could not be saved.",
      );
    }
    emitInventoryLog("info", {
      stage: "save_sync_metadata",
      outcome: "succeeded",
      duration_ms: Date.now() - connectionSaveStartedAt,
    });

    const workerCapacity = await getDuoPlusCapacityPool(context.admin, {
      connectionId: connection.id,
      organizationId: context.organizationId,
    });
    if (!workerCapacity) {
      throw new ApiError(
        503,
        "WORKER_CAPACITY_UNAVAILABLE",
        "Inventory synced, but the Startup worker pool could not be loaded.",
      );
    }

    emitInventoryLog("info", {
      stage: "complete",
      outcome: "succeeded",
      duration_ms: Date.now() - routeStartedAt,
      phone_count: phones.length,
      custom_template_count: customTemplatesToSave.length,
      official_template_count: officialTemplatesToSave.length,
      template_count: templatesToSave.length,
      subscription_capacity: subscriptionCapacity.total,
      subscription_in_use: subscriptionCapacity.inUse,
      subscription_available: subscriptionCapacity.available,
    });

    return dataResponse({
      phoneCount: phones.length,
      templateCount: templatesToSave.length,
      customTemplateCount: customTemplatesToSave.length,
      officialTemplateCount: officialTemplatesToSave.length,
      subscriptionCapacity: workerCapacity.workerCapacityLimit,
      subscriptionInUse: workerCapacity.activeWorkerCount,
      subscriptionAvailable: workerCapacity.availableWorkerSlots,
      workerCapacityLimit: workerCapacity.workerCapacityLimit,
      activeWorkerCount: workerCapacity.activeWorkerCount,
      availableWorkerSlots: workerCapacity.availableWorkerSlots,
      providerSubscriptionCapacity: subscriptionCapacity.total,
      providerSubscriptionInUse: subscriptionCapacity.inUse,
      providerSubscriptionAvailable: subscriptionCapacity.available,
      syncedAt,
    });
  });
}
