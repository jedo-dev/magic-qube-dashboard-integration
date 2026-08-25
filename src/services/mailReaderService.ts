import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { ImapCredentials, IntegrationType } from "../types/integration";

export interface MailListItem {
  uid: string;
  from: string;
  fromAddress: string;
  subject: string;
  date: string;
  /** Готовая к выводу метка времени: "17:42" для сегодняшних, иначе "24.08". */
  when: string;
  seen: boolean;
}

export interface MailBody {
  uid: string;
  from: string;
  subject: string;
  date: string;
  text: string;
}

const DEFAULT_HOSTS: Partial<Record<IntegrationType, string>> = {
  yandex_imap: "imap.yandex.ru",
  yandex_tracker_imap: "imap.yandex.ru",
  mailru_imap: "imap.mail.ru",
  mail_gs_tracker_imap: "imap.mail.ru"
};

export const whenLabel = (date: Date): string => {
  const now = new Date();
  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  return sameDay
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
};

const clean = (value: string | undefined | null, max: number): string => {
  if (!value) {
    return "";
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
};

/**
 * Чтение последних писем по IMAP для экрана Token Monitor.
 * Ничего не помечает прочитанным: письма забираются в режиме readOnly.
 */
export class MailReaderService {
  private async withClient<T>(
    type: IntegrationType,
    credentials: ImapCredentials,
    fn: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    const client = new ImapFlow({
      host: credentials.host ?? DEFAULT_HOSTS[type] ?? "imap.yandex.ru",
      port: credentials.port ?? 993,
      secure: credentials.secure ?? true,
      logger: false,
      auth: {
        user: credentials.login,
        pass: credentials.appPassword
      },
      connectionTimeout: env.imapConnectTimeoutMs
    });

    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async listRecent(
    type: IntegrationType,
    credentials: ImapCredentials,
    limit = 15
  ): Promise<MailListItem[]> {
    return this.withClient(type, credentials, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const mailbox = client.mailbox;
        const total = typeof mailbox === "object" ? mailbox.exists : 0;
        if (!total) {
          return [];
        }

        const from = Math.max(1, total - limit + 1);
        const items: MailListItem[] = [];

        for await (const msg of client.fetch(`${from}:${total}`, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: false
        })) {
          const sender = msg.envelope?.from?.[0];
          const date = msg.envelope?.date ?? new Date();
          items.push({
            uid: String(msg.uid),
            from: clean(sender?.name || sender?.address, 40),
            fromAddress: clean(sender?.address, 60),
            subject: clean(msg.envelope?.subject, 90) || "(без темы)",
            date: date.toISOString(),
            when: whenLabel(date),
            seen: msg.flags?.has("\\Seen") ?? false
          });
        }

        return items.reverse(); // новые сверху
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Читает письмо и помечает его прочитанным (\Seen) — как если бы его
   * открыли в почтовом клиенте.
   */
  async getBody(
    type: IntegrationType,
    credentials: ImapCredentials,
    uid: string,
    maxChars = 4000
  ): Promise<MailBody | null> {
    return this.withClient(type, credentials, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const downloaded = await client.download(uid, undefined, { uid: true });
        if (!downloaded?.content) {
          return null;
        }

        const parsed = await simpleParser(downloaded.content);

        await client
          .messageFlagsAdd(uid, ["\\Seen"], { uid: true })
          .catch((error) => logger.warn({ err: error, uid }, "failed to mark seen"));
        const html = typeof parsed.html === "string" ? parsed.html : "";
        const body = parsed.text?.trim() || clean(html.replace(/<[^>]+>/g, " "), maxChars);

        return {
          uid,
          from: clean(parsed.from?.text, 60),
          subject: clean(parsed.subject, 120) || "(без темы)",
          date: (parsed.date ?? new Date()).toISOString(),
          text: body.length > maxChars ? `${body.slice(0, maxChars)}…` : body
        };
      } catch (error) {
        logger.warn({ err: error, uid }, "failed to read message body");
        return null;
      } finally {
        lock.release();
      }
    });
  }
}
