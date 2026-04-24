import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { createRouter } from "./routes/createRouter";
import { PollScheduler } from "./scheduler/pollScheduler";
import { DashboardService } from "./services/dashboardService";
import { IntegrationService } from "./services/integrationService";
import { SyncService } from "./services/syncService";
import { BadRequestError } from "./http/parse";
import { apiKeyMiddleware } from "./http/apiKeyMiddleware";

interface AppDeps {
  integrationService: IntegrationService;
  dashboardService: DashboardService;
  syncService: SyncService;
  scheduler: PollScheduler;
}

export const createApp = (deps: AppDeps) => {
  const app = express();

  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      autoLogging: true
    })
  );

  app.use(apiKeyMiddleware);
  app.use(createRouter(deps));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof BadRequestError) {
      res.status(400).json({ message: error.message });
      return;
    }

    logger.error({ err: error }, "Unhandled API error");
    res.status(500).json({
      message: "Internal server error"
    });
  });

  return app;
};
