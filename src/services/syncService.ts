import { logger } from "../config/logger";
import { DashboardSnapshot } from "../models/dashboardSnapshot";
import { DashboardState } from "../types/integration";
import { DashboardService } from "./dashboardService";
import { EspClient } from "./espClient";
import { IntegrationService } from "./integrationService";

export type SyncTrigger = "startup" | "manual" | "scheduled";

export class SyncService {
  private syncInProgress = false;
  private firstSuccessfulPollPending = true;
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly integrationService: IntegrationService,
    private readonly dashboardService: DashboardService,
    private readonly espClient: EspClient
  ) {}

  getStatus(): { syncInProgress: boolean; firstSuccessfulPollPending: boolean } {
    return {
      syncInProgress: this.syncInProgress,
      firstSuccessfulPollPending: this.firstSuccessfulPollPending
    };
  }

  async renderStartup(): Promise<DashboardState> {
    const state = await this.dashboardService.buildState();
    this.dashboardService.setLatestState(state);
    await this.publishState("startup", true);
    return state;
  }

  async syncAll(trigger: SyncTrigger): Promise<DashboardState> {
    this.syncInProgress = true;
    try {
      const results = await this.integrationService.runAllEnabled();
      const hasSuccess = results.some((item) => item.success);
      const shouldForceFull = hasSuccess && this.firstSuccessfulPollPending;
      if (shouldForceFull) {
        this.firstSuccessfulPollPending = false;
      }
      return this.publishState(trigger, shouldForceFull);
    } finally {
      this.syncInProgress = false;
    }
  }

  async syncOneIntegration(integrationId: string): Promise<DashboardState> {
    const result = await this.integrationService.runSingleIntegration(integrationId);
    const shouldForceFull = result.success && this.firstSuccessfulPollPending;
    if (shouldForceFull) {
      this.firstSuccessfulPollPending = false;
    }
    return this.publishState("scheduled", shouldForceFull);
  }

  async rebuildStateOnly(): Promise<DashboardState> {
    const state = await this.dashboardService.buildState();
    this.dashboardService.setLatestState(state);
    return state;
  }

  private async publishState(trigger: SyncTrigger, forceFull: boolean): Promise<DashboardState> {
    let finalState: DashboardState | null = null;
    const queueTask = async () => {
      const previousState = this.dashboardService.getLatestState();
      const nextState = await this.dashboardService.buildState();
      this.dashboardService.setLatestState(nextState);
      finalState = nextState;

      try {
        await this.espClient.push(previousState, nextState, { forceFull });
      } catch (error) {
        logger.error({ err: error }, "Push to ESP failed");
      }
      await DashboardSnapshot.create({ state: nextState, trigger });
    };

    this.publishQueue = this.publishQueue.then(queueTask).catch((error) => {
      logger.error({ err: error }, "Publish queue execution failed");
    });

    await this.publishQueue;
    if (!finalState) {
      finalState = await this.dashboardService.buildState();
      this.dashboardService.setLatestState(finalState);
    }
    return finalState;
  }
}
