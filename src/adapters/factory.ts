import { IntegrationType } from "../types/integration";
import { MailIntegrationAdapter } from "./base";
import { MailRuImapAdapter } from "./mailruImapAdapter";
import { YandexImapAdapter } from "./yandexImapAdapter";
import { YandexTrackerImapAdapter } from "./yandexTrackerImapAdapter";

export class AdapterFactory {
  private readonly adapters: Record<IntegrationType, MailIntegrationAdapter> = {
    yandex_imap: new YandexImapAdapter(),
    mailru_imap: new MailRuImapAdapter(),
    yandex_tracker_imap: new YandexTrackerImapAdapter()
  };

  get(type: IntegrationType): MailIntegrationAdapter {
    const adapter = this.adapters[type];
    if (!adapter) {
      throw new Error(`Adapter for integration type "${type}" is not configured`);
    }
    return adapter;
  }
}
