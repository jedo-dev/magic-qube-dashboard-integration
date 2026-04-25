import { HydratedDocument, Model, Schema, model } from "mongoose";

interface TrackerTaskMongo {
  integrationId: string;
  taskKey: string;
  assignee: string;
  lastEventAt: Date;
  lastMailUid: number;
  rawSubject?: string;
}

const trackerTaskSchema = new Schema<TrackerTaskMongo>(
  {
    integrationId: {
      type: String,
      required: true,
      index: true
    },
    taskKey: {
      type: String,
      required: true
    },
    assignee: {
      type: String,
      required: true
    },
    lastEventAt: {
      type: Date,
      required: true
    },
    lastMailUid: {
      type: Number,
      required: true
    },
    rawSubject: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

trackerTaskSchema.index({ integrationId: 1, taskKey: 1 }, { unique: true });

export type TrackerTaskDocument = HydratedDocument<TrackerTaskMongo>;
export type TrackerTaskModel = Model<TrackerTaskMongo>;

export const TrackerTask = model<TrackerTaskMongo>("TrackerTask", trackerTaskSchema, "tracker_tasks");

