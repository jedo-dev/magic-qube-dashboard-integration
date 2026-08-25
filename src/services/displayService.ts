import { env } from "../config/env";
import { logger } from "../config/logger";
import { Integration, IntegrationDocument } from "../models/integration";
import { TrackerTask } from "../models/trackerTask";
import { ImapCredentials, IntegrationType } from "../types/integration";
import { deserializeCredentials } from "../utils/crypto";
import { MailListItem, MailReaderService } from "./mailReaderService";
import { PolzaService } from "./polzaService";

/** Типы, у которых письмо соответствует задаче в Mongo. */
const TASK_TYPES: IntegrationType[] = ["yandex_tracker_imap", "mail_gs_tracker_imap"];
const TASK_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/;
const WEATHER_CACHE_MS = 900_000;

const MAIL_CACHE_MS = 60_000;
const USAGE_STALE_MS = 300_000;
/** Столько писем помещается в список на экране 480×480 с запасом на прокрутку. */
const MESSAGES_ON_DISPLAY = 10;

export interface DisplayMailbox {
  id: string;
  label: string;
  color: string;
  unread: number;
  messages: MailListItem[];
  error?: string;
}

/** Данные о расходе Claude Code, которые присылает ПК (POST /display/ingest). */
export interface UsagePayload {
  block_pct?: number;
  reset_min?: number;
  week_pct?: number;
  week_reset_min?: number;
  tokens_today?: number;
  cost_today_usd?: number;
  busy?: boolean;
  host?: string;
}

export class DisplayService {
  private usage: UsagePayload = {};
  private usageAt = 0;
  private mailCache = new Map<string, { at: number; box: DisplayMailbox }>();
  private refreshing = new Set<string>();
  private weather: { at: number; data: Record<string, unknown> } = { at: 0, data: {} };

  /** Температура и рассвет/закат — open-meteo, без ключа. */
  private async getWeather(): Promise<Record<string, unknown>> {
    if (Date.now() - this.weather.at < WEATHER_CACHE_MS && Object.keys(this.weather.data).length) {
      return this.weather.data;
    }
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${env.weatherLat}` +
        `&longitude=${env.weatherLon}&current=temperature_2m&daily=sunrise,sunset` +
        "&timezone=auto&forecast_days=1";
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const json = (await response.json()) as {
        current?: { temperature_2m?: number };
        daily?: { sunrise?: string[]; sunset?: string[] };
      };
      this.weather = {
        at: Date.now(),
        data: {
          temp_c: Number((json.current?.temperature_2m ?? 0).toFixed(1)),
          sunrise: json.daily?.sunrise?.[0]?.slice(11, 16) ?? "--:--",
          sunset: json.daily?.sunset?.[0]?.slice(11, 16) ?? "--:--"
        }
      };
    } catch (error) {
      logger.warn({ err: error }, "weather request failed");
    }
    return this.weather.data;
  }

  constructor(
    private readonly mailReader: MailReaderService,
    private readonly polza: PolzaService
  ) {}

  ingestUsage(payload: UsagePayload): void {
    this.usage = payload;
    this.usageAt = Date.now();
  }

  private credentialsOf(doc: IntegrationDocument): ImapCredentials {
    return deserializeCredentials<ImapCredentials>(doc.credentialsEnc);
  }

  /**
   * Отдаёт кэш немедленно: дисплей опрашивает нас каждые 3 секунды и не должен
   * ждать IMAP. Устаревший кэш обновляется в фоне, к следующему опросу данные
   * уже свежие.
   */
  private mailboxFor(doc: IntegrationDocument): DisplayMailbox {
    const id = String(doc._id);
    const cached = this.mailCache.get(id);

    if (!cached || Date.now() - cached.at >= MAIL_CACHE_MS) {
      this.refreshMailbox(doc);
    }

    return (
      cached?.box ?? {
        id,
        label: doc.label,
        color: doc.color,
        unread: doc.lastUnreadCount ?? 0,
        messages: []
      }
    );
  }

  private refreshMailbox(doc: IntegrationDocument): void {
    const id = String(doc._id);
    if (this.refreshing.has(id)) {
      return;
    }
    this.refreshing.add(id);

    void (async () => {
      const box: DisplayMailbox = {
        id,
        label: doc.label,
        color: doc.color,
        unread: doc.lastUnreadCount ?? 0,
        messages: this.mailCache.get(id)?.box.messages ?? []
      };

      try {
        box.messages = await this.mailReader.listRecent(doc.type, this.credentialsOf(doc), 15);
      } catch (error) {
        box.error = error instanceof Error ? error.message : "IMAP error";
        logger.warn({ err: error, integrationId: id }, "failed to list recent mail");
      } finally {
        this.mailCache.set(id, { at: Date.now(), box });
        this.refreshing.delete(id);
      }
    })();
  }

  async getState() {
    const integrations = await Integration.find({ enabled: true }).sort({ sortOrder: 1, createdAt: 1 });
    const mailboxes = integrations.map((doc) => this.mailboxFor(doc));

    /* На плату отдаём только то, что реально рисуется: лишние поля
       раздували ответ до десятков килобайт. */
    const compact = mailboxes.map((box, i) => {
      const hasTasks = TASK_TYPES.includes(integrations[i].type);
      return {
        id: box.id,
        label: box.label,
        color: box.color,
        unread: box.unread,
        error: box.error,
        tasks: hasTasks,
        messages: box.messages.slice(0, MESSAGES_ON_DISPLAY).map((m) => ({
          uid: m.uid,
          from: m.from,
          subject: m.subject,
          when: m.when,
          seen: m.seen,
          /* ключ задачи, чтобы её можно было удалить прямо с экрана */
          task: hasTasks ? m.subject.match(TASK_KEY_REGEX)?.[0] : undefined
        }))
      };
    });

    const now = new Date();
    return {
      ...(await this.getWeather()),
      time: now.toTimeString().slice(0, 5),
      date: now.toDateString().slice(0, 10),
      claude: {
        ...this.usage,
        stale: Date.now() - this.usageAt > USAGE_STALE_MS
      },
      polza: await this.polza.getState(),
      mailboxes: compact,
      unreadTotal: mailboxes.reduce((sum, box) => sum + box.unread, 0)
    };
  }

  /** Удалить задачу трекера из Mongo — счётчик пересчитается на следующем опросе. */
  async deleteTask(integrationId: string, taskKey: string): Promise<boolean> {
    const result = await TrackerTask.deleteOne({ integrationId, taskKey });
    logger.info({ integrationId, taskKey, deleted: result.deletedCount }, "task delete from display");
    return (result.deletedCount ?? 0) > 0;
  }

  async getMessage(integrationId: string, uid: string) {
    const doc = await Integration.findById(integrationId);
    if (!doc) {
      return null;
    }
    return this.mailReader.getBody(doc.type, this.credentialsOf(doc), uid);
  }
}
