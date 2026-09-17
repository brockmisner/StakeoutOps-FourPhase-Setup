import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from "@/lib/crypto/aes-gcm";
import { createHmac } from "node:crypto";

export interface EncryptedDuoPlusApiKey {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function encryptionKey(override?: string): string {
  const key = override ?? process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured");
  }
  return key;
}

export function encryptDuoPlusApiKey(
  apiKey: string,
  keyOverride?: string,
): EncryptedDuoPlusApiKey {
  if (!apiKey.trim()) throw new Error("DuoPlus API key cannot be empty");
  const encrypted = encryptSecret(apiKey.trim(), encryptionKey(keyOverride));
  return {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
  };
}

export function decryptDuoPlusApiKey(
  encrypted: EncryptedDuoPlusApiKey,
  keyOverride?: string,
): string {
  const payload: EncryptedSecret = encrypted;
  return decryptSecret(payload, encryptionKey(keyOverride));
}

/**
 * Stable, non-reversible identity used only to share the physical Startup
 * ceiling when the same DuoPlus account is connected to multiple workspaces.
 */
export function duoPlusCapacityPoolFingerprint(
  apiKey: string,
  keyOverride?: string,
): string {
  if (!apiKey.trim()) throw new Error("DuoPlus API key cannot be empty");
  return createHmac("sha256", encryptionKey(keyOverride))
    .update("stakeout-duoplus-capacity-pool-v1\0")
    .update(apiKey.trim())
    .digest("hex");
}
