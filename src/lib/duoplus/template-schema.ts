import { isSensitiveDuoPlusConfigKey } from "./task-config";
import type { DuoPlusConfigValueType, DuoPlusTaskConfigEntry } from "./types";

export type DuoPlusTemplateInputRole = "operator" | "constant";

export type DuoPlusTemplateInput = {
  key: string;
  label: string;
  type: DuoPlusConfigValueType;
  required: boolean;
  description: string;
  defaultValue: string | number | boolean | string[];
  role: DuoPlusTemplateInputRole;
  usedByTemplate: boolean;
};

export type DuoPlusTemplateConfigSchema = {
  schemaVersion: 1;
  source: "duoplus-export" | "bundled-export";
  sourceName: string;
  inputs: DuoPlusTemplateInput[];
  internalVariables: string[];
  unresolvedVariables: string[];
};

const SUPPORTED_TYPES = new Set<DuoPlusConfigValueType>([
  "string",
  "textarea",
  "number",
  "boolean",
  "file",
  "excel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleCaseKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeDuoPlusTemplateName(value: string): string {
  return value
    .replace(/\.json$/i, "")
    .replace(/\s*\(\d+\)\s*$/i, "")
    .replace(/^\s*\$\s*/, "")
    .replace(/&amp;/gi, "and")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function collectTemplateVariables(value: unknown): {
  placeholders: Set<string>;
  savedResults: Set<string>;
} {
  const placeholders = new Set<string>();
  const savedResults = new Set<string>();
  const seen = new WeakSet<object>();

  function visit(candidate: unknown): void {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\$\{([^}]+)\}/g)) {
        const name = match[1]?.trim();
        if (name) placeholders.add(name);
      }
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "save_result" && typeof item === "string" && item.trim()) {
        savedResults.add(item.trim());
      }
      visit(item);
    }
  }

  visit(value);
  return { placeholders, savedResults };
}

function inferRole(key: string, description: string): DuoPlusTemplateInputRole {
  const text = `${key} ${description}`.toLowerCase();
  if (
    key.endsWith("_text") &&
    /(marker|button|control|terminal|state|label|finder|overview)/.test(text)
  ) {
    return "constant";
  }
  return "operator";
}

function normalizeInput(
  candidate: unknown,
  usedByTemplate: boolean,
): DuoPlusTemplateInput | null {
  if (!isRecord(candidate)) return null;
  const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
  if (!key || key.length > 128 || isSensitiveDuoPlusConfigKey(key)) return null;
  const type = candidate.type;
  if (typeof type !== "string" || !SUPPORTED_TYPES.has(type as DuoPlusConfigValueType)) {
    return null;
  }
  const required = candidate.required === true;
  const description = typeof candidate.desc === "string"
    ? candidate.desc.trim().slice(0, 500)
    : typeof candidate.description === "string"
      ? candidate.description.trim().slice(0, 500)
      : "";
  let defaultValue: DuoPlusTemplateInput["defaultValue"];
  if (type === "file") {
    defaultValue = Array.isArray(candidate.value)
      ? candidate.value.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
  } else if (type === "number") {
    defaultValue = typeof candidate.value === "number" || typeof candidate.value === "string"
      ? candidate.value
      : "";
  } else if (type === "boolean") {
    defaultValue = candidate.value === true || candidate.value === "true";
  } else if (type === "excel" && Array.isArray(candidate.value)) {
    defaultValue = candidate.value.filter((item): item is string => typeof item === "string").slice(0, 100);
  } else {
    defaultValue = typeof candidate.value === "string" ? candidate.value.slice(0, 50_000) : "";
  }
  const role = inferRole(key, description);
  // RPA exports often contain the last client's live values. Keep stable UI
  // selector constants, but never turn required operator data (emails,
  // keywords, business names, etc.) into catalog defaults or placeholders.
  if (role === "operator" && required && type !== "boolean") {
    defaultValue = type === "file" || type === "excel" ? [] : "";
  }
  return {
    key,
    label: titleCaseKey(key),
    type: type as DuoPlusConfigValueType,
    required,
    description,
    defaultValue,
    role,
    usedByTemplate,
  };
}

