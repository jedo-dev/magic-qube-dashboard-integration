export type IntegrationType =
  | "yandex_imap"
  | "mailru_imap"
  | "yandex_tracker_imap"
  | "mail_gs_tracker_imap";

export interface ImapCredentials {
  login: string;
  appPassword: string;
  assigneeName?: string;
  completionSender?: string;
  host?: string;
  port?: number;
  secure?: boolean;
}

export interface IntegrationApiDto {
  id: string;
  type: IntegrationType;
  enabled: boolean;
  pollIntervalSec: number;
  label: string;
  color: string;
  sortOrder: number;
  lastUnreadCount: number;
  lastCheckedAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string | null;
  errorStreak: number;
  nextRunAt: Date;
}

export interface DashboardIntegrationState {
  id: string;
  type: IntegrationType;
  label: string;
  color: string;
  unreadCount: number;
  lastCheckedAt?: Date;
  lastSuccessAt?: Date;
  status: "ok" | "error";
  lastError?: string | null;
}

export interface DashboardState {
  generatedAt: Date;
  totalUnread: number;
  integrations: DashboardIntegrationState[];
}
