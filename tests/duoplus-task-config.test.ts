import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { DuoPlusClient } from "@/lib/duoplus/client";
import {
  duoPlusTaskConfigSchema,
  sanitizeDuoPlusTaskConfig,
  taskConfigIssueMessage,
} from "@/lib/duoplus/task-config";
import { buildDuoPlusTaskConfig } from "@/lib/scheduler/worker";

describe("DuoPlus scheduled-task config", () => {
  it("builds every documented config type without coercing values", () => {
    const files = ["L1ZVt", "https://assets.example/image.png"];
    const excelRows = ["first@example.com", "second@example.com"];

    const result = buildDuoPlusTaskConfig("beaches near me", {
      title: "Lakeland",
      age: 18,
      enabled: true,
      copy: {
        key: "description",
        value: "line one\nline two",
        type: "textarea",
        required: true,
      },
      uploads: {
        key: "file",
        value: files,
        type: "file",
        required: true,
      },
      emailRows: {
        key: "email",
        value: excelRows,
        type: "excel",
        required: false,
      },
    });

    expect(result).toMatchObject({
      title: {
        key: "title",
        value: "Lakeland",
        type: "string",
        required: false,
      },
      age: { key: "age", value: 18, type: "number", required: false },
      enabled: {
        key: "enabled",
        value: true,
        type: "boolean",
        required: false,
      },
      copy: {
        key: "description",
        value: "line one\nline two",
        type: "textarea",
        required: true,
      },
      uploads: {
        key: "file",
        value: files,
        type: "file",
        required: true,
      },
      emailRows: {
        key: "email",
        value: excelRows,
        type: "excel",
        required: false,
      },
      keyword: {
        key: "keyword",
        value: "beaches near me",
        type: "string",
        required: true,
      },
    });

    expect(result.uploads.value).not.toBe(files);
    expect(result.emailRows.value).not.toBe(excelRows);
  });

  it("preserves documented string encodings and always owns the keyword field", () => {
    const result = buildDuoPlusTaskConfig("canonical keyword", {
      quantity: { type: "number", value: "18" },
      enabled: { type: "boolean", value: "true" },
      keyword: { type: "string", value: "wrong" },
    });

    expect(result.quantity).toEqual({
      key: "quantity",
      value: "18",
      type: "number",
      required: false,
    });
    expect(result.enabled).toEqual({
      key: "enabled",
      value: "true",
      type: "boolean",
      required: false,
    });
    expect(result.keyword).toEqual({
      key: "keyword",
      value: "canonical keyword",
      type: "string",
      required: true,
    });
  });

  it("fails closed on malformed, ambiguous, or credential-bearing entries", () => {
    const raw = JSON.parse(`{
      "__proto__": {"type":"string","value":"safe"},
      "stringAsNumber": {"type":"number","value":"18"},
      "numberAsBoolean": {"type":"boolean","value":1},
      "mixedFiles": {"type":"file","value":["good",5]},
      "ambiguousArray": ["one","two"],
      "infinite": 1e400,
      "unknown": {"type":"json","value":"ignored"}
    }`) as Record<string, unknown>;

    expect(() => buildDuoPlusTaskConfig("canonical keyword", raw)).toThrow(
      "Boolean task config values",
    );
    expect(() =>
      buildDuoPlusTaskConfig("canonical keyword", {
        email_password: { type: "excel", value: "do-not-store" },
      }),
    ).toThrow("cannot contain passwords");
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects sensitive keys recursively but accepts ordinary email data", () => {
    expect(
      sanitizeDuoPlusTaskConfig({
        keyword: "plumber near me",
        email: {
          key: "email",
          type: "excel",
          value: "first@example.com,second@example.com",
          required: true,
        },
      }),
    ).toMatchObject({
      keyword: {
        key: "keyword",
        type: "string",
        value: "plumber near me",
        required: false,
      },
      email: {
        key: "email",
        type: "excel",
        value: "first@example.com,second@example.com",
        required: true,
      },
    });

    for (const config of [
      { password: "value" },
      { apiKey: "value" },
      { email_token: "value" },
      { proxy_username: "value" },
      { field: { key: "proxy_password", type: "string", value: "value" } },
      { field: { type: "string", value: { nested_secret: "value" } } },
    ]) {
      expect(() => sanitizeDuoPlusTaskConfig(config)).toThrow(
        "cannot contain passwords, tokens, API keys",
      );
    }
  });

  it("rejects oversized and unsupported nested values at the shared schema", () => {
    expect(
      duoPlusTaskConfigSchema.safeParse({ copy: "x".repeat(50_001) }).success,
    ).toBe(false);
    expect(
      duoPlusTaskConfigSchema.safeParse({
        settings: { type: "string", value: { nested: "not supported" } },
      }).success,
    ).toBe(false);

    const requestResult = z.object({ config: duoPlusTaskConfigSchema }).safeParse({
      config: { api_key: "do-not-store" },
    });
    expect(requestResult.success).toBe(false);
    if (!requestResult.success) {
      expect(taskConfigIssueMessage(requestResult.error)).toContain(
        "cannot contain passwords, tokens, API keys",
      );
    }
  });

  it("posts addTask with a numeric template type and typed config", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return new Response(
          JSON.stringify({ code: 200, data: { message: "success" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const fetchImpl = fetchMock as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-1",
      fetchImpl,
      minGapMs: 0,
    });

    await client.addTask({
      template_id: "Olm2q",
      template_type: 1,
      name: "stk_run-1",
      images: [
        {
          image_id: "AIZ3k",
          issue_at: "2026-09-05 14:01",
          config: buildDuoPlusTaskConfig("beaches near me", {
            uploads: { type: "file", value: ["L1ZVt"] },
          }),
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe(
      "https://openapi.duoplus.net/api/v1/automation/addTask",
    );
    expect(body.template_type).toBe(1);
    expect(typeof body.template_type).toBe("number");
    expect(body).toMatchObject({
      images: [
        {
          config: {
            uploads: { key: "uploads", value: ["L1ZVt"], type: "file" },
          },
        },
      ],
    });
  });

  it("rejects non-numeric template types before any network call", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new DuoPlusClient({
      apiKey: "friend-key",
      connectionId: "connection-1",
      fetchImpl,
      minGapMs: 0,
    });

    expect(() =>
      client.addTask({
        template_id: "Olm2q",
        template_type: "1" as unknown as 1,
        name: "stk_run-1",
        images: [],
      }),
    ).toThrow("template type must be numeric 1 or 2");
    expect(() =>
      client.addTask({
        template_id: "Olm2q",
        template_type: 1,
        name: "stk_run-1",
        images: [
          {
            image_id: "AIZ3k",
            issue_at: "2026-09-05 14:01",
            config: {
              password: {
                key: "password",
                value: "do-not-send",
                type: "string",
                required: true,
              },
            },
          },
        ],
      }),
    ).toThrow("cannot contain passwords");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