export function extractDuoPlusTemplateConfigSchema(
  definition: unknown,
  sourceName: string,
  source: DuoPlusTemplateConfigSchema["source"] = "duoplus-export",
): DuoPlusTemplateConfigSchema {
  if (!isRecord(definition) || !Array.isArray(definition.config)) {
    throw new Error("This file is not a DuoPlus RPA export with a root config array.");
  }
  const { placeholders, savedResults } = collectTemplateVariables(definition);
  const inputs = definition.config
    .map((candidate) => {
      const key = isRecord(candidate) && typeof candidate.key === "string"
        ? candidate.key.trim()
        : "";
      return normalizeInput(candidate, placeholders.has(key));
    })
    .filter((input): input is DuoPlusTemplateInput => input !== null);
  if (inputs.length !== definition.config.length) {
    throw new Error("One or more template inputs are invalid or contain a sensitive field name.");
  }
  const configured = new Set(inputs.map((input) => input.key));
  const internalVariables = [...placeholders]
    .filter((name) => !configured.has(name) && savedResults.has(name))
    .sort();
  const unresolvedVariables = [...placeholders]
    .filter((name) => !configured.has(name) && !savedResults.has(name))
    .sort();
  return {
    schemaVersion: 1,
    source,
    sourceName: sourceName.slice(0, 240),
    inputs,
    internalVariables,
    unresolvedVariables,
  };
}

export function isDuoPlusTemplateConfigSchema(
  value: unknown,
): value is DuoPlusTemplateConfigSchema {
  try {
    sanitizeDuoPlusTemplateConfigSchema(value);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeDuoPlusTemplateConfigSchema(
  value: unknown,
): DuoPlusTemplateConfigSchema {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.source !== "duoplus-export" && value.source !== "bundled-export") ||
    typeof value.sourceName !== "string" ||
    !value.sourceName.trim() ||
    !Array.isArray(value.inputs) ||
    value.inputs.length > 64 ||
    !Array.isArray(value.internalVariables) ||
    !Array.isArray(value.unresolvedVariables)
  ) {
    throw new Error("Template input schema is invalid.");
  }
  const seen = new Set<string>();
  const inputs = value.inputs.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Template input schema is invalid.");
    const normalized = normalizeInput({
      ...candidate,
      value: candidate.defaultValue,
      desc: candidate.description,
    }, candidate.usedByTemplate !== false);
    if (
      !normalized ||
      (candidate.role !== "operator" && candidate.role !== "constant") ||
      seen.has(normalized.key)
    ) {
      throw new Error("Template input schema contains an invalid or duplicate input.");
    }
    seen.add(normalized.key);
    return {
      ...normalized,
      label: typeof candidate.label === "string" && candidate.label.trim()
        ? candidate.label.trim().slice(0, 160)
        : normalized.label,
      role: candidate.role as DuoPlusTemplateInputRole,
    };
  });
  function variableList(candidate: unknown[]): string[] {
    if (!candidate.every((item) => typeof item === "string" && item.length <= 128)) {
      throw new Error("Template variable metadata is invalid.");
    }
    return [...new Set(candidate as string[])].slice(0, 128).sort();
  }
  return {
    schemaVersion: 1,
    source: value.source,
    sourceName: value.sourceName.trim().slice(0, 240),
    inputs,
    internalVariables: variableList(value.internalVariables),
    unresolvedVariables: variableList(value.unresolvedVariables),
  };
}

export function defaultTaskConfigForSchema(
  schema: DuoPlusTemplateConfigSchema,
): Record<string, DuoPlusTaskConfigEntry> {
  const result: Record<string, DuoPlusTaskConfigEntry> = {};
  for (const input of schema.inputs) {
    const shouldInclude = input.role === "constant" || input.type === "boolean" ||
      (!input.required && input.defaultValue !== "");
    if (!shouldInclude) continue;
    result[input.key] = {
      key: input.key,
      value: input.defaultValue,
      type: input.type,
      required: input.required,
    } as DuoPlusTaskConfigEntry;
  }
  return result;
}

