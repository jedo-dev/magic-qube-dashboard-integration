import { env } from "../config/env";
import { logger } from "../config/logger";
import { Integration, IntegrationDocument } from "../models/integration";
import { TrackerTask } from "../models/trackerTask";
import { ImapCredentials, IntegrationType } from "../types/integration";
import { deserializeCredentials } from "../utils/crypto";
import { MailListItem, MailReaderService, whenLabel } from "./mailReaderService";
import { PolzaService } from "./polzaService";

/** Типы, у которых письмо соответствует задаче в Mongo. */
const TASK_TYPES: IntegrationType[] = ["yandex_tracker_imap", "mail_gs_tracker_imap"];
const TASK_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/;
const WEATHER_CACHE_MS = 900_000;

/* Каждое обновление — отдельное IMAP-соединение на ящик. Реже = меньше
   нагрузки на почтовики и меньше таймаутов на слабой сети. */
const MAIL_CACHE_MS = 180_000;
/* После ошибки не долбимся в тот же ящик каждые 3 минуты. */
const MAIL_ERROR_BACKOFF_MS = 600_000;
const USAGE_STALE_MS = 300_000;
/** Столько писем помещается в список на экране 480×480 с запасом на прокрутку. */
const MESSAGES_ON_DISPLAY = 10;
/** Задач отдаём больше: на дисплее их список прокручивается в модалке. */
const TASKS_ON_DISPLAY = 30;

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
  /** ok | token_expired | no_token | unavailable — см. agent/claude_limits.py */
  usage_status?: string;
}

/** Машины, которые давно молчат, в сводку не берём. */
const SOURCE_FORGET_MS = 24 * 3600_000;

export class DisplayService {
  /* Данные могут приходить с нескольких машин (ПК, ноутбук): держим
     последний пакет от каждой и сводим их, иначе экран прыгал бы между ними. */
  private usageSources = new Map<string, { at: number; data: UsagePayload }>();
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
        `&longitude=${env.weatherLon}&current=temperature_2m,weather_code,is_day&daily=sunrise,sunset` +
        "&timezone=auto&forecast_days=1";
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const json = (await response.json()) as {
        current?: { temperature_2m?: number; weather_code?: number; is_day?: number };
        daily?: { sunrise?: string[]; sunset?: string[] };
      };
      this.weather = {
        at: Date.now(),
        data: {
          temp_c: Number((json.current?.temperature_2m ?? 0).toFixed(1)),
          /* WMO-код и день/ночь — дисплей выбирает по ним иконку */
          weather_code: json.current?.weather_code ?? -1,
          is_day: json.current?.is_day ?? 1,
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
    const host = payload.host || "default";
    this.usageSources.set(host, { at: Date.now(), data: payload });
  }

  /**
   * Сводка по всем машинам.
   * Лимиты общие на аккаунт — берём самые свежие с рабочим токеном: если на
   * ноутбуке токен протух, а на ПК живой, показываем цифры с ПК.
   * Токены и стоимость за день считаются по локальным журналам каждой
   * машины — их складываем. «Работает» — если работает хоть одна.
   */
  private mergedUsage(): UsagePayload & { stale: boolean; hosts: string[] } {
    const now = Date.now();
    for (const [host, src] of this.usageSources) {
      if (now - src.at > SOURCE_FORGET_MS) {
        this.usageSources.delete(host);
      }
    }

    const fresh = [...this.usageSources.entries()]
      .filter(([, src]) => now - src.at <= USAGE_STALE_MS)
      .sort((a, b) => b[1].at - a[1].at);
    if (!fresh.length) {
      const last = [...this.usageSources.values()].sort((a, b) => b.at - a.at)[0];
      return { ...(last?.data ?? {}), busy: false, stale: true, hosts: [] };
    }

    const withLimits =
      fresh.find(([, src]) => src.data.usage_status === "ok") ?? fresh[0];
    const limits = withLimits[1].data;

    return {
      usage_status: limits.usage_status,
      block_pct: limits.block_pct,
      reset_min: limits.reset_min,
      week_pct: limits.week_pct,
      week_reset_min: limits.week_reset_min,
      tokens_today: fresh.reduce((sum, [, src]) => sum + (src.data.tokens_today ?? 0), 0),
      cost_today_usd: Number(
        fresh.reduce((sum, [, src]) => sum + (src.data.cost_today_usd ?? 0), 0).toFixed(2)
      ),
      busy: fresh.some(([, src]) => src.data.busy),
      host: withLimits[0],
      hosts: fresh.map(([host]) => host),
      stale: false
    };
  }

  private credentialsOf(doc: IntegrationDocument): ImapCredentials {
    return deserializeCredentials<ImapCredentials>(doc.credentialsEnc);
  }

  /**
   * Отдаёт кэш немедленно: дисплей опрашивает нас каждые 3 секунды и не должен
   * ждать IMAP. Устаревший кэш обновляется в фоне, к следующему опросу данные
   * уже свежие.
   */
  /** Для трекер-интеграций список — это сами задачи из Mongo, а не письма:
      удалённая задача исчезает сразу и навсегда, письмо в ящике не мешает. */
  private async taskBox(doc: IntegrationDocument): Promise<DisplayMailbox> {
    const id = String(doc._id);
    const tasks = await TrackerTask.find({ integrationId: id })
      .sort({ lastEventAt: -1 })
      .limit(TASKS_ON_DISPLAY)
      .lean();

    return {
      id,
      label: doc.label,
      color: doc.color,
      unread: await TrackerTask.countDocuments({ integrationId: id }),
      messages: tasks.map((task) => ({
        uid: String(task.lastMailUid ?? ""),
        from: task.taskKey,
        fromAddress: "",
        subject: task.rawSubject?.trim() || task.taskKey,
        date: new Date(task.lastEventAt).toISOString(),
        when: whenLabel(new Date(task.lastEventAt)),
        seen: true
      }))
    };
  }

  private mailboxFor(doc: IntegrationDocument): DisplayMailbox {
    const id = String(doc._id);
    const cached = this.mailCache.get(id);
    const ttl = cached?.box.error ? MAIL_ERROR_BACKOFF_MS : MAIL_CACHE_MS;

    if (!cached || Date.now() - cached.at >= ttl) {
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
    const mailboxes = await Promise.all(
      integrations.map((doc) =>
        TASK_TYPES.includes(doc.type) ? this.taskBox(doc) : this.mailboxFor(doc)
      )
    );

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
        messages: box.messages.slice(0, hasTasks ? TASKS_ON_DISPLAY : MESSAGES_ON_DISPLAY).map((m) => ({
          uid: m.uid,
          from: m.from,
          subject: m.subject,
          when: m.when,
          seen: m.seen,
          /* ключ задачи, чтобы её можно было удалить прямо с экрана */
          task: hasTasks ? m.from || m.subject.match(TASK_KEY_REGEX)?.[0] : undefined
        }))
      };
    });

