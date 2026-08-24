import { logger } from "../config/logger";
import { Integration, IntegrationDocument } from "../models/integration";
import { ImapCredentials } from "../types/integration";
import { deserializeCredentials } from "../utils/crypto";
import { MailListItem, MailReaderService } from "./mailReaderService";
import { PolzaService } from "./polzaService";

const MAIL_CACHE_MS = 60_000;
const USAGE_STALE_MS = 300_000;

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

  private async mailboxFor(doc: IntegrationDocument | null): Promise<DisplayMailbox | null> {
    if (!doc) {
      return null;
    }
    const id = String(doc._id);
    const cached = this.mailCache.get(id);
    if (cached && Date.now() - cached.at < MAIL_CACHE_MS) {
      return cached.box;
    }

    const box: DisplayMailbox = {
      id,
      label: doc.label,
      color: doc.color,
      unread: doc.lastUnreadCount ?? 0,
      messages: []
    };

    try {
      box.messages = await this.mailReader.listRecent(doc.type, this.credentialsOf(doc), 15);
    } catch (error) {
      box.error = error instanceof Error ? error.message : "IMAP error";
      logger.warn({ err: error, integrationId: id }, "failed to list recent mail");
    }

    this.mailCache.set(id, { at: Date.now(), box });
    return box;
  }

  async getState() {
    const integrations = await Integration.find({ enabled: true }).sort({ sortOrder: 1, createdAt: 1 });
    const mailboxes: DisplayMailbox[] = [];
    for (const doc of integrations) {
      const box = await this.mailboxFor(doc);
      if (box) {
        mailboxes.push(box);
      }
    }

    const now = new Date();
    return {
      time: now.toTimeString().slice(0, 5),
      date: now.toDateString().slice(0, 10),
      claude: {
        ...this.usage,
        stale: Date.now() - this.usageAt > USAGE_STALE_MS
      },
      polza: await this.polza.getState(),
      mailboxes,
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
