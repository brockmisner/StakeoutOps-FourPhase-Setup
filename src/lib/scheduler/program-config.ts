import { z } from "zod";

import {
  DuoPlusTaskConfigValidationError,
  isSensitiveDuoPlusConfigKey,
  sanitizeDuoPlusTaskConfig,
} from "@/lib/duoplus/task-config";
import type { DuoPlusTemplateConfigSchema } from "@/lib/duoplus/template-schema";
import type {
  DuoPlusConfigValueType,
  DuoPlusTaskConfigEntry,
} from "@/lib/duoplus/types";

const EXACT_VARIABLE = /^\{\{([a-z][a-z0-9_]{0,63})\}\}$/;
const PLACEHOLDER_MARKER = /\{\{|\}\}/;
const MAX_PROGRAM_CONFIG_SERIALIZED_LENGTH = 200_000;

export type DuoPlusProgramTaskConfigEntry = {
  key: string;
  value: string | number | boolean | string[];
  type: DuoPlusConfigValueType;
  required: boolean;
};

export type DuoPlusProgramTaskConfig = Record<
  string,
  DuoPlusProgramTaskConfigEntry
>;

export type ProgramVariableDefinition = {
  name: string;
  type: DuoPlusConfigValueType;
  required: boolean;
  fields: string[];
};

export class ProgramConfigBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramConfigBindingError";
  }
}

function placeholderName(
  entry: DuoPlusTaskConfigEntry | DuoPlusProgramTaskConfigEntry,
): string | null {
  if (typeof entry.value !== "string") return null;
  return EXACT_VARIABLE.exec(entry.value)?.[1] ?? null;
}

function concretePlaceholderStandIn(type: unknown): unknown {
  switch (type) {
    case "string":
    case "textarea":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "file":
    case "excel":
      return [];
    default:
      return "";
  }
}

function hasInexactPlaceholderMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return PLACEHOLDER_MARKER.test(value) && !EXACT_VARIABLE.test(value);
  }
  return Array.isArray(value) && value.some(hasInexactPlaceholderMarker);
}

/**
 * Program definitions use the same strict config envelope as schedules, but
 * may bind an exact {{variable_name}} at the whole-value boundary for every
 * DuoPlus type. Concrete schedule validation intentionally remains unchanged.
 */
export function sanitizeDuoPlusProgramTaskConfig(
  value: unknown,
): DuoPlusProgramTaskConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // Reuse the concrete validator's stable, value-free error message.
    sanitizeDuoPlusTaskConfig(value);
  }

  const source = value as Record<string, unknown>;
  const placeholderNames = new Map<string, string>();
  const shadow = Object.fromEntries(
    Object.entries(source).map(([field, candidate]) => {
      if (typeof candidate === "string") {
        const name = EXACT_VARIABLE.exec(candidate)?.[1];
        if (name) {
          placeholderNames.set(field, name);
          return [field, ""];
        }
        if (hasInexactPlaceholderMarker(candidate)) {
          throw new DuoPlusTaskConfigValidationError(
            "Program variables must occupy the entire config value as {{variable_name}}.",
          );
        }
        return [field, candidate];
      }

      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [field, candidate];
      }
      const entry = candidate as Record<string, unknown>;
      const name = typeof entry.value === "string"
        ? EXACT_VARIABLE.exec(entry.value)?.[1]
        : undefined;
      if (name) {
        placeholderNames.set(field, name);
        return [
          field,
          {
            ...entry,
            value: concretePlaceholderStandIn(entry.type),
          },
        ];
      }
      if (hasInexactPlaceholderMarker(entry.value)) {
        throw new DuoPlusTaskConfigValidationError(
          "Program variables must occupy the entire config value as {{variable_name}}.",
        );
      }
      return [field, candidate];
    }),
  );

  const sanitized = sanitizeDuoPlusTaskConfig(shadow);
  const result: DuoPlusProgramTaskConfig = Object.create(null);
  for (const [field, entry] of Object.entries(sanitized)) {
    const name = placeholderNames.get(field);
    if (!name) {
      result[field] = entry;
      continue;
    }
    if (isSensitiveDuoPlusConfigKey(name)) {
      throw new DuoPlusTaskConfigValidationError(
        "Program variables cannot request credentials or other sensitive values.",
      );
    }
    result[field] = {
      ...entry,
      value: `{{${name}}}`,
    };
  }

  if (JSON.stringify(result).length > MAX_PROGRAM_CONFIG_SERIALIZED_LENGTH) {
    throw new DuoPlusTaskConfigValidationError(
      `Task config cannot exceed ${MAX_PROGRAM_CONFIG_SERIALIZED_LENGTH} serialized characters.`,
    );
  }
  return result;
}

