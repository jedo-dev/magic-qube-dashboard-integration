import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "../config/logger";

export const connectMongo = async (): Promise<void> => {
  await mongoose.connect(env.mongoUri);
  logger.info({ mongoUri: env.mongoUri }, "MongoDB connected");
};

export const mongoStatus = (): "connected" | "disconnected" => (
  mongoose.connection.readyState === 1 ? "connected" : "disconnected"
);
