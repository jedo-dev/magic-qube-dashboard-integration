import { env } from "../config/env";
import { logger } from "../config/logger";
import { IntegrationService } from "../services/integrationService";
import { SyncService } from "../services/syncService";

export class PollScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly syncService: SyncService,
    private readonly integrationService: IntegrationService
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, env.schedulerTickSec * 1000);
    logger.info(
      { tickSec: env.schedulerTickSec, maxConcurrentJobs: env.maxConcurrentJobs },
      "Scheduler started"
    );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): { running: boolean; activeJobs: number; maxConcurrentJobs: number } {
    return {
      running: this.timer !== null,
      activeJobs: this.inFlight.size,
      maxConcurrentJobs: env.maxConcurrentJobs
    };
  }

  private async tick(): Promise<void> {
    const availableSlots = Math.max(0, env.maxConcurrentJobs - this.inFlight.size);
    if (availableSlots === 0) {
      return;
    }

    const dueIntegrations = await this.integrationService.listDue(new Date(), availableSlots * 3);
    for (const integration of dueIntegrations) {
      if (this.inFlight.size >= env.maxConcurrentJobs) {
        break;
      }

      const integrationId = integration._id.toString();
      if (this.inFlight.has(integrationId)) {
        continue;
      }

      this.inFlight.add(integrationId);
      void this.syncService
        .syncOneIntegration(integrationId)
        .catch((error) => {
          logger.error({ err: error, integrationId }, "Scheduled integration sync failed");
        })
        .finally(() => {
          this.inFlight.delete(integrationId);
        });
    }
  }
}
