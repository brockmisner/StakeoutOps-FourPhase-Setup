export const INVITATION_REQUIRED_MESSAGE =
  "Access is invitation-only. Sign in with an invited email address or ask the workspace owner for access.";

/**
 * Public account creation is fail-closed. The setting is intentionally strict:
 * only the literal value `true` enables the signup surface.
 */
export function arePublicSignupsAllowed(
  value = process.env.NEXT_PUBLIC_ALLOW_SIGNUPS,
): boolean {
  return value === "true";
}
