import type { AuthContext } from "./context";
import { requireOrganization } from "./context";
import { ApiError, apiErrorResponse } from "./errors";

export async function withOrganization(
  request: Request,
  handler: (context: AuthContext) => Promise<Response>,
): Promise<Response> {
  try {
    const context = await requireOrganization(request);
    if (
      context.demo &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())
    ) {
      throw new ApiError(
        409,
        "DEMO_MODE_READ_ONLY",
        "This is a read-only sample workspace. Configure live Preview environment variables before saving changes.",
      );
    }
    return await handler(context);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
