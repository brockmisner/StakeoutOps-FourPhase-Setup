import type { JsonValue } from "@/lib/duoplus";
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_NUMBER =
  /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/g;
const AUTH_VALUE =
  /(\b(?:authorization|password|passwd|pwd|api[_-]?key|secret|token)\b\s*[=:]\s*["']?)[^\s,"'}<]+/gi;
const UI_DUMP_MAX_CHARS = 20_000;

interface StoredUiDumpEvidence {
  format: "android_ui_hierarchy";
  xml: string | null;
  truncated: boolean;
  originalLength: number;
  detail?: string;
}

function redactSensitiveInputNodes(value: string): string {
  return value.replace(/<node\b[^>]*>/gi, (node) => {
    const isPassword = /\bpassword="true"/i.test(node);
    const isEditable = /\bclass="[^"]*(?:EditText|TextInput)[^"]*"/i.test(node);
    if (!isPassword && !isEditable) return node;
    return node.replace(
      /\b(text|content-desc)="[^"]*"/gi,
      '$1="[REDACTED_INPUT]"',
    );
  });
}

function redactUiText(value: string): string {
  return redactSensitiveInputNodes(value)
    .replace(EMAIL_ADDRESS, "[REDACTED_EMAIL]")
    .replace(PHONE_NUMBER, "[REDACTED_PHONE]")
    .replace(AUTH_VALUE, "$1[REDACTED]");
}

function findHierarchyXml(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (typeof value === "string") {
    return /<(?:\?xml|hierarchy|node)\b/i.test(value) ? value : null;
  }
  if (!value || typeof value !== "object" || depth >= 5 || seen.has(value)) {
    return null;
  }
  seen.add(value);
  const values = Array.isArray(value)
    ? value.slice(0, 20)
    : Object.values(value as Record<string, unknown>).slice(0, 40);
  for (const candidate of values) {
    const xml = findHierarchyXml(candidate, depth + 1, seen);
    if (xml) return xml;
  }
  return null;
}

/**
 * Preserve selector-bearing XML while bounding database growth and removing
 * obvious credentials/profile email addresses. This evidence is diagnostic;
 * it is never an activity or scoring signal.
 */
export function summarizeUiDumpEvidence(value: unknown): JsonValue {
  const xml = findHierarchyXml(value);
  if (!xml) {
    return {
      format: "android_ui_hierarchy",
      xml: null,
      truncated: false,
      originalLength: 0,
      detail: "DuoPlus command returned no XML hierarchy",
    } satisfies StoredUiDumpEvidence;
  }
  const safeXml = redactUiText(xml);
  return {
    format: "android_ui_hierarchy",
    xml: safeXml.slice(0, UI_DUMP_MAX_CHARS),
    truncated: safeXml.length > UI_DUMP_MAX_CHARS,
    originalLength: safeXml.length,
  } satisfies StoredUiDumpEvidence;
}
