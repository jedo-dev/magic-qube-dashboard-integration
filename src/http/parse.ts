import { IntegrationType, ImapCredentials } from "../types/integration";

const allowedTypes: IntegrationType[] = ["yandex_imap", "mailru_imap"];

export class BadRequestError extends Error {}

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`Field "${field}" must be non-empty string`);
  }
  return value.trim();
};

const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new BadRequestError(`Field "${field}" must be string`);
  }
  return value;
};

const asOptionalNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new BadRequestError(`Field "${field}" must be positive number`);
  }
  return value;
};

const asOptionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new BadRequestError(`Field "${field}" must be boolean`);
  }
  return value;
};

export const parseIntegrationType = (value: unknown): IntegrationType => {
  if (typeof value !== "string" || !allowedTypes.includes(value as IntegrationType)) {
    throw new BadRequestError(`Field "type" must be one of: ${allowedTypes.join(", ")}`);
  }
  return value as IntegrationType;
};

export const parseCredentials = (value: unknown): ImapCredentials => {
  if (!value || typeof value !== "object") {
    throw new BadRequestError('Field "credentials" must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    login: asString(obj.login, "credentials.login"),
    appPassword: asString(obj.appPassword, "credentials.appPassword"),
    host: asOptionalString(obj.host, "credentials.host"),
    port: asOptionalNumber(obj.port, "credentials.port"),
    secure: asOptionalBoolean(obj.secure, "credentials.secure")
  };
};

export const parseCreateIntegrationBody = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Body must be an object");
  }
  const b = body as Record<string, unknown>;
  return {
    type: parseIntegrationType(b.type),
    enabled: asOptionalBoolean(b.enabled, "enabled"),
    credentials: parseCredentials(b.credentials),
    pollIntervalSec: asOptionalNumber(b.pollIntervalSec, "pollIntervalSec"),
    label: asString(b.label, "label"),
    color: asOptionalString(b.color, "color"),
    sortOrder: asOptionalNumber(b.sortOrder, "sortOrder")
  };
};

export const parsePatchIntegrationBody = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Body must be an object");
  }
  const b = body as Record<string, unknown>;
  return {
    enabled: asOptionalBoolean(b.enabled, "enabled"),
    credentials: b.credentials === undefined ? undefined : parseCredentials(b.credentials),
    pollIntervalSec: asOptionalNumber(b.pollIntervalSec, "pollIntervalSec"),
    label: asOptionalString(b.label, "label"),
    color: asOptionalString(b.color, "color"),
    sortOrder: asOptionalNumber(b.sortOrder, "sortOrder")
  };
};
