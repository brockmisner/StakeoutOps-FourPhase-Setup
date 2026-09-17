import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

function encryptionKey(override?: string): Buffer {
  const raw = (override ?? process.env.INTEGRATION_ENCRYPTION_KEY)?.trim();
  if (!raw) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured.");
  }

  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }

  return key;
}

export function encryptSecret(
  plaintext: string,
  keyOverride?: string,
): EncryptedSecret {
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty secret.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(keyOverride), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(
  secret: EncryptedSecret,
  keyOverride?: string,
): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(keyOverride),
    Buffer.from(secret.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
