import { z } from "zod";

import {
  requireSchedulerManager,
  type AuthContext,
} from "@/lib/auth/context";
import { getDefaultDuoConnection } from "@/lib/auth/duoplus";
import { ApiError, dataResponse } from "@/lib/auth/errors";
import { taskConfigIssueMessage } from "@/lib/duoplus/task-config";
import { resolvedTemplateConfigSchema } from "@/lib/duoplus/template-schema";
import { withOrganization } from "@/lib/auth/route";
import {
  duoPlusProgramTaskConfigSchema,
  programTaskConfigForTemplateSchema,
} from "@/lib/scheduler/program-config";
import { collectBoundedSupabasePages } from "@/lib/supabase/bounded-pages";
import {
  phasePlanSchema,
  phasePlanDuration,
  phaseWindowForRule,
} from "@/lib/scheduler/phase-plan";

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  templateId: z.string().uuid(),
  ruleKind: z.enum(["daily_range", "day_range", "window_once"]),
  startDay: z.number().int().min(1).max(36),
  endDay: z.number().int().min(1).max(36),
  phaseKind: z.enum(["baseline", "warmup", "money", "final_squeeze", "after_action"]).nullable().optional(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sequence: z.number().int().min(1).max(100),
  config: duoPlusProgramTaskConfigSchema.default({}),
  expectedDurationSeconds: z.number().int().min(30).max(21_600).default(600),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  required: z.boolean().default(true),
  appKind: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .default("other"),
  points: z.number().int().min(1).max(100).default(1),
});

const createProgramSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    durationDays: z.number().int().min(15).max(36),
    phasePlan: phasePlanSchema.nullable().optional(),
    timezone: z.string().trim().min(1).max(80),
    readyDay: z.number().int().min(1).max(36).default(10),
    readyThresholdPercent: z.number().int().min(1).max(100).default(80),
    completionThresholdPercent: z.number().int().min(1).max(100).default(90),
    rules: z.array(ruleSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (!value.phasePlan && value.readyDay > value.durationDays) {
      context.addIssue({
        code: "custom",
        path: ["readyDay"],
        message: "Ready day must fit inside the program duration.",
      });
    }
    if (value.completionThresholdPercent < value.readyThresholdPercent) {
      context.addIssue({
        code: "custom",
        path: ["completionThresholdPercent"],
        message: "Completed threshold cannot be lower than the Ready threshold.",
      });
    }
  });

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

type LiveAuthContext = Exclude<AuthContext, { demo: true }>;

type ProgramTemplateRow = {
  id: string;
  duoplus_template_id: string;
  template_type: 1 | 2;
  name: string;
  config_schema: unknown;
  enabled: boolean;
};

async function loadProgramTemplates(context: LiveAuthContext) {
  const result = await collectBoundedSupabasePages<ProgramTemplateRow>(
    async (from, to) => {
      const { data, error } = await context.admin
        .from("duo_templates")
        .select("id, duoplus_template_id, template_type, name, config_schema, enabled")
        .eq("organization_id", context.organizationId)
        .order("id", { ascending: true })
        .range(from, to);
      return { data: data as ProgramTemplateRow[] | null, error };
    },
  );
  if (!result.complete) {
    throw new ApiError(
      503,
      result.reason === "limit"
        ? "PROGRAM_TEMPLATE_LIST_TOO_LARGE"
        : "PROGRAM_LIST_FAILED",
      result.reason === "limit"
        ? "This template catalog requires filtered pagination."
        : "Cycle programs could not be loaded.",
    );
  }
  return result.rows;
}

