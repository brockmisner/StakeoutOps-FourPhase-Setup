import type { DuoPlusTask } from "@/lib/duoplus/types";

import { formatDuoPlusDate } from "./time";

export function makeDuoPlusTaskName(runId: string): string {
  const normalized = runId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error("runId is required");
  return `stk_${normalized}`;
}

export function matchesDuoPlusTaskName(
  candidate: Pick<DuoPlusTask, "name">,
  runId: string,
): boolean {
  return candidate.name === makeDuoPlusTaskName(runId);
}

export function selectDuoPlusTaskMatch(
  tasks: DuoPlusTask[],
  options: {
    runId: string;
    imageId?: string;
    issueAt: Date;
    issueTimeZone?: string;
  },
): DuoPlusTask | null {
  const expectedName = makeDuoPlusTaskName(options.runId);
  const expectedTime = options.issueAt.getTime();
  const expectedWallTime = formatDuoPlusDate(
    options.issueAt,
    options.issueTimeZone ?? "UTC",
  );

  const parseIssueAt = (value: string): number => {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    return new Date(hasZone ? normalized : `${normalized}Z`).getTime();
  };

  const matches = tasks
    .filter((task) => task.name === expectedName)
    .filter(
      (task) =>
        !options.imageId || !task.image_id || task.image_id === options.imageId,
    )
    .map((task) => ({
      task,
      distance: task.issue_at
        ? task.issue_at.replace("T", " ").slice(0, 16) === expectedWallTime
          ? 0
          : Math.abs(parseIssueAt(task.issue_at) - expectedTime)
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.distance - right.distance);

  return matches[0]?.task ?? null;
}
