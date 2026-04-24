import { Schema, model } from "mongoose";
import { DashboardState } from "../types/integration";

interface DashboardSnapshotMongo {
  state: DashboardState;
  trigger: "startup" | "manual" | "scheduled";
  createdAt: Date;
}

const dashboardSnapshotSchema = new Schema<DashboardSnapshotMongo>({
  state: {
    type: Schema.Types.Mixed,
    required: true
  },
  trigger: {
    type: String,
    enum: ["startup", "manual", "scheduled"],
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

dashboardSnapshotSchema.index({ createdAt: -1 });
dashboardSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const DashboardSnapshot = model<DashboardSnapshotMongo>(
  "DashboardSnapshot",
  dashboardSnapshotSchema
);