async function loadPrograms(context: LiveAuthContext) {
  const [programResult, ruleResult, templateResult] = await Promise.all([
    context.admin
      .from("cycle_programs")
      .select("id, connection_id, name, duration_days, phase_plan, timezone, ready_day, ready_threshold_percent, completion_threshold_percent, version, status, published_at, created_at")
      .eq("organization_id", context.organizationId)
      .order("created_at", { ascending: false }),
    context.admin
      .from("cycle_program_rules")
      .select("id, program_id, template_id, name, rule_kind, phase_kind, app_kind, points, start_day, end_day, local_time, sequence, config, expected_duration_seconds, max_attempts, required")
      .eq("organization_id", context.organizationId)
      .order("sequence", { ascending: true }),
    loadProgramTemplates(context),
  ]);
  if (programResult.error || ruleResult.error) {
    throw new ApiError(503, "PROGRAM_LIST_FAILED", "Cycle programs could not be loaded.");
  }
  const templatesById = new Map(templateResult.map((row) => [row.id, row]));
  return (programResult.data ?? []).map((program) => ({
    id: program.id,
    connectionId: program.connection_id,
    name: program.name,
    durationDays: program.duration_days,
    phasePlan: program.phase_plan ?? null,
    timezone: program.timezone,
    readyDay: program.ready_day,
    readyThresholdPercent: program.ready_threshold_percent,
    completionThresholdPercent: program.completion_threshold_percent,
    version: program.version,
    status: program.status,
    publishedAt: program.published_at,
    createdAt: program.created_at,
    rules: (ruleResult.data ?? [])
      .filter((rule) => rule.program_id === program.id)
      .map((rule) => {
        const template = templatesById.get(rule.template_id);
        return {
          id: rule.id,
          // This is always the internal duo_templates UUID used by the FK.
          templateId: rule.template_id,
          templateName: template?.name ?? null,
          templateType: template?.template_type ?? null,
          templateSource:
            template?.template_type === 1
              ? "official"
              : template?.template_type === 2
                ? "custom"
                : null,
          duoplusTemplateId: template?.duoplus_template_id ?? null,
          name: rule.name,
          ruleKind: rule.rule_kind,
          phaseKind: rule.phase_kind ?? null,
          appKind: rule.app_kind,
          points: rule.points,
          startDay: rule.start_day,
          endDay: rule.end_day,
          localTime: String(rule.local_time).slice(0, 5),
          sequence: rule.sequence,
          config: rule.config,
          expectedDurationSeconds: rule.expected_duration_seconds,
          maxAttempts: rule.max_attempts,
          required: rule.required,
        };
      }),
  }));
}

export async function GET(request: Request) {
  return withOrganization(request, async (context) => {
    if (context.demo) {
      return dataResponse({
        programs: [
          {
            id: "demo-cycle-program",
            name: "30-day local presence cycle",
            durationDays: 30,
            timezone: "America/New_York",
            readyDay: 10,
            readyThresholdPercent: 80,
            completionThresholdPercent: 90,
            version: 1,
            status: "published",
            rules: [],
          },
        ],
      });
    }
    return dataResponse({ programs: await loadPrograms(context) });
  });
}

