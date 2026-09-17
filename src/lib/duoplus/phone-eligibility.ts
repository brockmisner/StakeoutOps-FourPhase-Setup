export type DuoPlusPhoneEligibility = {
  enabled: boolean;
  status: number;
  providerPresent?: boolean;
  expiredAt?: string | null;
};

/** Phones that cannot legally start another DuoPlus task stay out of planners. */
export function isSchedulablePhone(
  phone: DuoPlusPhoneEligibility,
  now = Date.now(),
): boolean {
  if (
    !phone.enabled ||
    phone.providerPresent === false ||
    phone.status === 3 ||
    phone.status === 4
  ) {
    return false;
  }
  if (phone.expiredAt === undefined || phone.expiredAt === null) return true;
  const expiresAt = new Date(phone.expiredAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}
