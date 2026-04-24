import axios, { AxiosInstance } from "axios";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { DashboardState } from "../types/integration";

interface DrawBatchPayload {
  commands: Array<
    | { type: "clear"; color: string }
    | { type: "text"; x: number; y: number; text: string; size: number; color: string }
    | {
        type: "rect";
        x: number;
        y: number;
        w: number;
        h: number;
        color: string;
        fill: boolean;
      }
    | { type: "line"; x0: number; y0: number; x1: number; y1: number; color: string }
  >;
}

interface DrawTextPayload {
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  bg: string;
  clear: boolean;
}

const MAX_VISIBLE_INTEGRATIONS = 4;
const BG_COLOR = "#000000";
const MAIL_TITLE_COLOR = "#ffffff";
const LABEL_COLOR = "#aaaaaa";
const ICON_COLOR = "#00ffff";

export class EspClient {
  private readonly client: AxiosInstance;
  private shouldForceFull = true;
  private wasUnavailable = false;

  constructor() {
    this.client = axios.create({
      baseURL: env.esp.baseUrl || undefined,
      timeout: env.esp.timeoutMs
    });
  }

  async push(
    previous: DashboardState | null,
    next: DashboardState,
    options?: { forceFull?: boolean }
  ): Promise<void> {
    if (!env.esp.baseUrl) {
      logger.warn("ESP_BASE_URL is empty, skip push");
      return;
    }

    const forceFull = options?.forceFull === true || this.shouldForceFull || this.wasUnavailable;

    try {
      if (forceFull || !previous || this.shouldLayoutFullRender(previous, next)) {
        await this.sendFullRender(next);
        this.shouldForceFull = false;
      } else {
        await this.sendDeltaRender(previous, next);
      }
      this.wasUnavailable = false;
    } catch (error) {
      this.wasUnavailable = true;
      this.shouldForceFull = true;
      throw error;
    }
  }

  forceFullOnNextPush(): void {
    this.shouldForceFull = true;
  }

  private shouldLayoutFullRender(previous: DashboardState, next: DashboardState): boolean {
    const previousRows = previous.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    const nextRows = next.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    if (previousRows.length !== nextRows.length) {
      return true;
    }
    for (let i = 0; i < nextRows.length; i += 1) {
      const p = previousRows[i];
      const n = nextRows[i];
      if (p.id !== n.id || p.label !== n.label || p.color !== n.color) {
        return true;
      }
    }
    return false;
  }

  private async sendFullRender(state: DashboardState): Promise<void> {
    if (env.stopGifOnRender) {
      await this.postWithRetry(env.esp.stopGifEndpoint, {});
    }

    const payload: DrawBatchPayload = {
      commands: this.buildFullCommands(state)
    };
    await this.postWithRetry(env.esp.drawBatchEndpoint, payload);
  }

  private buildFullCommands(state: DashboardState): DrawBatchPayload["commands"] {
    const commands: DrawBatchPayload["commands"] = [
      { type: "clear", color: BG_COLOR },
      { type: "text", x: 12, y: 10, text: "MAIL", size: 2, color: MAIL_TITLE_COLOR }
    ];

    const rows = state.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    rows.forEach((item, index) => {
      const y = 50 + index * 42;
      commands.push({ type: "rect", x: 12, y, w: 22, h: 14, color: ICON_COLOR, fill: false });
      commands.push({ type: "line", x0: 12, y0: y, x1: 23, y1: y + 10, color: ICON_COLOR });
      commands.push({ type: "line", x0: 34, y0: y, x1: 23, y1: y + 10, color: ICON_COLOR });
      commands.push({ type: "text", x: 44, y: y - 2, text: item.label, size: 1, color: LABEL_COLOR });
      commands.push({
        type: "text",
        x: 170,
        y: y - 6,
        text: String(item.unreadCount),
        size: 3,
        color: item.color
      });
    });

    return commands;
  }

  private async sendDeltaRender(previous: DashboardState, next: DashboardState): Promise<void> {
    const prevRows = previous.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    const nextRows = next.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    const previousById = new Map(prevRows.map((item) => [item.id, item]));

    for (let index = 0; index < nextRows.length; index += 1) {
      const current = nextRows[index];
      const prev = previousById.get(current.id);
      if (!prev || prev.unreadCount === current.unreadCount) {
        continue;
      }

      const y = 50 + index * 42;
      const payload: DrawTextPayload = {
        x: 170,
        y: y - 6,
        text: String(current.unreadCount),
        size: 3,
        color: current.color,
        bg: BG_COLOR,
        clear: true
      };
      await this.postWithRetry(env.esp.drawTextEndpoint, payload);
    }
  }

  private async postWithRetry(url: string, payload: unknown): Promise<void> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= env.esp.retryCount) {
      try {
        await this.client.post(url, payload);
        return;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt > env.esp.retryCount) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, env.esp.retryDelayMs));
      }
    }

    logger.error({ err: lastError, url }, "ESP request failed");
    throw new Error(`ESP request failed: ${url}`);
  }
}
