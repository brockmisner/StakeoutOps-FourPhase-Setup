import {
  DUOPLUS_PHONE_STATUS,
  type DuoPlusClient,
} from "@/lib/duoplus";
import type { Clock } from "@/lib/duoplus/rate-limit";
import { systemClock } from "@/lib/duoplus/rate-limit";

import type { SchedulerRepository } from "./repository";
import type {
  DuoConnectionRow,
  SchedulerPowerOffSummary,
} from "./types";

export const DEFAULT_PHONE_IDLE_SECONDS = 15 * 60;
const DEFAULT_POWER_OFF_CLAIM_SECONDS = 2 * 60;
const DEFAULT_POWER_OFF_LIMIT = 20;

type PowerClientFactory = (connection: DuoConnectionRow) => DuoPlusClient;

function emptySummary(): SchedulerPowerOffSummary {
  return { claimed: 0, poweredOff: 0, released: 0, failed: 0 };
}

function supportsPowerOffSweep(repository: SchedulerRepository): repository is
  SchedulerRepository &
    Required<
      Pick<
        SchedulerRepository,
        | "claimIdleSchedulerPoweredOnPhones"
        | "loadPowerManagementConnection"
        | "completeSchedulerPowerOff"
        | "consumeSchedulerPowerOffOwnership"
        | "releaseSchedulerPowerOffClaim"
      >
    > {
  return Boolean(
    repository.claimIdleSchedulerPoweredOnPhones &&
      repository.loadPowerManagementConnection &&
      repository.completeSchedulerPowerOff &&
      repository.consumeSchedulerPowerOffOwnership &&
      repository.releaseSchedulerPowerOffClaim,
  );
}

function isSettledNonOnStatus(status: number): boolean {
  const settledStatuses: readonly number[] = [
    DUOPLUS_PHONE_STATUS.NOT_CONFIGURED,
    DUOPLUS_PHONE_STATUS.OFF,
    DUOPLUS_PHONE_STATUS.EXPIRED,
    DUOPLUS_PHONE_STATUS.RENEWAL_OVERDUE,
    DUOPLUS_PHONE_STATUS.CONFIG_FAILED,
  ];
  return settledStatuses.includes(status);
}

/**
 * Powers off phones only after an atomic database claim proves that:
 *
 * - the scheduler requested their off -> on transition and later observed on;
 * - the phone has been idle for the configured interval;
 * - no active/near-term run or phone lease can use it; and
 * - another worker is not already managing the same power-off.
 *
 * Ownership is consumed before the external powerOff call. If the function
 * dies or the provider result is ambiguous, that phone is deliberately left
 * unowned instead of risking a later shutdown after someone manually starts it.
 */
export async function runSchedulerPowerOffSweep(options: {
  repository: SchedulerRepository;
  clientFactory: PowerClientFactory;
  workerId: string;
  idleSeconds?: number;
  limit?: number;
  claimSeconds?: number;
  deadline?: number;
  clock?: Clock;
}): Promise<SchedulerPowerOffSummary> {
  const { repository } = options;
  const summary = emptySummary();
  if (!supportsPowerOffSweep(repository)) return summary;

  const clock = options.clock ?? systemClock;
  if (options.deadline !== undefined && clock.now().getTime() >= options.deadline) {
    return summary;
  }

  const candidates = await repository.claimIdleSchedulerPoweredOnPhones({
    workerId: options.workerId,
    idleSeconds: options.idleSeconds ?? DEFAULT_PHONE_IDLE_SECONDS,
    limit: options.limit ?? DEFAULT_POWER_OFF_LIMIT,
    claimSeconds: options.claimSeconds ?? DEFAULT_POWER_OFF_CLAIM_SECONDS,
  });
  summary.claimed = candidates.length;

  const clients = new Map<string, DuoPlusClient>();
  for (const candidate of candidates) {
    let ownershipConsumed = false;
    if (
      options.deadline !== undefined &&
      clock.now().getTime() + 5_000 >= options.deadline
    ) {
      await repository.releaseSchedulerPowerOffClaim(
        candidate.id,
        options.workerId,
        candidate.claim_token,
        { errorMessage: "Power-off deferred because the scheduler deadline was near" },
      );
      summary.released += 1;
      continue;
    }

    try {
      let client = clients.get(candidate.connection_id);
      if (!client) {
        const connection = await repository.loadPowerManagementConnection(
          candidate.connection_id,
          candidate.organization_id,
        );
        client = options.clientFactory(connection);
        clients.set(candidate.connection_id, client);
      }

      const remotePhone = await client.getPhone(candidate.duoplus_image_id);
      if (!remotePhone) {
        await repository.releaseSchedulerPowerOffClaim(
          candidate.id,
          options.workerId,
          candidate.claim_token,
          { errorMessage: "Phone state could not be verified before power-off" },
        );
        summary.failed += 1;
        continue;
      }

      if (remotePhone.status !== DUOPLUS_PHONE_STATUS.ON) {
        if (isSettledNonOnStatus(remotePhone.status)) {
          await repository.completeSchedulerPowerOff(
            candidate.id,
            options.workerId,
            candidate.claim_token,
            remotePhone.status,
          );
        } else {
          await repository.releaseSchedulerPowerOffClaim(
            candidate.id,
            options.workerId,
            candidate.claim_token,
            { errorMessage: "Phone is still changing power state" },
          );
        }
        summary.released += 1;
        continue;
      }

      const consumed = await repository.consumeSchedulerPowerOffOwnership(
        candidate.id,
        options.workerId,
        candidate.claim_token,
      );
      if (!consumed) {
        await repository.releaseSchedulerPowerOffClaim(
          candidate.id,
          options.workerId,
          candidate.claim_token,
          { errorMessage: "Power ownership changed before shutdown" },
        );
        summary.released += 1;
        continue;
      }
      ownershipConsumed = true;

      try {
        await client.powerOff([candidate.duoplus_image_id]);
      } catch {
        // The request may have reached DuoPlus. Never retry it under stale
        // ownership: a person could manually start the phone in between.
        await repository.releaseSchedulerPowerOffClaim(
          candidate.id,
          options.workerId,
          candidate.claim_token,
          {
            abandonOwnership: true,
            errorMessage:
              "Power-off result was uncertain; scheduler ownership was relinquished",
          },
        );
        summary.failed += 1;
        continue;
      }

      const completed = await repository.completeSchedulerPowerOff(
        candidate.id,
        options.workerId,
        candidate.claim_token,
        DUOPLUS_PHONE_STATUS.OFF,
      );
      if (completed) summary.poweredOff += 1;
      else summary.failed += 1;
    } catch {
      try {
        await repository.releaseSchedulerPowerOffClaim(
          candidate.id,
          options.workerId,
          candidate.claim_token,
          {
            ...(ownershipConsumed ? { abandonOwnership: true } : {}),
            errorMessage: ownershipConsumed
              ? "Power-off result could not be finalized; shutdown remains quarantined"
              : "Phone power-off preparation failed",
          },
        );
      } catch {
        // The short claim lease expires automatically. Ownership remains
        // intact because no powerOff side effect was attempted in this path.
      }
      summary.failed += 1;
    }
  }

  return summary;
}
