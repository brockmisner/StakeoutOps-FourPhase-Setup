import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ApiError, dataResponse } from "@/lib/auth/errors";
import { requireWorkspaceAdmin } from "@/lib/auth/context";
import { withOrganization } from "@/lib/auth/route";

const clientSchema = z.object({
  name: z.string().trim().min(2).max(120),
  brandName: z.string().trim().max(120).optional(),
  domain: z.string().trim().max(255).optional(),
});

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

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      return dataResponse({
        clients: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Harbor Injury Law",
            brandName: "Harbor Injury Law",
            domain: "harborinjurylaw.example",
            active: true,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }

    const includeInactive =
      new URL(request.url).searchParams.get("includeInactive") === "true";
    let query = context.admin
      .from("clients")
      .select("id, name, brand_name, domain, status, created_at")
      .eq("organization_id", context.organizationId)
      .order("name", { ascending: true });
    if (!includeInactive) query = query.eq("status", "active");

    const { data, error } = await query;
    if (error) {
      throw new ApiError(503, "CLIENT_LIST_FAILED", "Clients could not be loaded.");
    }

    return dataResponse({
      clients: ((data ?? []) as ClientRow[]).map(presentClient),
    });
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireWorkspaceAdmin(context);
    let input: z.infer<typeof clientSchema>;
    try {
      input = clientSchema.parse(await request.json());
    } catch {
      throw new ApiError(400, "INVALID_REQUEST", "Enter a client name.");
    }

    if (context.demo) {
      return dataResponse(
        {
          client: {
            id: randomUUID(),
            name: input.name,
            brandName: input.brandName || input.name,
            domain: input.domain || "",
            active: true,
            createdAt: new Date().toISOString(),
          },
        },
        { status: 201 },
      );
    }

    const { data, error } = await context.admin
      .from("clients")
      .insert({
        organization_id: context.organizationId,
        name: input.name,
        brand_name: input.brandName || input.name,
        domain: input.domain || "",
        status: "active",
      })
      .select("id, name, brand_name, domain, status, created_at")
      .single();

    if (error || !data) {
      throw new ApiError(503, "CLIENT_CREATE_FAILED", "The client could not be created.");
    }

    return dataResponse(
      { client: presentClient(data as ClientRow) },
      { status: 201 },
    );
  });
}