    const now = new Date();
    return {
      ...(await this.getWeather()),
      time: now.toTimeString().slice(0, 5),
      date: now.toDateString().slice(0, 10),
      claude: {
        ...this.mergedUsage()
      },
      polza: await this.polza.getState(),
      mailboxes: compact,
      unreadTotal: mailboxes.reduce((sum, box) => sum + box.unread, 0)
    };
  }

  /** Удалить задачу трекера и сразу же обновить счётчик на плитке. */
  async deleteTask(integrationId: string, taskKey: string): Promise<boolean> {
    const result = await TrackerTask.deleteOne({ integrationId, taskKey });
    const left = await TrackerTask.countDocuments({ integrationId });
    await Integration.updateOne({ _id: integrationId }, { lastUnreadCount: left });

    logger.info(
      { integrationId, taskKey, deleted: result.deletedCount, left },
      "task deleted from display"
    );
    return (result.deletedCount ?? 0) > 0;
  }

  async getMessage(integrationId: string, uid: string) {
    const doc = await Integration.findById(integrationId);
    if (!doc) {
      return null;
    }
    const body = await this.mailReader.getBody(doc.type, this.credentialsOf(doc), uid);

    /* письмо только что стало прочитанным — поправим кэш и счётчик,
       не дожидаясь следующего опроса ящика */
    if (body) {
      const cached = this.mailCache.get(String(doc._id));
      const item = cached?.box.messages.find((m) => m.uid === uid);
      if (item && !item.seen) {
        item.seen = true;
        cached!.box.unread = Math.max(0, cached!.box.unread - 1);
        await Integration.updateOne(
          { _id: doc._id },
          { lastUnreadCount: cached!.box.unread }
        );
      }
    }
    return body;
  }
}
