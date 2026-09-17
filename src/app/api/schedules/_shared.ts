import { z } from "zod";

import type { AuthContext } from "@/lib/auth/context";
import { getDefaultDuoConnection } from "@/lib/auth/duoplus";
import { ApiError } from "@/lib/auth/errors";
import { duoPlusTaskConfigSchema } from "@/lib/duoplus/task-config";
import { isPhoneEligibleForNewWork } from "@/lib/scheduler/phone-safety";
import { nextScheduleOccurrence } from "@/lib/scheduler/recurrence";

const optionalCoordinates = z
  .object({
    gpsLatitude: z.number().min(-90).max(90).nullable().optional(),
    gpsLongitude: z.number().min(-180).max(180).nullable().optional(),
    gpsMode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .refine(
    (input) =>
      (input.gpsLatitude == null) === (input.gpsLongitude == null),
    { message: "Latitude and longitude must be supplied together." },
  )
  .refine(
    (input) =>
      input.gpsMode !== 2 ||
      (input.gpsLatitude != null && input.gpsLongitude != null),
    { message: "Explicit GPS mode requires coordinates." },
  );

export const scheduleCreateSchema = z
  .object({
    clientId: z.string().uuid(),
    phoneId: z.string().uuid(),
    templateId: z.string().uuid(),
    name: z.string().trim().min(1).max(180).optional(),
    keyword: z.string().trim().min(1).max(500),
    config: duoPlusTaskConfigSchema.default({}),
    cronExpression: z.string().trim().min(5).max(120),
    timezone: z.string().trim().min(1).max(80).default("UTC"),
    nextRunAt: z.string().datetime({ offset: true }).optional(),
    enabled: z.boolean().default(true),
    gpsLatitude: z.number().min(-90).max(90).nullable().optional(),
    gpsLongitude: z.number().min(-180).max(180).nullable().optional(),
    gpsMode: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    localeTimezone: z.string().trim().min(1).max(80).nullable().optional(),
    localeLanguage: z.string().trim().min(1).max(24).nullable().optional(),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    expectedDurationSeconds: z.number().int().min(30).max(21_600).default(600),
  })
  .and(optionalCoordinates);

export const scheduleUpdateSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    // Every calendar schedule is a queue entry for one specific phone. Updates
    // may move it to another eligible phone, but must never restore the legacy
    // auto-assignment behavior by clearing this field.
    phoneId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(180).optional(),
    keyword: z.string().trim().min(1).max(500).optional(),
    config: duoPlusTaskConfigSchema.optional(),
    cronExpression: z.string().trim().min(5).max(120).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    nextRunAt: z.string().datetime({ offset: true }).optional(),
    enabled: z.boolean().optional(),
    gpsLatitude: z.number().min(-90).max(90).nullable().optional(),
    gpsLongitude: z.number().min(-180).max(180).nullable().optional(),
    gpsMode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    localeTimezone: z.string().trim().min(1).max(80).nullable().optional(),
    localeLanguage: z.string().trim().min(1).max(24).nullable().optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    expectedDurationSeconds: z.number().int().min(30).max(21_600).optional(),
  })
  .and(optionalCoordinates)
  .refine((input) => Object.keys(input).length > 0);

export type ScheduleCreateInput = z.infer<typeof scheduleCreateSchema>;

export function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ApiError(400, "INVALID_TIMEZONE", "Enter a valid IANA timezone.");
  }
}

export function calculateNextRun(
  cronExpression: string,
  timezone: string,
  supplied?: string,
): string {
  assertTimeZone(timezone);
  try {
    const next = supplied
      ? new Date(supplied)
      : nextScheduleOccurrence({
          cronExpression,
          timeZone: timezone,
          after: new Date(),
        });
    if (Number.isNaN(next.getTime())) throw new Error("Invalid date");
    return next.toISOString();
  } catch {
    throw new ApiError(
      400,
      "INVALID_SCHEDULE",
      "The cron expression or next run time is invalid.",
    );
  }
}

export async function resolveScheduleReferences(
  context: Exclude<AuthContext, { demo: true }>,
  input: { clientId: string; phoneId?: string | null; templateId: string },
) {
  const connection = await getDefaultDuoConnection(context, { requireKey: true });
  if (!connection) {
    throw new ApiError(
      409,
      "DUOPLUS_NOT_CONNECTED",
      "Connect and sync a DuoPlus account first.",
    );
  }

  const [clientResult, phoneResult, templateResult] = await Promise.all([
    context.admin
      .from("clients")
      .select("id")
      .eq("id", input.clientId)
      .eq("organization_id", context.organizationId)
      .eq("status", "active")
      .maybeSingle(),
    input.phoneId
      ? context.admin
          .from("duo_phones")
          .select("id, connection_id, client_id, enabled, provider_present, status, expired_at")
          .eq("id", input.phoneId)
          .eq("organization_id", context.organizationId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    context.admin
      .from("duo_templates")
      .select("id, connection_id, enabled")
      .eq("id", input.templateId)
      .eq("organization_id", context.organizationId)
      .maybeSingle(),
  ]);

  if (clientResult.error || phoneResult.error || templateResult.error) {
    throw new ApiError(
      503,
      "REFERENCE_LOOKUP_FAILED",
      "Schedule inventory could not be checked.",
    );
  }
  if (!clientResult.data) {
    throw new ApiError(400, "INVALID_CLIENT", "Choose an active client.");
  }
  if (!templateResult.data || !templateResult.data.enabled) {
    throw new ApiError(400, "INVALID_TEMPLATE", "Choose an enabled template.");
  }
  if (templateResult.data.connection_id !== connection.id) {
    throw new ApiError(400, "CONNECTION_MISMATCH", "That template belongs to another connection.");
  }
  if (
    input.phoneId &&
    (!phoneResult.data ||
      !isPhoneEligibleForNewWork(phoneResult.data) ||
      (phoneResult.data.client_id !== null &&
        phoneResult.data.client_id !== input.clientId))
  ) {
    throw new ApiError(
      400,
      "INVALID_PHONE",
      "Choose an available, non-expired phone for this client.",
    );
  }
  if (phoneResult.data && phoneResult.data.connection_id !== connection.id) {
    throw new ApiError(400, "CONNECTION_MISMATCH", "That phone belongs to another connection.");
  }

  return connection;
}

export type ScheduleRow = {
  id: string;
  client_id: string;
  connection_id: string;
  phone_id: string | null;
  template_id: string;
  name: string;
  keyword: string;
  config: Record<string, unknown>;
  cron_expression: string;
  timezone: string;
  next_run_at: string;
  last_enqueued_at: string | null;
  enabled: boolean;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_mode: number;
  locale_timezone: string | null;
  locale_language: string | null;
  max_attempts: number;
  expected_duration_seconds: number;
  created_at: string;
  updated_at: string;
};

export function presentSchedule(
  row: ScheduleRow,
  names: {
    client?: string;
    phone?: string;
    template?: string;
  } = {},
) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: names.client ?? null,
    connectionId: row.connection_id,
    phoneId: row.phone_id,
    phoneName: names.phone ?? null,
    templateId: row.template_id,
    templateName: names.template ?? null,
    name: row.name,
    keyword: row.keyword,
    config: row.config,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    lastEnqueuedAt: row.last_enqueued_at,
    enabled: row.enabled,
    gpsLatitude: row.gps_latitude,
    gpsLongitude: row.gps_longitude,
    gpsMode: row.gps_mode,
    localeTimezone: row.locale_timezone,
    localeLanguage: row.locale_language,
    maxAttempts: row.max_attempts,
    expectedDurationSeconds: row.expected_duration_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
