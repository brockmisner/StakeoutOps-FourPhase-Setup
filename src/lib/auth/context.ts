import "server-only";

import type { User } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { ApiError } from "./errors";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type OrganizationRole = "owner" | "admin" | "member" | string;

export type AuthContext =
  | {
      demo: true;
      user: { id: "demo-user"; email: "preview@stakeout.local" };
      organizationId: "demo-workspace";
      role: "owner";
      admin: null;
    }
  | {
      demo: false;
      user: User;
      organizationId: string;
      role: OrganizationRole;
      admin: AdminClient;
    };

type Membership = {
  organization_id: string;
  role: OrganizationRole;
};

function requestedOrganizationId(request: Request): string | null {
  const fromHeader = request.headers.get("x-organization-id")?.trim();
  if (fromHeader) return fromHeader;

  return new URL(request.url).searchParams.get("organizationId")?.trim() || null;
}

async function membershipsForUser(
  admin: AdminClient,
  userId: string,
): Promise<Membership[]> {
  const { data, error } = await admin
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .order("organization_id", { ascending: true });

  if (error) {
    throw new ApiError(
      503,
      "WORKSPACE_LOOKUP_FAILED",
      "Your workspace could not be loaded.",
    );
  }

  return (data ?? []) as Membership[];
}

async function bootstrapPersonalWorkspace(
  userClient: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  user: User,
): Promise<void> {
  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";
  const emailName = user.email?.split("@")[0]?.trim();
  const workspaceName = metadataName || emailName || "My workspace";

  const { error } = await userClient.rpc("ensure_personal_workspace", {
    p_name: workspaceName,
  });

  if (error) {
    throw new ApiError(
      503,
      "WORKSPACE_BOOTSTRAP_FAILED",
      "Your private workspace could not be created.",
    );
  }
}

export async function requireOrganization(request: Request): Promise<AuthContext> {
  if (isDemoMode()) {
    return {
      demo: true,
      user: { id: "demo-user", email: "preview@stakeout.local" },
      organizationId: "demo-workspace",
      role: "owner",
      admin: null,
    };
  }

  let userClient: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  let admin: AdminClient;
  try {
    userClient = await createSupabaseServerClient();
    admin = createSupabaseAdminClient();
  } catch {
    throw new ApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Authentication is not configured for this deployment.",
    );
  }

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue.");
  }

  let memberships = await membershipsForUser(admin, user.id);
  if (memberships.length === 0) {
    await bootstrapPersonalWorkspace(userClient, user);
    memberships = await membershipsForUser(admin, user.id);
  }

  const requestedId = requestedOrganizationId(request);
  const membership = requestedId
    ? memberships.find((item) => item.organization_id === requestedId)
    : memberships[0];

  if (!membership) {
    throw new ApiError(
      403,
      "WORKSPACE_ACCESS_DENIED",
      requestedId
        ? "You do not have access to that workspace."
        : "No workspace is available for this account.",
    );
  }

  return {
    demo: false,
    user,
    organizationId: membership.organization_id,
    role: membership.role,
    admin,
  };
}

export function requireWorkspaceAdmin(
  context: AuthContext,
): asserts context is Exclude<AuthContext, { demo: true }> {
  if (context.demo) {
    throw new ApiError(
      409,
      "DEMO_MODE_READ_ONLY",
      "This is a read-only sample workspace. Configure the deployment for live mode before connecting DuoPlus or saving changes.",
    );
  }
  if (context.role !== "owner" && context.role !== "admin") {
    throw new ApiError(
      403,
      "INSUFFICIENT_ROLE",
      "Workspace admin access is required.",
    );
  }
}

export function requireSchedulerManager(
  context: AuthContext,
): asserts context is Exclude<AuthContext, { demo: true }> {
  if (context.demo) {
    throw new ApiError(
      409,
      "DEMO_MODE_READ_ONLY",
      "This is a read-only sample workspace. Configure the deployment for live mode before scheduling or syncing work.",
    );
  }
  if (!["owner", "admin", "analyst"].includes(context.role)) {
    throw new ApiError(
      403,
      "INSUFFICIENT_ROLE",
      "Schedule management access is required.",
    );
  }
}
