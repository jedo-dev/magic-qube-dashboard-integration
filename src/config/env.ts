import dotenv from "dotenv";

dotenv.config();

const asNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: asNumber(process.env.PORT, 3000),
  host: process.env.HOST ?? "127.0.0.1",
  mongoUri: process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/magic_qube_dashboard",
  logLevel: process.env.LOG_LEVEL ?? "info",
  credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY ?? "",
  apiKey: process.env.API_KEY ?? "",
  defaultPollIntervalSec: asNumber(process.env.DEFAULT_POLL_INTERVAL_SEC, 60),
  schedulerTickSec: asNumber(process.env.SCHEDULER_TICK_SEC, 2),
  maxConcurrentJobs: asNumber(process.env.MAX_CONCURRENT_JOBS, 2),
  imapConnectTimeoutMs: asNumber(process.env.IMAP_CONNECT_TIMEOUT_MS, 10000),
  stopGifOnRender: (process.env.STOP_GIF_ON_RENDER ?? "false").toLowerCase() === "true",
  esp: {
    baseUrl: process.env.ESP_BASE_URL ?? "",
    drawBatchEndpoint: "/api/v1/draw/batch",
    drawTextEndpoint: "/api/v1/draw/text",
    stopGifEndpoint: "/api/v1/gif/stop",
    timeoutMs: asNumber(process.env.ESP_TIMEOUT_MS, 4000),
    retryCount: asNumber(process.env.ESP_RETRY_COUNT, 3),
    retryDelayMs: asNumber(process.env.ESP_RETRY_DELAY_MS, 1000)
  }
};
