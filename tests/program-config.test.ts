import { describe, expect, it } from "vitest";

import {
  duoPlusProgramTaskConfigSchema,
  extractProgramVariables,
  programTaskConfigForTemplateSchema,
  resolveProgramTaskConfig,
  sanitizeDuoPlusProgramTaskConfig,
} from "@/lib/scheduler/program-config";
import { sanitizeDuoPlusTaskConfig } from "@/lib/duoplus/task-config";
import type { DuoPlusTemplateConfigSchema } from "@/lib/duoplus/template-schema";

describe("reusable cycle program configuration", () => {
  it("generates exact operator placeholders for every type and keeps safe constants concrete", () => {
    const schema: DuoPlusTemplateConfigSchema = {
      schemaVersion: 1,
      source: "duoplus-export",
      sourceName: "All input types",
      internalVariables: [],
      unresolvedVariables: [],
      inputs: [
        { key: "business_name", label: "Business", type: "string", required: true, description: "", defaultValue: "", role: "operator", usedByTemplate: true },
        { key: "visit_count", label: "Count", type: "number", required: true, description: "", defaultValue: 2, role: "operator", usedByTemplate: true },
        { key: "open_result", label: "Open", type: "boolean", required: false, description: "", defaultValue: true, role: "operator", usedByTemplate: true },
        { key: "attachments", label: "Files", type: "file", required: false, description: "", defaultValue: [], role: "operator", usedByTemplate: true },
        { key: "rows", label: "Rows", type: "excel", required: true, description: "", defaultValue: [], role: "operator", usedByTemplate: true },
        { key: "button_text", label: "Button", type: "string", required: true, description: "", defaultValue: "Show more", role: "constant", usedByTemplate: true },
      ],
    };

    const config = programTaskConfigForTemplateSchema(schema);

    expect(Object.fromEntries(Object.entries(config).map(([key, entry]) => [key, entry.value])))
      .toEqual({
        business_name: "{{business_name}}",
        visit_count: "{{visit_count}}",
        open_result: "{{open_result}}",
        attachments: "{{attachments}}",
        rows: "{{rows}}",
        button_text: "Show more",
      });
    expect(extractProgramVariables([config]).map(({ name, type }) => ({ name, type })))
      .toEqual([
        { name: "attachments", type: "file" },
        { name: "business_name", type: "string" },
        { name: "open_result", type: "boolean" },
        { name: "rows", type: "excel" },
        { name: "visit_count", type: "number" },
      ]);
  });

  it("keeps program placeholders isolated from concrete schedule validation", () => {
    const programConfig = {
      count: { key: "count", type: "number", value: "{{visit_count}}", required: true },
      enabled: { key: "enabled", type: "boolean", value: "{{open_result}}", required: true },
      files: { key: "files", type: "file", value: "{{attachments}}", required: true },
    };

    expect(() => sanitizeDuoPlusProgramTaskConfig(programConfig)).not.toThrow();
    expect(duoPlusProgramTaskConfigSchema.safeParse(programConfig).success).toBe(true);
    expect(() => sanitizeDuoPlusTaskConfig(programConfig)).toThrow();
    expect(() => sanitizeDuoPlusProgramTaskConfig({
      query: { type: "string", value: "prefix {{keyword}}", required: true },
    })).toThrow("entire config value");
  });

  it("extracts and deduplicates client variables without storing their values", () => {
    const variables = extractProgramVariables([
      {
        business: { key: "business", type: "string", value: "{{business_name}}", required: true },
      },
      {
        brand: { key: "brand", type: "string", value: "{{business_name}}", required: false },
        email: { key: "email", type: "excel", value: "{{contact_emails}}", required: true },
      },
    ]);

    expect(variables).toEqual([
      { name: "business_name", type: "string", required: true, fields: ["business", "brand"] },
      { name: "contact_emails", type: "excel", required: true, fields: ["email"] },
    ]);
  });

  it("resolves exact placeholders into a cycle-specific immutable snapshot", () => {
    const resolved = resolveProgramTaskConfig(
      {
        business: { key: "business_name", type: "string", value: "{{business_name}}", required: true },
        email: { key: "email", type: "excel", value: "{{contact_emails}}", required: true },
        count: { key: "count", type: "number", value: 3, required: false },
      },
      {
        business_name: { type: "string", value: "Example Dental" },
        contact_emails: { type: "excel", value: "test@example.com" },
      },
    );

    expect(resolved.business).toMatchObject({ key: "business_name", value: "Example Dental" });
    expect(resolved.email).toMatchObject({ key: "email", value: "test@example.com" });
    expect(resolved.count.value).toBe(3);
  });

  it("resolves number, boolean, file, and Excel placeholders to concrete values", () => {
    const resolved = resolveProgramTaskConfig(
      {
        count: { type: "number", value: "{{visit_count}}", required: true },
        enabled: { type: "boolean", value: "{{open_result}}", required: true },
        files: { type: "file", value: "{{attachments}}", required: true },
        rows: { type: "excel", value: "{{spreadsheet_rows}}", required: true },
      },
      {
        visit_count: { type: "number", value: 4 },
        open_result: { type: "boolean", value: false },
        attachments: { type: "file", value: ["asset-a"] },
        spreadsheet_rows: { type: "excel", value: ["one,two"] },
      },
    );

    expect(resolved).toMatchObject({
      count: { type: "number", value: 4 },
      enabled: { type: "boolean", value: false },
      files: { type: "file", value: ["asset-a"] },
      rows: { type: "excel", value: ["one,two"] },
    });
  });

  it("fails closed for missing, type-conflicting, sensitive, or nested placeholders", () => {
    const config = {
      business: { type: "string", value: "{{business_name}}", required: true },
    };
    expect(() => resolveProgramTaskConfig(config, {})).toThrow("business_name is required");
    expect(() => resolveProgramTaskConfig(config, { business_name: { type: "number", value: 4 } })).toThrow("string input type");
    expect(() => resolveProgramTaskConfig(config, { business_name: "{{another_value}}" })).toThrow("concrete value");
    expect(() => resolveProgramTaskConfig(config, { api_key: "never persist" })).toThrow("cannot contain passwords");
  });

  it.each([
    "AWS_Access-Key",
    "browser.cookie",
    "private-key-pem",
    "Session_ID",
  ])("rejects redaction-aligned credential key %s", (key) => {
    expect(() => sanitizeDuoPlusTaskConfig({ [key]: "never persist" }))
      .toThrow("cannot contain passwords");
  });

  it("omits an unbound optional placeholder", () => {
    expect(resolveProgramTaskConfig({ note: { type: "string", value: "{{note}}" } }, {})).toEqual({});
  });
});
