import { z } from "zod";

import { requireSchedulerManager } from "@/lib/auth/context";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { withOrganization } from "@/lib/auth/route";
import {
  normalizeDuoPlusTemplateName,
  sanitizeDuoPlusTemplateConfigSchema,
} from "@/lib/duoplus/template-schema";

const importSchema = z.object({
  exports: z.array(z.object({
    fileName: z.string().trim().min(1).max(240),
    templateId: z.string().uuid().optional(),
    schema: z.unknown(),
  }).strict()).min(1).max(100),
}).strict();

type TemplateRow = {
  id: string;
  name: string;
  template_type: 1 | 2;
};

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    let input: z.infer<typeof importSchema>;
    try {
      input = importSchema.parse(await request.json());
    } catch {
      throw new ApiError(
        400,
        "INVALID_TEMPLATE_SCHEMA_IMPORT",
        "Choose valid DuoPlus RPA JSON exports to import.",
      );
    }

    const { data, error } = await context.admin
      .from("duo_templates")
      .select("id, name, template_type")
      .eq("organization_id", context.organizationId)
      .eq("enabled", true);
    if (error) {
      throw new ApiError(503, "TEMPLATE_LIST_FAILED", "Templates could not be loaded.");
    }
    const templates = (data ?? []) as TemplateRow[];
    const templateById = new Map(templates.map((template) => [template.id, template]));
    const templatesByName = new Map<string, TemplateRow[]>();
    for (const template of templates) {
      const key = normalizeDuoPlusTemplateName(template.name);
      templatesByName.set(key, [...(templatesByName.get(key) ?? []), template]);
    }

    const updated: Array<{ id: string; name: string; inputCount: number }> = [];
    const unmatched: string[] = [];
    for (const item of input.exports) {
      let schema;
      try {
        schema = sanitizeDuoPlusTemplateConfigSchema(item.schema);
      } catch {
        throw new ApiError(
          400,
          "INVALID_TEMPLATE_SCHEMA_IMPORT",
          `${item.fileName} does not contain a safe DuoPlus input definition.`,
        );
      }
      let target = item.templateId ? templateById.get(item.templateId) : undefined;
      if (!target) {
        const matches = templatesByName.get(normalizeDuoPlusTemplateName(item.fileName)) ?? [];
        target = matches.find((candidate) => candidate.template_type === 2) ??
          (matches.length === 1 ? matches[0] : undefined);
      }
      if (!target) {
        unmatched.push(item.fileName);
        continue;
      }
      const { error: updateError } = await context.admin
        .from("duo_templates")
        .update({ config_schema: schema, updated_at: new Date().toISOString() })
        .eq("organization_id", context.organizationId)
        .eq("id", target.id);
      if (updateError) {
        throw new ApiError(
          503,
          "TEMPLATE_SCHEMA_SAVE_FAILED",
          `Inputs for ${target.name} could not be saved.`,
        );
      }
      updated.push({ id: target.id, name: target.name, inputCount: schema.inputs.length });
    }

    return dataResponse({ updated, unmatched });
  });
}

