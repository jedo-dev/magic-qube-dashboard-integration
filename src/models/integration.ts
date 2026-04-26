import { HydratedDocument, Model, Schema, model } from "mongoose";
import { env } from "../config/env";
import { IntegrationApiDto, IntegrationType } from "../types/integration";

interface IntegrationMongo {
  type: IntegrationType;
  enabled: boolean;
  credentialsEnc: string;
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

const integrationSchema = new Schema<IntegrationMongo>(
  {
    type: {
      type: String,
      enum: ["yandex_imap", "mailru_imap", "yandex_tracker_imap", "mail_gs_tracker_imap"],
      required: true
    },
    enabled: {
      type: Boolean,
      default: true
    },
    credentialsEnc: {
      type: String,
      required: true
    },
    pollIntervalSec: {
      type: Number,
      default: env.defaultPollIntervalSec,
      min: 10
    },
    label: {
      type: String,
      required: true,
      trim: true
    },
    color: {
      type: String,
      required: true,
      default: "#ffcc00"
    },
    sortOrder: {
      type: Number,
      default: 100
    },
    lastUnreadCount: {
      type: Number,
      default: 0
    },
    lastCheckedAt: Date,
    lastSuccessAt: Date,
    lastError: {
      type: String,
      default: null
    },
    errorStreak: {
      type: Number,
      default: 0
    },
    nextRunAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

integrationSchema.index({ enabled: 1, nextRunAt: 1 });
integrationSchema.index({ sortOrder: 1 });

export type IntegrationDocument = HydratedDocument<IntegrationMongo>;
export type IntegrationModel = Model<IntegrationMongo>;

export const Integration = model<IntegrationMongo>("Integration", integrationSchema);

export const toIntegrationDto = (doc: IntegrationDocument): IntegrationApiDto => ({
  id: doc._id.toString(),
  type: doc.type,
  enabled: doc.enabled,
  pollIntervalSec: doc.pollIntervalSec,
  label: doc.label,
  color: doc.color,
  sortOrder: doc.sortOrder,
  lastUnreadCount: doc.lastUnreadCount,
  lastCheckedAt: doc.lastCheckedAt,
  lastSuccessAt: doc.lastSuccessAt,
  lastError: doc.lastError,
  errorStreak: doc.errorStreak,
  nextRunAt: doc.nextRunAt
});
