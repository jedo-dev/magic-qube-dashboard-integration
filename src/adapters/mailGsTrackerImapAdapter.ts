import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { IntegrationDocument } from "../models/integration";
import { ProcessedTrackerMail } from "../models/processedTrackerMail";
import { TrackerTask } from "../models/trackerTask";
import { ImapCredentials } from "../types/integration";
import { MailIntegrationAdapter } from "./base";

const GS_TASK_KEY_REGEX = /\bGS-\d+\b/i;
const DEFAULT_COMPLETION_SENDER = "gitlab@dear.com.ru";

const extractTaskKey = (...parts: Array<string | undefined>): string | null => {
  const joined = parts.filter(Boolean).join("\n").toUpperCase();
  const match = joined.match(GS_TASK_KEY_REGEX);
  return match ? match[0].toUpperCase() : null;
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const getSenderEmails = (parsed: Awaited<ReturnType<typeof simpleParser>>): string[] => {
  const fromList = parsed.from?.value ?? [];
  return fromList.map((item) => normalizeEmail(item.address ?? "")).filter((item) => item.length > 0);
};

export class MailGsTrackerImapAdapter implements MailIntegrationAdapter {
  async getUnreadCount(integration: IntegrationDocument, credentials: ImapCredentials): Promise<number> {
    const integrationId = integration._id.toString();
    const completionSender = normalizeEmail(credentials.completionSender ?? DEFAULT_COMPLETION_SENDER);

    const client = new ImapFlow({
      host: credentials.host ?? "imap.mail.ru",
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
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uidValidity =
          client.mailbox && typeof client.mailbox === "object" && "uidValidity" in client.mailbox
            ? String(client.mailbox.uidValidity ?? "0")
            : "0";
        const unseenResult = await client.search({ seen: false });
        const unseenUids = Array.isArray(unseenResult) ? unseenResult : [];

        for (const uid of unseenUids) {
          const alreadyProcessed = await ProcessedTrackerMail.exists({ integrationId, uidValidity, uid });
          if (alreadyProcessed) {
            continue;
          }

          const message = await client.fetchOne(uid, {
            uid: true,
            envelope: true,
            source: true,
            internalDate: true
          });

          if (!message || !message.source) {
            await this.markProcessed(integrationId, uidValidity, uid, undefined, undefined);
            continue;
          }

          const parsed = await simpleParser(Buffer.from(message.source));
          const html = typeof parsed.html === "string" ? parsed.html : "";
          const text = parsed.text ?? "";
          const taskKey = extractTaskKey(parsed.subject ?? "", html, text);

          logger.info(
            {
              integrationId,
              uid,
              subject: parsed.subject ?? "",
              taskKey
            },
            "Mail GS message parsed"
          );

          if (!taskKey) {
            await this.markProcessed(integrationId, uidValidity, uid, parsed.messageId ?? undefined, undefined);
            continue;
          }

          const senderEmails = getSenderEmails(parsed);
          const isCompletion = senderEmails.includes(completionSender);

          if (isCompletion) {
            await TrackerTask.deleteOne({ integrationId, taskKey });
            logger.info({ integrationId, uid, taskKey, senderEmails }, "Mail GS task marked completed");
          } else {
            await TrackerTask.updateOne(
              { integrationId, taskKey },
              {
                $set: {
                  assignee: credentials.login,
                  lastEventAt: new Date(),
                  lastMailUid: uid,
                  rawSubject: parsed.subject ?? ""
                }
              },
              { upsert: true }
            );
            logger.info({ integrationId, uid, taskKey, senderEmails }, "Mail GS task upserted");
          }

          await this.markProcessed(integrationId, uidValidity, uid, parsed.messageId ?? undefined, taskKey);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    const count = await TrackerTask.countDocuments({ integrationId });
    logger.info({ integrationId, count }, "Mail GS integration synced from unread emails");
    return count;
  }

  private async markProcessed(
    integrationId: string,
    uidValidity: string,
    uid: number,
    messageId?: string,
    taskKey?: string
  ): Promise<void> {
    try {
      await ProcessedTrackerMail.create({
        integrationId,
        uidValidity,
        uid,
        messageId,
        taskKey,
        processedAt: new Date()
      });
    } catch (error) {
      logger.debug({ err: error, integrationId, uidValidity, uid }, "Processed mail already exists");
    }
  }
}

