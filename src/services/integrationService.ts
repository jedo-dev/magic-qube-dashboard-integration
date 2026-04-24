import { AdapterFactory } from "../adapters/factory";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { Integration, IntegrationDocument } from "../models/integration";
import { ImapCredentials, IntegrationType } from "../types/integration";
import { deserializeCredentials, serializeCredentials } from "../utils/crypto";

const IMAP_RETRY_DELAYS_MS = [2000, 5000, 15000];

export interface IntegrationRunResult {
  integrationId: string;
  success: boolean;
}

export interface CreateIntegrationInput {
  type: IntegrationType;
  enabled?: boolean;
  credentials: ImapCredentials;
  pollIntervalSec?: number;
  label: string;
  color?: string;
  sortOrder?: number;
}

export interface UpdateIntegrationInput {
  enabled?: boolean;
  credentials?: ImapCredentials;
  pollIntervalSec?: number;
  label?: string;
  color?: string;
  sortOrder?: number;
}

export class IntegrationService {
  constructor(private readonly adapterFactory: AdapterFactory) {}

  async list() {
    return Integration.find().sort({ sortOrder: 1, createdAt: 1 });
  }

  async listDue(now: Date, limit: number) {
    return Integration.find({
      enabled: true,
      nextRunAt: { $lte: now }
    })
      .sort({ nextRunAt: 1, sortOrder: 1, createdAt: 1 })
      .limit(limit);
  }

  async create(input: CreateIntegrationInput) {
    const now = new Date();
    const doc = await Integration.create({
      type: input.type,
      enabled: input.enabled ?? true,
      credentialsEnc: serializeCredentials(input.credentials),
      pollIntervalSec: input.pollIntervalSec ?? env.defaultPollIntervalSec,
      label: input.label,
      color: input.color ?? "#ffcc00",
      sortOrder: input.sortOrder ?? 100,
      nextRunAt: now
    });
    return doc;
  }

  async update(id: string, input: UpdateIntegrationInput) {
    const updateData: Record<string, unknown> = {};
    if (typeof input.enabled === "boolean") {
      updateData.enabled = input.enabled;
      if (input.enabled) {
        updateData.nextRunAt = new Date();
      }
    }
    if (input.credentials) {
      updateData.credentialsEnc = serializeCredentials(input.credentials);
    }
    if (typeof input.pollIntervalSec === "number") {
      updateData.pollIntervalSec = input.pollIntervalSec;
    }
    if (typeof input.label === "string") {
      updateData.label = input.label;
    }
    if (typeof input.color === "string") {
      updateData.color = input.color;
    }
    if (typeof input.sortOrder === "number") {
      updateData.sortOrder = input.sortOrder;
    }

    return Integration.findByIdAndUpdate(id, updateData, { new: true });
  }

  async runSingleIntegration(id: string): Promise<IntegrationRunResult> {
    const integration = await Integration.findById(id);
    if (!integration || !integration.enabled) {
      return { integrationId: id, success: false };
    }

    return this.runIntegrationDocument(integration);
  }

  async runAllEnabled(): Promise<IntegrationRunResult[]> {
    const integrations = await Integration.find({ enabled: true }).sort({ sortOrder: 1, createdAt: 1 });
    const results = await Promise.allSettled(
      integrations.map((integration) => this.runIntegrationDocument(integration))
    );
    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      return {
        integrationId: integrations[index]._id.toString(),
        success: false
      };
    });
  }

  private async runIntegrationDocument(integration: IntegrationDocument): Promise<IntegrationRunResult> {
    const integrationId = integration._id.toString();
    const now = new Date();
    try {
      const adapter = this.adapterFactory.get(integration.type);
      const credentials = deserializeCredentials<ImapCredentials>(integration.credentialsEnc);
      const unreadCount = await this.fetchUnreadWithRetry(integration, adapter, credentials);
      integration.lastUnreadCount = unreadCount;
      integration.lastCheckedAt = now;
      integration.lastSuccessAt = now;
      integration.lastError = null;
      integration.errorStreak = 0;
      integration.nextRunAt = new Date(now.getTime() + integration.pollIntervalSec * 1000);
      await integration.save();
      logger.info({ integrationId, unreadCount }, "Integration synced");
      return { integrationId, success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown sync error";
      integration.lastCheckedAt = now;
      integration.lastError = errorMessage;
      integration.errorStreak += 1;
      const backoffMs = this.getErrorBackoffMs(integration.errorStreak);
      const retryMs = Math.min(integration.pollIntervalSec * 1000, backoffMs);
      integration.nextRunAt = new Date(now.getTime() + retryMs);
      await integration.save();
      logger.error({ err: error, integrationId, errorStreak: integration.errorStreak }, "Integration sync failed");
      return { integrationId, success: false };
    }
  }

  private async fetchUnreadWithRetry(
    integration: IntegrationDocument,
    adapter: ReturnType<AdapterFactory["get"]>,
    credentials: ImapCredentials
  ): Promise<number> {
    let lastError: unknown;
    const totalAttempts = IMAP_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      try {
        return await adapter.getUnreadCount(integration, credentials);
      } catch (error) {
        lastError = error;
        if (attempt >= IMAP_RETRY_DELAYS_MS.length) {
          break;
        }
        const delayMs = IMAP_RETRY_DELAYS_MS[attempt];
        logger.warn(
          { err: error, integrationId: integration._id.toString(), attempt: attempt + 1, delayMs },
          "IMAP request failed, retry scheduled"
        );
        await this.sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("IMAP retry exhausted");
  }

  private getErrorBackoffMs(errorStreak: number): number {
    const index = Math.max(0, Math.min(errorStreak - 1, IMAP_RETRY_DELAYS_MS.length - 1));
    return IMAP_RETRY_DELAYS_MS[index];
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
