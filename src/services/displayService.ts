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
const WEATHER_RETRY_MS = 60_000;

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

/**
 * Часы и дата для дисплея в часовом поясе владельца, а не контейнера
 * (в Docker это UTC). Формат даты «Tue Sep 22» — прошивка переводит сам.
 */
const localClock = (now: Date): { time: string; date: string } => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return {
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.weekday} ${parts.month} ${parts.day}`
  };
};

interface MetForecast {
  properties?: {
    timeseries?: {
      data?: {
        instant?: { details?: { air_temperature?: number } };
        next_1_hours?: { summary?: { symbol_code?: string } };
        next_6_hours?: { summary?: { symbol_code?: string } };
      };
    }[];
  };
}

interface MetSun {
  properties?: { sunrise?: { time?: string }; sunset?: { time?: string } };
}

const MET_USER_AGENT = "token-monitor/1.0 github.com/jedo-dev/token-monitor";

const metNo = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.met.no/weatherapi/${path}`, {
    headers: { "User-Agent": MET_USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`met.no ${path.split("?")[0]} responded ${response.status}`);
  }
  return (await response.json()) as T;
};

/** Сегодняшняя дата и смещение («+03:00») в часовом поясе владельца. */
const localDate = (now: Date): { date: string; offset: string } => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: env.timeZone }).format(now);
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone: env.timeZone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  return { date, offset };
};

/**
 * Символ met.no («partlycloudy_day», «lightrain») → WMO-код, который
 * понимает прошивка: 0 ясно, 1–2 малооблачно, 3 облачно, 45 туман,
 * 61 дождь, 71 снег, 95 гроза, -1 неизвестно.
 */
const wmoFromMetSymbol = (symbol: string): number => {
  const base = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (!base) return -1;
  if (base.includes("thunder")) return 95;
  if (base.includes("snow") || base.includes("sleet")) return 71;
  if (base.includes("rain")) return 61;
  if (base === "fog") return 45;
  if (base === "clearsky") return 0;
  if (base === "fair") return 1;
  if (base === "partlycloudy") return 2;
  if (base === "cloudy") return 3;
  return -1;
};

/** День ли сейчас: по суффиксу символа, а если его нет — по восходу и закату. */
const isDay = (symbol: string, now: Date, sunrise?: string, sunset?: string): boolean => {
  if (symbol.endsWith("_day")) return true;
  if (symbol.endsWith("_night") || symbol.endsWith("_polartwilight")) return false;
  if (!sunrise || !sunset) return true;
  const t = now.getTime();
  return t >= Date.parse(sunrise) && t < Date.parse(sunset);
};

export class DisplayService {
  /* Данные могут приходить с нескольких машин (ПК, ноутбук): держим
     последний пакет от каждой и сводим их, иначе экран прыгал бы между ними. */
  private usageSources = new Map<string, { at: number; data: UsagePayload }>();
  private mailCache = new Map<string, { at: number; box: DisplayMailbox }>();
  private refreshing = new Set<string>();
  private weather: { at: number; data: Record<string, unknown> } = { at: 0, data: {} };

  private weatherTriedAt = 0;
  private weatherLoading = false;
  private polzaState: Awaited<ReturnType<PolzaService["getState"]>> = null;
  private polzaLoading = false;

  /* Внешние API не должны задерживать ответ дисплею: он ждёт 8 с, и когда
     open-meteo не отвечал, экран уходил в OFFLINE. Отдаём то, что уже есть,
     а обновляем в фоне; после ошибки пробуем снова через минуту. */
  private getWeather(): Record<string, unknown> {
    const now = Date.now();
    const fresh = now - this.weather.at < WEATHER_CACHE_MS;
    if (!fresh && !this.weatherLoading && now - this.weatherTriedAt >= WEATHER_RETRY_MS) {
      this.weatherTriedAt = now;
      this.weatherLoading = true;
      void this.loadWeather().finally(() => {
        this.weatherLoading = false;
      });
    }
    return this.weather.data;
  }

  /** polza.ai кэширует сам; здесь только не ждём его в запросе дисплея. */
  private getPolza() {
    if (!this.polzaLoading) {
      this.polzaLoading = true;
      void this.polza
        .getState()
        .then((state) => {
          this.polzaState = state;
        })
        .finally(() => {
          this.polzaLoading = false;
        });
    }
    return this.polzaState;
  }

  /**
   * Температура, иконка и рассвет/закат — MET Norway (api.met.no), без ключа.
   * open-meteo стоит на Hetzner, а его подсети из России недоступны.
   * met.no требует представиться в User-Agent.
   */
  private async loadWeather(): Promise<void> {
    try {
      const now = new Date();
      const { date, offset } = localDate(now);
      const [forecast, sun] = await Promise.all([
        metNo<MetForecast>(
          `locationforecast/2.0/compact?lat=${env.weatherLat}&lon=${env.weatherLon}`
        ),
        metNo<MetSun>(
          `sunrise/3.0/sun?lat=${env.weatherLat}&lon=${env.weatherLon}` +
            `&date=${date}&offset=${encodeURIComponent(offset)}`
        )
      ]);

      /* первая точка ряда — текущий час */
      const point = forecast.properties?.timeseries?.[0]?.data;
      const temp = point?.instant?.details?.air_temperature;
      if (typeof temp !== "number") {
        throw new Error("met.no: нет температуры в ответе");
      }
      const symbol =
        point?.next_1_hours?.summary?.symbol_code ?? point?.next_6_hours?.summary?.symbol_code ?? "";
      const sunrise = sun.properties?.sunrise?.time;
      const sunset = sun.properties?.sunset?.time;

      this.weather = {
        at: Date.now(),
        data: {
          temp_c: Number(temp.toFixed(1)),
          /* дисплей выбирает иконку по WMO-коду и дню/ночи */
          weather_code: wmoFromMetSymbol(symbol),
          is_day: isDay(symbol, now, sunrise, sunset) ? 1 : 0,
          sunrise: sunrise?.slice(11, 16) ?? "--:--",
          sunset: sunset?.slice(11, 16) ?? "--:--"
        }
      };
    } catch (error) {
      logger.warn({ err: error }, "weather request failed");
    }
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
      ...this.getWeather(),
      ...localClock(now),
      claude: {
        ...this.mergedUsage()
      },
      polza: this.getPolza(),
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
