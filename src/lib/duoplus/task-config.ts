import { z } from "zod";

import type {
  DuoPlusConfigValueType,
  DuoPlusTaskConfigEntry,
} from "./types";

const MAX_CONFIG_FIELDS = 64;
const MAX_CONFIG_KEY_LENGTH = 128;
const MAX_CONFIG_STRING_LENGTH = 50_000;
const MAX_CONFIG_ARRAY_ITEMS = 100;
const MAX_CONFIG_ARRAY_ITEM_LENGTH = 4_096;
const MAX_CONFIG_SERIALIZED_LENGTH = 200_000;
const ENTRY_KEYS = new Set(["key", "value", "type", "required"]);

export class DuoPlusTaskConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuoPlusTaskConfigValidationError";
  }
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Credential-shaped field names are never safe to persist as task config. */
export function isSensitiveDuoPlusConfigKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (!normalized) return false;
  if (
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized === "pwd" ||
    normalized.endsWith("pwd") ||
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("cookie") ||
    normalized.includes("privatekey") ||
    normalized.includes("session") ||
    normalized.includes("secret") ||
    normalized.includes("credential")
  ) {
    return true;
  }
  return (
    normalized.includes("proxy") &&
    ["user", "username", "login", "pass", "pwd", "host", "port", "auth"].some(
      (part) => normalized.includes(part),
    )
  );
}

function configError(message: string): never {
  throw new DuoPlusTaskConfigValidationError(message);
}

function assertConfigKey(key: string): void {
  if (!key.trim() || key.length > MAX_CONFIG_KEY_LENGTH) {
    configError(`Task config keys must be 1-${MAX_CONFIG_KEY_LENGTH} characters.`);
  }
  if (isSensitiveDuoPlusConfigKey(key)) {
    configError(
      "Task config cannot contain passwords, tokens, API keys, access keys, cookies, sessions, private keys, secrets, authorization data, or proxy credentials.",
    );
  }
}

function assertNoNestedSensitiveKeys(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (!value || typeof value !== "object") return;
  if (depth > 4) {
    configError("Nested task config values are not supported.");
  }
  if (seen.has(value)) configError("Circular task config values are not supported.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoNestedSensitiveKeys(item, depth + 1, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveDuoPlusConfigKey(key)) {
      configError(
        "Task config cannot contain passwords, tokens, API keys, access keys, cookies, sessions, private keys, secrets, authorization data, or proxy credentials.",
      );
    }
    assertNoNestedSensitiveKeys(item, depth + 1, seen);
  }
}

function assertString(value: string, maximum = MAX_CONFIG_STRING_LENGTH): void {
  if (value.length > maximum) {
    configError(`Task config text cannot exceed ${maximum} characters.`);
  }
}

function copyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return configError("File and Excel task config values must be string arrays.");
  }
  if (value.length > MAX_CONFIG_ARRAY_ITEMS) {
    return configError(
      `Task config arrays cannot contain more than ${MAX_CONFIG_ARRAY_ITEMS} items.`,
    );
  }
  if (!value.every((item) => typeof item === "string")) {
    return configError("Task config arrays can contain strings only.");
  }
  for (const item of value) assertString(item, MAX_CONFIG_ARRAY_ITEM_LENGTH);
  return [...value] as string[];
}

function isNumericString(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Number(value));
}

function inferredType(value: unknown): DuoPlusConfigValueType | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}

