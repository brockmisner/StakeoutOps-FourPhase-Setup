import { z } from "zod";

import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireWorkspaceAdmin } from "@/lib/auth/context";
import { withOrganization } from "@/lib/auth/route";

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    brandName: z.string().trim().max(120).optional(),
    domain: z.string().trim().max(255).optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

type ClientRow = {
  id: string;
  name: string;
  brand_name: string | null;
  domain: string | null;
  status: "active" | "paused" | "archived";
  created_at: string;
};

function presentClient(row: ClientRow) {
  return {
    id: row.id,
    name: row.name,
    brandName: row.brand_name,
    domain: row.domain,
    active: row.status === "active",
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrganization(request, async (context) => {
    requireWorkspaceAdmin(context);
    const { id } = await params;
    let input: z.infer<typeof updateSchema>;
    try {
      input = updateSchema.parse(await request.json());
    } catch {
      throw new ApiError(400, "INVALID_REQUEST", "No valid client changes were supplied.");
    }

    if (context.demo) {
      return dataResponse({
        client: {
          id,
          name: input.name ?? "Preview client",
          brandName: input.brandName ?? input.name ?? "Preview client",
          domain: input.domain ?? "",
          active: input.active ?? true,
          createdAt: new Date().toISOString(),
        },
      });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.brandName !== undefined) updates.brand_name = input.brandName;
    if (input.domain !== undefined) updates.domain = input.domain;
    if (input.active !== undefined) updates.status = input.active ? "active" : "paused";

    const { data, error } = await context.admin
      .from("clients")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", context.organizationId)
      .select("id, name, brand_name, domain, status, created_at")
      .maybeSingle();

    if (error) {
      throw new ApiError(503, "CLIENT_UPDATE_FAILED", "The client could not be updated.");
    }
    if (!data) {
      throw new ApiError(404, "CLIENT_NOT_FOUND", "Client not found.");
    }

    return dataResponse({ client: presentClient(data as ClientRow) });
  });
}
