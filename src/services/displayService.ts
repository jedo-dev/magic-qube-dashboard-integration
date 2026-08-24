import { logger } from "../config/logger";
import { Integration, IntegrationDocument } from "../models/integration";
import { ImapCredentials } from "../types/integration";
import { deserializeCredentials } from "../utils/crypto";
import { MailListItem, MailReaderService } from "./mailReaderService";
import { PolzaService } from "./polzaService";

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
    const compact = mailboxes.map((box) => ({
      id: box.id,
      label: box.label,
      color: box.color,
      unread: box.unread,
      error: box.error,
      messages: box.messages.slice(0, MESSAGES_ON_DISPLAY).map((m) => ({
        uid: m.uid,
        from: m.from,
        subject: m.subject,
        when: m.when,
        seen: m.seen
      }))
    }));

    const now = new Date();
    return {
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

  async getMessage(integrationId: string, uid: string) {
    const doc = await Integration.findById(integrationId);
    if (!doc) {
      return null;
    }
    return this.mailReader.getBody(doc.type, this.credentialsOf(doc), uid);
  }
}
