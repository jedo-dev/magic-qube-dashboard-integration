import { HydratedDocument, Model, Schema, model } from "mongoose";

interface ProcessedTrackerMailMongo {
  integrationId: string;
  uidValidity: string;
  uid: number;
  messageId?: string;
  taskKey?: string;
  processedAt: Date;
}

const processedTrackerMailSchema = new Schema<ProcessedTrackerMailMongo>(
  {
    integrationId: {
      type: String,
      required: true,
      index: true
    },
    uidValidity: {
      type: String,
      required: true
    },
    uid: {
      type: Number,
      required: true
    },
    messageId: {
      type: String
    },
    taskKey: {
      type: String
    },
    processedAt: {
      type: Date,
      required: true
    }
  },
  {
    timestamps: true
  }
);

processedTrackerMailSchema.index({ integrationId: 1, uidValidity: 1, uid: 1 }, { unique: true });
processedTrackerMailSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export type ProcessedTrackerMailDocument = HydratedDocument<ProcessedTrackerMailMongo>;
export type ProcessedTrackerMailModel = Model<ProcessedTrackerMailMongo>;

export const ProcessedTrackerMail = model<ProcessedTrackerMailMongo>(
  "ProcessedTrackerMail",
  processedTrackerMailSchema,
  "processed_tracker_mails"
);

