import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { IntegrationDocument } from "../models/integration";
import { ProcessedTrackerMail } from "../models/processedTrackerMail";
import { TrackerTask } from "../models/trackerTask";
import { ImapCredentials } from "../types/integration";
import { MailIntegrationAdapter } from "./base";

type TrackerEventType = "assigned_to_me" | "removed_from_me" | "ignored";

const TASK_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/;
const ASSIGNEE_FIELD_WORD = "исполнитель";

const normalize = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .replaceAll("ё", "е")
    .trim()
    .toLowerCase();

const includesName = (value: string, targetName: string): boolean => {
  if (!value || !targetName) {
    return false;
  }
  return normalize(value).includes(normalize(targetName));
};

const stripHtmlTags = (value: string): string => value.replace(/<[^>]+>/g, " ");
const decodeBasicEntities = (value: string): string =>
  value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const cleanHtmlText = (value: string): string => normalize(decodeBasicEntities(stripHtmlTags(value)));

const extractTaskKey = (...parts: Array<string | undefined>): string | null => {
  const joined = parts.filter(Boolean).join("\n").toUpperCase();
  const match = joined.match(TASK_KEY_REGEX);
  return match ? match[0] : null;
};

const extractAssigneeValueCell = (html: string): string => {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const rowText = cleanHtmlText(row);
    if (!rowText.includes(ASSIGNEE_FIELD_WORD)) {
      continue;
    }

    const tdMatch = row.match(/<td\b[^>]*>[\s\S]*?<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (tdMatch && tdMatch[1]) {
      return tdMatch[1];
    }
  }
  return "";
};

const extractOldAssignee = (valueCellHtml: string): string | null => {
  const lineThroughRegex = /<[^>]*line-through[^>]*>([^<]{2,200})<\/[^>]+>/gi;
  const strikeRegex = /<(?:s|strike)[^>]*>([^<]{2,200})<\/(?:s|strike)>/gi;
  const first = lineThroughRegex.exec(valueCellHtml);
  if (first && first[1]) {
    return first[1].trim();
  }
  const second = strikeRegex.exec(valueCellHtml);
  return second && second[1] ? second[1].trim() : null;
};

const extractNewAssignee = (valueCellHtml: string, oldAssignee: string | null): string | null => {
  // Preferred path: read text from non-strike <span> inside the same assignee value cell.
  const spans = Array.from(valueCellHtml.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi));
  for (const span of spans) {
    const attrs = (span[1] ?? "").toLowerCase();
    const text = decodeBasicEntities(stripHtmlTags(span[2] ?? "")).trim();
    if (!text) {
      continue;
    }
    if (attrs.includes("line-through")) {
      continue;
    }
    if (!oldAssignee || normalize(text) !== normalize(oldAssignee)) {
      return text;
    }
  }

  // Fallback: any visible text in the assignee value cell except old assignee.
  const candidates = Array.from(valueCellHtml.matchAll(/>\s*([^<>]{2,200})\s*</g))
    .map((it) => decodeBasicEntities((it[1] ?? "").trim()))
    .filter((it) => it.length > 0);

  if (candidates.length === 0) {
    return null;
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!oldAssignee || normalize(candidate) !== normalize(oldAssignee)) {
      return candidate;
    }
  }

  return null;
};

const detectTrackerEvent = (html: string, text: string, targetAssignee: string): TrackerEventType => {
  const valueCellHtml = extractAssigneeValueCell(html);
  if (valueCellHtml) {
    const oldAssignee = extractOldAssignee(valueCellHtml);
    const newAssignee = extractNewAssignee(valueCellHtml, oldAssignee);
    if (oldAssignee && newAssignee) {
      if (includesName(newAssignee, targetAssignee) && !includesName(oldAssignee, targetAssignee)) {
        return "assigned_to_me";
      }
      if (includesName(oldAssignee, targetAssignee) && !includesName(newAssignee, targetAssignee)) {
        return "removed_from_me";
      }
    }
  }

  const plain = normalize(stripHtmlTags(html) + "\n" + text);
  if (plain.includes(ASSIGNEE_FIELD_WORD) && includesName(plain, targetAssignee)) {
    return "assigned_to_me";
  }
  return "ignored";
};

export class YandexTrackerImapAdapter implements MailIntegrationAdapter {
  async getUnreadCount(integration: IntegrationDocument, credentials: ImapCredentials): Promise<number> {
    const integrationId = integration._id.toString();
    const assigneeName = credentials.assigneeName?.trim();
    if (!assigneeName) {
      throw new Error(
        `Integration "${integration.label}" requires credentials.assigneeName for yandex_tracker_imap`
      );
    }

    const client = new ImapFlow({
      host: credentials.host ?? "imap.yandex.ru",
      port: credentials.port ?? 993,
      secure: credentials.secure ?? true,
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
            logger.debug({ integrationId, uid }, "Tracker mail skipped: already processed");
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
              taskKey,
              assigneeName
            },
            "Tracker mail parsed"
          );

          if (!taskKey) {
            await this.markProcessed(integrationId, uidValidity, uid, parsed.messageId ?? undefined, undefined);
            continue;
          }

          const eventType = detectTrackerEvent(html, text, assigneeName);
          logger.info({ integrationId, uid, taskKey, eventType }, "Tracker event detected");
          if (eventType === "assigned_to_me") {
            await TrackerTask.updateOne(
              { integrationId, taskKey },
              {
                $set: {
                  assignee: assigneeName,
                  lastEventAt: new Date(),
                  lastMailUid: uid,
                  rawSubject: parsed.subject ?? ""
                }
              },
              { upsert: true }
            );
            logger.info({ integrationId, uid, taskKey }, "Tracker task upserted");
          } else if (eventType === "removed_from_me") {
            await TrackerTask.deleteOne({ integrationId, taskKey });
            logger.info({ integrationId, uid, taskKey }, "Tracker task removed");
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
    logger.info({ integrationId, count }, "Tracker integration synced from unread emails");
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