/** Zod adapter for reusable program rules only. */
export const duoPlusProgramTaskConfigSchema = z.unknown().transform(
  (value, context) => {
    try {
      return sanitizeDuoPlusProgramTaskConfig(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof DuoPlusTaskConfigValidationError
            ? error.message
            : "Program task config is invalid.",
      });
      return z.NEVER;
    }
  },
);

/** Build a client-neutral program config from trusted template input roles. */
export function programTaskConfigForTemplateSchema(
  schema: DuoPlusTemplateConfigSchema,
): DuoPlusProgramTaskConfig {
  const config = Object.fromEntries(
    schema.inputs.map((input) => [
      input.key,
      {
        key: input.key,
        value: input.role === "operator"
          ? `{{${input.key}}}`
          : input.defaultValue,
        type: input.type,
        required: input.required,
      },
    ]),
  );
  return sanitizeDuoPlusProgramTaskConfig(config);
}

/**
 * Describe the client-specific inputs a reusable program asks for. Values are
 * exact placeholders rather than string interpolation so typed DuoPlus values
 * cannot be partially assembled or accidentally leak into definitions.
 */
export function extractProgramVariables(
  configs: Array<Record<string, unknown>>,
): ProgramVariableDefinition[] {
  const definitions = new Map<string, ProgramVariableDefinition>();

  for (const candidate of configs) {
    const config = sanitizeDuoPlusProgramTaskConfig(candidate);
    for (const [field, entry] of Object.entries(config)) {
      const name = placeholderName(entry);
      if (!name) continue;
      if (isSensitiveDuoPlusConfigKey(name)) {
        throw new ProgramConfigBindingError(
          "Program variables cannot request credentials or other sensitive values.",
        );
      }
      const existing = definitions.get(name);
      if (existing && existing.type !== entry.type) {
        throw new ProgramConfigBindingError(
          `Program variable ${name} is declared with conflicting input types.`,
        );
      }
      if (existing) {
        existing.required ||= entry.required;
        if (!existing.fields.includes(field)) existing.fields.push(field);
      } else {
        definitions.set(name, {
          name,
          type: entry.type,
          required: entry.required,
          fields: [field],
        });
      }
    }
  }

  return Array.from(definitions.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Resolve a reusable rule config into the immutable config snapshot for a cycle. */
export function resolveProgramTaskConfig(
  reusableConfig: Record<string, unknown>,
  cycleVariables: Record<string, unknown>,
): Record<string, DuoPlusTaskConfigEntry> {
  let config: DuoPlusProgramTaskConfig;
  let variables: Record<string, DuoPlusTaskConfigEntry>;
  try {
    config = sanitizeDuoPlusProgramTaskConfig(reusableConfig);
    variables = sanitizeDuoPlusTaskConfig(cycleVariables);
  } catch (error) {
    if (error instanceof DuoPlusTaskConfigValidationError) {
      throw new ProgramConfigBindingError(error.message);
    }
    throw error;
  }
  const resolved: Record<string, unknown> = Object.create(null);

  for (const [field, entry] of Object.entries(config)) {
    const variableName = placeholderName(entry);
    if (!variableName) {
      resolved[field] = entry;
      continue;
    }
    if (isSensitiveDuoPlusConfigKey(variableName)) {
      throw new ProgramConfigBindingError(
        "Program variables cannot request credentials or other sensitive values.",
      );
    }

    const binding = variables[variableName];
    if (!binding) {
      if (entry.required) {
        throw new ProgramConfigBindingError(
          `Program variable ${variableName} is required.`,
        );
      }
      continue;
    }
    if (placeholderName(binding)) {
      throw new ProgramConfigBindingError(
        `Program variable ${variableName} must contain a concrete value.`,
      );
    }
    if (binding.type !== entry.type) {
      throw new ProgramConfigBindingError(
        `Program variable ${variableName} must use the ${entry.type} input type.`,
      );
    }

    resolved[field] = {
      ...entry,
      value: binding.value,
    } as DuoPlusTaskConfigEntry;
  }

  try {
    return sanitizeDuoPlusTaskConfig(resolved);
  } catch (error) {
    if (error instanceof DuoPlusTaskConfigValidationError) {
      throw new ProgramConfigBindingError(error.message);
    }
    throw error;
  }
}
