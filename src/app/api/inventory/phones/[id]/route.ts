import { z } from "zod";

import { requireSchedulerManager } from "@/lib/auth/context";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

const assignmentSchema = z
  .object({
    clientId: z.string().uuid().nullable(),
  })
  .strict();

const locationSchema = z
  .object({
    gpsLatitude: z.number().min(-90).max(90).nullable(),
    gpsLongitude: z.number().min(-180).max(180).nullable(),
  })
  .strict()
  .refine(
    (value) => (value.gpsLatitude === null) === (value.gpsLongitude === null),
    "Latitude and longitude must be supplied together.",
  );

const phoneUpdateSchema = z.union([assignmentSchema, locationSchema]);

type PhoneRow = {
  id: string;
  connection_id: string;
  client_id: string | null;
  duoplus_image_id: string;
  name: string;
  status: number;
  enabled: boolean;
  busy_until: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  locale_timezone: string | null;
  last_seen_at: string | null;
  expired_at: string | null;
};

function presentPhone(row: PhoneRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    imageId: row.duoplus_image_id,
    name: row.name,
    status: row.status,
    enabled: row.enabled,
    busyUntil: row.busy_until,
    gpsLatitude: row.gps_latitude,
    gpsLongitude: row.gps_longitude,
    timezone: row.locale_timezone,
    lastSeenAt: row.last_seen_at,
    expiredAt: row.expired_at,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    const { id } = await params;

    if (!z.string().uuid().safeParse(id).success) {
      throw new ApiError(
        400,
        "INVALID_PHONE_ID",
        "Supply a valid phone ID.",
      );
    }

    let input: z.infer<typeof phoneUpdateSchema>;
    try {
      input = phoneUpdateSchema.parse(await request.json());
    } catch {
      throw new ApiError(
        400,
        "INVALID_PHONE_ASSIGNMENT",
        "Supply a valid client ID, or null to remove the phone assignment.",
      );
    }

    if ("gpsLatitude" in input) {
      const { data, error } = await context.admin
        .from("duo_phones")
        .update({
          gps_latitude: input.gpsLatitude,
          gps_longitude: input.gpsLongitude,
          gps_mode: input.gpsLatitude === null ? null : 2,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("organization_id", context.organizationId)
        .select(
          "id, connection_id, client_id, duoplus_image_id, name, status, enabled, busy_until, gps_latitude, gps_longitude, locale_timezone, last_seen_at, expired_at",
        )
        .maybeSingle();
      if (error) {
        throw new ApiError(503, "PHONE_LOCATION_SAVE_FAILED", "Device location could not be saved.");
      }
      if (!data) throw new ApiError(404, "PHONE_NOT_FOUND", "Phone not found.");
      return dataResponse({ phone: presentPhone(data as PhoneRow) });
    }

    const { data, error } = await context.admin.rpc(
      "assign_duoplus_phone_client",
      {
        p_organization_id: context.organizationId,
        p_phone_id: id,
        p_client_id: input.clientId,
      },
    );
    if (error) {
      if (error.code === "P4101") {
        throw new ApiError(404, "PHONE_NOT_FOUND", "Phone not found.");
      }
      if (error.code === "P4102") {
        throw new ApiError(404, "CLIENT_NOT_FOUND", "Client not found.");
      }
      if (error.code === "P4103") {
        throw new ApiError(
          409,
          "CLIENT_UNAVAILABLE",
          "Assign phones to an active client only.",
        );
      }
      if (error.code === "P4104") {
        throw new ApiError(
          409,
          "PHONE_HAS_OPEN_CYCLE",
          "Complete or cancel the phone's open device cycle before changing its client assignment.",
        );
      }
      if (error.code === "P4105") {
        throw new ApiError(
          409,
          "PHONE_UNAVAILABLE",
          "Expired, renewal-overdue, or missing phones cannot be assigned.",
        );
      }
      if (error.code === "P4106") {
        throw new ApiError(
          409,
          "PHONE_HAS_SCHEDULED_WORK",
          "Pause or reassign schedules and finish open runs before changing this phone's client.",
        );
      }
      throw new ApiError(
        503,
        "PHONE_ASSIGNMENT_FAILED",
        "The phone client assignment could not be saved.",
      );
    }

    const updated = (Array.isArray(data) ? data[0] : data) as PhoneRow | null;
    if (!updated) {
      throw new ApiError(
        503,
        "PHONE_ASSIGNMENT_FAILED",
        "The phone client assignment could not be saved.",
      );
    }

    return dataResponse({ phone: presentPhone(updated) });
  });
}
