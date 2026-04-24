import { Integration, IntegrationDocument } from "../models/integration";
import { DashboardState } from "../types/integration";

export class DashboardService {
  private latestState: DashboardState | null = null;

  async buildState(): Promise<DashboardState> {
    const integrations = await Integration.find().sort({ sortOrder: 1, createdAt: 1 });
    const state = this.mapToState(integrations);
    this.latestState = state;
    return state;
  }

  getLatestState(): DashboardState | null {
    return this.latestState;
  }

  setLatestState(state: DashboardState): void {
    this.latestState = state;
  }

  private mapToState(docs: IntegrationDocument[]): DashboardState {
    const integrationStates = docs.map((doc) => ({
      id: doc._id.toString(),
      type: doc.type,
      label: doc.label,
      color: doc.color,
      unreadCount: doc.lastUnreadCount ?? 0,
      lastCheckedAt: doc.lastCheckedAt,
      lastSuccessAt: doc.lastSuccessAt,
      status: doc.lastError ? "error" : "ok",
      lastError: doc.lastError ?? null
    })) as DashboardState["integrations"];

    return {
      generatedAt: new Date(),
      totalUnread: integrationStates.reduce((acc, item) => acc + item.unreadCount, 0),
      integrations: integrationStates
    };
  }
}
