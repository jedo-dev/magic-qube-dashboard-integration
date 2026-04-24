import { IntegrationDocument } from "../models/integration";
import { ImapCredentials } from "../types/integration";

export interface MailIntegrationAdapter {
  getUnreadCount(integration: IntegrationDocument, credentials: ImapCredentials): Promise<number>;
}
