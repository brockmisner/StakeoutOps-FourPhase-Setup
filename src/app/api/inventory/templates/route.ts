import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import { resolvedTemplateConfigSchema } from "@/lib/duoplus/template-schema";
import { collectBoundedSupabasePages } from "@/lib/supabase/bounded-pages";

type TemplateInventoryRow = {
  id: string;
  connection_id: string;
  duoplus_template_id: string;
  template_type: number;
  name: string;
  description: string | null;
  config_schema: Record<string, unknown>;
  enabled: boolean;
  last_synced_at: string | null;
};

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      return dataResponse({
        templates: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            duoplusTemplateId: "SERP01",
            templateSource: "custom",
            templateId: "SERP01",
            name: "Chrome SERP observation",
            templateType: 2,
            configSchema: null,
            enabled: true,
          },
          {
            id: "00000000-0000-4000-8000-000000000202",
            duoplusTemplateId: "MAPS01",
            templateSource: "custom",
            templateId: "MAPS01",
            name: "Maps finder observation",
            templateType: 2,
            configSchema: null,
            enabled: true,
          },
          {
            id: "00000000-0000-4000-8000-000000000203",
            duoplusTemplateId: "WARM01",
            templateSource: "custom",
            templateId: "WARM01",
            name: "Device warm-up",
            templateType: 2,
            configSchema: null,
            enabled: true,
          },
          {
            id: "00000000-0000-4000-8000-000000000204",
            duoplusTemplateId: "REDDIT01",
            templateSource: "official",
            templateId: "REDDIT01",
            name: "Reddit Account Warming",
            templateType: 1,
            configSchema: null,
            enabled: true,
          },
          {
            id: "00000000-0000-4000-8000-000000000205",
            duoplusTemplateId: "SERP01",
            templateSource: "official",
            templateId: "SERP01",
            name: "Chrome SERP observation",
            templateType: 1,
            configSchema: null,
            enabled: true,
          },
        ],
      });
    }

    const result = await collectBoundedSupabasePages<TemplateInventoryRow>(
      async (from, to) => {
        const { data, error } = await context.admin
          .from("duo_templates")
          .select(
            "id, connection_id, duoplus_template_id, template_type, name, description, config_schema, enabled, last_synced_at",
          )
          .eq("organization_id", context.organizationId)
          .order("template_type", { ascending: false })
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return { data: data as TemplateInventoryRow[] | null, error };
      },
    );

    if (!result.complete) {
      throw new ApiError(
        503,
        result.reason === "limit"
          ? "TEMPLATE_LIST_TOO_LARGE"
          : "TEMPLATE_LIST_FAILED",
        result.reason === "limit"
          ? "This template catalog requires filtered pagination."
          : "Templates could not be loaded.",
      );
    }

    const templates = result.rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      duoplusTemplateId: row.duoplus_template_id,
      templateSource: row.template_type === 1 ? "official" : "custom",
      // Compatibility alias for clients created before the explicit DTO name.
      templateId: row.duoplus_template_id,
      templateType: row.template_type,
      name: row.name,
      description: row.description,
      configSchema: resolvedTemplateConfigSchema(row.name, row.config_schema),
      enabled: row.enabled,
      lastSyncedAt: row.last_synced_at,
    }));
    return dataResponse({ templates });
  });
}