function bundledSchema(
  name: string,
  config: Array<Record<string, unknown>>,
  used: string[],
  internal: string[] = [],
): DuoPlusTemplateConfigSchema {
  const placeholders = new Set(used);
  const inputs = config.map((candidate) => normalizeInput(
    candidate,
    placeholders.has(String(candidate.key ?? "")),
  ));
  if (inputs.some((input) => input === null)) {
    throw new Error(`Bundled DuoPlus template schema is invalid: ${name}`);
  }
  return {
    schemaVersion: 1,
    source: "bundled-export",
    sourceName: name,
    inputs: inputs as DuoPlusTemplateInput[],
    internalVariables: internal,
    unresolvedVariables: [],
  };
}

const BUNDLED_SCHEMAS: DuoPlusTemplateConfigSchema[] = [
  bundledSchema("$ Chrome AIO + Local Pack GBP Click", [
    { key: "search_term", value: "", type: "string", required: true, desc: "Keyword/query to search in Chrome" },
    { key: "business_name", value: "", type: "string", required: true, desc: "Exact GBP/business title text" },
    { key: "ai_overview_text", value: "AI Overview", type: "string", required: true, desc: "User-supplied AIO local-pack state marker" },
    { key: "ai_show_more_text", value: "Show more AI Overview", type: "string", required: true, desc: "User-supplied AIO expansion button text" },
    { key: "more_businesses_text", value: "More businesses", type: "string", required: true, desc: "Classic local-pack expansion control" },
    { key: "finder_terminal_text", value: "More search results", type: "string", required: true, desc: "Optional Local Finder terminal marker" },
  ], ["search_term", "business_name", "ai_overview_text", "ai_show_more_text", "more_businesses_text"]),
  bundledSchema("$ Gmail_ Open Unread_Read Emails", [
    { key: "email_send_to", value: "", type: "textarea", required: true, desc: "One recipient per line; optional compose branch uses random_pick." },
    { key: "compose_subject", value: "", type: "textarea", required: true, desc: "Compose subject choices; one line is selected randomly." },
    { key: "email_body", value: "", type: "string", required: true, desc: "Compose message body." },
  ], ["email_send_to", "compose_subject", "email_body"]),
  bundledSchema("$ Maps App Daily Actions Reviews + SAVE", [
    { key: "search_terms", value: "", type: "textarea", required: true, desc: "One Maps search phrase per line; the template selects one for each run." },
  ], ["search_terms"]),
  bundledSchema("$ Google app; Semi-Daily DISCOVERY FEED", [], []),
  bundledSchema("$Chrome app_ 2nd CONVERSION", [
    { key: "competition_gbp", value: "", type: "string", required: true, desc: "Competitor business name." },
    { key: "search_term", value: "", type: "textarea", required: true, desc: "Discovery keywords, one per line; the template selects one per run." },
    { key: "listing_text", value: "", type: "string", required: true, desc: "Target business listing text." },
  ], ["competition_gbp", "search_term", "listing_text"], ["competitor_name", "gbp_vis"]),
  bundledSchema("$ Maps App_ Daily - Brand Save Fav List", [
    { key: "business_name", value: "", type: "string", required: true, desc: "Business to search and save in Google Maps." },
    { key: "save_list", value: "Favorites", type: "string", required: false, desc: "List name: Favorites, Want to go, Starred, or a custom list." },
  ], ["business_name"]),
];

const BUNDLED_BY_NAME = new Map(
  BUNDLED_SCHEMAS.map((schema) => [normalizeDuoPlusTemplateName(schema.sourceName), schema]),
);

export function bundledTemplateSchemaForName(
  name: string,
): DuoPlusTemplateConfigSchema | null {
  return BUNDLED_BY_NAME.get(normalizeDuoPlusTemplateName(name)) ?? null;
}

export function resolvedTemplateConfigSchema(
  name: string,
  storedSchema: unknown,
): DuoPlusTemplateConfigSchema | null {
  return isDuoPlusTemplateConfigSchema(storedSchema)
    ? storedSchema
    : bundledTemplateSchemaForName(name);
}
