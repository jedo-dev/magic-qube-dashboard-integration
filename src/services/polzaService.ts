import { env } from "../config/env";
import { logger } from "../config/logger";

const API = "https://polza.ai/api/v1";
const CACHE_MS = 60_000;

export interface PolzaDayPoint {
  d: string;
  c: number;
  r: number;
}

export interface PolzaState {
  balanceRub: number;
  spentTotalRub: number;
  spentTodayRub: number;
  requestsToday: number;
  requestsTotal: number;
  errors: number;
  topModel?: string;
  history: PolzaDayPoint[];
}

interface Generation {
  model?: string;
  modelDisplayName?: string;
  cost?: string | number;
  status?: string;
  createdAt?: string;
  usage?: { total_tokens?: number };
}

/** Баланс и расходы аккаунта polza.ai (LLM-агрегатор). */
export class PolzaService {
  private cache: { at: number; state: PolzaState } | null = null;

  private get apiKey(): string {
    return env.polzaApiKey;
  }

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${API}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      throw new Error(`polza ${path} responded ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async getState(days = 7): Promise<PolzaState | null> {
    if (!this.apiKey) {
      return null;
    }
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.state;
    }

    try {
      const balance = await this.get<{ amount: string; spentAmount?: string }>("/balance");

      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const items: Generation[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const chunk = await this.get<{ items: Generation[]; meta?: { totalPages?: number } }>(
          "/history/generations",
          { limit: 100, page, dateFrom: since, sortBy: "createdAt", sortOrder: "desc" }
        );
        items.push(...(chunk.items ?? []));
        if (!chunk.items?.length || page >= (chunk.meta?.totalPages ?? 1)) {
          break;
        }
      }

      const dayKey = (value: string | undefined) =>
        value ? new Date(value).toISOString().slice(0, 10) : "";
      const today = new Date().toISOString().slice(0, 10);
      const perDay = new Map<string, { cost: number; reqs: number }>();
      const perModel = new Map<string, number>();
      let spentToday = 0;
      let requestsToday = 0;
      let errors = 0;

      for (const item of items) {
        const cost = Number(item.cost ?? 0) || 0;
        const key = dayKey(item.createdAt);
        const slot = perDay.get(key) ?? { cost: 0, reqs: 0 };
        slot.cost += cost;
        slot.reqs += 1;
        perDay.set(key, slot);

        const model = item.modelDisplayName || item.model || "";
        perModel.set(model, (perModel.get(model) ?? 0) + cost);

        if (key === today) {
          spentToday += cost;
          requestsToday += 1;
        }
        if (item.status === "failed") {
          errors += 1;
        }
      }

      const history: PolzaDayPoint[] = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        const slot = perDay.get(key) ?? { cost: 0, reqs: 0 };
        history.push({ d: key.slice(5), c: Number(slot.cost.toFixed(2)), r: slot.reqs });
      }

      const topModel = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

      const state: PolzaState = {
        balanceRub: Number(Number(balance.amount ?? 0).toFixed(2)),
        spentTotalRub: Number(Number(balance.spentAmount ?? 0).toFixed(2)),
        spentTodayRub: Number(spentToday.toFixed(2)),
        requestsToday,
        requestsTotal: items.length,
        errors,
        topModel: topModel ? topModel.split("/").pop()?.slice(0, 22) : undefined,
        history
      };

      this.cache = { at: Date.now(), state };
      return state;
    } catch (error) {
      logger.warn({ err: error }, "polza.ai request failed");
      return this.cache?.state ?? null;
    }
  }
}
