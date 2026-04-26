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
    | { type: "circle"; x: number; y: number; r: number; color: string; fill: boolean }
    | {
        type: "triangle";
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        color: string;
        fill: boolean;
      }
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
const SCREEN_WIDTH = 240;
const COUNT_RIGHT_PADDING = 4;
const FONT_CHAR_WIDTH = 6;
const COUNT_TEXT_SIZE = 4;
const MIN_COUNT_X = 120;
const TRACKER_ICON_BG = "#4f525e";
const TRACKER_ICON_FG = "#ffffff";
const TRACKER_ICON_BLUE = "#5a84e8";
const GS_ICON_LIGHT = "#4f8df5";
const GS_ICON_DARK = "#2c5fd2";
const YANDEX_MAIL_YELLOW = "#f4d44d";
const YANDEX_MAIL_YELLOW_DARK = "#f0c808";
const YANDEX_MAIL_RED = "#ff2d3b";

export class EspClient {
  private readonly client: AxiosInstance;
  private shouldForceFull = true;
  private wasUnavailable = false;
  private lastFullRenderAt = 0;

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

    const forceFull =
      options?.forceFull === true || this.shouldForceFull || this.wasUnavailable || this.isPeriodicFullDue();

    try {
      if (forceFull || !previous || this.shouldLayoutFullRender(previous, next)) {
        await this.sendFullRender(next);
        this.shouldForceFull = false;
        this.lastFullRenderAt = Date.now();
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

  private isPeriodicFullDue(): boolean {
    if (this.lastFullRenderAt === 0) {
      return true;
    }
    const intervalMs = env.esp.fullRenderIntervalSec * 1000;
    return Date.now() - this.lastFullRenderAt >= intervalMs;
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
      // { type: "text", x: 12, y: 10, text: "MAIL", size: 2, color: MAIL_TITLE_COLOR }
    ];

    const rows = state.integrations.slice(0, MAX_VISIBLE_INTEGRATIONS);
    rows.forEach((item, index) => {
      const y = 50 + index * 42;
      const countText = String(item.unreadCount);
      if (item.type === "yandex_imap") {
        this.drawYandexMailIcon(commands, 12, y);
      } else if (item.type === "mail_gs_tracker_imap") {
        this.drawGsIcon(commands, 12, y);
      } else if (item.type === "yandex_tracker_imap") {
        this.drawTrackerIcon(commands, 12, y);
      } else {
        this.drawMailIcon(commands, 12, y);
      }
      commands.push({ type: "text", x: 44, y: y - 2, text: item.label, size: 3, color: LABEL_COLOR });
      commands.push({
        type: "text",
        x: this.getCountX(countText, COUNT_TEXT_SIZE),
        y: y - 6,
        text: countText,
        size: COUNT_TEXT_SIZE,
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
      const countText = String(current.unreadCount);
      const payload: DrawTextPayload = {
        x: this.getCountX(countText, COUNT_TEXT_SIZE),
        y: y - 6,
        text: countText,
        size: COUNT_TEXT_SIZE,
        color: current.color,
        bg: BG_COLOR,
        clear: true
      };
      await this.postWithRetry(env.esp.drawTextEndpoint, payload);
    }
  }

  private getCountX(text: string, size: number): number {
    const width = text.length * FONT_CHAR_WIDTH * size;
    const rightAligned = SCREEN_WIDTH - COUNT_RIGHT_PADDING - width;
    return Math.max(MIN_COUNT_X, rightAligned);
  }

  private drawMailIcon(commands: DrawBatchPayload["commands"], x: number, y: number): void {
    commands.push({ type: "rect", x, y, w: 22, h: 14, color: ICON_COLOR, fill: false });
    commands.push({ type: "line", x0: x, y0: y, x1: x + 11, y1: y + 10, color: ICON_COLOR });
    commands.push({ type: "line", x0: x + 22, y0: y, x1: x + 11, y1: y + 10, color: ICON_COLOR });
  }

  private drawTrackerIcon(commands: DrawBatchPayload["commands"], x: number, y: number): void {
    // Circular Tracker mark with block "T"
    const cx = x + 11;
    const cy = y + 7;
    commands.push({ type: "circle", x: cx, y: cy, r: 7, color: TRACKER_ICON_BLUE, fill: true });
    commands.push({ type: "rect", x: x + 4, y: y + 2, w: 4, h: 3, color: TRACKER_ICON_FG, fill: true });
    commands.push({ type: "rect", x: x + 9, y: y + 2, w: 4, h: 3, color: TRACKER_ICON_FG, fill: true });
    commands.push({ type: "rect", x: x + 14, y: y + 2, w: 4, h: 3, color: TRACKER_ICON_FG, fill: true });
    commands.push({ type: "rect", x: x + 9, y: y + 6, w: 4, h: 3, color: TRACKER_ICON_FG, fill: true });
    commands.push({ type: "rect", x: x + 9, y: y + 10, w: 4, h: 3, color: TRACKER_ICON_FG, fill: true });
  }

  private drawGsIcon(commands: DrawBatchPayload["commands"], x: number, y: number): void {
    // Draw in a square area to avoid horizontal squashing on 22x14 row slot.
    const size = 14;
    const offsetX = x + 4; // center square in the 22px slot
    const offsetY = y;
    const cx = offsetX + 7;
    const topY = offsetY;
    const midY = offsetY + 7;
    const bottomY = offsetY + size;
    const leftX = offsetX;
    const rightX = offsetX + size;

    // Outer rhombus
    commands.push({
      type: "triangle",
      x0: cx,
      y0: topY,
      x1: rightX,
      y1: midY,
      x2: leftX,
      y2: midY,
      color: GS_ICON_LIGHT,
      fill: true
    });
    commands.push({
      type: "triangle",
      x0: cx,
      y0: bottomY,
      x1: rightX,
      y1: midY,
      x2: leftX,
      y2: midY,
      color: GS_ICON_LIGHT,
      fill: true
    });

    // Dark folds on the right side
    commands.push({
      type: "triangle",
      x0: cx,
      y0: topY,
      x1: rightX - 1,
      y1: midY - 1,
      x2: cx,
      y2: midY,
      color: GS_ICON_DARK,
      fill: true
    });
    commands.push({
      type: "triangle",
      x0: cx,
      y0: bottomY,
      x1: rightX - 1,
      y1: midY + 1,
      x2: cx,
      y2: midY,
      color: GS_ICON_DARK,
      fill: true
    });

    // Inner hole (transparent via background color)
    commands.push({
      type: "triangle",
      x0: cx,
      y0: offsetY + 5,
      x1: offsetX + 10,
      y1: midY,
      x2: offsetX + 4,
      y2: midY,
      color: BG_COLOR,
      fill: true
    });
    commands.push({
      type: "triangle",
      x0: cx,
      y0: offsetY + 9,
      x1: offsetX + 10,
      y1: midY,
      x2: offsetX + 4,
      y2: midY,
      color: BG_COLOR,
      fill: true
    });
  }

  private drawYandexMailIcon(commands: DrawBatchPayload["commands"], x: number, y: number): void {
    const left = x;
    const right = x + 22;
    const top = y;
    const midY = y + 7;
    const bottom = y + 14;
    const centerX = x + 11;

    // Envelope body
    commands.push({ type: "rect", x: left, y: top, w: 22, h: 14, color: YANDEX_MAIL_YELLOW, fill: true });
    commands.push({
      type: "triangle",
      x0: left,
      y0: bottom,
      x1: centerX,
      y1: midY,
      x2: right,
      y2: bottom,
      color: YANDEX_MAIL_YELLOW_DARK,
      fill: true
    });

    // Red top flap
    commands.push({
      type: "triangle",
      x0: left,
      y0: top,
      x1: right,
      y1: top,
      x2: centerX,
      y2: midY + 1,
      color: YANDEX_MAIL_RED,
      fill: true
    });
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
