import { ImapFlow } from "imapflow";
import { env } from "../config/env";
import { IntegrationDocument } from "../models/integration";
import { ImapCredentials } from "../types/integration";
import { MailIntegrationAdapter } from "./base";

export class MailRuImapAdapter implements MailIntegrationAdapter {
  async getUnreadCount(_integration: IntegrationDocument, credentials: ImapCredentials): Promise<number> {
    const client = new ImapFlow({
      host: credentials.host ?? "imap.mail.ru",
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
        const status = await client.status("INBOX", { unseen: true });
        return status.unseen ?? 0;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