export async function POST(request: Request) {
  return withOrganization(request, async (context) => {
    requireSchedulerManager(context);
    let input: z.infer<typeof createProgramSchema>;
    try {
      input = createProgramSchema.parse(await request.json());
    } catch (error) {
      const configMessage = taskConfigIssueMessage(error);
      if (configMessage) {
        throw new ApiError(400, "INVALID_TASK_CONFIG", configMessage);
      }
      throw new ApiError(400, "INVALID_CYCLE_PROGRAM", "Check the program name, readiness gates, app points, day ranges, times, task configs, and template selections.");
    }
    if (!validTimezone(input.timezone)) {
      throw new ApiError(400, "INVALID_TIMEZONE", "Use a valid IANA timezone.");
    }
    if (input.phasePlan) {
      const plan = input.phasePlan;
      if (input.rules.some((rule) => !rule.phaseKind)) {
        throw new ApiError(400, "PHASE_REQUIRED", "Choose a phase for every task in a four-phase program.");
      }
      // Dates come from the sequential phase plan, never independently entered
      // day ranges that could put a Money task inside warmup.
      input = {
        ...input,
        durationDays: phasePlanDuration(plan),
        readyDay: plan.warmupDays,
        rules: input.rules.map((rule) => ({
          ...rule,
          ruleKind: "daily_range" as const,
          ...phaseWindowForRule(plan, rule.phaseKind!),
        })),
      };
      const counts = (kind: string) => input.rules.filter((rule) => rule.phaseKind === kind).length;
      const requiredCounts = (kind: string) => input.rules.filter((rule) => rule.phaseKind === kind && rule.required).length;
      if (requiredCounts("baseline") < 5 || requiredCounts("money") < 3 || counts("money") > 4 ||
          requiredCounts("final_squeeze") < 4 || counts("final_squeeze") > 7 ||
          requiredCounts("after_action") < 3 || counts("after_action") > 5) {
        throw new ApiError(400, "INVALID_PHASE_TASK_COUNTS", "Require at least five daily tasks, three Money tasks, four Final squeeze tasks, and three After action tasks. Phase totals may not exceed four Money, seven Final squeeze, or five After action tasks.");
      }
      for (const requirement of plan.appRequirements) {
        const availableRuns = input.rules.filter((rule) =>
          rule.appKind === requirement.appKind &&
          (rule.phaseKind === "baseline" || rule.phaseKind === "warmup")
        ).length * plan.warmupDays;
        if (requirement.minSuccessfulRuns > availableRuns || requirement.minActiveDays > plan.warmupDays ||
            (requirement.minActiveDays > 0 && availableRuns === 0)) {
          throw new ApiError(400, "UNREACHABLE_APP_REQUIREMENT", `The warmup tasks cannot satisfy the ${requirement.appKind} app requirements.`);
        }
      }
    } else if (input.rules.some((rule) => rule.phaseKind != null)) {
      throw new ApiError(400, "PHASE_PLAN_REQUIRED", "Add a four-phase plan before assigning tasks to phases.");
    }
    if (new Set(input.rules.map((rule) => rule.sequence)).size !== input.rules.length) {
      throw new ApiError(400, "DUPLICATE_RULE_SEQUENCE", "Every program task needs a unique sequence.");
    }
    if (input.rules.some((rule) => rule.endDay < rule.startDay || rule.endDay > input.durationDays)) {
      throw new ApiError(400, "INVALID_RULE_WINDOW", "Every task day must fit inside the program duration.");
    }
    if (context.demo) {
      return dataResponse({ program: { id: "demo-cycle-program", ...input, status: "published", version: 1 } }, { status: 201 });
    }

    const connection = await getDefaultDuoConnection(context);
    if (!connection || connection.status !== "active") {
      throw new ApiError(409, "DUOPLUS_REQUIRED", "Connect DuoPlus before publishing a cycle program.");
    }
    const templates = await loadProgramTemplates(context);
    const templatesById = new Map(templates.map((template) => [template.id, template]));
    let rules = input.rules;
    try {
      rules = input.rules.map((rule) => {
        const template = templatesById.get(rule.templateId);
        if (!template || template.enabled === false) {
          throw new ApiError(
            409,
            "PROGRAM_TEMPLATE_UNAVAILABLE",
            "Every program task must use a currently enabled DuoPlus template.",
          );
        }
        const schema = resolvedTemplateConfigSchema(
          template.name,
          template.config_schema,
        );
        return {
          ...rule,
          // Known input definitions are authoritative: operator values remain
          // cycle bindings and selector constants come from the safe schema.
          config: schema
            ? programTaskConfigForTemplateSchema(schema)
            : rule.config,
        };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        "INVALID_PROGRAM_TEMPLATE_CONFIG",
        error instanceof Error
          ? error.message
          : "A program template input definition is invalid.",
      );
    }
    const { data, error } = await context.admin.rpc("create_cycle_program", {
      p_organization_id: context.organizationId,
      p_connection_id: connection.id,
      p_name: input.name,
      p_duration_days: input.durationDays,
      p_timezone: input.timezone,
      p_rules: rules,
      p_created_by: context.user.id,
      p_ready_day: input.readyDay,
      p_ready_threshold_percent: input.readyThresholdPercent,
      p_completion_threshold_percent: input.completionThresholdPercent,
      p_phase_plan: input.phasePlan ?? null,
    });
    if (error || !data) {
      throw new ApiError(
        409,
        "PROGRAM_CREATE_FAILED",
        "The cycle program could not be created. Check that every template is still enabled.",
      );
    }
    const programs = await loadPrograms(context);
    const program = programs.find((item) => item.id === data);
    if (!program) throw new ApiError(503, "PROGRAM_READBACK_FAILED", "The program was saved but could not be reloaded.");
    return dataResponse({ program }, { status: 201 });
  });
}
