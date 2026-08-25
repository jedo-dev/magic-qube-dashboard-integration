import { Router } from "express";
import mongoose from "mongoose";
import { mongoStatus } from "../db/mongoose";
import { toIntegrationDto } from "../models/integration";
import { PollScheduler } from "../scheduler/pollScheduler";
import { DashboardService } from "../services/dashboardService";
import { IntegrationService } from "../services/integrationService";
import { SyncService } from "../services/syncService";
import { DisplayService } from "../services/displayService";
import {
  BadRequestError,
  parseCreateIntegrationBody,
  parsePatchIntegrationBody
} from "../http/parse";

interface RouterDeps {
  integrationService: IntegrationService;
  dashboardService: DashboardService;
  syncService: SyncService;
  scheduler: PollScheduler;
  displayService: DisplayService;
}

export const createRouter = (deps: RouterDeps): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      mongo: mongoStatus(),
      scheduler: deps.scheduler.getStatus(),
      sync: deps.syncService.getStatus()
    });
  });

  router.get("/integrations", async (_req, res, next) => {
    try {
      const list = await deps.integrationService.list();
      res.json(list.map((doc) => toIntegrationDto(doc)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/integrations", async (req, res, next) => {
    try {
      const payload = parseCreateIntegrationBody(req.body);
      const created = await deps.integrationService.create(payload);
      res.status(201).json(toIntegrationDto(created));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/integrations/:id", async (req, res, next) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        throw new BadRequestError("Invalid integration id");
      }
      const payload = parsePatchIntegrationBody(req.body);
      const updated = await deps.integrationService.update(req.params.id, payload);
      if (!updated) {
        res.status(404).json({ message: "Integration not found" });
        return;
      }
      res.json(toIntegrationDto(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post("/sync", async (_req, res, next) => {
    try {
      const state = await deps.syncService.syncAll("manual");
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  router.get("/dashboard/state", async (_req, res, next) => {
    try {
      const current = deps.dashboardService.getLatestState() ?? (await deps.syncService.rebuildStateOnly());
      res.json(current);
    } catch (error) {
      next(error);
    }
  });

  /* ---- Token Monitor display (ESP32-S3-Touch-LCD-4) ---- */

  router.get("/display/state", async (_req, res, next) => {
    try {
      res.json(await deps.displayService.getState());
    } catch (error) {
      next(error);
    }
  });

  router.get("/display/mail/:integrationId/:uid", async (req, res, next) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.integrationId)) {
        throw new BadRequestError("Invalid integration id");
      }
      const message = await deps.displayService.getMessage(req.params.integrationId, req.params.uid);
      if (!message) {
        res.status(404).json({ message: "Message not found" });
        return;
      }
      res.json(message);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/display/task/:integrationId/:taskKey", async (req, res, next) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.integrationId)) {
        throw new BadRequestError("Invalid integration id");
      }
      const deleted = await deps.displayService.deleteTask(
        req.params.integrationId,
        req.params.taskKey
      );
      res.json({ ok: deleted });
    } catch (error) {
      next(error);
    }
  });

  router.post("/display/ingest", (req, res) => {
    deps.displayService.ingestUsage(req.body ?? {});
    res.json({ ok: true });
  });

  return router;
};
