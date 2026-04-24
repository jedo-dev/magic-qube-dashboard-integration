import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";
import { logger } from "../config/logger";

const ENCRYPTED_PREFIX = "enc:v1:";
const PLAIN_PREFIX = "plain:v1:";

const getKey = (): Buffer | null => {
  if (!env.credentialsEncryptionKey) {
    return null;
  }
  return createHash("sha256").update(env.credentialsEncryptionKey).digest();
};

export const serializeCredentials = (input: unknown): string => {
  const raw = Buffer.from(JSON.stringify(input), "utf8");
  const key = getKey();

  if (!key) {
    logger.warn("CREDENTIALS_ENCRYPTION_KEY is empty, credentials are not encrypted at rest");
    return `${PLAIN_PREFIX}${raw.toString("base64url")}`;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64url");
  return `${ENCRYPTED_PREFIX}${payload}`;
};

export const deserializeCredentials = <T>(serialized: string): T => {
  if (serialized.startsWith(PLAIN_PREFIX)) {
    const data = serialized.slice(PLAIN_PREFIX.length);
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
  }

  if (!serialized.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error("Unsupported credentials format");
  }

  const key = getKey();
  if (!key) {
    throw new Error("Encrypted credentials found but CREDENTIALS_ENCRYPTION_KEY is empty");
  }

  const payload = Buffer.from(serialized.slice(ENCRYPTED_PREFIX.length), "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
};
