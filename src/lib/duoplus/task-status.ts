export type SchedulerTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export function mapDuoPlusTaskStatus(status: number): SchedulerTaskStatus {
  switch (status) {
    case 0:
      return "queued";
    case 1:
      return "running";
    case 2:
      return "paused";
    case 3:
      return "succeeded";
    case 4:
      return "failed";
    case 5:
      return "cancelled";
    default:
      return "unknown";
  }
}

export function isDuoPlusTerminalStatus(status: number): boolean {
  return status === 3 || status === 4 || status === 5;
}
