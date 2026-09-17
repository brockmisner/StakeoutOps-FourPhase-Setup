import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from "@/lib/crypto/aes-gcm";
import { redactDuoPlusValue } from "@/lib/duoplus/protocol";
import { duoPlusCapacityPoolFingerprint } from "@/lib/duoplus/credentials";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("DuoPlus credential encryption", () => {
  beforeEach(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });

  it("round-trips a key without storing plaintext", () => {
    const plaintext = "duoplus_test_key_very_secret";
    const encrypted = encryptSecret(plaintext);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(encrypted.iv).not.toContain(plaintext);
    expect(encrypted.authTag).not.toContain(plaintext);
    expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(encrypted.authTag, "base64")).toHaveLength(16);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("uses a fresh IV for every encryption", () => {
    const first = encryptSecret("same-key");
    const second = encryptSecret("same-key");

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("derives a stable opaque worker-pool identity without exposing the key", () => {
    const apiKey = "duoplus-shared-account-secret";
    const first = duoPlusCapacityPoolFingerprint(apiKey);
    const second = duoPlusCapacityPoolFingerprint(apiKey);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(apiKey);
    expect(duoPlusCapacityPoolFingerprint(`${apiKey}-other`)).not.toBe(first);
  });

  it("supports an explicit key without consulting process state", () => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;

    const encrypted = encryptSecret("friend-owned-key", TEST_KEY);
    expect(decryptSecret(encrypted, TEST_KEY)).toBe("friend-owned-key");
  });

  it("rejects a missing or incorrectly sized encryption key", () => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    expect(() => encryptSecret("secret")).toThrow(
      "INTEGRATION_ENCRYPTION_KEY is not configured",
    );

    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(31).toString("base64");
    expect(() => encryptSecret("secret")).toThrow("base64-encoded 32-byte key");
  });

  it("fails closed when authenticated ciphertext is changed", () => {
    const encrypted = encryptSecret("do-not-disclose");
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] ^= 1;
    const tampered: EncryptedSecret = {
      ...encrypted,
      ciphertext: bytes.toString("base64"),
    };

    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("DuoPlus log redaction", () => {
  it("redacts credential-shaped fields recursively, including HTTP headers", () => {
    const input = {
      request: {
        headers: {
          "DuoPlus-API-Key": "never-log-this",
          Authorization: "Bearer never-log-this-either",
          Lang: "en",
        },
        password: "private",
      },
      response: [{ auth_tag: "private" }, { iv: "private" }],
      camelCase: {
        apiKey: "private",
        adbPassword: "private",
        accessToken: "private",
        authTag: "private",
      },
    };

    expect(redactDuoPlusValue(input)).toEqual({
      request: {
        headers: {
          "DuoPlus-API-Key": "[REDACTED]",
          Authorization: "[REDACTED]",
          Lang: "en",
        },
        password: "[REDACTED]",
      },
      response: [{ auth_tag: "[REDACTED]" }, { iv: "[REDACTED]" }],
      camelCase: {
        apiKey: "[REDACTED]",
        adbPassword: "[REDACTED]",
        accessToken: "[REDACTED]",
        authTag: "[REDACTED]",
      },
    });
  });

  it("does not mutate the source value and terminates on cycles", () => {
    const source: Record<string, unknown> = { token: "secret" };
    source.self = source;

    const redacted = redactDuoPlusValue(source) as Record<string, unknown>;
    expect(source.token).toBe("secret");
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.self).toBe("[Circular]");
  });
});
