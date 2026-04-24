import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

export const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (req.path === "/health") {
    next();
    return;
  }

  const token = req.header("X-API-Key");
  if (!token || token !== env.apiKey) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  next();
};
