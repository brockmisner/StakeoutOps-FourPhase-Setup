import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isSchedulablePhone } from "@/lib/duoplus/phone-eligibility";
import {
  bundledTemplateSchemaForName,
  defaultTaskConfigForSchema,
  extractDuoPlusTemplateConfigSchema,
  normalizeDuoPlusTemplateName,
} from "@/lib/duoplus/template-schema";
import { buildDuoPlusTaskConfig } from "@/lib/scheduler/worker";

describe("DuoPlus template input discovery", () => {
  it("uses only root config as operator input and classifies saved node variables as internal", () => {
    const schema = extractDuoPlusTemplateConfigSchema({
      config: [
        { key: "search_term", value: "plumber near me", type: "string", required: true, desc: "Search query" },
        { key: "more_button_text", value: "More businesses", type: "string", required: true, desc: "Finder button marker" },
      ],
      nodes: [
        { data: { value: "${search_term}", save_result: "gbp_visible" } },
        { data: { value: "${gbp_visible}" } },
      ],
    }, "Chrome Local.json");

    expect(schema.inputs.map((input) => input.key)).toEqual([
      "search_term",
      "more_button_text",
    ]);
    expect(schema.inputs.map((input) => input.role)).toEqual([
      "operator",
      "constant",
    ]);
    expect(schema.inputs[0]?.defaultValue).toBe("");
    expect(schema.inputs[1]?.defaultValue).toBe("More businesses");
    expect(schema.internalVariables).toEqual(["gbp_visible"]);
    expect(schema.unresolvedVariables).toEqual([]);
  });

  it("matches download-copy filenames to the bundled template definitions", () => {
    expect(normalizeDuoPlusTemplateName("$ Chrome AIO + Local Pack GBP Click (1).json"))
      .toBe(normalizeDuoPlusTemplateName("$ Chrome AIO + Local Pack GBP Click"));
    expect(bundledTemplateSchemaForName("$ Chrome AIO + Local Pack GBP Click (1)"))
      .toMatchObject({ schemaVersion: 1, source: "bundled-export" });
  });

  it("prefills safe selector defaults but leaves client-specific required values blank", () => {
    const schema = bundledTemplateSchemaForName("$ Chrome AIO + Local Pack GBP Click");
    expect(schema).not.toBeNull();
    const defaults = defaultTaskConfigForSchema(schema!);
    expect(defaults).toHaveProperty("ai_overview_text.value", "AI Overview");
    expect(defaults).toHaveProperty("finder_terminal_text.value", "More search results");
    expect(defaults).not.toHaveProperty("search_term");
    expect(defaults).not.toHaveProperty("business_name");
  });

  it("sends exact known-template variables without adding the legacy keyword field", () => {
    const config = buildDuoPlusTaskConfig("dashboard label", {
      search_term: { key: "search_term", value: "plumber near me", type: "string", required: true },
      business_name: { key: "business_name", value: "Acme Plumbing", type: "string", required: true },
    }, { name: "$ Chrome AIO + Local Pack GBP Click" });

    expect(config).not.toHaveProperty("keyword");
    expect(config).toHaveProperty("search_term.value", "plumber near me");
    expect(config).toHaveProperty("business_name.value", "Acme Plumbing");
    expect(config).toHaveProperty("ai_overview_text.value", "AI Overview");
    expect(config).toHaveProperty("finder_terminal_text.value", "More search results");
  });

  it("sends an empty config for a verified no-input template", () => {
    expect(buildDuoPlusTaskConfig("dashboard label", {}, {
      name: "$ Google app; Semi-Daily DISCOVERY FEED",
    })).toEqual({});
  });

  it("blocks known templates with missing required operator input", () => {
    expect(() => buildDuoPlusTaskConfig("dashboard label", {}, {
      name: "$ Maps App Daily Actions Reviews + SAVE",
    })).toThrow("Missing required template inputs: search_terms");
  });
});

describe("scheduler phone eligibility", () => {
  const now = new Date("2026-09-06T12:00:00.000Z").getTime();

  it.each([
    [{ enabled: true, status: 3, expiredAt: null }, false],
    [{ enabled: true, status: 4, expiredAt: null }, false],
    [{ enabled: true, status: 2, expiredAt: "2026-09-05T12:00:00.000Z" }, false],
    [{ enabled: true, status: 2, expiredAt: "2026-09-07T12:00:00.000Z" }, true],
    [{ enabled: false, status: 1, expiredAt: null }, false],
  ])("returns %s for provider eligibility", (phone, expected) => {
    expect(isSchedulablePhone(phone, now)).toBe(expected);
  });
});
