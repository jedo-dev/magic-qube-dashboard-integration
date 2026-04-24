import { createApp } from "./app";
import { AdapterFactory } from "./adapters/factory";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { connectMongo } from "./db/mongoose";
import { PollScheduler } from "./scheduler/pollScheduler";
import { DashboardService } from "./services/dashboardService";
import { EspClient } from "./services/espClient";
import { IntegrationService } from "./services/integrationService";
import { SyncService } from "./services/syncService";

const bootstrap = async () => {
  if (!env.apiKey) {
    throw new Error("API_KEY env is required");
  }

  await connectMongo();

  const adapterFactory = new AdapterFactory();
  const dashboardService = new DashboardService();
  const integrationService = new IntegrationService(adapterFactory);
  const espClient = new EspClient();
  const syncService = new SyncService(integrationService, dashboardService, espClient);
  const scheduler = new PollScheduler(syncService, integrationService);

  const app = createApp({
    integrationService,
    dashboardService,
    syncService,
    scheduler
  });

  await syncService.renderStartup();
  scheduler.start();

  app.listen(env.port, env.host, () => {
    logger.info({ host: env.host, port: env.port }, "Service started");
  });
};

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "Bootstrap failed");
  process.exit(1);
});