function makeEntry(
  key: string,
  type: unknown,
  value: unknown,
  required: unknown,
): DuoPlusTaskConfigEntry {
  assertConfigKey(key);
  if (required !== undefined && typeof required !== "boolean") {
    return configError("Task config required flags must be boolean.");
  }
  const base = { key, required: required ?? false } as const;

  switch (type) {
    case "string":
    case "textarea":
      if (typeof value !== "string") {
        return configError(`${type} task config values must be strings.`);
      }
      assertString(value);
      return { ...base, value, type };
    case "number":
      if (
        !(
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && isNumericString(value))
        )
      ) {
        return configError(
          "Number task config values must be finite numbers or numeric strings.",
        );
      }
      if (typeof value === "string") assertString(value);
      return { ...base, value, type };
    case "boolean":
      if (
        typeof value !== "boolean" &&
        !(typeof value === "string" && (value === "true" || value === "false"))
      ) {
        return configError(
          'Boolean task config values must be booleans or the strings "true" and "false".',
        );
      }
      return { ...base, value, type };
    case "file": {
      const files = copyStringArray(value);
      return { ...base, value: files, type };
    }
    case "excel": {
      if (typeof value === "string") {
        assertString(value);
        return { ...base, value, type };
      }
      const rows = copyStringArray(value);
      return { ...base, value: rows, type };
    }
    default:
      return configError(
        "Task config types must be string, number, boolean, textarea, file, or excel.",
      );
  }
}

/**
 * Validate one top-level field and return a defensive, JSON-safe copy.
 * Primitive shorthand remains supported for existing schedules.
 */
export function sanitizeDuoPlusTaskConfigEntry(
  name: string,
  candidate: unknown,
): DuoPlusTaskConfigEntry {
  assertConfigKey(name);
  assertNoNestedSensitiveKeys(candidate);

  if (candidate === null || candidate === undefined) {
    return configError("Task config values cannot be null.");
  }
  if (typeof candidate !== "object") {
    const type = inferredType(candidate);
    if (!type) return configError("Task config values must be JSON primitives.");
    return makeEntry(name, type, candidate, false);
  }
  if (Array.isArray(candidate)) {
    return configError(
      "Array task config values require an explicit file or excel entry.",
    );
  }

  const entry = candidate as Record<string, unknown>;
  const fields = Object.keys(entry);
  if (fields.some((field) => !ENTRY_KEYS.has(field))) {
    return configError(
      "Task config entries may contain only key, value, type, and required.",
    );
  }
  if (!("value" in entry)) {
    return configError("Task config entries require a value.");
  }
  if (entry.key !== undefined && typeof entry.key !== "string") {
    return configError("Task config entry keys must be strings.");
  }
  const key = typeof entry.key === "string" && entry.key.trim()
    ? entry.key.trim()
    : name;
  const type = entry.type === undefined ? inferredType(entry.value) : entry.type;
  if (!type) {
    return configError(
      "Array values require an explicit file or excel task config type.",
    );
  }
  return makeEntry(key, type, entry.value, entry.required);
}

/**
 * Strict storage-boundary validator. It intentionally rejects credential
 * payloads instead of redacting them, because redacted data cannot run an RPA
 * task correctly and must never become durable schedule JSON.
 */
export function sanitizeDuoPlusTaskConfig(
  value: unknown,
): Record<string, DuoPlusTaskConfigEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return configError("Task config must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  const entries = Object.entries(source);
  if (entries.length > MAX_CONFIG_FIELDS) {
    return configError(
      `Task config cannot contain more than ${MAX_CONFIG_FIELDS} fields.`,
    );
  }

  const result = Object.create(null) as Record<string, DuoPlusTaskConfigEntry>;
  for (const [name, candidate] of entries) {
    result[name] = sanitizeDuoPlusTaskConfigEntry(name, candidate);
  }
  if (JSON.stringify(result).length > MAX_CONFIG_SERIALIZED_LENGTH) {
    return configError(
      `Task config cannot exceed ${MAX_CONFIG_SERIALIZED_LENGTH} serialized characters.`,
    );
  }
  return result;
}

/** Zod adapter shared by schedule and cycle-program request contracts. */
export const duoPlusTaskConfigSchema = z.unknown().transform((value, context) => {
  try {
    return sanitizeDuoPlusTaskConfig(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message:
        error instanceof DuoPlusTaskConfigValidationError
          ? error.message
          : "Task config is invalid.",
    });
    return z.NEVER;
  }
});

/** Extract a config-specific Zod issue without exposing submitted values. */
export function taskConfigIssueMessage(error: unknown): string | null {
  if (!(error instanceof z.ZodError)) return null;
  const issue = error.issues.find((candidate) =>
    candidate.path.some((part) => part === "config" || part === "variables"),
  );
  return issue?.message ?? null;
}
