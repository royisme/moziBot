import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function decodeMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("Invalid master key. Expected base64-encoded 32-byte key.");
  }
  return key;
}

export function resolveMasterKey(envName: string): Buffer {
  const raw = process.env[envName];
  if (!raw || raw.trim().length === 0) {
    throw new Error(`Missing master key env: ${envName}`);
  }
  return decodeMasterKey(raw.trim());
}

export function encryptSecret(
  plaintext: string,
  masterKey: Buffer,
): {
  ciphertext: Buffer;
  nonce: Buffer;
} {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]),
    nonce,
  };
}

export function decryptSecret(ciphertextWithTag: Buffer, nonce: Buffer, masterKey: Buffer): string {
  if (ciphertextWithTag.length < TAG_LENGTH) {
    throw new Error("Corrupted ciphertext payload");
  }
  const encrypted = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_LENGTH);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}
