import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      return dataResponse({
        phones: Array.from({ length: 8 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
          imageId: `PHONE${index + 1}`,
          name: `Field phone ${String(index + 1).padStart(2, "0")}`,
          status: index === 7 ? 2 : 1,
          enabled: true,
          clientId:
            index < 2 ? "00000000-0000-4000-8000-000000000001" : null,
          busyUntil: null,
          gpsLatitude: null,
          gpsLongitude: null,
          lastSeenAt: new Date().toISOString(),
        })),
      });
    }

    const { data, error } = await context.admin
      .from("duo_phones")
      .select(
        "id, connection_id, client_id, duoplus_image_id, name, status, enabled, provider_present, busy_until, gps_latitude, gps_longitude, locale_timezone, last_seen_at, expired_at",
      )
      .eq("organization_id", context.organizationId)
      .order("name", { ascending: true });

    if (error) {
      throw new ApiError(503, "PHONE_LIST_FAILED", "Phones could not be loaded.");
    }

    const phones = (data ?? []).map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      clientId: row.client_id,
      imageId: row.duoplus_image_id,
      name: row.name,
      status: row.status,
      enabled: row.enabled,
      providerPresent: row.provider_present,
      busyUntil: row.busy_until,
      gpsLatitude: row.gps_latitude,
      gpsLongitude: row.gps_longitude,
      timezone: row.locale_timezone,
      lastSeenAt: row.last_seen_at,
      expiredAt: row.expired_at,
    }));
    return dataResponse({ phones });
  });
}
